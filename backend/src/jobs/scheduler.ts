import cron from 'node-cron';
import { queryMany } from '../db/client';
import { queueOpportunityJob, queueDealRiskJob, queueBatchScoringJob, queueCrmSyncJob, queuePredictionJob } from '../workers/queue';
import { BusinessOperator } from '../ai/operator/business-operator';
import { query } from '../db/client';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { eventBus } from '../events/bus';
import { EventNames } from '../events/types';

async function getAllTenants(): Promise<{ id: string }[]> {
  return queryMany<{ id: string }>(
    "SELECT id FROM organizations WHERE is_active = true",
    [],
  );
}

// ── Opportunity Scan Job ──────────────────────────────────────────────────────
cron.schedule(config.jobs.opportunityScanCron, async () => {
  logger.info('Cron: opportunity scan starting');
  const tenants = await getAllTenants();

  for (const tenant of tenants) {
    await queueOpportunityJob({ tenant_id: tenant.id });
  }

  logger.info({ tenants: tenants.length }, 'Cron: opportunity scan queued for all tenants');
});

// ── Deal Risk Scan Job ────────────────────────────────────────────────────────
cron.schedule(config.jobs.dealRiskScanCron, async () => {
  logger.debug('Cron: deal risk scan starting');
  const tenants = await getAllTenants();

  for (const tenant of tenants) {
    const activeDeals = await queryMany<{ id: string }>(
      `SELECT id FROM deals WHERE tenant_id = $1
       AND stage NOT IN ('closed_won','closed_lost','withdrawn','lead')
       ORDER BY updated_at ASC LIMIT 50`,
      [tenant.id],
    );

    for (const deal of activeDeals) {
      await queueDealRiskJob({ tenant_id: tenant.id, deal_id: deal.id });
    }
  }
});

// ── Daily Briefing Job ────────────────────────────────────────────────────────
cron.schedule(config.jobs.dailyBriefingCron, async () => {
  logger.info('Cron: daily briefing generation starting');
  const tenants = await getAllTenants();
  const today = new Date().toISOString().split('T')[0];

  for (const tenant of tenants) {
    try {
      const existing = await queryMany(
        'SELECT id FROM daily_briefings WHERE tenant_id = $1 AND date = $2',
        [tenant.id, today],
      );

      if (existing.length > 0) continue;

      const operator = new BusinessOperator(tenant.id);
      const briefing = await operator.generateDailyBriefing(new Date());

      await query(
        `INSERT INTO daily_briefings (
          tenant_id, date, top_actions, who_to_contact, deals_at_risk,
          revenue_forecast, summary, generated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (tenant_id, date) DO NOTHING`,
        [
          tenant.id, today,
          JSON.stringify(briefing.top_actions), JSON.stringify(briefing.who_to_contact),
          JSON.stringify(briefing.deals_at_risk), JSON.stringify(briefing.revenue_forecast),
          briefing.summary, briefing.generated_at,
        ],
      );

      // Notify all agents
      await eventBus.emit(EventNames.NOTIFICATION_SEND, {
        tenant_id: tenant.id,
        user_id: 'all',
        type: 'daily_summary',
        title: 'Your Daily Briefing is Ready',
        body: briefing.summary?.slice(0, 120),
        data: { date: today },
        channels: ['in_app'],
      });

      logger.info({ tenant_id: tenant.id }, 'Daily briefing generated');
    } catch (err) {
      logger.error({ err, tenant_id: tenant.id }, 'Daily briefing generation failed');
    }
  }
});

// ── Batch Scoring Job ─────────────────────────────────────────────────────────
cron.schedule(config.jobs.scoringBatchCron, async () => {
  logger.debug('Cron: batch scoring starting');
  const tenants = await getAllTenants();

  for (const tenant of tenants) {
    const contacts = await queryMany<{ id: string }>(
      `SELECT id FROM contacts
       WHERE tenant_id = $1 AND status = 'active'
       AND updated_at > NOW() - INTERVAL '4 hours'
       LIMIT 200`,
      [tenant.id],
    );

    if (contacts.length > 0) {
      await queueBatchScoringJob(tenant.id, contacts.map(c => c.id));
    }
  }
});

// ── Campaign Processor ────────────────────────────────────────────────────────
cron.schedule(config.jobs.campaignProcessCron, async () => {
  const tenants = await getAllTenants();

  for (const tenant of tenants) {
    // Activate scheduled campaigns
    const scheduled = await queryMany<{ id: string }>(
      `SELECT id FROM campaigns
       WHERE tenant_id = $1 AND status = 'scheduled'
         AND scheduled_at <= NOW()`,
      [tenant.id],
    );

    for (const campaign of scheduled) {
      await query(
        "UPDATE campaigns SET status = 'active', started_at = NOW() WHERE id = $1",
        [campaign.id],
      );
      logger.info({ campaign_id: campaign.id }, 'Campaign auto-activated');
    }
  }
});

// ── CRM Background Sync ───────────────────────────────────────────────────────
// Runs every 5 minutes. Checks crm_credentials for rows with next_sync_at <= NOW()
// and queues a sync job for each. Each credential controls its own interval.
cron.schedule('*/5 * * * *', async () => {
  try {
    const { findCredentialsDueForSync } = await import('../ingestion/db/credentials');
    const due = await findCredentialsDueForSync(200);

    if (due.length === 0) return;
    logger.debug({ count: due.length }, 'CRM sync cron: credentials due');

    for (const cred of due) {
      await queueCrmSyncJob({
        tenant_id: cred.tenant_id,
        credential_id: cred.id,
        crm_type: cred.crm_type,
        sync_type: 'incremental',
        entity_types: cred.settings.entity_types,
      });
    }

    logger.info({ queued: due.length }, 'CRM sync cron: sync jobs queued');
  } catch (err) {
    logger.error({ err }, 'CRM sync cron: error');
  }
});

// ── Enterprise Usage Anomaly Detection ───────────────────────────────────────
// Runs hourly — checks Enterprise tenants for unusual usage spikes
cron.schedule('30 * * * *', async () => {
  const { detectUsageAnomaly } = await import('../billing/usage-tracker');
  const { hasFeature } = await import('../billing/plans');

  const enterpriseTenants = await queryMany<{ id: string }>(
    "SELECT id FROM organizations WHERE plan = 'enterprise' AND is_active = true",
    [],
  ).catch(() => []);

  for (const tenant of enterpriseTenants) {
    try {
      const { anomalous, spikes } = await detectUsageAnomaly(tenant.id);
      if (anomalous && spikes.length > 0) {
        const { eventBus: eb } = await import('../events/bus');
        const { EventNames: EN } = await import('../events/types');
        await eb.emit(EN.USAGE_ANOMALY as any, {
          tenant_id: tenant.id,
          spikes,
        });
      }
    } catch { /* non-fatal */ }
  }
});

// ── Daily Usage Snapshot ──────────────────────────────────────────────────────
cron.schedule('0 23 * * *', async () => {
  logger.info('Cron: daily usage snapshot starting');
  const { takeDailySnapshot } = await import('../billing/usage-tracker');
  const tenants = await getAllTenants();
  for (const tenant of tenants) {
    await takeDailySnapshot(tenant.id).catch(err =>
      logger.error({ err, tenant_id: tenant.id }, 'Usage snapshot failed'),
    );
  }
  logger.info({ tenants: tenants.length }, 'Cron: daily usage snapshot complete');
});

// ── Nightly Prediction Batch ─────────────────────────────────────────────────
// Runs at 2 AM daily. Processes all active contacts per tenant through
// all 4 prediction models (seller, buyer, reactivation, deal failure).
cron.schedule('0 2 * * *', async () => {
  logger.info('Cron: nightly prediction batch starting');
  const tenants = await getAllTenants();

  for (const tenant of tenants) {
    await queuePredictionJob({
      tenant_id: tenant.id,
      prediction_type: 'full',
    });
  }

  logger.info({ tenants: tenants.length }, 'Cron: prediction batch queued for all tenants');
});

logger.info({
  opportunity: config.jobs.opportunityScanCron,
  risk: config.jobs.dealRiskScanCron,
  briefing: config.jobs.dailyBriefingCron,
  scoring: config.jobs.scoringBatchCron,
  crm_sync: '*/5 * * * *',
  prediction: '0 2 * * *',
}, 'Job scheduler started');
