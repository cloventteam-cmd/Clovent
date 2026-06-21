import { queryMany } from '../../db/client';
import { queueCampaignStepJob } from '../../workers/queue';
import { eventBus } from '../../events/bus';
import { EventNames } from '../../events/types';
import type { UUID, TriggerRule } from '../../shared/types';
import { logger } from '../../shared/logger';

// ─── Trigger Rules Engine ─────────────────────────────────────────────────────
// Evaluates campaign trigger_rules against system events to enroll contacts.

export class TriggerEngine {
  private tenantId: UUID;

  constructor(tenantId: UUID) {
    this.tenantId = tenantId;
  }

  async evaluateTrigger(
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // Find active campaigns that match this event
    const campaigns = await queryMany<{
      id: UUID;
      trigger_rules: TriggerRule[];
      sequence: unknown[];
    }>(
      `SELECT id, trigger_rules, sequence FROM campaigns
       WHERE tenant_id = $1 AND status = 'active'`,
      [this.tenantId],
    );

    for (const campaign of campaigns) {
      const triggerRules = Array.isArray(campaign.trigger_rules)
        ? campaign.trigger_rules
        : JSON.parse(String(campaign.trigger_rules));

      for (const rule of triggerRules) {
        if (rule.event !== eventName) continue;

        const contactId = payload.contact_id as UUID;
        if (!contactId) continue;

        // Check if already enrolled
        const existing = await queryMany<{ id: UUID }>(
          `SELECT id FROM campaign_contacts
           WHERE campaign_id = $1 AND contact_id = $2 AND status NOT IN ('completed','unsubscribed')`,
          [campaign.id, contactId],
        );

        if (existing.length > 0) continue;

        // Enroll contact
        await queryMany(
          `INSERT INTO campaign_contacts (tenant_id, campaign_id, contact_id, status)
           VALUES ($1,$2,$3,'enrolled')
           ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
          [this.tenantId, campaign.id, contactId],
        );

        // Update to active
        await queryMany(
          `UPDATE campaign_contacts SET status = 'active' WHERE campaign_id = $1 AND contact_id = $2`,
          [campaign.id, contactId],
        );

        const delayMs = (rule.delay_minutes ?? 0) * 60000;
        await queueCampaignStepJob(
          { tenant_id: this.tenantId, campaign_id: campaign.id, contact_id: contactId, step: 0 },
          delayMs,
        );

        logger.info({ campaign_id: campaign.id, contact_id: contactId, event: eventName }, 'Contact enrolled in campaign');

        await eventBus.emit(EventNames.CAMPAIGN_TRIGGERED, {
          tenant_id: this.tenantId,
          campaign_id: campaign.id,
          contact_id: contactId,
          trigger_event: eventName,
        });
      }
    }
  }
}
