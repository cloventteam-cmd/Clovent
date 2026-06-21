/**
 * Deal Failure Prediction Model
 *
 * Predicts probability of deal falling out before close.
 *
 * Signals:
 * - Stalled in stage (days > expected average for that stage)
 * - Expected close date passed or overdue
 * - Communication gap (no activities in X days on an active deal)
 * - Existing risk score from risk tracker
 * - Stage regression (moved backwards)
 * - Price/commission changes
 * - Absence of key milestones (no inspection logged despite being in inspection stage)
 */
import type { DealSummary, Prediction, PredictionSignal } from './types';
import { clamp, daysAgo } from '../../shared/utils';

const MODEL_VERSION = '1.1';

// Expected days per stage before it becomes "stalled"
const STAGE_EXPECTED_DAYS: Record<string, number> = {
  lead:            7,
  nurture:        21,
  active:         14,
  under_contract:  7,
  inspection:      7,
  appraisal:      10,
  financing:      14,
  clear_to_close:  5,
};

export interface DealFailurePrediction {
  deal_id: string;
  contact_id?: string;
  type: 'deal_failure';
  probability: number;
  confidence: number;
  horizon_days: number;
  failure_categories: string[];
  signals: PredictionSignal[];
  model_version: string;
  comparables_used: number;
}

export function predictDealFailure(
  deal: DealSummary,
  activities: Array<{ type: string; occurred_at: Date; deal_id?: string }>,
  contactId?: string,
): DealFailurePrediction {
  const signals: PredictionSignal[] = [];
  let rawScore = 0;

  // Skip closed/withdrawn deals
  if (['closed_won', 'closed_lost', 'withdrawn'].includes(deal.stage)) {
    return {
      deal_id: deal.id, contact_id: contactId,
      type: 'deal_failure', probability: 0, confidence: 0, horizon_days: 30,
      failure_categories: [], signals: [], model_version: MODEL_VERSION, comparables_used: 0,
    };
  }

  const failureCategories: string[] = [];

  // ── 1. Days stalled in current stage ─────────────────────────────────────
  const expectedDays = STAGE_EXPECTED_DAYS[deal.stage] ?? 14;
  const daysSinceUpdate = daysAgo(deal.updated_at);
  if (daysSinceUpdate > expectedDays) {
    const stallRatio = Math.min(daysSinceUpdate / (expectedDays * 3), 1);
    const stall = stallRatio * 0.30;
    rawScore += stall;
    failureCategories.push('stalled');
    signals.push({
      type: 'stage_stall',
      weight: stall,
      value: Math.round(daysSinceUpdate),
      description: `Stalled ${Math.round(daysSinceUpdate)}d in ${deal.stage.replace('_',' ')} (expected ≤${expectedDays}d)`,
    });
  }

  // ── 2. Overdue close date ─────────────────────────────────────────────────
  if (deal.expected_close_date) {
    const daysToClose = -daysAgo(deal.expected_close_date); // negative = overdue
    if (daysToClose < 0) {
      const overdueScore = Math.min(Math.abs(daysToClose) / 14, 1) * 0.35;
      rawScore += overdueScore;
      failureCategories.push('overdue');
      signals.push({
        type: 'close_date_overdue',
        weight: overdueScore,
        value: Math.round(Math.abs(daysToClose)),
        description: `Closing date passed ${Math.round(Math.abs(daysToClose))}d ago`,
      });
    } else if (daysToClose < 5 && deal.stage !== 'clear_to_close') {
      rawScore += 0.20;
      failureCategories.push('imminent_close_not_ready');
      signals.push({
        type: 'close_imminent_not_ready',
        weight: 0.20,
        value: Math.round(daysToClose),
        description: `Closing in ${Math.round(daysToClose)}d but not in clear-to-close stage`,
      });
    }
  }

  // ── 3. Communication gap ──────────────────────────────────────────────────
  const dealActivities = activities.filter(a => (a as any).deal_id === deal.id);
  const lastDealActivity = dealActivities[0]?.occurred_at;
  const commGapDays = lastDealActivity ? daysAgo(lastDealActivity) : daysSinceUpdate;

  const commThreshold = deal.stage === 'active' ? 14 : 7;
  if (commGapDays > commThreshold) {
    const commScore = Math.min((commGapDays - commThreshold) / (commThreshold * 2), 1) * 0.20;
    rawScore += commScore;
    failureCategories.push('communication_gap');
    signals.push({
      type: 'communication_gap',
      weight: commScore,
      value: Math.round(commGapDays),
      description: `${Math.round(commGapDays)}d communication gap on active deal`,
    });
  }

  // ── 4. Existing risk score ────────────────────────────────────────────────
  const existingRisk = Number(deal.risk_score ?? 0);
  if (existingRisk > 0.3) {
    const riskContribution = existingRisk * 0.30;
    rawScore += riskContribution;
    signals.push({
      type: 'existing_risk_score',
      weight: riskContribution,
      value: existingRisk,
      description: `Existing risk score: ${Math.round(existingRisk * 100)}%`,
    });
  }

  // ── 5. Failure probability from risk tracker ──────────────────────────────
  const failureProb = Number(deal.failure_probability ?? 0);
  if (failureProb > 0.2) {
    const contribution = failureProb * 0.20;
    rawScore += contribution;
    signals.push({
      type: 'failure_probability',
      weight: contribution,
      value: failureProb,
      description: `Risk tracker failure probability: ${Math.round(failureProb * 100)}%`,
    });
  }

  const probability = clamp(rawScore, 0, 1);

  // Confidence: higher when deal has more activity data
  const confidence = clamp(
    0.4 + Math.min(dealActivities.length / 5, 1) * 0.4 +
    (existingRisk > 0 ? 0.2 : 0),
    0.2, 0.9,
  );

  return {
    deal_id: deal.id,
    contact_id: contactId,
    type: 'deal_failure',
    probability,
    confidence,
    horizon_days: 30,
    failure_categories: failureCategories,
    signals,
    model_version: MODEL_VERSION,
    comparables_used: 0,
  };
}
