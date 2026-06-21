/**
 * Per-Tenant Worker Throttle
 *
 * Prevents any single tenant from overwhelming the BullMQ queues.
 * Applied inside workers BEFORE processing a job.
 *
 * Strategy:
 *   - Track active job count per tenant in Redis (with TTL)
 *   - If tenant is at their concurrent limit → delay job (requeue with backoff)
 *   - If tenant's hourly job count is near limit → lower priority
 *
 * This ensures a high-volume Enterprise tenant can't starve Starter tenants.
 */
import type { Job } from 'bullmq';
import { getLimits, getPlan, type PlanId } from './plans';
import { getUsage, getTenantPlan, trackUsage } from './usage-tracker';
import { logger } from '../shared/logger';
import { redisConnection } from '../workers/queue';

const TTL_SECONDS = 3600; // 1 hour key TTL

function activeKey(tenantId: string, queueName: string): string {
  return `clovent:throttle:active:${queueName}:${tenantId}`;
}

function hourlyKey(tenantId: string): string {
  const hour = new Date().toISOString().slice(0, 13);
  return `clovent:throttle:hourly:${tenantId}:${hour}`;
}

// Call at start of job processing
export async function acquireSlot(
  job: Job,
  queueName: string,
  tenantId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  try {
    const planId    = await getTenantPlan(tenantId) as PlanId;
    const limits    = getLimits(planId);
    const maxSlots  = queueName.includes('import')
      ? limits.max_concurrent_imports
      : queueName.includes('prediction')
      ? limits.max_concurrent_predictions
      : limits.max_concurrent_imports; // default

    const key = activeKey(tenantId, queueName);

    // Atomic increment + check
    const count = await redisConnection.incr(key);
    await redisConnection.expire(key, TTL_SECONDS);

    if (count > maxSlots) {
      // Over limit — release slot and signal retry
      await redisConnection.decr(key);
      return {
        allowed: false,
        reason: `Concurrency limit: ${count - 1}/${maxSlots} active ${queueName} jobs`,
      };
    }

    // Track hourly worker job count for billing
    const hKey = hourlyKey(tenantId);
    await redisConnection.incr(hKey);
    await redisConnection.expire(hKey, TTL_SECONDS + 300);

    return { allowed: true };
  } catch {
    // Redis unavailable — allow the job (fail open)
    return { allowed: true };
  }
}

// Call when job completes or fails
export async function releaseSlot(queueName: string, tenantId: string): Promise<void> {
  try {
    const key = activeKey(tenantId, queueName);
    const n = await redisConnection.decr(key);
    if (n < 0) await redisConnection.set(key, '0', 'EX', TTL_SECONDS);
  } catch { /* ignore */ }
}

// Get current active slot count for a tenant (for monitoring)
export async function getActiveSlots(tenantId: string, queueName: string): Promise<number> {
  try {
    const val = await redisConnection.get(activeKey(tenantId, queueName));
    return parseInt(val ?? '0', 10);
  } catch {
    return 0;
  }
}

// Check if tenant's hourly worker job rate is approaching limit
export async function checkWorkerQuota(tenantId: string): Promise<{
  current: number;
  limit: number;
  pct: number;
  throttle: boolean;
}> {
  try {
    const planId = await getTenantPlan(tenantId) as PlanId;
    const limit  = getLimits(planId).worker_jobs_per_hour;

    const hKey   = hourlyKey(tenantId);
    const val    = await redisConnection.get(hKey);
    const current = parseInt(val ?? '0', 10);
    const pct    = (current / limit) * 100;

    return {
      current,
      limit,
      pct,
      // Throttle (add delay) when above 90% of hourly job quota
      throttle: pct >= 90,
    };
  } catch {
    return { current: 0, limit: 1000, pct: 0, throttle: false };
  }
}

// Compute a delay (ms) to add to a job when tenant is under rate pressure
// This creates natural backpressure without hard-blocking
export function computeBackpressureDelay(pct: number): number {
  if (pct < 70) return 0;
  if (pct < 80) return 500;
  if (pct < 90) return 2_000;
  if (pct < 95) return 5_000;
  return 15_000; // near limit: significant delay to let quota reset
}
