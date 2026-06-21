/**
 * CLOVENT Event Pipeline — Central Registration
 *
 * This file is the single source of truth for the complete event-driven pipeline.
 * Import this ONCE in src/index.ts. It registers every handler in dependency order.
 *
 * PIPELINE 1: Import → Contact
 * ─────────────────────────────
 * upload file
 *   → IMPORT_STARTED
 *   → [import worker] parse + normalize rows
 *   → CONTACT_CREATED (per new contact)
 *   → [scoring worker] score 6 dimensions
 *   → CONTACT_SCORED
 *   → [opportunity worker] scan 4 types
 *   → OPPORTUNITY_DETECTED
 *   → [notification worker] in_app + email
 *   → IMPORT_COMPLETED (after all rows)
 *   → SCORING_BATCH_REQUESTED (catch remaining contacts)
 *
 * PIPELINE 2: Deal Stage Change
 * ──────────────────────────────
 * PATCH /deals/:id/stage
 *   → DEAL_STAGE_CHANGED
 *   → [probability worker] update probability column
 *   → [deal-risk worker] analyze inspection/appraisal/financing/closing risk
 *   → DEAL_RISK_DETECTED (if risk ≥ threshold)
 *   → [notification worker] in_app + email
 *
 * PIPELINE 3: Activity → Re-score
 * ────────────────────────────────
 * POST /contacts/:id/activities
 *   → ACTIVITY_CREATED
 *   → SCORING_REQUESTED
 *   → [scoring worker]
 *   → CONTACT_SCORED
 *   → [opportunity worker]
 *   → OPPORTUNITY_DETECTED (if signals changed)
 */

// Register handlers in dependency order
import './handlers/import.handler';       // IMPORT_COMPLETED, IMPORT_FAILED
import './handlers/contact.handler';      // CONTACT_CREATED, CONTACT_UPDATED, CONTACT_SCORED, SCORING_BATCH_REQUESTED
import './handlers/scoring.handler';      // SCORING_REQUESTED (activity-triggered)
import './handlers/deal.handler';         // DEAL_STAGE_CHANGED, DEAL_RISK_DETECTED, DEAL_CLOSED
import './handlers/opportunity.handler';  // OPPORTUNITY_DETECTED, OPPORTUNITY_ACTIONED
import './handlers/activity.handler';     // ACTIVITY_CREATED → SCORING_REQUESTED
import './handlers/notification.handler'; // NOTIFICATION_SEND → BullMQ queue
import './handlers/ingestion.handler';    // IMPORT_REQUESTED (Phase 2 CRM connectors)
import './handlers/prediction.handler';   // CONTACT_PREDICTION_UPDATED, PREDICTION_BATCH_COMPLETED
import './handlers/billing.handler';      // PLAN_UPGRADED, PLAN_LIMIT_REACHED, BILLING_WARNING

import { eventBus } from './bus';
import { EventNames } from './types';
import { logger } from '../shared/logger';

// Verify the critical pipeline links are wired
export function verifyPipelineWiring(): void {
  const required: Array<[string, string]> = [
    [EventNames.CONTACT_CREATED,          'scoring + embedding queue'],
    [EventNames.CONTACT_SCORED,           'opportunity queue + hot-lead notification'],
    [EventNames.OPPORTUNITY_DETECTED,     'notification dispatch'],
    [EventNames.DEAL_STAGE_CHANGED,       'probability update + risk queue'],
    [EventNames.DEAL_RISK_DETECTED,       'notification dispatch'],
    [EventNames.IMPORT_COMPLETED,         'batch scoring + user notification'],
    [EventNames.SCORING_BATCH_REQUESTED,  'batch scoring queue dispatch'],
    [EventNames.ACTIVITY_CREATED,         'scoring trigger'],
    [EventNames.NOTIFICATION_SEND,        'notification worker dispatch'],
    [EventNames.IMPORT_REQUESTED,         'ingestion handler → import pipeline'],
  ];

  let ok = true;
  for (const [event, description] of required) {
    const count = eventBus.listenerCount(event as any);
    if (count === 0) {
      logger.error({ event }, `PIPELINE WIRING ERROR: No handler for ${event} (expected: ${description})`);
      ok = false;
    } else {
      logger.debug({ event, handlers: count }, `PIPELINE OK: ${event}`);
    }
  }

  if (!ok) throw new Error('Pipeline has unhandled events — see logs above');
  logger.info('Pipeline wiring verified — all events have handlers');
}
