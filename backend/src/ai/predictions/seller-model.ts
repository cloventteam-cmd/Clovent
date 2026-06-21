/**
 * Seller Prediction Model
 *
 * Predicts the likelihood that a contact will list/sell property
 * within 30, 60, or 90 days.
 *
 * Signal stack (in priority order):
 *
 * 1. Intent detection (highest weight)          → scans messages for selling phrases
 * 2. Temporal pattern — sudden engagement       → reactivating after dormancy = seller signal
 * 3. Temporal pattern — declining engagement    → going cold after long relationship
 * 4. Relationship duration                      → 18+ month clients more likely to move
 * 5. Past seller behavior                       → sold before = more likely to sell again
 * 6. Seasonal context                           → spring/summer = higher sell probability
 * 7. Existing seller probability from scorer    → inherit the signal
 * 8. Comparable contacts                        → similar behavioral profiles who did sell
 */
import type { ContactContext, Prediction, PredictionSignal } from './types';
import { detectIntent } from './intent-detector';
import { analyzeTemporalPattern } from './temporal-analyzer';
import { clamp, daysAgo } from '../../shared/utils';

const MODEL_VERSION = '1.1';

export function predictSeller(ctx: ContactContext): Prediction[] {
  const signals: PredictionSignal[] = [];
  let rawScore = 0;

  // ── 1. Intent detection ───────────────────────────────────────────────────
  const intent = detectIntent(ctx.messages, ctx.activities);
  if (intent.seller > 0) {
    const contribution = intent.seller * 0.45; // max 45% of score from intent
    rawScore += contribution;
    signals.push({
      type: 'seller_intent',
      weight: contribution,
      value: intent.seller,
      description: `Selling intent detected: "${intent.matched_phrases.slice(0, 2).join('", "')}"`,
      is_intent: true,
    });
  }

  // ── 2. Temporal pattern analysis ──────────────────────────────────────────
  const temporal = analyzeTemporalPattern(ctx.activities);

  if (temporal.trend === 'reactivating') {
    const boost = 0.20;
    rawScore += boost;
    signals.push({
      type: 'reactivation_signal',
      weight: boost,
      value: temporal.last_activity_gap_days,
      description: `Reactivated after ${Math.round(temporal.last_activity_gap_days)}d silence — seller intent pattern`,
    });
  }

  if (temporal.trend === 'declining' && temporal.trend_change_pct < -40) {
    const boost = 0.10;
    rawScore += boost;
    signals.push({
      type: 'engagement_declining',
      weight: boost,
      value: temporal.trend_change_pct,
      description: `Engagement dropped ${Math.round(Math.abs(temporal.trend_change_pct))}% — may be deciding to list`,
    });
  }

  // ── 3. Relationship duration ──────────────────────────────────────────────
  const contactAgeDays = daysAgo(ctx.created_at);
  if (contactAgeDays >= 540) { // 18 months+
    const duration_boost = Math.min((contactAgeDays - 540) / 900, 1) * 0.12;
    rawScore += duration_boost;
    signals.push({
      type: 'long_relationship',
      weight: duration_boost,
      value: Math.round(contactAgeDays / 30),
      description: `${Math.round(contactAgeDays / 30)}m relationship — statistically more likely to sell`,
    });
  }

  // ── 4. Past seller / transaction history ──────────────────────────────────
  const pastSellerDeals = ctx.deals.filter(
    d => d.type === 'seller' && d.stage === 'closed_won',
  );
  if (pastSellerDeals.length > 0) {
    const boost = Math.min(pastSellerDeals.length * 0.08, 0.15);
    rawScore += boost;
    signals.push({
      type: 'past_seller_history',
      weight: boost,
      value: pastSellerDeals.length,
      description: `${pastSellerDeals.length} past sale(s) — repeat seller signal`,
    });
  }

  // ── 5. Seasonal context ────────────────────────────────────────────────────
  const month = new Date().getMonth() + 1; // 1-12
  const isSellingSeason = month >= 3 && month <= 8; // Mar–Aug
  if (isSellingSeason) {
    const boost = 0.05;
    rawScore += boost;
    signals.push({
      type: 'seasonal',
      weight: boost,
      value: month,
      description: 'Spring/summer selling season increases probability',
    });
  }

  // ── 6. Inherit base seller score ──────────────────────────────────────────
  const baseSellerScore = Number(ctx.seller_probability ?? 0);
  if (baseSellerScore > 0.15) {
    const contribution = baseSellerScore * 0.25;
    rawScore += contribution;
    signals.push({
      type: 'base_seller_score',
      weight: contribution,
      value: baseSellerScore,
      description: `Existing seller probability: ${Math.round(baseSellerScore * 100)}%`,
    });
  }

  // ── 7. Contact type signals ───────────────────────────────────────────────
  if (ctx.type === 'past_client') {
    rawScore += 0.08;
    signals.push({
      type: 'past_client',
      weight: 0.08,
      value: 1,
      description: 'Past client — likely owns property and may want to sell',
    });
  }

  const probability = clamp(rawScore, 0, 1);

  // Confidence: higher when we have intent signals or temporal patterns
  const hasStrongSignal = intent.seller > 0.4 || temporal.trend === 'reactivating';
  const dataRichness = Math.min(ctx.activities.length / 10, 1) * 0.3 +
                       Math.min(ctx.messages.length / 5, 1) * 0.3;
  const confidence = clamp(
    (hasStrongSignal ? 0.7 : 0.3) + dataRichness,
    0.1, 0.95,
  );

  // Generate predictions for 30/60/90 day horizons
  // Longer horizons have slightly higher probability (more time)
  return [
    { type: 'seller_30d', horizon: 30, multiplier: 0.7 },
    { type: 'seller_60d', horizon: 60, multiplier: 0.85 },
    { type: 'seller_90d', horizon: 90, multiplier: 1.0 },
  ].map(h => ({
    contact_id: ctx.id,
    type: h.type as any,
    probability: clamp(probability * h.multiplier, 0, 1),
    confidence,
    horizon_days: h.horizon,
    signals: signals.map(s => ({ ...s, weight: s.weight * h.multiplier })),
    model_version: MODEL_VERSION,
    comparables_used: ctx.pattern?.similar_contact_ids?.length ?? 0,
  }));
}
