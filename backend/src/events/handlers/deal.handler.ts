/**
 * Deal Event Handlers
 *
 * DEAL_STAGE_CHANGED  → probability update worker + risk scan
 * DEAL_RISK_DETECTED  → notification
 * DEAL_CLOSED         → update contact type, notify
 */
import { eventBus } from '../bus';
import { EventNames } from '../types';
import { logger } from '../../shared/logger';
import { queueDealRiskJob, queueProbabilityJob } from '../../workers/queue';
import { findContactById, updateContact } from '../../db/repositories/contacts';

const RISK_STAGES = new Set([
  'under_contract', 'inspection', 'appraisal',
  'financing', 'clear_to_close',
]);

// ─── DEAL_STAGE_CHANGED → probability worker + risk worker ───────────────────
eventBus.on(EventNames.DEAL_STAGE_CHANGED, async (payload) => {
  logger.info(
    { deal_id: payload.deal_id, from: payload.from_stage, to: payload.to_stage },
    'Pipeline: DEAL_STAGE_CHANGED → probability update + risk scan',
  );

  // ── Queue probability update (dedicated worker, no direct DB write here) ──
  await queueProbabilityJob({
    tenant_id: payload.tenant_id,
    deal_id: payload.deal_id,
    stage: payload.to_stage,
  });

  // ── Queue risk analysis for contract stages ────────────────────────────────
  if (RISK_STAGES.has(payload.to_stage)) {
    await queueDealRiskJob({
      tenant_id: payload.tenant_id,
      deal_id: payload.deal_id,
    });
  }

  // ── Re-score the associated contact ───────────────────────────────────────
  if (payload.contact_id) {
    await eventBus.emit(EventNames.SCORING_REQUESTED, {
      tenant_id: payload.tenant_id,
      contact_id: payload.contact_id,
      trigger: `deal_stage_${payload.to_stage}`,
    });
  }
});

// ─── DEAL_RISK_DETECTED → notification ────────────────────────────────────────
eventBus.on(EventNames.DEAL_RISK_DETECTED, async (payload) => {
  logger.warn(
    { deal_id: payload.deal_id, risk: payload.risk_score.toFixed(3), categories: payload.categories },
    'Pipeline: DEAL_RISK_DETECTED → notification',
  );

  if (payload.risk_score >= 0.5) {
    const severity = payload.risk_score >= 0.75 ? 'CRITICAL' : payload.risk_score >= 0.6 ? 'HIGH' : 'MEDIUM';

    await eventBus.emit(EventNames.NOTIFICATION_SEND, {
      tenant_id: payload.tenant_id,
      user_id: 'deal_owner',
      type: 'deal_risk',
      title: `[${severity}] Deal Risk Alert`,
      body: `Risk ${Math.round(payload.risk_score * 100)}% on categories: ${payload.categories.join(', ')}`,
      data: {
        deal_id: payload.deal_id,
        risk_score: payload.risk_score,
        failure_probability: payload.failure_probability,
        categories: payload.categories,
      },
      entity_type: 'deal',
      entity_id: payload.deal_id,
      channels: payload.risk_score >= 0.7 ? ['in_app', 'email'] : ['in_app'],
    });
  }
});

// ─── DEAL_CLOSED → update contact to past_client ──────────────────────────────
eventBus.on(EventNames.DEAL_CLOSED, async (payload) => {
  logger.info({ deal_id: payload.deal_id, outcome: payload.outcome }, 'Pipeline: DEAL_CLOSED');

  if (payload.outcome === 'won') {
    // Look up the deal to get contact_id
    const { queryOne } = await import('../../db/client');
    const deal = await queryOne<{ contact_id: string; tenant_id: string }>(
      'SELECT contact_id, tenant_id FROM deals WHERE id = $1',
      [payload.deal_id],
    );

    if (deal?.contact_id) {
      await updateContact(deal.tenant_id, deal.contact_id, { type: 'past_client' } as any);
      logger.info({ contact_id: deal.contact_id }, 'Contact upgraded to past_client after won deal');

      await eventBus.emit(EventNames.SCORING_REQUESTED, {
        tenant_id: deal.tenant_id,
        contact_id: deal.contact_id,
        trigger: 'deal_closed_won',
      });
    }
  }
});
