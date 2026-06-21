import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { withRetry, isPgRetryable } from '../shared/retry';
import { dbBreaker } from '../shared/circuit-breaker';
import { getCorrelationId } from '../observability/correlation';

const pool = new Pool({
  connectionString: config.db.url,
  min: config.db.poolMin,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'PostgreSQL pool error');
});

pool.on('connect', () => {
  logger.debug('PostgreSQL pool: new client connected');
});

export async function query<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const start = Date.now();
  const cid = getCorrelationId();

  return dbBreaker.call(() =>
    withRetry(
      () => pool.query<T>(sql, params),
      {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 2_000,
        jitter: true,
        retryable: isPgRetryable,
        onRetry: (attempt, err) =>
          logger.warn({ attempt, sql: sql.slice(0, 80), cid, err: (err as Error).message }, 'DB query retry'),
      },
    ).then(result => {
      const duration = Date.now() - start;
      if (duration > 500) logger.warn({ duration_ms: duration, sql: sql.slice(0, 120), cid }, 'Slow query');
      return result;
    })
  );
}

export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function queryOne<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T | null> {
  const result = await query<T>(sql, params);
  return result.rows[0] ?? null;
}

export async function queryMany<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await query<T>(sql, params);
  return result.rows;
}

export async function healthCheck(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export { pool };
