/**
 * Reactivation Prediction Model
 *
 * Identifies dormant contacts who are likely to re-engage soon.
 *
 * A strong reactivation candidate has:
 * - Was previously engaged (high historical engagement)
 * - Has been quiet for 90-365 days (not forever-lost, not recently active)
 * - Shows a recent trigger (email open, message, or brief contact after silence)
 * - Had a past transaction or was close to one
 * - Life event context (anniversary, birthday — if known)
 *
 * The model explicitly excludes:
 * - Contacts marked do_not_contact
 * - Contacts inactive > 2 years (likely lost forever)
 * - Contacts currently active (no reactivation needed)
 */
import type { ContactContext, Prediction, PredictionSignal } from './types';
import { detectIntent } from './intent-detector';
import { analyzeTemporalPattern } from './temporal-analyzer';
import { clamp, daysAgo } from '../../shared/utils';

const MODEL_VERSION = '1.1';

const MIN_DORMANCY_DAYS = 90;
const MAX_DORMANCY_DAYS = 730; // 2 years

export function predictReactivation(ctx: ContactContext): Prediction[] {
  if (ctx.status === 'do_not_contact') {
    return [];
  }

  const signals: PredictionSignal[] = [];
  let rawScore = 0;

  const temporal = analyzeTemporalPattern(ctx.activities);
  const gapDays = temporal.last_activity_gap_days;

  // ── Guard: only dormant contacts ──────────────────────────────────────────
  if (gapDays < MIN_DORMANCY_DAYS || gapDays > MAX_DORMANCY_DAYS) {
    return [];
  }

  // ── 1. Dormancy window score ──────────────────────────────────────────────
  // Peak reactivation window: 120-270 days. Outside: lower probability.
  const dormancyScore = dormancyWindowScore(gapDays);
  if (dormancyScore > 0) {
    rawScore += dormancyScore;
    signals.push({
      type: 'dormancy_window',
      weight: dormancyScore,
      value: Math.round(gapDays),
      description: `${Math.round(gapDays)}d inactive — in optimal reactivation window`,
    });
  }

  // ── 2. Prior engagement quality ───────────────────────────────────────────
  const historicalEngagement = Number(ctx.engagement_score ?? 0);
  if (historicalEngagement > 0.4) {
    const engagementBoost = historicalEngagement * 0.25;
    rawScore += engagementBoost;
    signals.push({
      type: 'prior_engagement',
      weight: engagementBoost,
      value: historicalEngagement,
      description: `Previously had ${Math.round(historicalEngagement * 100)}% engagement score`,
    });
  }

  // ── 3. Reactivation trigger (temporal pattern) ────────────────────────────
  if (temporal.trend === 'reactivating') {
    rawScore += 0.30;
    signals.push({
      type: 'reactivation_detected',
      weight: 0.30,
      value: 1,
      description: 'Recent activity after prolonged silence — reactivation in progress',
    });
  }

  // ── 4. Intent signals ─────────────────────────────────────────────────────
  const intent = detectIntent(ctx.messages, ctx.activities, 60); // only recent 60 days
  if (intent.reactivation > 0) {
    const contribution = intent.reactivation * 0.35;
    rawScore += contribution;
    signals.push({
      type: 'reactivation_intent',
      weight: contribution,
      value: intent.reactivation,
      description: `Re-engagement intent detected in messages`,
      is_intent: true,
    });
  }

  // Seller/buyer intent on dormant contact = strong reactivation signal
  const crossIntent = Math.max(intent.seller, intent.buyer) * 0.20;
  if (crossIntent > 0) {
    rawScore += crossIntent;
    signals.push({
      type: 'cross_intent_signal',
      weight: crossIntent,
      value: Math.max(intent.seller, intent.buyer),
      description: 'Transaction intent detected in dormant contact — reactivation likely',
      is_intent: true,
    });
  }

  // ── 5. Past transaction history ───────────────────────────────────────────
  const pastDeals = ctx.deals.filter(d =>
    d.stage === 'closed_won' || d.stage === 'closed_lost',
  );
  if (pastDeals.length > 0) {
    const boost = Math.min(pastDeals.length * 0.10, 0.20);
    rawScore += boost;
    signals.push({
      type: 'past_transaction',
      weight: boost,
      value: pastDeals.length,
      description: `${pastDeals.length} prior transaction(s) — established relationship`,
    });
  }

  // ── 6. Contact type bonus ─────────────────────────────────────────────────
  if (ctx.type === 'past_client') {
    rawScore += 0.12;
    signals.push({
      type: 'past_client_type',
      weight: 0.12,
      value: 1,
      description: 'Past client — likely to re-engage for next transaction',
    });
  }

  const probability = clamp(rawScore, 0, 1);

  // Confidence higher when we have both temporal signal and data richness
  const hasSignal = temporal.trend === 'reactivating' || intent.reactivation > 0.3;
  const dataRich  = Math.min(ctx.activities.length / 8, 1) * 0.3;
  const confidence = clamp(
    (hasSignal ? 0.65 : 0.4) + dataRich,
    0.1, 0.90,
  );

  return [
    { type: 'reactivation_30d', horizon: 30, multiplier: 0.7 },
    { type: 'reactivation_60d', horizon: 60, multiplier: 1.0 },
  ].map(h => ({
    contact_id: ctx.id,
    type: h.type as any,
    probability: clamp(probability * h.multiplier, 0, 1),
    confidence,
    horizon_days: h.horizon,
    signals,
    model_version: MODEL_VERSION,
    comparables_used: ctx.pattern?.similar_contact_ids?.length ?? 0,
  }));
}

// Bell-curve: peaks at 180d dormancy, lower at extremes
function dormancyWindowScore(days: number): number {
  const peak = 180;
  const sigma = 90;
  return Math.exp(-0.5 * Math.pow((days - peak) / sigma, 2)) * 0.20;
}
