import { createWorker, type ImportJobData } from './queue';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { acquireSlot, releaseSlot, checkWorkerQuota, computeBackpressureDelay } from '../billing/tenant-throttle';
import { trackUsage } from '../billing/usage-tracker';
import { eventBus } from '../events/bus';
import { EventNames } from '../events/types';
import { ImportEngine } from '../imports/engine';
import { findImportById, updateImportStatus, updateImportStats } from '../db/repositories/imports';

export function startImportWorker(): void {
  createWorker<ImportJobData>(
    config.queues.import,
    async (job) => {
      const { tenant_id, import_id, user_id } = job.data;

      // Per-tenant concurrency + rate enforcement
      const slot = await acquireSlot(job, config.queues.import, tenant_id);
      if (!slot.allowed) {
        // Backpressure: requeue with delay instead of failing
        logger.warn({ import_id, reason: slot.reason }, 'Import worker: concurrency limit — requeueing');
        await new Promise(r => setTimeout(r, 30_000));
        throw new Error(`Concurrency limit: ${slot.reason}`);
      }

      // Apply backpressure delay if tenant is burning through hourly quota
      const quota = await checkWorkerQuota(tenant_id);
      const delay = computeBackpressureDelay(quota.pct);
      if (delay > 0) {
        logger.debug({ tenant_id, pct: quota.pct.toFixed(1), delay }, 'Import worker: backpressure delay');
        await new Promise(r => setTimeout(r, delay));
      }

      logger.info({ import_id }, 'Import worker: starting job');

      const importRecord = await findImportById(tenant_id, import_id);
      if (!importRecord) throw new Error(`Import ${import_id} not found`);

      await updateImportStatus(tenant_id, import_id, 'committing', {
        started_at: new Date(),
        job_id: job.id!,
      });

      const engine = new ImportEngine(tenant_id, importRecord);

      try {
        const stats = await engine.commit((progress) => {
          job.updateProgress(progress);
        });

        await updateImportStats(tenant_id, import_id, stats);

        await eventBus.emit(EventNames.IMPORT_COMPLETED, {
          tenant_id,
          import_id,
          stats,
        });

        // Track ingestion records for billing quota
        trackUsage(tenant_id, 'worker_jobs');
        if (stats.created || stats.updated) {
          trackUsage(tenant_id, 'ingestion_records', (stats.created ?? 0) + (stats.updated ?? 0));
        }

        logger.info({ import_id, stats }, 'Import worker: completed');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ import_id, err }, 'Import worker: failed');

        await eventBus.emit(EventNames.IMPORT_FAILED, {
          tenant_id,
          import_id,
          error: message,
        });

        throw err;
      } finally {
        await releaseSlot(config.queues.import, tenant_id);
      }
    },
    2, // max 2 concurrent import jobs
  );

  logger.info('Import worker started');
}
