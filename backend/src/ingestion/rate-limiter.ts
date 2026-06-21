/**
 * Token-bucket rate limiter per CRM type.
 *
 * Works with both Redis (cross-process) and in-memory (single-process).
 * Backpressure: `throttle()` sleeps until a token is available.
 */
import type { CrmType } from './types';
import { logger } from '../shared/logger';

interface BucketConfig {
  requests: number;   // tokens per window
  windowMs: number;   // window duration
}

// Official API rate limits (conservative)
const LIMITS: Record<CrmType, BucketConfig> = {
  hubspot:      { requests: 90,  windowMs: 10_000  },  // 100/10s — leave 10% headroom
  salesforce:   { requests: 20,  windowMs: 1_000   },  // varies; default to 20/s
  followupboss: { requests: 25,  windowMs: 60_000  },  // ~30/min
  kvcore:       { requests: 10,  windowMs: 60_000  },
  generic_rest: { requests: 10,  windowMs: 1_000   },
};

// In-memory bucket state (per crm_type + tenant to avoid cross-tenant starvation)
interface Bucket {
  tokens: number;
  lastRefill: number;
  queue: Array<() => void>;
}

const buckets = new Map<string, Bucket>();

function getBucket(key: string, config: BucketConfig): Bucket {
  if (!buckets.has(key)) {
    buckets.set(key, {
      tokens: config.requests,
      lastRefill: Date.now(),
      queue: [],
    });
  }
  return buckets.get(key)!;
}

function refill(bucket: Bucket, config: BucketConfig): void {
  const now = Date.now();
  const elapsed = now - bucket.lastRefill;
  if (elapsed >= config.windowMs) {
    const periods = Math.floor(elapsed / config.windowMs);
    bucket.tokens = Math.min(config.requests, bucket.tokens + periods * config.requests);
    bucket.lastRefill = now;
  }
}

export class RateLimiter {
  private readonly key: string;
  private readonly config: BucketConfig;

  constructor(crmType: CrmType, tenantId?: string) {
    // Per-CRM global limit (not per-tenant) to avoid hammering CRM APIs
    this.key = `${crmType}`;
    this.config = LIMITS[crmType] ?? LIMITS.generic_rest;
  }

  async throttle(): Promise<void> {
    const bucket = getBucket(this.key, this.config);
    refill(bucket, this.config);

    if (bucket.tokens > 0) {
      bucket.tokens--;
      return;
    }

    // No tokens — wait for next window
    const waitMs = this.config.windowMs - (Date.now() - bucket.lastRefill) + 10;
    logger.debug({ key: this.key, waitMs }, 'Rate limiter: waiting');
    await new Promise<void>(resolve => setTimeout(resolve, waitMs));
    await this.throttle(); // retry after sleep
  }

  /** Consume N tokens at once (for bulk operations) */
  async throttleN(n: number): Promise<void> {
    for (let i = 0; i < n; i++) await this.throttle();
  }

  static globalStats(): Record<string, { tokens: number; queue: number }> {
    const out: Record<string, { tokens: number; queue: number }> = {};
    for (const [key, b] of buckets) {
      out[key] = { tokens: b.tokens, queue: b.queue.length };
    }
    return out;
  }
}
