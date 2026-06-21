/**
 * Temporal Behavioral Analyzer
 *
 * Computes activity rate trends across multiple time windows and classifies
 * the engagement direction. This catches patterns the point-in-time scorer misses:
 *
 * - Contact was active 6 months ago, now silent → "declining" → seller signal
 * - Contact was silent for a year, suddenly emailed → "reactivating" → re-engagement opportunity
 * - Contact's engagement rate accelerating → "rising" → hot lead
 *
 * Output feeds into all four prediction models.
 */
import type { ActivitySummary, BehavioralPatternRow, EngagementTrend } from './types';

const MS_PER_DAY = 86_400_000;

interface RateWindow {
  days: number;
  count: number;
  rate: number; // activities per day
}

export interface TemporalAnalysis {
  windows: RateWindow[];
  trend: EngagementTrend;
  trend_change_pct: number;       // (30d rate - 90d rate) / 90d rate * 100
  last_activity_gap_days: number;
  peak_activity_date?: Date;
  dormant_since?: Date;
  reactivated_at?: Date;
  summary: string;
}

const DORMANCY_THRESHOLD_DAYS = 60;  // quiet for 60d = dormant
const REACTIVATION_GAP_DAYS   = 45;  // was quiet 45d then became active = reactivating

export function analyzeTemporalPattern(
  activities: ActivitySummary[],
  now = new Date(),
): TemporalAnalysis {
  if (activities.length === 0) {
    return {
      windows: [],
      trend: 'dormant',
      trend_change_pct: 0,
      last_activity_gap_days: 9999,
      summary: 'No activities recorded',
    };
  }

  const sorted = [...activities].sort(
    (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime(),
  );

  const nowMs = now.getTime();
  const lastMs = new Date(sorted[0].occurred_at).getTime();
  const lastActivityGapDays = (nowMs - lastMs) / MS_PER_DAY;

  // Compute rate windows
  const WINDOWS = [7, 30, 90, 180];
  const windows: RateWindow[] = WINDOWS.map(days => {
    const cutoff = nowMs - days * MS_PER_DAY;
    const count = activities.filter(a => new Date(a.occurred_at).getTime() >= cutoff).length;
    return { days, count, rate: count / days };
  });

  // Trend: compare 30d rate vs 90d rate
  const rate30  = windows.find(w => w.days === 30)?.rate  ?? 0;
  const rate90  = windows.find(w => w.days === 90)?.rate  ?? 0;
  const rate180 = windows.find(w => w.days === 180)?.rate ?? 0;

  let trendChangePct = 0;
  if (rate90 > 0.001) {
    trendChangePct = ((rate30 - rate90) / rate90) * 100;
  } else if (rate30 > 0) {
    trendChangePct = 100; // was zero, now has activity = strong reactivation
  }

  // Peak activity period (which 30-day window had the most activity?)
  let peakDate: Date | undefined;
  let peakCount = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const windowStart = new Date(sorted[i].occurred_at).getTime();
    const count = activities.filter(a => {
      const t = new Date(a.occurred_at).getTime();
      return t >= windowStart - 30 * MS_PER_DAY && t <= windowStart;
    }).length;
    if (count > peakCount) { peakCount = count; peakDate = sorted[i].occurred_at as any; }
  }

  // Dormant since: when did they go quiet?
  let dormantSince: Date | undefined;
  if (lastActivityGapDays >= DORMANCY_THRESHOLD_DAYS) {
    dormantSince = sorted[0].occurred_at as any;
  }

  // Reactivated: was quiet, now active
  let reactivatedAt: Date | undefined;
  const prevActivityMs = sorted[1] ? new Date(sorted[1].occurred_at).getTime() : 0;
  const gapBeforeLast = prevActivityMs > 0 ? (lastMs - prevActivityMs) / MS_PER_DAY : 0;
  if (
    lastActivityGapDays < 14 &&    // recently active
    gapBeforeLast > REACTIVATION_GAP_DAYS &&  // but was quiet before
    sorted.length > 1
  ) {
    reactivatedAt = sorted[0].occurred_at as any;
  }

  // Classify trend
  const trend: EngagementTrend = classifyTrend({
    lastActivityGapDays,
    trendChangePct,
    rate30,
    rate90,
    reactivatedAt,
  });

  return {
    windows,
    trend,
    trend_change_pct: trendChangePct,
    last_activity_gap_days: lastActivityGapDays,
    peak_activity_date: peakDate,
    dormant_since: dormantSince,
    reactivated_at: reactivatedAt,
    summary: buildSummary(trend, lastActivityGapDays, trendChangePct),
  };
}

function classifyTrend(args: {
  lastActivityGapDays: number;
  trendChangePct: number;
  rate30: number;
  rate90: number;
  reactivatedAt?: Date;
}): EngagementTrend {
  const { lastActivityGapDays, trendChangePct, rate30, rate90, reactivatedAt } = args;

  if (reactivatedAt) return 'reactivating';
  if (lastActivityGapDays > DORMANCY_THRESHOLD_DAYS) return 'dormant';
  if (rate30 === 0 && rate90 === 0) return 'dormant';
  if (trendChangePct > 30) return 'rising';
  if (trendChangePct < -40) return 'declining';
  return 'stable';
}

function buildSummary(trend: EngagementTrend, gapDays: number, changePct: number): string {
  const gap = Math.round(gapDays);
  switch (trend) {
    case 'rising':    return `Engagement up ${Math.round(changePct)}% vs prior period`;
    case 'declining': return `Engagement down ${Math.round(Math.abs(changePct))}% vs prior period`;
    case 'dormant':   return `Silent for ${gap} days`;
    case 'reactivating': return `Reactivated after silence — strong signal`;
    default:          return `Stable engagement, last contact ${gap}d ago`;
  }
}

// ── Rate-based averages for scoring ──────────────────────────────────────────
export function computeRateWindows(activities: ActivitySummary[]): {
  rate_7d: number; rate_30d: number; rate_90d: number; rate_180d: number;
} {
  const nowMs = Date.now();
  const count = (days: number) => activities.filter(
    a => new Date(a.occurred_at).getTime() >= nowMs - days * MS_PER_DAY,
  ).length;

  return {
    rate_7d:   count(7)   / 7,
    rate_30d:  count(30)  / 30,
    rate_90d:  count(90)  / 90,
    rate_180d: count(180) / 180,
  };
}
