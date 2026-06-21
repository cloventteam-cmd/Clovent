/**
 * Queue system with Redis/BullMQ primary and in-memory fallback.
 *
 * If Redis is unreachable, all workers run as in-process async processors —
 * jobs execute immediately in the local event loop instead of via BullMQ.
 * The external API (queueXxxJob, createWorker) is identical in both modes.
 */
import { Queue, Worker, type Job, type Processor, type ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../shared/config';
import { logger } from '../shared/logger';

// ─── Redis connection (for pub/sub + direct use) ──────────────────────────────
export const redisConnection = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

let redisAvailable = false;

redisConnection.on('error', () => { /* silenced — availability tracked below */ });
redisConnection.on('ready', () => {
  if (!redisAvailable) logger.info('Redis connected — queue mode: BullMQ');
  redisAvailable = true;
});

// Parse Redis URL into BullMQ-compatible ConnectionOptions (avoids duplicate-ioredis type clash)
function bullConnection(): ConnectionOptions {
  try {
    const u = new URL(config.redis.url);
    return {
      host: u.hostname || 'localhost',
      port: u.port ? parseInt(u.port, 10) : 6379,
      password: u.password || undefined,
      tls: u.protocol === 'rediss:' ? {} : undefined,
    } as ConnectionOptions;
  } catch {
    return { host: 'localhost', port: 6379 } as ConnectionOptions;
  }
}

// ─── In-memory queue fallback ─────────────────────────────────────────────────
// Used when Redis is unavailable. Jobs run directly in the local event loop.
type AnyProcessor = Processor<unknown>;

class InMemoryQueue {
  private processor: AnyProcessor | null = null;
  private counter = 0;

  attach(p: AnyProcessor) { this.processor = p; }

  async add(_name: string, data: unknown): Promise<{ id: string }> {
    const id = String(++this.counter);
    if (this.processor) {
      setImmediate(async () => {
        try {
          await this.processor!({ data, id } as Job<unknown>, {} as any);
        } catch (err) {
          logger.error({ err, queueJob: id }, 'In-memory job error');
        }
      });
    }
    return { id };
  }

  async addBulk(jobs: Array<{ name: string; data: unknown }>): Promise<void> {
    for (const j of jobs) await this.add(j.name, j.data);
  }

  async getWaitingCount() { return 0; }
  async getActiveCount() { return 0; }
  async getFailedCount() { return 0; }
}

// ─── Queue registry ───────────────────────────────────────────────────────────
const bullQueues = new Map<string, Queue>();
const memQueues = new Map<string, InMemoryQueue>();

function getBullQueue(name: string): Queue {
  if (!bullQueues.has(name)) {
    bullQueues.set(name, new Queue(name, {
      connection: bullConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    }));
  }
  return bullQueues.get(name)!;
}

function getMemQueue(name: string): InMemoryQueue {
  if (!memQueues.has(name)) memQueues.set(name, new InMemoryQueue());
  return memQueues.get(name)!;
}

async function enqueue(name: string, jobName: string, data: unknown, opts?: object): Promise<string> {
  if (redisAvailable) {
    const job = await getBullQueue(name).add(jobName, data, opts ?? {});
    return job.id ?? '';
  }
  const { id } = await getMemQueue(name).add(jobName, data);
  return id;
}

async function enqueueBulk(name: string, jobs: Array<{ name: string; data: unknown; opts?: object }>): Promise<void> {
  if (redisAvailable) {
    await getBullQueue(name).addBulk(jobs);
  } else {
    for (const j of jobs) await getMemQueue(name).add(j.name, j.data);
  }
}

// ─── Worker factory ───────────────────────────────────────────────────────────
export function createWorker<T = unknown>(
  queueName: string,
  processor: Processor<T>,
  concurrency = 5,
): Worker<T> | InMemoryQueue {
  if (redisAvailable) {
    const worker = new Worker<T>(queueName, processor, {
      connection: bullConnection(),
      concurrency,
    });
    worker.on('completed', (job) => logger.debug({ queue: queueName, job: job.id }, 'Job completed'));
    worker.on('failed', (job, err) => logger.error({ queue: queueName, job: job?.id, err }, 'Job failed'));
    worker.on('stalled', (jobId) => logger.warn({ queue: queueName, jobId }, 'Job stalled'));
    return worker;
  }
  // In-memory mode: attach processor to in-memory queue
  const q = getMemQueue(queueName);
  q.attach(processor as unknown as AnyProcessor);
  logger.debug({ queue: queueName }, 'In-memory worker attached');
  return q;
}

// ─── Probe Redis (called once during bootstrap) ───────────────────────────────
export async function probeRedis(): Promise<boolean> {
  try {
    await redisConnection.connect();
    await redisConnection.ping();
    redisAvailable = true;
    logger.info('Redis available — using BullMQ queues');
    return true;
  } catch {
    redisAvailable = false;
    logger.warn('Redis unavailable — using in-memory queues (single-process mode)');
    return false;
  }
}

// ─── Job interfaces ───────────────────────────────────────────────────────────
export interface ScoringJobData     { tenant_id: string; contact_id: string }
export interface EmbeddingJobData   { tenant_id: string; entity_type: string; entity_id: string; content: string }
export interface ImportJobData      { tenant_id: string; import_id: string; user_id?: string }
export interface OpportunityJobData { tenant_id: string; contact_id?: string }
export interface CampaignJobData    { tenant_id: string; campaign_id: string; contact_id: string; step: number }
export interface DealRiskJobData    { tenant_id: string; deal_id: string }
export interface ProbabilityJobData { tenant_id: string; deal_id: string; stage: string }
// Imported from ingestion/types to avoid circular dep
export interface CrmSyncJobData {
  tenant_id: string;
  credential_id: string;
  crm_type: string;
  sync_type: 'full' | 'incremental' | 'webhook';
  entity_types: ('contacts' | 'deals')[];
  log_id?: string;
}

export interface PredictionJobData {
  tenant_id: string;
  prediction_type: 'full' | 'seller' | 'buyer' | 'reactivation' | 'deal_failure';
  contact_id?: string;
  deal_id?: string;
}

export interface NotificationJobData {
  tenant_id: string; user_id: string; type: string; title: string;
  body?: string; data?: Record<string, unknown>;
  entity_type?: string; entity_id?: string; channels: string[];
}

// ─── Job producers ────────────────────────────────────────────────────────────
export async function queueScoringJob(data: ScoringJobData, priority?: number): Promise<void> {
  await enqueue(config.queues.scoring, 'score-contact', data, { priority: priority ?? 5 });
}

export async function queueEmbeddingJob(data: EmbeddingJobData): Promise<void> {
  await enqueue(config.queues.embedding, 'embed', data,
    { jobId: `embed-${data.entity_type}-${data.entity_id}` });
}

export async function queueImportJob(data: ImportJobData): Promise<string> {
  return enqueue(config.queues.import, 'process-import', data);
}

export async function queueOpportunityJob(data: OpportunityJobData): Promise<void> {
  await enqueue(config.queues.opportunity, 'scan-opportunities', data);
}

export async function queueCampaignStepJob(data: CampaignJobData, delayMs = 0): Promise<void> {
  await enqueue(config.queues.campaign, 'execute-step', data, {
    delay: delayMs,
    jobId: `campaign-${data.campaign_id}-${data.contact_id}-step-${data.step}`,
  });
}

export async function queueDealRiskJob(data: DealRiskJobData): Promise<void> {
  await enqueue(config.queues.dealRisk, 'analyze-risk', data);
}

export async function queueProbabilityJob(data: ProbabilityJobData): Promise<void> {
  await enqueue(config.queues.probability, 'update-probability', data, { priority: 1 });
}

export async function queueNotificationJob(data: NotificationJobData): Promise<void> {
  await enqueue(config.queues.notification, 'send-notification', data);
}

export async function queuePredictionJob(data: PredictionJobData): Promise<string> {
  return enqueue(config.queues.prediction, 'run-prediction', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 60_000 },
  });
}

export async function queueCrmSyncJob(data: CrmSyncJobData): Promise<string> {
  return enqueue(config.queues.crmSync, 'crm-sync', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 30_000 },
  });
}

export async function queueBatchScoringJob(tenantId: string, contactIds: string[]): Promise<void> {
  const jobs = contactIds.map(id => ({
    name: 'score-contact',
    data: { tenant_id: tenantId, contact_id: id },
  }));
  await enqueueBulk(config.queues.scoring, jobs);
}

// ─── Health check ─────────────────────────────────────────────────────────────
export async function getQueueStats(): Promise<Record<string, { waiting: number; active: number; failed: number; mode: string }>> {
  const stats: Record<string, { waiting: number; active: number; failed: number; mode: string }> = {};
  if (!redisAvailable) {
    for (const name of Object.values(config.queues)) {
      stats[name] = { waiting: 0, active: 0, failed: 0, mode: 'in-memory' };
    }
    return stats;
  }
  for (const [name, queue] of bullQueues) {
    const [waiting, active, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getFailedCount(),
    ]);
    stats[name] = { waiting, active, failed, mode: 'bullmq' };
  }
  return stats;
}
