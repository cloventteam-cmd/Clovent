import type { UUID } from '../shared/types';

// ─── All system event names ───────────────────────────────────────────────────
export const EventNames = {
  // Contact lifecycle
  CONTACT_CREATED: 'contact.created',
  CONTACT_UPDATED: 'contact.updated',
  CONTACT_SCORED: 'contact.scored',
  CONTACT_MERGED: 'contact.merged',

  // Deal lifecycle
  DEAL_CREATED: 'deal.created',
  DEAL_STAGE_CHANGED: 'deal.stage_changed',
  DEAL_RISK_DETECTED: 'deal.risk_detected',
  DEAL_CLOSED: 'deal.closed',

  // Activity
  ACTIVITY_CREATED: 'activity.created',

  // Message
  MESSAGE_RECEIVED: 'message.received',
  MESSAGE_SENT: 'message.sent',

  // Import (file-based)
  IMPORT_STARTED: 'import.started',
  IMPORT_ROW_PROCESSED: 'import.row_processed',
  IMPORT_COMPLETED: 'import.completed',
  IMPORT_FAILED: 'import.failed',

  // Ingestion (CRM connectors — Phase 2)
  IMPORT_REQUESTED: 'import.requested',         // connector → handler → pipeline
  CRM_SYNC_STARTED: 'crm.sync_started',
  CRM_SYNC_COMPLETED: 'crm.sync_completed',
  CRM_SYNC_FAILED: 'crm.sync_failed',
  CRM_WEBHOOK_RECEIVED: 'crm.webhook_received',

  // Opportunity
  OPPORTUNITY_DETECTED: 'opportunity.detected',
  OPPORTUNITY_ACTIONED: 'opportunity.actioned',

  // Scoring
  SCORING_REQUESTED: 'scoring.requested',
  SCORING_BATCH_REQUESTED: 'scoring.batch_requested',

  // Embedding
  EMBEDDING_REQUESTED: 'embedding.requested',

  // Campaign
  CAMPAIGN_TRIGGERED: 'campaign.triggered',
  CAMPAIGN_STEP_EXECUTED: 'campaign.step_executed',
  CAMPAIGN_COMPLETED: 'campaign.completed',

  // Notification
  NOTIFICATION_SEND: 'notification.send',

  // Jobs
  JOB_OPPORTUNITY_SCAN: 'job.opportunity_scan',
  JOB_DEAL_RISK_SCAN: 'job.deal_risk_scan',
  JOB_DAILY_BRIEFING: 'job.daily_briefing',

  // Phase 5 — SaaS Monetization
  PLAN_UPGRADED:         'billing.plan_upgraded',
  PLAN_LIMIT_REACHED:    'billing.limit_reached',
  BILLING_WARNING:       'billing.warning',
  SUBSCRIPTION_CANCELLED:'billing.cancelled',
  USAGE_THRESHOLD:       'billing.usage_threshold',  // 95% — stronger pre-limit warning
  USAGE_ANOMALY:         'billing.usage_anomaly',    // spike detected (Enterprise)

  // Phase 4 — AI Prediction Engine
  CONTACT_PREDICTION_UPDATED: 'prediction.contact_updated',
  DEAL_RISK_UPDATED:          'prediction.deal_risk_updated',
  PREDICTION_BATCH_COMPLETED: 'prediction.batch_completed',
  PREDICTION_UPDATED:         'prediction.updated',
} as const;

export type EventName = typeof EventNames[keyof typeof EventNames];

// ─── Event Payloads ───────────────────────────────────────────────────────────
export interface BaseEventPayload {
  tenant_id: UUID;
  occurred_at: Date;
  correlation_id?: string;
}

export interface ContactCreatedPayload extends BaseEventPayload {
  contact_id: UUID;
  source: string;
  import_id?: UUID;
}

export interface ContactUpdatedPayload extends BaseEventPayload {
  contact_id: UUID;
  changed_fields: string[];
}

export interface ContactScoredPayload extends BaseEventPayload {
  contact_id: UUID;
  scores: {
    buyer_probability: number;
    seller_probability: number;
    engagement_score: number;
    relationship_health: number;
  };
}

export interface DealCreatedPayload extends BaseEventPayload {
  deal_id: UUID;
  contact_id?: UUID;
  stage: string;
}

export interface DealStageChangedPayload extends BaseEventPayload {
  deal_id: UUID;
  contact_id?: UUID;
  from_stage: string;
  to_stage: string;
  user_id?: UUID;
}

export interface DealRiskDetectedPayload extends BaseEventPayload {
  deal_id: UUID;
  risk_score: number;
  failure_probability: number;
  categories: string[];
}

export interface ActivityCreatedPayload extends BaseEventPayload {
  activity_id: UUID;
  contact_id?: UUID;
  deal_id?: UUID;
  activity_type: string;
}

export interface ImportStartedPayload extends BaseEventPayload {
  import_id: UUID;
  source_type: string;
  total_rows: number;
}

export interface ImportCompletedPayload extends BaseEventPayload {
  import_id: UUID;
  stats: {
    total: number;
    created: number;
    updated: number;
    skipped: number;
    errors: number;
  };
}

export interface OpportunityDetectedPayload extends BaseEventPayload {
  opportunity_id: UUID;
  contact_id?: UUID;
  type: string;
  score: number;
  priority: string;
}

export interface ScoringRequestedPayload extends BaseEventPayload {
  contact_id: UUID;
  trigger: string;
}

export interface EmbeddingRequestedPayload extends BaseEventPayload {
  entity_type: string;
  entity_id: UUID;
  content: string;
}

export interface CampaignTriggeredPayload extends BaseEventPayload {
  campaign_id: UUID;
  contact_id: UUID;
  trigger_event: string;
}

export interface NotificationSendPayload extends BaseEventPayload {
  user_id: UUID;
  type: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  entity_type?: string;
  entity_id?: UUID;
  channels: ('in_app' | 'email' | 'push' | 'sms')[];
}

export interface MessageReceivedPayload extends BaseEventPayload {
  message_id: UUID;
  contact_id?: UUID;
  channel: string;
  body: string;
}

// Union type for all event payloads
export type EventPayloadMap = {
  [EventNames.CONTACT_CREATED]: ContactCreatedPayload;
  [EventNames.CONTACT_UPDATED]: ContactUpdatedPayload;
  [EventNames.CONTACT_SCORED]: ContactScoredPayload;
  [EventNames.CONTACT_MERGED]: BaseEventPayload & { contact_id: UUID; merged_into_id: UUID };
  [EventNames.DEAL_CREATED]: DealCreatedPayload;
  [EventNames.DEAL_STAGE_CHANGED]: DealStageChangedPayload;
  [EventNames.DEAL_RISK_DETECTED]: DealRiskDetectedPayload;
  [EventNames.DEAL_CLOSED]: BaseEventPayload & { deal_id: UUID; outcome: 'won' | 'lost' };
  [EventNames.ACTIVITY_CREATED]: ActivityCreatedPayload;
  [EventNames.MESSAGE_RECEIVED]: MessageReceivedPayload;
  [EventNames.MESSAGE_SENT]: BaseEventPayload & { message_id: UUID; channel: string };
  [EventNames.IMPORT_STARTED]: ImportStartedPayload;
  [EventNames.IMPORT_ROW_PROCESSED]: BaseEventPayload & { import_id: UUID; row_index: number; status: string };
  [EventNames.IMPORT_COMPLETED]: ImportCompletedPayload;
  [EventNames.IMPORT_FAILED]: BaseEventPayload & { import_id: UUID; error: string };
  [EventNames.OPPORTUNITY_DETECTED]: OpportunityDetectedPayload;
  [EventNames.OPPORTUNITY_ACTIONED]: BaseEventPayload & { opportunity_id: UUID; user_id: UUID };
  [EventNames.SCORING_REQUESTED]: ScoringRequestedPayload;
  [EventNames.SCORING_BATCH_REQUESTED]: BaseEventPayload & { contact_ids: UUID[] };
  [EventNames.EMBEDDING_REQUESTED]: EmbeddingRequestedPayload;
  [EventNames.CAMPAIGN_TRIGGERED]: CampaignTriggeredPayload;
  [EventNames.CAMPAIGN_STEP_EXECUTED]: BaseEventPayload & { campaign_id: UUID; contact_id: UUID; step: number };
  [EventNames.CAMPAIGN_COMPLETED]: BaseEventPayload & { campaign_id: UUID };
  [EventNames.NOTIFICATION_SEND]: NotificationSendPayload;
  [EventNames.JOB_OPPORTUNITY_SCAN]: BaseEventPayload;
  [EventNames.JOB_DEAL_RISK_SCAN]: BaseEventPayload;
  [EventNames.JOB_DAILY_BRIEFING]: BaseEventPayload;
  // Phase 2 — ingestion
  [EventNames.IMPORT_REQUESTED]: BaseEventPayload & {
    credential_id: UUID;
    crm_type: string;
    sync_type: string;
    entity_type: string;
    rows: unknown[];
    batch_index: number;
    is_last_batch: boolean;
    new_cursor?: unknown;
    log_id?: UUID;
  };
  [EventNames.CRM_SYNC_STARTED]:    BaseEventPayload & { credential_id: UUID; crm_type: string };
  [EventNames.CRM_SYNC_COMPLETED]:  BaseEventPayload & { credential_id: UUID; crm_type: string; fetched: number };
  [EventNames.CRM_SYNC_FAILED]:     BaseEventPayload & { credential_id: UUID; crm_type: string; error: string };
  [EventNames.CRM_WEBHOOK_RECEIVED]:BaseEventPayload & { credential_id: UUID; crm_type: string; event_type: string };
  // Phase 4 — AI Prediction Engine
  [EventNames.CONTACT_PREDICTION_UPDATED]: BaseEventPayload & {
    contact_id: UUID;
    top_prediction_type?: string;
    top_prediction_probability: number;
    seller_90d: number;
    buyer_90d: number;
    reactivation_60d: number;
    deal_failure_count: number;
    batch_run_id?: string;
  };
  [EventNames.DEAL_RISK_UPDATED]: BaseEventPayload & {
    deal_id: UUID;
    contact_id?: UUID;
    risk_score: number;
    failure_probability: number;
    failure_categories: string[];
  };
  [EventNames.PREDICTION_BATCH_COMPLETED]: BaseEventPayload & {
    job_run_id: string;
    contacts_processed: number;
    predictions_created: number;
    high_prob_count: number;
    duration_ms: number;
  };
  // Phase 5 — Billing
  [EventNames.PLAN_UPGRADED]: BaseEventPayload & {
    old_plan: string; new_plan: string; source: string;
  };
  [EventNames.PLAN_LIMIT_REACHED]: BaseEventPayload & {
    metric: string; current: number; limit: number; plan: string;
  };
  [EventNames.BILLING_WARNING]: BaseEventPayload & {
    warning_type: string; metric?: string; current?: number; limit?: number;
    pct_used?: number; plan?: string; amount?: number;
  };
  [EventNames.SUBSCRIPTION_CANCELLED]: BaseEventPayload & { reason: string };
  [EventNames.USAGE_THRESHOLD]: BaseEventPayload & {
    metric: string; current: number; limit: number; pct: number; plan: string;
  };
  [EventNames.USAGE_ANOMALY]: BaseEventPayload & {
    spikes: Array<{ metric: string; current: number; typical: number; ratio: number }>;
  };
  // Prediction (existing)
  [EventNames.PREDICTION_UPDATED]: BaseEventPayload & {
    contact_id?: UUID;
    deal_id?: UUID;
    prediction_type: string;
    probability: number;
    confidence: number;
  };
};
