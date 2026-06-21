import { queryMany, query } from '../../db/client';
import { findDealById, updateDealRisk } from '../../db/repositories/deals';
import { eventBus } from '../../events/bus';
import { EventNames } from '../../events/types';
import { ai } from '../../ai/layer';
import { clamp, daysAgo } from '../../shared/utils';
import { logger } from '../../shared/logger';
import type { UUID, DealRisk, DealRiskCategory } from '../../shared/types';

interface RiskFactor {
  category: DealRiskCategory;
  severity: 'low' | 'medium' | 'high' | 'critical';
  score: number;
  failureProb: number;
  description: string;
  signals: Array<{ type: string; weight: number; value: unknown; description: string }>;
}

export class DealRiskTracker {
  private tenantId: UUID;

  constructor(tenantId: UUID) {
    this.tenantId = tenantId;
  }

  async analyze(dealId: UUID): Promise<void> {
    const deal = await findDealById(this.tenantId, dealId);
    if (!deal) return;

    const factors = await this.detectRiskFactors(dealId, deal);

    if (factors.length === 0) {
      await updateDealRisk(this.tenantId, dealId, 0, 0);
      return;
    }

    // Aggregate risk
    const maxScore = Math.max(...factors.map(f => f.score));
    const avgFailure = factors.reduce((s, f) => s + f.failureProb, 0) / factors.length;
    const compositeRisk = clamp(maxScore * 0.6 + avgFailure * 0.4, 0, 1);
    const overallFailure = clamp(avgFailure, 0, 1);

    await updateDealRisk(this.tenantId, dealId, compositeRisk, overallFailure);

    // Upsert risk records
    for (const factor of factors) {
      await this.upsertRiskRecord(dealId, factor);
    }

    if (compositeRisk >= 0.4) {
      await eventBus.emit(EventNames.DEAL_RISK_DETECTED, {
        tenant_id: this.tenantId,
        deal_id: dealId,
        risk_score: compositeRisk,
        failure_probability: overallFailure,
        categories: factors.map(f => f.category),
      });
    }

    logger.info({ deal_id: dealId, risk_score: compositeRisk, factors: factors.length }, 'Deal risk analyzed');
  }

  private async detectRiskFactors(dealId: UUID, deal: any): Promise<RiskFactor[]> {
    const factors: RiskFactor[] = [];
    const stage = deal.stage as string;

    // ── Inspection risk ─────────────────────────────────────────────────────
    if (['inspection', 'under_contract', 'appraisal'].includes(stage)) {
      const activities = await queryMany<{ occurred_at: Date; type: string }>(
        `SELECT occurred_at, type FROM activities
         WHERE deal_id = $1 AND type = 'inspection'
         ORDER BY occurred_at DESC LIMIT 1`,
        [dealId],
      );

      const lastInspection = activities[0];
      if (!lastInspection) {
        factors.push({
          category: 'inspection',
          severity: 'medium',
          score: 0.55,
          failureProb: 0.2,
          description: 'No inspection activity logged — schedule or confirm status',
          signals: [{ type: 'no_inspection', weight: 0.55, value: true, description: 'No inspection recorded' }],
        });
      } else {
        const daysSince = daysAgo(lastInspection.occurred_at);
        if (daysSince > 5) {
          factors.push({
            category: 'inspection',
            severity: daysSince > 10 ? 'high' : 'medium',
            score: clamp(0.4 + daysSince * 0.02, 0, 0.9),
            failureProb: 0.25,
            description: `Inspection was ${daysSince} days ago — follow up on results`,
            signals: [{ type: 'inspection_delay', weight: 0.4, value: daysSince, description: `${daysSince} days since inspection` }],
          });
        }
      }
    }

    // ── Appraisal risk ──────────────────────────────────────────────────────
    if (['appraisal', 'financing', 'clear_to_close'].includes(stage)) {
      const appraisalActivity = await queryMany<{ occurred_at: Date }>(
        `SELECT occurred_at FROM activities
         WHERE deal_id = $1 AND type = 'appraisal'
         ORDER BY occurred_at DESC LIMIT 1`,
        [dealId],
      );

      if (!appraisalActivity[0] && stage === 'appraisal') {
        factors.push({
          category: 'appraisal',
          severity: 'medium',
          score: 0.50,
          failureProb: 0.3,
          description: 'Appraisal pending — no result recorded',
          signals: [{ type: 'appraisal_pending', weight: 0.5, value: true, description: 'Appraisal not yet completed' }],
        });
      }

      // Price vs appraisal gap risk (simulated — in prod, integrate appraisal data)
      if (deal.price && deal.price > 500000_00) { // > $500k (stored in cents)
        factors.push({
          category: 'appraisal',
          severity: 'low',
          score: 0.3,
          failureProb: 0.15,
          description: 'Higher price point — elevated appraisal gap risk',
          signals: [{ type: 'high_price', weight: 0.3, value: deal.price, description: 'Price above $500K' }],
        });
      }
    }

    // ── Financing risk ──────────────────────────────────────────────────────
    if (['financing', 'clear_to_close', 'under_contract'].includes(stage)) {
      const daysSinceUpdate = daysAgo(deal.updated_at);

      if (daysSinceUpdate > 14) {
        factors.push({
          category: 'financing',
          severity: daysSinceUpdate > 21 ? 'high' : 'medium',
          score: clamp(0.35 + daysSinceUpdate * 0.015, 0, 0.85),
          failureProb: 0.3,
          description: `Financing stage stalled — ${daysSinceUpdate} days without update`,
          signals: [{ type: 'financing_stall', weight: 0.4, value: daysSinceUpdate, description: `${daysSinceUpdate} days in financing` }],
        });
      }
    }

    // ── Closing risk ────────────────────────────────────────────────────────
    if (deal.expected_close_date) {
      const daysToClose = Math.floor(
        (new Date(deal.expected_close_date).getTime() - Date.now()) / 86400000,
      );

      if (daysToClose >= 0 && daysToClose <= 3) {
        // Check for missing critical activities
        const closingActivities = await queryMany<{ type: string }>(
          `SELECT type FROM activities
           WHERE deal_id = $1 AND type IN ('inspection','appraisal')`,
          [dealId],
        );

        const hasBoth = closingActivities.some(a => a.type === 'inspection') &&
          closingActivities.some(a => a.type === 'appraisal');

        if (!hasBoth) {
          factors.push({
            category: 'closing',
            severity: 'critical',
            score: 0.85,
            failureProb: 0.45,
            description: `Closing in ${daysToClose} days — missing inspection or appraisal record`,
            signals: [{ type: 'closing_imminent_incomplete', weight: 0.85, value: daysToClose, description: `Closing in ${daysToClose} days, incomplete` }],
          });
        }
      }

      if (daysToClose < 0 && stage !== 'closed_won') {
        factors.push({
          category: 'closing',
          severity: 'critical',
          score: 0.9,
          failureProb: 0.6,
          description: 'Closing date has passed — immediate intervention needed',
          signals: [{ type: 'overdue_closing', weight: 0.9, value: Math.abs(daysToClose), description: `${Math.abs(daysToClose)} days past closing date` }],
        });
      }
    }

    return factors;
  }

  private async upsertRiskRecord(dealId: UUID, factor: RiskFactor): Promise<void> {
    await query(
      `INSERT INTO deal_risks (
        tenant_id, deal_id, category, severity, risk_score,
        failure_probability, description, signals
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (tenant_id, deal_id, category)
      DO UPDATE SET
        severity = EXCLUDED.severity,
        risk_score = EXCLUDED.risk_score,
        failure_probability = EXCLUDED.failure_probability,
        description = EXCLUDED.description,
        signals = EXCLUDED.signals,
        is_resolved = false`,
      [
        this.tenantId, dealId, factor.category, factor.severity,
        factor.score, factor.failureProb, factor.description,
        JSON.stringify(factor.signals),
      ],
    ).catch(() => {
      // If ON CONFLICT doesn't have a constraint named this way — insert fresh
      return query(
        `INSERT INTO deal_risks (
          tenant_id, deal_id, category, severity, risk_score,
          failure_probability, description, signals
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          this.tenantId, dealId, factor.category, factor.severity,
          factor.score, factor.failureProb, factor.description,
          JSON.stringify(factor.signals),
        ],
      );
    });
  }
}
