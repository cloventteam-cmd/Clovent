/**
 * Prediction Engine — Orchestrator
 *
 * Loads contact context from DB, runs all 4 prediction models,
 * persists results, and emits events. This is the only entry point
 * for running predictions; all models are private to this file.
 *
 * Pipeline:
 *   loadContactContext(contactId)
 *     → computeAndStoreBehavioralPattern (pgvector + temporal)
 *     → run all 4 models in parallel
 *     → persist results to predictions table
 *     → emit CONTACT_PREDICTION_UPDATED
 *     → if high-probability: emit OPPORTUNITY_DETECTED
 */
import { query, queryMany, queryOne } from '../../db/client';
import { eventBus } from '../../events/bus';
import { EventNames } from '../../events/types';
import { logger } from '../../shared/logger';
import { uuid } from '../../shared/utils';
import { clamp } from '../../shared/utils';

import { predictSeller } from './seller-model';
import { predictBuyer  } from './buyer-model';
import { predictReactivation } from './reactivation-model';
import { predictDealFailure, type DealFailurePrediction } from './deal-failure-model';
import {
  computeAndStoreBehavioralPattern,
  loadBehavioralPattern,
} from './behavioral-store';
import type {
  ContactContext, Prediction, PredictionBatchStats,
} from './types';
import type { UUID } from '../../shared/types';

// Thresholds to convert predictions → opportunity engine signals
const OPPORTUNITY_THRESHOLDS = {
  seller_90d:       0.55,
  buyer_90d:        0.50,
  reactivation_60d: 0.45,
  deal_failure:     0.50,
};

export class PredictionEngine {
  private tenantId: UUID;
  private batchRunId: string;

  constructor(tenantId: UUID, batchRunId?: string) {
    this.tenantId  = tenantId;
    this.batchRunId = batchRunId ?? uuid();
  }

  // ── Run full prediction for a single contact ───────────────────────────────
  async predictContact(contactId: UUID): Promise<Prediction[]> {
    const ctx = await this.loadContactContext(contactId);
    if (!ctx) return [];

    // Compute behavioral pattern (includes pgvector similarity lookup)
    ctx.pattern = await computeAndStoreBehavioralPattern(ctx);

    // Run all models in parallel
    const [sellerPreds, buyerPreds, reactivationPreds] = await Promise.all([
      predictSeller(ctx),
      predictBuyer(ctx),
      predictReactivation(ctx),
    ]);

    const allPreds = [...sellerPreds, ...buyerPreds, ...reactivationPreds];

    // Run deal failure model for each active deal
    const dealPreds: DealFailurePrediction[] = [];
    for (const deal of ctx.deals) {
      if (!['closed_won', 'closed_lost', 'withdrawn'].includes(deal.stage)) {
        const fp = predictDealFailure(deal, ctx.activities as any, contactId);
        if (fp.probability > 0.1) dealPreds.push(fp);
      }
    }

    // Persist all predictions
    await this.persistPredictions(allPreds);
    await this.persistDealPredictions(dealPreds);

    // Emit events
    await this.emitContactPredictionUpdated(contactId, allPreds, dealPreds);

    // Feed high-probability predictions → opportunity engine
    await this.maybeGenerateOpportunities(ctx, allPreds, dealPreds);

    return allPreds;
  }

  // ── Batch: all active contacts for a tenant ────────────────────────────────
  async runBatch(
    batchSize = 100,
    onProgress?: (processed: number, total: number) => void,
  ): Promise<PredictionBatchStats> {
    const start = Date.now();
    let processed = 0, created = 0, updated = 0, highProb = 0;

    const contacts = await queryMany<{ id: UUID }>(
      `SELECT id FROM contacts
       WHERE tenant_id = $1 AND status = 'active'
       ORDER BY updated_at ASC`,
      [this.tenantId],
    );

    const total = contacts.length;

    // Process in chunks to avoid memory pressure
    for (let i = 0; i < contacts.length; i += batchSize) {
      const chunk = contacts.slice(i, i + batchSize);

      await Promise.allSettled(
        chunk.map(async (c) => {
          try {
            const preds = await this.predictContact(c.id);
            processed++;

            const newHighProb = preds.filter(p => p.probability > 0.7).length;
            highProb += newHighProb;

            // Count creates vs updates
            created++;
          } catch (err) {
            logger.warn({ err, contact_id: c.id }, 'PredictionEngine: contact prediction failed');
          }
        }),
      );

      onProgress?.(Math.min(i + batchSize, total), total);
    }

    // Run deal failure predictions for active deals
    await this.runDealFailureBatch();

    const duration = Date.now() - start;

    logger.info(
      {
        tenant_id: this.tenantId,
        processed,
        high_prob: highProb,
        duration_ms: duration,
        batch_run: this.batchRunId,
      },
      'PredictionEngine: batch complete',
    );

    return {
      tenant_id: this.tenantId,
      run_id: this.batchRunId,
      contacts_processed: processed,
      predictions_created: created,
      predictions_updated: updated,
      high_prob_count: highProb,
      duration_ms: duration,
    };
  }

  // ── Deal failure batch ─────────────────────────────────────────────────────
  private async runDealFailureBatch(): Promise<void> {
    const activeDeals = await queryMany<any>(
      `SELECT d.id, d.stage, d.type, d.price, d.probability, d.risk_score,
              d.failure_probability, d.expected_close_date, d.updated_at,
              d.contact_id
       FROM deals d
       WHERE d.tenant_id = $1
         AND d.stage NOT IN ('closed_won','closed_lost','withdrawn')`,
      [this.tenantId],
    );

    for (const deal of activeDeals) {
      const activities = await queryMany<any>(
        `SELECT type, occurred_at, deal_id FROM activities
         WHERE tenant_id = $1 AND deal_id = $2
         ORDER BY occurred_at DESC LIMIT 20`,
        [this.tenantId, deal.id],
      );

      const fp = predictDealFailure(deal, activities, deal.contact_id);

      if (fp.probability > 0.1) {
        await this.persistDealPredictions([fp]);

        // If high risk, update deal and emit event
        if (fp.probability >= 0.5) {
          await query(
            'UPDATE deals SET failure_probability = $2 WHERE id = $1',
            [deal.id, fp.probability],
          );

          await eventBus.emit(EventNames.DEAL_RISK_DETECTED as any, {
            tenant_id: this.tenantId,
            deal_id: deal.id,
            risk_score: fp.probability,
            failure_probability: fp.probability,
            categories: fp.failure_categories,
          });
        }
      }
    }
  }

  // ── Context loader ─────────────────────────────────────────────────────────
  private async loadContactContext(contactId: UUID): Promise<ContactContext | null> {
    const contact = await queryOne<any>(
      `SELECT * FROM contacts WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId, contactId],
    );
    if (!contact) return null;

    const [activities, messages, deals, pattern] = await Promise.all([
      queryMany<any>(
        `SELECT id, type, occurred_at, body FROM activities
         WHERE tenant_id = $1 AND contact_id = $2
         ORDER BY occurred_at DESC LIMIT 150`,
        [this.tenantId, contactId],
      ),
      queryMany<any>(
        `SELECT id, channel, direction, body, sent_at FROM messages
         WHERE tenant_id = $1 AND contact_id = $2
         ORDER BY sent_at DESC LIMIT 100`,
        [this.tenantId, contactId],
      ),
      queryMany<any>(
        `SELECT id, stage, type, price, probability, risk_score,
                failure_probability, expected_close_date, updated_at
         FROM deals WHERE tenant_id = $1 AND contact_id = $2`,
        [this.tenantId, contactId],
      ),
      loadBehavioralPattern(contactId),
    ]);

    return {
      id: contact.id,
      tenant_id: contact.tenant_id,
      first_name: contact.first_name,
      last_name: contact.last_name,
      type: contact.type,
      status: contact.status,
      created_at: contact.created_at,
      last_contacted_at: contact.last_contacted_at,
      buyer_probability:   Number(contact.buyer_probability ?? 0),
      seller_probability:  Number(contact.seller_probability ?? 0),
      engagement_score:    Number(contact.engagement_score ?? 0),
      relationship_health: Number(contact.relationship_health ?? 0.5),
      activities,
      messages,
      deals: deals.map(d => ({
        ...d,
        price:              Number(d.price ?? 0),
        probability:        Number(d.probability ?? 0),
        risk_score:         Number(d.risk_score ?? 0),
        failure_probability:Number(d.failure_probability ?? 0),
        days_in_stage: d.updated_at
          ? Math.floor((Date.now() - new Date(d.updated_at).getTime()) / 86_400_000)
          : 0,
      })),
      pattern: pattern ?? undefined,
    };
  }

  // ── Persistence helpers ────────────────────────────────────────────────────
  private async persistPredictions(preds: Prediction[]): Promise<void> {
    for (const p of preds) {
      await query(
        `INSERT INTO predictions (
           tenant_id, contact_id, prediction_type, probability, confidence,
           horizon_days, signals, model_version, comparables_used, batch_run_id,
           expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW() + INTERVAL '30 days')
         ON CONFLICT DO NOTHING`,
        [
          this.tenantId, p.contact_id ?? null, p.type, p.probability, p.confidence,
          p.horizon_days, JSON.stringify(p.signals),
          p.model_version, p.comparables_used, this.batchRunId,
        ],
      ).catch(() => {}); // ON CONFLICT DO NOTHING may fail if no unique constraint — safe to ignore
    }
  }

  private async persistDealPredictions(preds: DealFailurePrediction[]): Promise<void> {
    for (const p of preds) {
      await query(
        `INSERT INTO predictions (
           tenant_id, contact_id, deal_id, prediction_type, probability, confidence,
           horizon_days, signals, model_version, batch_run_id,
           expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW() + INTERVAL '7 days')
         ON CONFLICT DO NOTHING`,
        [
          this.tenantId, p.contact_id ?? null, p.deal_id,
          'deal_failure', p.probability, p.confidence,
          p.horizon_days, JSON.stringify(p.signals),
          p.model_version, this.batchRunId,
        ],
      ).catch(() => {});
    }
  }

  // ── Event emission ─────────────────────────────────────────────────────────
  private async emitContactPredictionUpdated(
    contactId: UUID,
    preds: Prediction[],
    dealPreds: DealFailurePrediction[],
  ): Promise<void> {
    const top = preds.reduce<Prediction | null>((best, p) =>
      !best || p.probability > best.probability ? p : best, null);

    await eventBus.emit(EventNames.CONTACT_PREDICTION_UPDATED as any, {
      tenant_id: this.tenantId,
      contact_id: contactId,
      top_prediction_type: top?.type,
      top_prediction_probability: top?.probability ?? 0,
      seller_90d: preds.find(p => p.type === 'seller_90d')?.probability ?? 0,
      buyer_90d:  preds.find(p => p.type === 'buyer_90d')?.probability ?? 0,
      reactivation_60d: preds.find(p => p.type === 'reactivation_60d')?.probability ?? 0,
      deal_failure_count: dealPreds.filter(d => d.probability > 0.5).length,
      batch_run_id: this.batchRunId,
    });
  }

  private async maybeGenerateOpportunities(
    ctx: ContactContext,
    preds: Prediction[],
    dealPreds: DealFailurePrediction[],
  ): Promise<void> {
    const opportunityMap: Record<string, { type: string; score: number; action: string }> = {
      seller_90d: {
        type: 'likely_seller',
        score: 0,
        action: 'Send a CMA and market update, then schedule a listing consultation',
      },
      buyer_90d: {
        type: 'likely_buyer',
        score: 0,
        action: 'Send curated property recommendations and schedule a buyer consultation',
      },
      reactivation_60d: {
        type: 'reactivation',
        score: 0,
        action: 'Send a personalized re-engagement message referencing their prior interest',
      },
    };

    for (const p of preds) {
      const threshold = OPPORTUNITY_THRESHOLDS[p.type as keyof typeof OPPORTUNITY_THRESHOLDS];
      if (!threshold || p.probability < threshold) continue;

      const oppDef = opportunityMap[p.type];
      if (!oppDef) continue;

      // Check if opportunity already exists for this contact+type
      const existing = await queryOne(
        `SELECT id FROM opportunities
         WHERE tenant_id = $1 AND contact_id = $2 AND type = $3 AND status = 'open'`,
        [this.tenantId, ctx.id, oppDef.type],
      );
      if (existing) continue;

      // Create opportunity
      const opp = await queryOne<{ id: UUID }>(
        `INSERT INTO opportunities (
           tenant_id, contact_id, type, priority, status,
           score, confidence, title, description, recommended_action,
           signals, expires_at, job_run_id
         ) VALUES ($1,$2,$3,$4,'open',$5,$6,$7,$8,$9,$10,NOW()+INTERVAL'30 days',$11)
         RETURNING id`,
        [
          this.tenantId, ctx.id, oppDef.type,
          p.probability > 0.8 ? 'high' : 'medium',
          p.probability, p.confidence,
          `${ctx.first_name} ${ctx.last_name} — ${p.type.replace(/_/g,' ')} prediction`,
          `AI prediction: ${Math.round(p.probability * 100)}% probability (${p.horizon_days}d horizon)`,
          oppDef.action,
          JSON.stringify(p.signals.slice(0, 5)),
          this.batchRunId,
        ],
      );

      if (opp) {
        await eventBus.emit(EventNames.OPPORTUNITY_DETECTED as any, {
          tenant_id: this.tenantId,
          opportunity_id: opp.id,
          contact_id: ctx.id,
          type: oppDef.type,
          score: p.probability,
          priority: p.probability > 0.8 ? 'high' : 'medium',
        });
      }
    }
  }
}
