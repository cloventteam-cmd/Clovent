/**
 * Contact Event Handlers
 *
 * CONTACT_CREATED     → queue scoring + queue embedding
 * CONTACT_UPDATED     → queue scoring (if scoring-relevant fields changed)
 * CONTACT_SCORED      → queue opportunity scan + hot-lead notification
 * SCORING_BATCH_REQUESTED → resolve contact IDs + queue batch scoring
 */
import { eventBus } from '../bus';
import { EventNames } from '../types';
import { logger } from '../../shared/logger';
import { queueScoringJob, queueEmbeddingJob, queueOpportunityJob, queueBatchScoringJob } from '../../workers/queue';
import { queryMany } from '../../db/client';

// ─── CONTACT_CREATED → scoring + embedding ────────────────────────────────────
eventBus.on(EventNames.CONTACT_CREATED, async (payload) => {
  logger.info({ contact_id: payload.contact_id, source: payload.source }, 'Pipeline: CONTACT_CREATED → scoring + embedding');

  await Promise.all([
    queueScoringJob(
      { tenant_id: payload.tenant_id, contact_id: payload.contact_id },
      1, // high priority
    ),
    queueEmbeddingJob({
      tenant_id: payload.tenant_id,
      entity_type: 'contact',
      entity_id: payload.contact_id,
      content: `Contact created via ${payload.source}${payload.import_id ? ` (import ${payload.import_id})` : ''}`,
    }),
  ]);
});

// ─── CONTACT_UPDATED → conditional re-score ───────────────────────────────────
eventBus.on(EventNames.CONTACT_UPDATED, async (payload) => {
  const scoringFields = ['phone', 'email', 'type', 'status', 'tags', 'source', 'last_contacted_at'];
  const shouldRescore = payload.changed_fields.some(f => scoringFields.includes(f));

  if (shouldRescore) {
    logger.debug({ contact_id: payload.contact_id, fields: payload.changed_fields }, 'Pipeline: CONTACT_UPDATED → rescore');
    await queueScoringJob({ tenant_id: payload.tenant_id, contact_id: payload.contact_id }, 5);
  }
});

// ─── CONTACT_SCORED → opportunity scan + hot-lead alert ──────────────────────
// THIS WAS THE MISSING LINK: scoring completed but never triggered opportunities.
eventBus.on(EventNames.CONTACT_SCORED, async (payload) => {
  const { scores, tenant_id, contact_id } = payload;

  logger.info(
    {
      contact_id,
      buyer: scores.buyer_probability.toFixed(3),
      seller: scores.seller_probability.toFixed(3),
      engagement: scores.engagement_score.toFixed(3),
    },
    'Pipeline: CONTACT_SCORED → opportunity scan',
  );

  // ── CHAIN: always queue opportunity scan after scoring ─────────────────────
  await queueOpportunityJob({ tenant_id, contact_id });

  // ── Hot lead alert ─────────────────────────────────────────────────────────
  const isHot =
    scores.buyer_probability > 0.75 ||
    scores.seller_probability > 0.75 ||
    scores.engagement_score > 0.80;

  if (isHot) {
    const topScore = Math.max(
      scores.buyer_probability,
      scores.seller_probability,
      scores.engagement_score,
    );
    const signalType =
      scores.buyer_probability > 0.75 ? 'Buyer'
      : scores.seller_probability > 0.75 ? 'Seller'
      : 'High Engagement';

    logger.info({ contact_id, topScore: topScore.toFixed(3), signalType }, 'Pipeline: HOT LEAD detected');

    await eventBus.emit(EventNames.NOTIFICATION_SEND, {
      tenant_id,
      user_id: 'contact_owner',
      type: 'hot_lead',
      title: `Hot Lead — ${signalType} Signal`,
      body: `Score ${Math.round(topScore * 100)}% — act now while intent is high`,
      data: { contact_id, scores, signal_type: signalType },
      entity_type: 'contact',
      entity_id: contact_id,
      channels: ['in_app', 'email'],
    });
  }
});

// ─── SCORING_BATCH_REQUESTED → resolve IDs + dispatch batch ──────────────────
// THIS WAS THE MISSING LINK: emitted after import_completed but nobody handled it.
eventBus.on(EventNames.SCORING_BATCH_REQUESTED, async (payload) => {
  let contactIds: string[] = payload.contact_ids;

  if (contactIds.length === 0) {
    // Fetch contacts imported or updated in the last 10 minutes
    const contacts = await queryMany<{ id: string }>(
      `SELECT id FROM contacts
       WHERE tenant_id = $1
         AND status = 'active'
         AND updated_at > NOW() - INTERVAL '10 minutes'
       ORDER BY updated_at DESC
       LIMIT 500`,
      [payload.tenant_id],
    );
    contactIds = contacts.map(c => c.id);
  }

  if (contactIds.length === 0) {
    logger.debug({ tenant_id: payload.tenant_id }, 'Pipeline: SCORING_BATCH_REQUESTED — no contacts to score');
    return;
  }

  logger.info({ tenant_id: payload.tenant_id, count: contactIds.length }, 'Pipeline: SCORING_BATCH_REQUESTED → batch scoring');
  await queueBatchScoringJob(payload.tenant_id, contactIds);
});
