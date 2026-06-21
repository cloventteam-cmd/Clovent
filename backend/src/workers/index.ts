/**
 * Worker registry — all BullMQ workers started in this process.
 * DLQ worker also started here (it's a setInterval, not a BullMQ worker).
 */
import { startImportWorker } from './import.worker';
import { startScoringWorker } from './scoring.worker';
import { startEmbeddingWorker } from './embedding.worker';
import { startNotificationWorker } from './notification.worker';
import { startOpportunityWorker } from './opportunity.worker';
import { startCampaignWorker } from './campaign.worker';
import { startDealRiskWorker } from './deal-risk.worker';
import { startProbabilityWorker } from './probability.worker';
import { startCrmSyncWorker } from './crm-sync.worker';
import { startDlqWorker } from './dlq.worker';
import { startPredictionWorker } from './prediction.worker';
import { logger } from '../shared/logger';

export function startAllWorkers(): void {
  // Downstream workers first so events never queue unhandled
  startNotificationWorker();  // always-on sink
  startProbabilityWorker();   // fast probability updates
  startDealRiskWorker();      // deal risk analysis
  startOpportunityWorker();   // opportunity detection
  startScoringWorker();       // 6-dimension scoring → triggers opportunity
  startEmbeddingWorker();     // pgvector embedding
  startCampaignWorker();      // campaign sequences
  startImportWorker();        // file imports (slowest)
  startCrmSyncWorker();       // CRM background sync (Phase 2)
  startDlqWorker();           // dead letter queue monitor (Phase 3)
  startPredictionWorker();    // AI prediction engine (Phase 4)

  logger.info(
    { workers: 11 },
    'All workers started: notification, probability, deal-risk, opportunity, scoring, embedding, campaign, import, crm-sync, dlq, prediction',
  );
}
