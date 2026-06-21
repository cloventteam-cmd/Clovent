/**
 * Retry utility with exponential backoff + jitter.
 *
 * Used by DB client and Redis reconnect logic.
 * Retryable errors are identified by code/message patterns.
 */
import { logger } from './logger';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  retryable?: (err: unknown) => boolean;
  onRetry?: (attempt: number, err: unknown) => void;
}

const DEFAULT_OPTS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  jitter: true,
};

function computeDelay(attempt: number, opts: RetryOptions): number {
  const exp = Math.min(opts.baseDelayMs * 2 ** (attempt - 1), opts.maxDelayMs);
  return opts.jitter ? exp * (0.5 + Math.random() * 0.5) : exp;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const o = { ...DEFAULT_OPTS, ...opts };

  for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === o.maxAttempts;
      const canRetry = o.retryable ? o.retryable(err) : true;

      if (isLast || !canRetry) throw err;

      const delay = computeDelay(attempt, o);
      o.onRetry?.(attempt, err);

      logger.debug(
        { attempt, maxAttempts: o.maxAttempts, delay_ms: Math.round(delay) },
        'Retrying after error',
      );

      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('withRetry: unreachable'); // appease TypeScript
}

// Postgres transient error codes that are safe to retry
const PG_RETRYABLE_CODES = new Set([
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '53300', // too_many_connections
  '57P03', // cannot_connect_now
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

export function isPgRetryable(err: unknown): boolean {
  const code = (err as any)?.code as string | undefined;
  if (!code) return false;
  return PG_RETRYABLE_CODES.has(code);
}

// Redis transient errors
export function isRedisRetryable(err: unknown): boolean {
  const msg = (err as Error)?.message?.toLowerCase() ?? '';
  return msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('timeout');
}
