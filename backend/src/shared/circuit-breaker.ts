/**
 * Simple circuit breaker.
 *
 * States: CLOSED (normal) → OPEN (failing) → HALF_OPEN (probing)
 *
 * Use it around external calls (DB, Redis, CRM APIs) to fast-fail
 * instead of piling up requests when the dependency is down.
 */
import { logger } from './logger';

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreakerOptions {
  name: string;
  failureThreshold: number;   // open after N consecutive failures
  successThreshold: number;   // close after N consecutive successes in HALF_OPEN
  timeoutMs: number;          // stay OPEN for N ms before probing
}

export class CircuitBreaker {
  private state: State = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private openedAt?: number;
  private readonly opts: CircuitBreakerOptions;

  constructor(opts: Partial<CircuitBreakerOptions> & { name: string }) {
    this.opts = {
      failureThreshold: 5,
      successThreshold: 2,
      timeoutMs: 30_000,
      ...opts,
    };
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - (this.openedAt ?? 0);
      if (elapsed < this.opts.timeoutMs) {
        throw new Error(`Circuit breaker OPEN: ${this.opts.name} (retry in ${Math.round((this.opts.timeoutMs - elapsed) / 1000)}s)`);
      }
      this.state = 'HALF_OPEN';
      this.successes = 0;
      logger.info({ circuit: this.opts.name }, 'Circuit breaker: probing (HALF_OPEN)');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this.state === 'HALF_OPEN') {
      this.successes++;
      if (this.successes >= this.opts.successThreshold) {
        this.state = 'CLOSED';
        logger.info({ circuit: this.opts.name }, 'Circuit breaker: CLOSED (recovered)');
      }
    }
  }

  private onFailure(err?: unknown): void {
    // Only trip on infrastructure failures, not application-level errors
    // (invalid UUID, constraint violations, etc. should not open the circuit)
    if (!this.isInfrastructureError(err)) return;

    this.failures++;
    if (this.state === 'HALF_OPEN' || this.failures >= this.opts.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      logger.warn(
        { circuit: this.opts.name, failures: this.failures },
        'Circuit breaker: OPEN (tripped)',
      );
    }
  }

  private isInfrastructureError(err: unknown): boolean {
    if (!err) return true;
    const code = (err as any)?.code as string | undefined;
    const msg  = ((err as Error)?.message ?? '').toLowerCase();

    // Postgres infrastructure codes
    const infraCodes = new Set(['08000','08003','08006','08001','53300','57P03','40001','40P01']);
    if (code && infraCodes.has(code)) return true;

    // Connection-level messages
    if (msg.includes('connect') || msg.includes('timeout') || msg.includes('econnrefused')) return true;

    // Application-level errors (22P02 = invalid UUID, 23xxx = constraint, etc.) → don't trip
    return false;
  }

  getState(): State { return this.state; }
  getFailures(): number { return this.failures; }
  reset(): void { this.state = 'CLOSED'; this.failures = 0; this.successes = 0; }
}

// Shared breakers for core dependencies
export const dbBreaker    = new CircuitBreaker({ name: 'postgres', failureThreshold: 5, timeoutMs: 15_000 });
export const redisBreaker = new CircuitBreaker({ name: 'redis',    failureThreshold: 3, timeoutMs: 10_000 });
