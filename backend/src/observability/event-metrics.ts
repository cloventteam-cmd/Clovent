/**
 * Event Metrics — In-memory counters flushed to DB every 60s.
 *
 * Tracks per-tenant, per-event-type counts.
 * Zero latency impact: all increments are synchronous Map operations.
 * DB flush is async and non-blocking.
 *
 * Data exposed at GET /health/metrics and GET /api/observability/metrics
 */
import { query } from '../db/client';
import { logger } from '../shared/logger';

// key = "<tenant_id>|||<event_name>|||<hour_bucket>" — pipe delimiter avoids colon conflict with ISO timestamps
const counters = new Map<string, number>();

// Throughput tracker (events in last 60s — sliding window)
const recentEvents: Array<{ name: string; tenantId?: string; ts: number }> = [];
const WINDOW_MS = 60_000;

function hourBucket(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

export function incrementEvent(eventName: string, tenantId?: string): void {
  if (tenantId) {
    const key = `${tenantId}|||${eventName}|||${hourBucket()}`;
    counters.set(key, (counters.get(key) ?? 0) + 1);
  }
  // Always track in recent window for throughput
  recentEvents.push({ name: eventName, tenantId, ts: Date.now() });
}

export function getRealtimeStats(): {
  events_per_minute: number;
  top_events: Array<{ name: string; count: number }>;
  top_tenants: Array<{ tenant_id: string; count: number }>;
} {
  const cutoff = Date.now() - WINDOW_MS;
  const recent = recentEvents.filter(e => e.ts >= cutoff);

  const byName = new Map<string, number>();
  const byTenant = new Map<string, number>();

  for (const e of recent) {
    byName.set(e.name, (byName.get(e.name) ?? 0) + 1);
    if (e.tenantId) byTenant.set(e.tenantId, (byTenant.get(e.tenantId) ?? 0) + 1);
  }

  return {
    events_per_minute: recent.length,
    top_events: [...byName.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([name, count]) => ({ name, count })),
    top_tenants: [...byTenant.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([tenant_id, count]) => ({ tenant_id, count })),
  };
}

export function getCounterSnapshot(): Array<{
  tenant_id: string; event_name: string; period_start: string; count: number;
}> {
  return [...counters.entries()].map(([key, count]) => {
    const [tenant_id, event_name, period_start] = key.split('|||');
    return { tenant_id, event_name, period_start, count };
  });
}

// ── DB flush (called every 60s by the health cron) ────────────────────────────
export async function flushMetricsToDB(): Promise<void> {
  if (counters.size === 0) return;

  // Prune old entries from recentEvents
  const cutoff = Date.now() - WINDOW_MS;
  while (recentEvents.length > 0 && recentEvents[0].ts < cutoff) {
    recentEvents.shift();
  }

  const snapshot = [...counters.entries()];
  counters.clear(); // clear before async work to avoid re-flushing

  for (const [key, count] of snapshot) {
    try {
      const [tenant_id, event_name, period_start] = key.split('|||');
      await query(
        `INSERT INTO event_metrics (tenant_id, event_name, period_start, count, updated_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (tenant_id, event_name, period_start)
         DO UPDATE SET count = event_metrics.count + EXCLUDED.count, updated_at = NOW()`,
        [tenant_id, event_name, period_start, count],
      );
    } catch (err) {
      logger.error({ err, key, count }, 'EventMetrics: flush error');
    }
  }
}

export async function getMetricsForTenant(
  tenantId: string,
  hours = 24,
): Promise<Array<{ event_name: string; period_start: string; count: number }>> {
  const { queryMany } = await import('../db/client');
  return queryMany(
    `SELECT event_name, period_start::text, count
     FROM event_metrics
     WHERE tenant_id = $1 AND period_start >= NOW() - ($2 || ' hours')::interval
     ORDER BY period_start DESC, count DESC`,
    [tenantId, hours],
  );
}
