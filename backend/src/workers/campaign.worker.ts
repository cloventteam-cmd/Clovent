import { createWorker, type CampaignJobData, queueCampaignStepJob } from './queue';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { eventBus } from '../events/bus';
import { EventNames } from '../events/types';
import { queryOne, query } from '../db/client';
import { MessageGenerator } from '../modules/automation/message-generator';
import type { Campaign } from '../shared/types';

export function startCampaignWorker(): void {
  createWorker<CampaignJobData>(
    config.queues.campaign,
    async (job) => {
      const { tenant_id, campaign_id, contact_id, step } = job.data;

      const [campaign, contact, cc] = await Promise.all([
        queryOne<Campaign & { id: string }>(
          'SELECT * FROM campaigns WHERE tenant_id = $1 AND id = $2',
          [tenant_id, campaign_id],
        ),
        queryOne(
          'SELECT * FROM contacts WHERE tenant_id = $1 AND id = $2',
          [tenant_id, contact_id],
        ),
        queryOne(
          `SELECT * FROM campaign_contacts WHERE campaign_id = $1 AND contact_id = $2`,
          [campaign_id, contact_id],
        ),
      ]);

      if (!campaign || !contact || !cc) {
        logger.warn({ campaign_id, contact_id }, 'Campaign step: missing campaign/contact');
        return;
      }

      if ((cc as any).status !== 'active' && (cc as any).status !== 'enrolled') {
        logger.debug({ campaign_id, contact_id }, 'Campaign contact not active');
        return;
      }

      const sequence: Array<any> = (campaign as any).sequence ?? [];
      const currentStep = sequence[step];

      if (!currentStep) {
        // Sequence complete
        await query(
          `UPDATE campaign_contacts SET status = 'completed', completed_at = NOW()
           WHERE campaign_id = $1 AND contact_id = $2`,
          [campaign_id, contact_id],
        );

        await eventBus.emit(EventNames.CAMPAIGN_STEP_EXECUTED, {
          tenant_id,
          campaign_id,
          contact_id,
          step,
        });
        return;
      }

      if (currentStep.type === 'wait') {
        const delayMs = (currentStep.delay_hours ?? 24) * 60 * 60 * 1000;
        await queueCampaignStepJob(
          { tenant_id, campaign_id, contact_id, step: step + 1 },
          delayMs,
        );
        return;
      }

      if (currentStep.type === 'email' || currentStep.type === 'sms') {
        const generator = new MessageGenerator();
        const message = generator.generate({
          template: currentStep.body_template ?? '',
          contact: contact as any,
          channel: currentStep.type,
        });

        await query(
          `INSERT INTO messages
           (tenant_id, contact_id, channel, direction, subject, body, status, campaign_id, sent_at)
           VALUES ($1,$2,$3,'outbound',$4,$5,'sent',$6,NOW())`,
          [
            tenant_id, contact_id, currentStep.type,
            currentStep.subject ?? null, message, campaign_id,
          ],
        );

        await query(
          `UPDATE campaign_contacts SET last_sent_at = NOW(), current_step = $3
           WHERE campaign_id = $1 AND contact_id = $2`,
          [campaign_id, contact_id, step + 1],
        );

        await eventBus.emit(EventNames.CAMPAIGN_STEP_EXECUTED, {
          tenant_id,
          campaign_id,
          contact_id,
          step,
        });

        // Schedule next step
        if (step + 1 < sequence.length) {
          const nextDelay = (sequence[step + 1]?.delay_hours ?? 0) * 3600000;
          await queueCampaignStepJob(
            { tenant_id, campaign_id, contact_id, step: step + 1 },
            nextDelay,
          );
        }
      }

      logger.debug({ campaign_id, contact_id, step }, 'Campaign step executed');
    },
    10,
  );

  logger.info('Campaign worker started');
}
