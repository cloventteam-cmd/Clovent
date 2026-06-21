/**
 * CRM Sync Worker
 *
 * Processes CRM sync jobs from the crm-sync BullMQ queue.
 * Each job syncs one CRM credential for one tenant.
 *
 * Backpressure design:
 *   - Concurrency = 5 (max 5 simultaneous syncs)
 *   - Each sync respects per-CRM rate limits internally
 *   - Large syncs (10k+ records) stream through batch emissions
 *     so no single job blocks the queue for other tenants
 */
import { createWorker } from './queue';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { syncEngine } from '../ingestion/sync-engine';
import type { CrmSyncJobData } from '../ingestion/types';

export function startCrmSyncWorker(): void {
  createWorker<CrmSyncJobData>(
    config.queues.crmSync,
    async (job) => {
      const { tenant_id, credential_id, crm_type, sync_type, entity_types, log_id } = job.data;

      logger.info(
        { tenant_id, credential_id, crm_type, sync_type, entities: entity_types },
        'CRM sync worker: starting job',
      );

      await job.updateProgress(5);

      const result = await syncEngine.run({
        tenantId: tenant_id,
        credentialId: credential_id,
        syncType: sync_type,
        entityTypes: entity_types,
        logId: log_id,
      });

      await job.updateProgress(100);

      if (!result.success) {
        throw new Error(`CRM sync failed for ${crm_type} credential ${credential_id}`);
      }

      logger.info(
        { tenant_id, crm_type, fetched: result.stats.fetched, batches: result.stats.batches },
        'CRM sync worker: job complete',
      );
    },
    5, // max 5 concurrent sync jobs
  );

  logger.info({ queue: config.queues.crmSync, concurrency: 5 }, 'CRM sync worker started');
}
