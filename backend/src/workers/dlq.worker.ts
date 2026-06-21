/**
 * Dead Letter Queue (DLQ) Worker
 *
 * Monitors all BullMQ queues for failed jobs, stores them in the
 * job_failures table, and provides automatic retry logic.
 *
 * Flow:
 *   1. Every 60s: scan all queues for newly failed jobs
 *   2. Insert into job_failures (dedup by queue+job_id)
 *   3. For jobs that haven't exceeded MAX_AUTO_RETRIES: re-queue
 *   4. For exhausted jobs: emit notification to tenant owner
 *
 * This runs INSIDE the existing worker process — no separate process needed.
 */
import { Queue } from 'bullmq';
import { query, queryMany } from '../db/client';
import { logger } from '../shared/logger';
import { config } from '../shared/config';
import { eventBus } from '../events/bus';
import { EventNames } from '../events/types';

const MAX_AUTO_RETRIES = 1; // auto-retry once before giving up
const SCAN_INTERVAL_MS = 60_000;

// All queue names to monitor
function getAllQueueNames(): string[] {
  return Object.values(config.queues);
}

function makeBullQueue(name: string) {
  const u = (() => { try { return new URL(config.redis.url); } catch { return null; } })();
  return new Queue(name, {
    connection: { host: u?.hostname || 'localhost', port: u?.port ? parseInt(u.port, 10) : 6379 },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function safeUuid(v: unknown): string | null {
  return typeof v === 'string' && UUID_RE.test(v) ? v : null;
}

async function scanAndStoreFailed(): Promise<void> {
  for (const queueName of getAllQueueNames()) {
    let q: Queue | null = null;
    try {
      q = makeBullQueue(queueName);
      const failedJobs = await q.getFailed(0, 99);

      for (const job of failedJobs) {
        const tenantId = safeUuid((job.data as any)?.tenant_id);

        try {
          await query(
            `INSERT INTO job_failures
               (queue_name, job_id, job_name, data, error, stack, attempts, max_attempts, tenant_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (queue_name, job_id) DO NOTHING`,
            [
              queueName,
              job.id!,
              job.name,
              JSON.stringify(job.data),
              job.failedReason ?? 'Unknown error',
              job.stacktrace?.join('\n')?.slice(0, 2000) ?? null,
              job.attemptsMade,
              (job.opts?.attempts ?? 3),
              tenantId,
            ],
          );
        } catch (dbErr) {
          logger.error({ dbErr, job_id: job.id }, 'DLQ: failed to store job failure');
        }
      }

      if (failedJobs.length > 0) {
        logger.debug({ queue: queueName, failed: failedJobs.length }, 'DLQ: scanned failed jobs');
      }
    } catch (err) {
      // Queue might not exist yet (in-memory mode or first boot)
      logger.debug({ queue: queueName, err: (err as Error).message }, 'DLQ: queue scan skipped');
    } finally {
      await q?.close().catch(() => {});
    }
  }
}

async function retryEligibleJobs(): Promise<void> {
  const eligible = await queryMany<{
    id: string;
    queue_name: string;
    job_id: string;
    job_name: string;
    data: unknown;
    attempts: number;
    max_attempts: number;
    tenant_id: string | null;
  }>(
    `SELECT id, queue_name, job_id, job_name, data, attempts, max_attempts, tenant_id
     FROM job_failures
     WHERE reprocessed = false
       AND attempts < $1
     ORDER BY failed_at ASC LIMIT 50`,
    [MAX_AUTO_RETRIES + 1],
  ).catch(() => []);

  for (const failure of eligible) {
    let q: Queue | null = null;
    try {
      q = makeBullQueue(failure.queue_name);
      await q.add(failure.job_name, failure.data, {
        attempts: 1,
        removeOnComplete: true,
      });

      await query(
        `UPDATE job_failures SET reprocessed = true, reprocessed_at = NOW()
         WHERE id = $1`,
        [failure.id],
      );

      logger.info(
        { queue: failure.queue_name, job: failure.job_name, failure_id: failure.id },
        'DLQ: job requeued for retry',
      );
    } catch (err) {
      logger.error({ err, failure_id: failure.id }, 'DLQ: retry failed');
    } finally {
      await q?.close().catch(() => {});
    }
  }
}

async function notifyExhaustedJobs(): Promise<void> {
  const exhausted = await queryMany<{
    id: string; queue_name: string; job_name: string; error: string; tenant_id: string | null;
  }>(
    `SELECT id, queue_name, job_name, error, tenant_id
     FROM job_failures
     WHERE reprocessed = false
       AND attempts >= max_attempts
       AND tenant_id IS NOT NULL
     ORDER BY failed_at DESC LIMIT 20`,
  ).catch(() => []);

  for (const job of exhausted) {
    if (!job.tenant_id) continue;

    try {
      await eventBus.emit(EventNames.NOTIFICATION_SEND as any, {
        tenant_id: job.tenant_id,
        user_id: 'all',
        type: 'system',
        title: `Background job failed: ${job.job_name}`,
        body: `Queue: ${job.queue_name} — ${(job.error ?? '').slice(0, 100)}`,
        data: { queue: job.queue_name, job_name: job.job_name, failure_id: job.id },
        channels: ['in_app'],
        occurred_at: new Date(),
      });

      // Mark as reprocessed so we don't re-notify
      await query('UPDATE job_failures SET reprocessed = true WHERE id = $1', [job.id]);
    } catch (err) {
      logger.error({ err, job_id: job.id }, 'DLQ: notification failed');
    }
  }
}

let scanInterval: NodeJS.Timeout | null = null;

export function startDlqWorker(): void {
  const run = async () => {
    try {
      await scanAndStoreFailed();
      await retryEligibleJobs();
      await notifyExhaustedJobs();
    } catch (err) {
      logger.error({ err }, 'DLQ worker: scan cycle error');
    }
  };

  // Run once immediately, then every SCAN_INTERVAL_MS
  run();
  scanInterval = setInterval(run, SCAN_INTERVAL_MS);

  logger.info({ interval_ms: SCAN_INTERVAL_MS }, 'DLQ worker started');
}

export function stopDlqWorker(): void {
  if (scanInterval) { clearInterval(scanInterval); scanInterval = null; }
}
