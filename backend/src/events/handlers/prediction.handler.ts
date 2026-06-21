/**
 * Prediction Event Handlers
 *
 * CONTACT_PREDICTION_UPDATED → update contact scores + notify if threshold crossed
 * PREDICTION_BATCH_COMPLETED → log stats, refresh briefing
 * DEAL_RISK_UPDATED          → notify deal owner if risk escalated
 */
import { eventBus } from '../bus';
import { EventNames } from '../types';
import { logger } from '../../shared/logger';
import { query, queryOne } from '../../db/client';
import { updateContactScores } from '../../db/repositories/contacts';
import type { UUID } from '../../shared/types';

// When a contact prediction is updated, boost the contact's existing scores
// by blending in the prediction probabilities
eventBus.on(EventNames.CONTACT_PREDICTION_UPDATED as any, async (payload: any) => {
  const {
    tenant_id, contact_id,
    seller_90d, buyer_90d, reactivation_60d,
  } = payload;

  logger.debug(
    { contact_id, seller: seller_90d?.toFixed(3), buyer: buyer_90d?.toFixed(3) },
    'Prediction: CONTACT_PREDICTION_UPDATED',
  );

  // Blend prediction probabilities into existing contact scores
  // Existing scorer handles engagement/activity signals; prediction adds forward-looking context
  const existing = await queryOne<{
    buyer_probability: string; seller_probability: string;
    engagement_score: string; relationship_health: string;
    investor_probability: string; referral_probability: string;
  }>(
    'SELECT buyer_probability, seller_probability, engagement_score, relationship_health, investor_probability, referral_probability FROM contacts WHERE tenant_id = $1 AND id = $2',
    [tenant_id, contact_id],
  );

  if (!existing) return;

  // Weighted blend: 60% existing scorer + 40% prediction
  const BLEND = 0.4;
  const blendedBuyer  = blend(Number(existing.buyer_probability ?? 0),  buyer_90d  ?? 0, BLEND);
  const blendedSeller = blend(Number(existing.seller_probability ?? 0), seller_90d ?? 0, BLEND);

  await updateContactScores(tenant_id, contact_id, {
    buyer_probability:    blendedBuyer,
    seller_probability:   blendedSeller,
    investor_probability: Number(existing.investor_probability ?? 0),
    referral_probability: Number(existing.referral_probability ?? 0),
    engagement_score:     Number(existing.engagement_score ?? 0),
    relationship_health:  Number(existing.relationship_health ?? 0.5),
    signals: [{
      type: 'prediction_blend',
      weight: BLEND,
      value: Math.max(blendedBuyer, blendedSeller),
      description: `AI prediction blended: buyer=${Math.round(blendedBuyer * 100)}% seller=${Math.round(blendedSeller * 100)}%`,
    }],
  });

  // Notify if prediction crossed hot-lead threshold
  const isNowHot = blendedBuyer > 0.75 || blendedSeller > 0.75;
  if (isNowHot) {
    await eventBus.emit(EventNames.NOTIFICATION_SEND as any, {
      tenant_id,
      user_id: 'contact_owner',
      type: 'hot_lead',
      title: 'AI Prediction: High Intent Detected',
      body: `Predictive model flagged ${contact_id} — ${Math.round(Math.max(blendedBuyer, blendedSeller) * 100)}% probability`,
      data: { contact_id, seller_90d, buyer_90d, source: 'prediction_engine' },
      entity_type: 'contact',
      entity_id: contact_id,
      channels: ['in_app'],
    });
  }
});

// Batch completion → update daily briefing
eventBus.on(EventNames.PREDICTION_BATCH_COMPLETED as any, async (payload: any) => {
  const { tenant_id, contacts_processed, high_prob_count, duration_ms } = payload;

  logger.info(
    { tenant_id, contacts: contacts_processed, high_prob: high_prob_count, ms: duration_ms },
    'Prediction: batch completed for tenant',
  );

  // Store batch completion in health snapshots (lightweight audit)
  await query(
    `UPDATE health_snapshots
     SET metrics = jsonb_set(
       COALESCE(metrics, '{}'),
       '{last_prediction_batch}',
       $2::jsonb
     )
     WHERE id = (SELECT id FROM health_snapshots ORDER BY captured_at DESC LIMIT 1)`,
    [
      null,
      JSON.stringify({
        tenant_id,
        contacts_processed,
        high_prob_count,
        duration_ms,
        completed_at: new Date().toISOString(),
      }),
    ],
  ).catch(() => {}); // non-fatal
});

function blend(existing: number, predicted: number, predWeight: number): number {
  return Math.max(0, Math.min(1, existing * (1 - predWeight) + predicted * predWeight));
}
