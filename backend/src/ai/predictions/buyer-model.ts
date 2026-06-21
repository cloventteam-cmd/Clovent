/**
 * Buyer Prediction Model
 *
 * Predicts likelihood of purchase within 30/60/90 days.
 *
 * Signals:
 * - Message intent (searching, pre-approved, budget mentions)
 * - Showing frequency acceleration
 * - Engagement trend (rising = hot buyer)
 * - Active buyer deal exists (already in pipeline)
 * - Contact type and source
 * - Time since pre-approval (if mentioned) — expires ~90 days
 */
import type { ContactContext, Prediction, PredictionSignal } from './types';
import { detectIntent } from './intent-detector';
import { analyzeTemporalPattern } from './temporal-analyzer';
import { clamp, daysAgo } from '../../shared/utils';

const MODEL_VERSION = '1.1';

export function predictBuyer(ctx: ContactContext): Prediction[] {
  const signals: PredictionSignal[] = [];
  let rawScore = 0;

  // ── 1. Intent detection ───────────────────────────────────────────────────
  const intent = detectIntent(ctx.messages, ctx.activities);
  if (intent.buyer > 0) {
    const contribution = intent.buyer * 0.40;
    rawScore += contribution;
    signals.push({
      type: 'buyer_intent',
      weight: contribution,
      value: intent.buyer,
      description: `Buyer intent detected: "${intent.matched_phrases.slice(0, 2).join('", "')}"`,
      is_intent: true,
    });
  }

  // ── 2. Showing frequency ──────────────────────────────────────────────────
  const recentShowings = ctx.activities.filter(a => {
    return a.type === 'showing' &&
      daysAgo(a.occurred_at) <= 30;
  }).length;

  if (recentShowings > 0) {
    const showingScore = Math.min(recentShowings / 3, 1) * 0.30;
    rawScore += showingScore;
    signals.push({
      type: 'recent_showings',
      weight: showingScore,
      value: recentShowings,
      description: `${recentShowings} showing(s) in last 30 days — active buyer behavior`,
    });
  }

  // ── 3. Engagement trend ───────────────────────────────────────────────────
  const temporal = analyzeTemporalPattern(ctx.activities);
  if (temporal.trend === 'rising') {
    const boost = 0.18 * Math.min(temporal.trend_change_pct / 100, 1);
    rawScore += boost;
    signals.push({
      type: 'engagement_rising',
      weight: boost,
      value: temporal.trend_change_pct,
      description: `Engagement up ${Math.round(temporal.trend_change_pct)}% — accelerating toward purchase`,
    });
  }

  // ── 4. Active buyer deal ──────────────────────────────────────────────────
  const activeBuyerDeals = ctx.deals.filter(
    d => d.type === 'buyer' && !['closed_won', 'closed_lost', 'withdrawn'].includes(d.stage),
  );

  if (activeBuyerDeals.length > 0) {
    const dealStageBoost = activeBuyerDeals.reduce((sum, d) => {
      const stageWeight: Record<string, number> = {
        lead: 0.1, nurture: 0.15, active: 0.25,
        under_contract: 0.50, inspection: 0.55, appraisal: 0.60,
        financing: 0.65, clear_to_close: 0.80,
      };
      return sum + (stageWeight[d.stage] ?? 0.1);
    }, 0);
    const boost = Math.min(dealStageBoost, 0.40);
    rawScore += boost;
    signals.push({
      type: 'active_deal',
      weight: boost,
      value: activeBuyerDeals[0].stage,
      description: `Active buyer deal in ${activeBuyerDeals[0].stage.replace('_', ' ')} stage`,
    });
  }

  // ── 5. Contact source signals ─────────────────────────────────────────────
  const highIntentSources = ['open house', 'zillow', 'realtor.com', 'showing request', 'referral'];
  const sourceLower = (ctx as any).source?.toLowerCase() ?? '';
  if (highIntentSources.some(s => sourceLower.includes(s))) {
    rawScore += 0.08;
    signals.push({
      type: 'high_intent_source',
      weight: 0.08,
      value: (ctx as any).source,
      description: `Source "${(ctx as any).source}" indicates active buyer intent`,
    });
  }

  // ── 6. Inherit base buyer score ───────────────────────────────────────────
  const baseBuyerScore = Number(ctx.buyer_probability ?? 0);
  if (baseBuyerScore > 0.15) {
    const contribution = baseBuyerScore * 0.20;
    rawScore += contribution;
    signals.push({
      type: 'base_buyer_score',
      weight: contribution,
      value: baseBuyerScore,
      description: `Existing buyer probability: ${Math.round(baseBuyerScore * 100)}%`,
    });
  }

  // ── 7. Investor buyer signals ─────────────────────────────────────────────
  if (intent.investor > 0.2) {
    rawScore += intent.investor * 0.15;
    signals.push({
      type: 'investor_intent',
      weight: intent.investor * 0.15,
      value: intent.investor,
      description: 'Investment purchase intent detected',
      is_intent: true,
    });
  }

  const probability = clamp(rawScore, 0, 1);

  // Confidence
  const hasStrong = intent.buyer > 0.4 || recentShowings >= 2 || activeBuyerDeals.length > 0;
  const dataRich = Math.min(ctx.activities.length / 8, 1) * 0.25 +
                   Math.min(ctx.messages.length / 5, 1) * 0.25;
  const confidence = clamp((hasStrong ? 0.75 : 0.35) + dataRich, 0.1, 0.95);

  return [
    { type: 'buyer_30d', horizon: 30, multiplier: 0.65 },
    { type: 'buyer_60d', horizon: 60, multiplier: 0.80 },
    { type: 'buyer_90d', horizon: 90, multiplier: 1.0 },
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
