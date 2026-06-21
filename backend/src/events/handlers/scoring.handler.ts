/**
 * Scoring Event Handlers
 *
 * SCORING_REQUESTED → queue individual scoring job (triggered by activities)
 */
import { eventBus } from '../bus';
import { EventNames } from '../types';
import { logger } from '../../shared/logger';
import { queueScoringJob } from '../../workers/queue';

// ─── SCORING_REQUESTED → queue job ───────────────────────────────────────────
// Triggered by: activity creation, deal stage change, manual rescore
eventBus.on(EventNames.SCORING_REQUESTED, async (payload) => {
  logger.debug(
    { contact_id: payload.contact_id, trigger: payload.trigger },
    'Pipeline: SCORING_REQUESTED → queue',
  );

  await queueScoringJob(
    { tenant_id: payload.tenant_id, contact_id: payload.contact_id },
    payload.trigger?.includes('deal') ? 2 : 6, // deal-triggered = higher priority
  );
});
