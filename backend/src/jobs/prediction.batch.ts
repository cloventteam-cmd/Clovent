/**
 * Nightly Prediction Batch Job
 *
 * Runs per-tenant at 2 AM local time. For each tenant:
 *   1. Run full prediction batch across all active contacts
 *   2. Update deal failure predictions
 *   3. Emit PREDICTION_BATCH_COMPLETED event
 *   4. Feed results to opportunity engine
 *   5. Refresh AI business operator briefing
 *
 * Designed for 100k+ tenants:
 *   - Processes tenants sequentially to bound memory usage
 *   - Per-tenant contact batches of 100 for safety
 *   - Async batch run with graceful error isolation per tenant
 */
import { PredictionEngine } from '../ai/predictions/engine';
import { getTenantsForPrediction } from '../ai/predictions/behavioral-store';
import { eventBus } from '../events/bus';
import { EventNames } from '../events/types';
import { logger } from '../shared/logger';
import { uuid } from '../shared/utils';
import type { UUID } from '../shared/types';

export async function runPredictionBatch(options: {
  tenantId?: UUID;        // run for single tenant only (for manual triggers)
  batchSize?: number;
  dryRun?: boolean;
} = {}): Promise<{
  tenants_processed: number;
  contacts_processed: number;
  predictions_created: number;
  high_prob_signals: number;
  duration_ms: number;
  errors: Array<{ tenant_id: string; error: string }>;
}> {
  const jobRunId = uuid();
  const start = Date.now();
  const errors: Array<{ tenant_id: string; error: string }> = [];

  let tenantsProcessed = 0;
  let totalContacts = 0;
  let totalPredictions = 0;
  let totalHighProb = 0;

  logger.info(
    { job_run: jobRunId, dry_run: options.dryRun ?? false },
    'PredictionBatch: starting nightly run',
  );

  // Determine which tenants to process
  const tenants = options.tenantId
    ? [{ id: options.tenantId, contact_count: 0 }]
    : await getTenantsForPrediction();

  logger.info({ tenant_count: tenants.length }, 'PredictionBatch: tenants queued');

  for (const tenant of tenants) {
    const tenantStart = Date.now();

    try {
      if (options.dryRun) {
        logger.info({ tenant_id: tenant.id }, 'PredictionBatch: [DRY RUN] would process tenant');
        tenantsProcessed++;
        continue;
      }

      const engine = new PredictionEngine(tenant.id, jobRunId);

      const stats = await engine.runBatch(
        options.batchSize ?? 100,
        (processed, total) => {
          if (processed % 500 === 0) {
            logger.debug(
              { tenant_id: tenant.id, processed, total },
              'PredictionBatch: progress',
            );
          }
        },
      );

      totalContacts    += stats.contacts_processed;
      totalPredictions += stats.predictions_created;
      totalHighProb    += stats.high_prob_count;
      tenantsProcessed++;

      const tenantDuration = Date.now() - tenantStart;
      logger.info(
        {
          tenant_id: tenant.id,
          contacts:  stats.contacts_processed,
          high_prob: stats.high_prob_count,
          duration_ms: tenantDuration,
        },
        'PredictionBatch: tenant complete',
      );

      // Emit per-tenant completion event
      await eventBus.emit(EventNames.PREDICTION_BATCH_COMPLETED as any, {
        tenant_id: tenant.id,
        job_run_id: jobRunId,
        contacts_processed: stats.contacts_processed,
        predictions_created: stats.predictions_created,
        high_prob_count: stats.high_prob_count,
        duration_ms: tenantDuration,
      });

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, tenant_id: tenant.id }, 'PredictionBatch: tenant failed');
      errors.push({ tenant_id: tenant.id, error: message });
    }
  }

  const duration = Date.now() - start;

  logger.info(
    {
      job_run: jobRunId,
      tenants: tenantsProcessed,
      contacts: totalContacts,
      predictions: totalPredictions,
      high_prob: totalHighProb,
      errors: errors.length,
      duration_ms: duration,
    },
    'PredictionBatch: nightly run complete',
  );

  return {
    tenants_processed: tenantsProcessed,
    contacts_processed: totalContacts,
    predictions_created: totalPredictions,
    high_prob_signals: totalHighProb,
    duration_ms: duration,
    errors,
  };
}
