import { createWorker, type DealRiskJobData } from './queue';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { DealRiskTracker } from '../modules/deal-risk/tracker';

export function startDealRiskWorker(): void {
  createWorker<DealRiskJobData>(
    config.queues.dealRisk,
    async (job) => {
      const { tenant_id, deal_id } = job.data;
      const tracker = new DealRiskTracker(tenant_id);
      await tracker.analyze(deal_id);
      logger.debug({ deal_id }, 'Deal risk analysis complete');
    },
    5,
  );

  logger.info('Deal risk worker started');
}
