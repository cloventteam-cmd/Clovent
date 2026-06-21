/**
 * Activity Event Handlers
 *
 * ACTIVITY_CREATED → emit SCORING_REQUESTED (so every touchpoint updates scores)
 */
import { eventBus } from '../bus';
import { EventNames } from '../types';
import { logger } from '../../shared/logger';
import { queueEmbeddingJob } from '../../workers/queue';
import { queryOne } from '../../db/client';

eventBus.on(EventNames.ACTIVITY_CREATED, async (payload) => {
  const { tenant_id, contact_id, deal_id, activity_type, activity_id } = payload;

  logger.debug({ activity_id, activity_type, contact_id }, 'Pipeline: ACTIVITY_CREATED');

  // ── Fetch activity body for embedding ────────────────────────────────────
  if (activity_id && activity_id !== 'pending') {
    const activity = await queryOne<{ body: string; subject: string; type: string }>(
      'SELECT body, subject, type FROM activities WHERE id = $1',
      [activity_id],
    );

    const content = [activity?.subject, activity?.body].filter(Boolean).join(': ');
    if (content) {
      await queueEmbeddingJob({
        tenant_id,
        entity_type: 'activity',
        entity_id: activity_id,
        content,
      });
    }
  }

  // ── Trigger re-scoring if there's a contact ──────────────────────────────
  if (contact_id) {
    await eventBus.emit(EventNames.SCORING_REQUESTED, {
      tenant_id,
      contact_id,
      trigger: `activity_${activity_type}`,
    });
  }
});
