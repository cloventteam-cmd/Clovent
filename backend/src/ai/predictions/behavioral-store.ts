/**
 * Behavioral Pattern Store
 *
 * Computes and persists behavioral_patterns rows.
 * Also handles pgvector similarity lookup — finds the N nearest
 * contacts in embedding space so predictions can use "comparable contacts"
 * who have already shown the predicted behavior.
 */
import { query, queryOne, queryMany } from '../../db/client';
import { EmbeddingPipeline } from '../embeddings/pipeline';
import { EmbeddingStore } from '../embeddings/store';
import type { ContactContext, BehavioralPatternRow, EngagementTrend } from './types';
import { analyzeTemporalPattern, computeRateWindows } from './temporal-analyzer';
import { detectIntent } from './intent-detector';
import type { UUID } from '../../shared/types';

const pipeline = new EmbeddingPipeline();
const store    = new EmbeddingStore();
const N_COMPARABLES = 5;

export async function computeAndStoreBehavioralPattern(
  ctx: ContactContext,
): Promise<BehavioralPatternRow> {
  const temporal = analyzeTemporalPattern(ctx.activities);
  const intent   = detectIntent(ctx.messages, ctx.activities);
  const rates    = computeRateWindows(ctx.activities);

  // Find pgvector similar contacts (if embeddings exist)
  const similarIds = await findSimilarContacts(ctx.tenant_id, ctx.id);

  const pattern: BehavioralPatternRow = {
    activity_rate_7d:    rates.rate_7d,
    activity_rate_30d:   rates.rate_30d,
    activity_rate_90d:   rates.rate_90d,
    activity_rate_180d:  rates.rate_180d,
    engagement_trend:    temporal.trend,
    trend_change_pct:    temporal.trend_change_pct,
    seller_intent_score: intent.seller,
    buyer_intent_score:  intent.buyer,
    last_activity_gap_days: Math.round(temporal.last_activity_gap_days),
    similar_contact_ids: similarIds,
  };

  // Upsert into DB
  await query(
    `INSERT INTO behavioral_patterns (
       tenant_id, contact_id,
       activity_rate_7d, activity_rate_30d, activity_rate_90d, activity_rate_180d,
       engagement_trend, trend_change_pct,
       seller_intent_score, buyer_intent_score,
       last_activity_gap_days, similar_contact_ids, computed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
     ON CONFLICT (contact_id)
     DO UPDATE SET
       activity_rate_7d  = EXCLUDED.activity_rate_7d,
       activity_rate_30d = EXCLUDED.activity_rate_30d,
       activity_rate_90d = EXCLUDED.activity_rate_90d,
       activity_rate_180d= EXCLUDED.activity_rate_180d,
       engagement_trend  = EXCLUDED.engagement_trend,
       trend_change_pct  = EXCLUDED.trend_change_pct,
       seller_intent_score = EXCLUDED.seller_intent_score,
       buyer_intent_score  = EXCLUDED.buyer_intent_score,
       last_activity_gap_days = EXCLUDED.last_activity_gap_days,
       similar_contact_ids = EXCLUDED.similar_contact_ids,
       computed_at = NOW()`,
    [
      ctx.tenant_id, ctx.id,
      rates.rate_7d, rates.rate_30d, rates.rate_90d, rates.rate_180d,
      temporal.trend, temporal.trend_change_pct,
      intent.seller, intent.buyer,
      Math.round(temporal.last_activity_gap_days),
      similarIds,
    ],
  );

  return pattern;
}

export async function loadBehavioralPattern(contactId: UUID): Promise<BehavioralPatternRow | null> {
  const row = await queryOne<any>(
    'SELECT * FROM behavioral_patterns WHERE contact_id = $1',
    [contactId],
  );
  if (!row) return null;

  return {
    activity_rate_7d:    Number(row.activity_rate_7d),
    activity_rate_30d:   Number(row.activity_rate_30d),
    activity_rate_90d:   Number(row.activity_rate_90d),
    activity_rate_180d:  Number(row.activity_rate_180d),
    engagement_trend:    row.engagement_trend as EngagementTrend,
    trend_change_pct:    Number(row.trend_change_pct),
    seller_intent_score: Number(row.seller_intent_score),
    buyer_intent_score:  Number(row.buyer_intent_score),
    last_activity_gap_days: Number(row.last_activity_gap_days),
    similar_contact_ids: row.similar_contact_ids ?? [],
  };
}

// Find contacts with similar behavioral fingerprints via pgvector
async function findSimilarContacts(
  tenantId: UUID,
  contactId: UUID,
): Promise<UUID[]> {
  try {
    // Get this contact's embedding
    const ownEmbedding = await queryOne<{ embedding: string }>(
      `SELECT embedding FROM embeddings
       WHERE tenant_id = $1 AND entity_type = 'contact' AND entity_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, contactId],
    );

    if (!ownEmbedding?.embedding) return [];

    // Find N nearest neighbors (excluding self)
    const similar = await queryMany<{ entity_id: UUID; similarity: number }>(
      `SELECT entity_id, 1 - (embedding <=> $2::vector) AS similarity
       FROM embeddings
       WHERE tenant_id = $1
         AND entity_type = 'contact'
         AND entity_id != $3
       ORDER BY embedding <=> $2::vector
       LIMIT $4`,
      [tenantId, ownEmbedding.embedding, contactId, N_COMPARABLES],
    );

    return similar.map(s => s.entity_id);
  } catch {
    return []; // pgvector not available or no embeddings yet
  }
}

// Persist intent signals from message scanning to DB for audit trail
export async function persistIntentSignals(
  tenantId: UUID,
  contactId: UUID,
  signals: Array<{
    category: string;
    phrase: string;
    weight: number;
    message_id?: UUID;
    activity_id?: UUID;
  }>,
): Promise<void> {
  for (const s of signals) {
    await query(
      `INSERT INTO intent_signals
         (tenant_id, contact_id, signal_category, phrase_matched, weight, message_id, activity_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (contact_id, signal_category, phrase_matched, ((detected_at AT TIME ZONE 'UTC')::date))
       DO UPDATE SET weight = GREATEST(intent_signals.weight, EXCLUDED.weight)`,
      [
        tenantId, contactId, s.category, s.phrase, s.weight,
        s.message_id ?? null, s.activity_id ?? null,
      ],
    ).catch(() => {}); // non-fatal if dupe detected_at constraint fires
  }
}

// Get tenants with active contacts needing prediction runs
export async function getTenantsForPrediction(): Promise<Array<{ id: UUID; contact_count: number }>> {
  return queryMany(
    `SELECT o.id, COUNT(c.id)::int AS contact_count
     FROM organizations o
     JOIN contacts c ON c.tenant_id = o.id AND c.status = 'active'
     WHERE o.is_active = true
     GROUP BY o.id
     HAVING COUNT(c.id) > 0
     ORDER BY COUNT(c.id) DESC`,
    [],
  ) as any;
}
