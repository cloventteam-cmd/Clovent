/**
 * Internal Error Tracker
 *
 * Stores errors in the error_events table with deduplication by fingerprint.
 * No external dependency (Sentry, Datadog, etc.) required.
 *
 * Features:
 *   - Fingerprinting: identical errors are counted, not duplicated
 *   - Context: tenant_id, correlation_id, source tagged on every error
 *   - Threshold alerting: emits notification when error count crosses threshold
 */
import crypto from 'crypto';
import { query, queryOne } from '../db/client';
import { logger } from '../shared/logger';
import { getContext } from './correlation';

const ALERT_THRESHOLD = 10; // fire notification after N occurrences

function fingerprint(err: Error | unknown): string {
  const e = err instanceof Error ? err : new Error(String(err));
  const raw = `${e.constructor.name}:${e.message.slice(0, 200)}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export async function trackError(
  err: Error | unknown,
  context: Record<string, unknown> = {},
  source?: string,
): Promise<void> {
  const e = err instanceof Error ? err : new Error(String(err));
  const fp = fingerprint(e);
  const ctx = getContext();

  const merged = {
    ...context,
    correlation_id: ctx?.correlationId,
    user_id: ctx?.userId,
  };

  try {
    const result = await query<{ count: number; id: string }>(
      `INSERT INTO error_events
         (fingerprint, type, message, stack, context, tenant_id, source, count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1)
       ON CONFLICT (fingerprint)
       DO UPDATE SET
         count      = error_events.count + 1,
         last_seen_at = NOW(),
         context    = EXCLUDED.context
       RETURNING count, id`,
      [
        fp,
        e.constructor.name,
        e.message,
        e.stack ?? null,
        JSON.stringify(merged),
        ctx?.tenantId ?? null,
        source ?? ctx?.source ?? 'unknown',
      ],
    );

    const row = result.rows[0];

    // Alert on threshold cross
    if (row && row.count === ALERT_THRESHOLD) {
      logger.warn(
        { error_id: row.id, type: e.constructor.name, message: e.message, count: row.count },
        `ErrorTracker: error exceeded threshold (${ALERT_THRESHOLD} occurrences)`,
      );
    }
  } catch (dbErr) {
    // Never let error tracking break the app
    logger.error({ dbErr, originalErr: e.message }, 'ErrorTracker: failed to persist error');
  }
}

export async function getActiveErrors(limit = 50): Promise<Array<{
  id: string; type: string; message: string; count: number;
  source: string; last_seen_at: Date; first_seen_at: Date;
}>> {
  const { queryMany } = await import('../db/client');
  return queryMany(
    `SELECT id, type, message, count, source, last_seen_at, first_seen_at
     FROM error_events
     WHERE resolved = false
     ORDER BY last_seen_at DESC LIMIT $1`,
    [limit],
  ) as any;
}

export async function resolveError(id: string): Promise<void> {
  await query('UPDATE error_events SET resolved = true WHERE id = $1', [id]);
}
