/**
 * Prediction Worker
 *
 * Processes prediction jobs from the prediction queue.
 * Dispatches to PredictionEngine for:
 *   - 'full' → all contacts + all deals for a tenant
 *   - 'seller'/'buyer'/'reactivation' → single contact prediction
 *   - 'deal_failure' → single deal prediction
 */
import type { Job } from 'bullmq';
import { createWorker, type PredictionJobData } from './queue';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { PredictionEngine } from '../ai/predictions/engine';

export function startPredictionWorker(): void {
  createWorker<PredictionJobData>(
    config.queues.prediction,
    async (job: Job<PredictionJobData>) => {
      const { tenant_id, prediction_type, contact_id, deal_id } = job.data;

      logger.info(
        { tenant_id, prediction_type, contact_id, deal_id },
        'Prediction worker: starting job',
      );

      await job.updateProgress(5);

      const engine = new PredictionEngine(tenant_id, job.id!);

      if (prediction_type === 'full') {
        const stats = await engine.runBatch(100, (processed, total) => {
          job.updateProgress(Math.round((processed / total) * 95) + 5);
        });
        logger.info(stats, 'Prediction worker: full batch complete');
      } else if (contact_id) {
        await engine.predictContact(contact_id);
        logger.info({ contact_id, prediction_type }, 'Prediction worker: single contact complete');
      }

      await job.updateProgress(100);
    },
    2, // max 2 concurrent prediction runs (they're heavy)
  );

  logger.info({ queue: config.queues.prediction, concurrency: 2 }, 'Prediction worker started');
}
