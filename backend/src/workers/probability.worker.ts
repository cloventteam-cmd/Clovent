/**
 * Probability Worker
 *
 * Handles DEAL_STAGE_CHANGED by computing and persisting the new
 * probability value. Decoupled from the deal service so no direct
 * DB writes happen inside event handlers.
 */
import type { Job } from 'bullmq';
import { createWorker, type ProbabilityJobData } from './queue';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { DEAL_STAGE_PROBABILITIES } from '../shared/constants';
import { query } from '../db/client';

async function processProbabilityJob(job: Job<ProbabilityJobData>): Promise<void> {
  const { tenant_id, deal_id, stage } = job.data;

  const probability = DEAL_STAGE_PROBABILITIES[stage] ?? 25;

  await query(
    `UPDATE deals SET probability = $3, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2`,
    [tenant_id, deal_id, probability],
  );

  logger.info(
    { deal_id, stage, probability },
    'Probability worker: deal probability updated',
  );
}

export function startProbabilityWorker(): void {
  createWorker<ProbabilityJobData>(config.queues.probability, processProbabilityJob, 20);
  logger.info({ queue: config.queues.probability, concurrency: 20 }, 'Probability worker started');
}
