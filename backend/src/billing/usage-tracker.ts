/**
 * Usage Tracker — Per-tenant usage counters with DB flush.
 *
 * Tracks all billable/enforceable metrics at hour/day/month granularity.
 * In-memory counters flushed every 60s → usage_metrics table.
 * Daily snapshot job → usage_snapshots for billing.
 *
 * Enforcement flow:
 *   trackUsage() → in-memory counter
 *   plan-enforcer middleware reads getUsage() → compare to plan limit
 *   At 80%: BILLING_WARNING
 *   At 95%: USAGE_THRESHOLD (new — stronger signal)
 *   At 100% × soft_cap.hard_pct: PLAN_LIMIT_REACHED + 402
 */
import { query, queryOne, queryMany } from '../db/client';
import { logger } from '../shared/logger';
import type { UUID } from '../shared/types';

export type MetricType =
  | 'api_calls'
  | 'contacts_created'
  | 'imports_started'
  | 'ingestion_records'       // records ingested via CRM connectors
  | 'predictions_run'
  | 'campaigns_sent'
  | 'crm_syncs'
  | 'ai_completions'
  | 'worker_jobs'             // total BullMQ jobs dispatched
  | 'webhook_received'
  | 'storage_mb_written';     // file storage written

type PeriodType = 'hour' | 'day' | 'month';

// key = "<tenant_id>|||<metric>|||<period_type>|||<period_start>"
const counters = new Map<string, number>();

function currentPeriod(type: PeriodType): string {
  const d = new Date();
  if (type === 'hour') { d.setMinutes(0, 0, 0); }
  else if (type === 'day') { d.setHours(0, 0, 0, 0); }
  else { d.setDate(1); d.setHours(0, 0, 0, 0); }
  return d.toISOString();
}

// Which periods to track per metric (some need hourly, some daily/monthly)
const METRIC_PERIODS: Record<MetricType, PeriodType[]> = {
  api_calls:          ['hour', 'day'],
  contacts_created:   ['month'],
  imports_started:    ['month'],
  ingestion_records:  ['day', 'month'],
  predictions_run:    ['day'],
  campaigns_sent:     ['day', 'month'],
  crm_syncs:          ['day', 'month'],
  ai_completions:     ['day'],
  worker_jobs:        ['hour', 'day'],
  webhook_received:   ['hour'],
  storage_mb_written: ['day', 'month'],
};

export function trackUsage(tenantId: UUID, metric: MetricType, count = 1): void {
  const periods = METRIC_PERIODS[metric] ?? ['day'];
  for (const period of periods) {
    const key = `${tenantId}|||${metric}|||${period}|||${currentPeriod(period)}`;
    counters.set(key, (counters.get(key) ?? 0) + count);
  }
}

export async function getUsage(
  tenantId: UUID,
  metric: MetricType,
  period: PeriodType,
): Promise<number> {
  const periodStart = currentPeriod(period);
  const key = `${tenantId}|||${metric}|||${period}|||${periodStart}`;

  const inMem = counters.get(key) ?? 0;

  const row = await queryOne<{ count: string }>(
    `SELECT COALESCE(SUM(count), 0)::text AS count FROM usage_metrics
     WHERE tenant_id = $1 AND metric_type = $2 AND period_type = $3
       AND period_start = $4`,
    [tenantId, metric, period, periodStart],
  ).catch(() => null);

  return inMem + parseInt(row?.count ?? '0', 10);
}

// Get multiple metrics at once (reduces DB round trips)
export async function getUsageMulti(
  tenantId: UUID,
  requests: Array<{ metric: MetricType; period: PeriodType }>,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  for (const req of requests) {
    const value = await getUsage(tenantId, req.metric, req.period);
    result.set(`${req.metric}:${req.period}`, value);
  }

  return result;
}

export async function flushUsageToDB(): Promise<void> {
  if (counters.size === 0) return;

  const snapshot = [...counters.entries()];
  counters.clear();

  for (const [key, count] of snapshot) {
    const [tenant_id, metric_type, period_type, period_start] = key.split('|||');
    try {
      await query(
        `INSERT INTO usage_metrics (tenant_id, metric_type, period_type, period_start, count, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (tenant_id, metric_type, period_start, period_type)
         DO UPDATE SET count = usage_metrics.count + EXCLUDED.count, updated_at = NOW()`,
        [tenant_id, metric_type, period_type, period_start, count],
      );
    } catch (err) {
      logger.error({ err, key, count }, 'UsageTracker: flush error — re-queuing');
      // Re-queue so data isn't lost
      counters.set(key, (counters.get(key) ?? 0) + count);
    }
  }
}

export async function takeDailySnapshot(tenantId: UUID): Promise<void> {
  const today = new Date().toISOString().split('T')[0];

  const [contacts, deals, teamMembers, activeCampaigns] = await Promise.all([
    queryOne<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM contacts WHERE tenant_id = $1 AND status != 'archived'",
      [tenantId],
    ),
    queryOne<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM deals WHERE tenant_id = $1 AND stage NOT IN ('closed_won','closed_lost','withdrawn')",
      [tenantId],
    ),
    queryOne<{ n: string }>(
      'SELECT COUNT(DISTINCT user_id)::text AS n FROM team_members WHERE tenant_id = $1',
      [tenantId],
    ),
    queryOne<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM campaigns WHERE tenant_id = $1 AND status = 'active'",
      [tenantId],
    ),
  ]);

  const [apiCallsDay, importsMonth, predictionsDay] = await Promise.all([
    getUsage(tenantId, 'api_calls', 'day'),
    getUsage(tenantId, 'imports_started', 'month'),
    getUsage(tenantId, 'predictions_run', 'day'),
  ]);

  await query(
    `INSERT INTO usage_snapshots
       (tenant_id, snapshot_date, contacts_total, deals_total,
        api_calls_day, imports_month, predictions_day,
        campaigns_active, team_members)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, snapshot_date)
     DO UPDATE SET
       contacts_total  = EXCLUDED.contacts_total,
       deals_total     = EXCLUDED.deals_total,
       api_calls_day   = EXCLUDED.api_calls_day,
       imports_month   = EXCLUDED.imports_month,
       predictions_day = EXCLUDED.predictions_day,
       campaigns_active= EXCLUDED.campaigns_active,
       team_members    = EXCLUDED.team_members`,
    [
      tenantId, today,
      parseInt(contacts?.n ?? '0', 10),
      parseInt(deals?.n ?? '0', 10),
      apiCallsDay, importsMonth, predictionsDay,
      parseInt(activeCampaigns?.n ?? '0', 10),
      parseInt(teamMembers?.n ?? '0', 10),
    ],
  );
}

export async function getUsageSummary(tenantId: UUID) {
  const latest = await queryOne<any>(
    'SELECT * FROM usage_snapshots WHERE tenant_id = $1 ORDER BY snapshot_date DESC LIMIT 1',
    [tenantId],
  );

  const [apiHour, importsMonth, predictionsDay, workerJobsHour, ingestDay] = await Promise.all([
    getUsage(tenantId, 'api_calls', 'hour'),
    getUsage(tenantId, 'imports_started', 'month'),
    getUsage(tenantId, 'predictions_run', 'day'),
    getUsage(tenantId, 'worker_jobs', 'hour'),
    getUsage(tenantId, 'ingestion_records', 'day'),
  ]);

  return {
    contacts_total:       latest?.contacts_total      ?? 0,
    imports_this_month:   Math.max(importsMonth,         latest?.imports_month ?? 0),
    predictions_today:    Math.max(predictionsDay,        latest?.predictions_day ?? 0),
    api_calls_this_hour:  apiHour,
    worker_jobs_this_hour:workerJobsHour,
    ingestion_records_today: ingestDay,
    campaigns_active:     latest?.campaigns_active    ?? 0,
    team_members:         latest?.team_members        ?? 0,
  };
}

export async function getTenantPlan(tenantId: UUID): Promise<string> {
  const org = await queryOne<{ plan: string }>(
    'SELECT plan FROM organizations WHERE id = $1',
    [tenantId],
  );
  return org?.plan ?? 'starter';
}

// Detect anomalous usage spikes (called by Enterprise tenant monitoring)
export async function detectUsageAnomaly(tenantId: UUID): Promise<{
  anomalous: boolean;
  spikes: Array<{ metric: string; current: number; typical: number; ratio: number }>;
}> {
  // Compare current hour to 7-day average for same hour-of-day
  const spikes = await queryMany<any>(
    `WITH current_hour AS (
       SELECT metric_type, count
       FROM usage_metrics
       WHERE tenant_id = $1
         AND period_type = 'hour'
         AND period_start = date_trunc('hour', NOW())
     ),
     historical_avg AS (
       SELECT metric_type, AVG(count) AS avg_count
       FROM usage_metrics
       WHERE tenant_id = $1
         AND period_type = 'hour'
         AND period_start >= NOW() - INTERVAL '7 days'
         AND EXTRACT(HOUR FROM period_start) = EXTRACT(HOUR FROM NOW())
       GROUP BY metric_type
     )
     SELECT c.metric_type, c.count AS current, COALESCE(h.avg_count, 0) AS typical,
            CASE WHEN COALESCE(h.avg_count, 0) > 0
                 THEN c.count / h.avg_count ELSE 99 END AS ratio
     FROM current_hour c
     LEFT JOIN historical_avg h USING (metric_type)
     WHERE c.count > 0
       AND (h.avg_count IS NULL OR c.count > h.avg_count * 3)`,
    [tenantId],
  ).catch(() => []);

  return {
    anomalous: spikes.length > 0,
    spikes: spikes.map(s => ({
      metric: s.metric_type,
      current: Number(s.current),
      typical: Number(s.typical),
      ratio: Number(s.ratio),
    })),
  };
}
