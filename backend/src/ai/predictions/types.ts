import type { UUID } from '../../shared/types';

// ── Prediction types ──────────────────────────────────────────────────────────
export type PredictionType =
  | 'seller_30d' | 'seller_60d' | 'seller_90d'
  | 'buyer_30d'  | 'buyer_60d'  | 'buyer_90d'
  | 'reactivation_30d' | 'reactivation_60d'
  | 'deal_failure' | 'going_cold';

export type EngagementTrend = 'rising' | 'stable' | 'declining' | 'dormant' | 'reactivating';

// ── Core prediction output ────────────────────────────────────────────────────
export interface Prediction {
  contact_id?: UUID;
  deal_id?: UUID;
  type: PredictionType;
  probability: number;       // 0-1 predicted likelihood
  confidence: number;        // 0-1 model confidence in the probability
  horizon_days: number;      // how many days forward we're predicting
  signals: PredictionSignal[];
  model_version: string;
  comparables_used: number;  // # similar historical contacts used
  batch_run_id?: string;
}

export interface PredictionSignal {
  type: string;
  weight: number;       // 0-1 signal weight in final score
  value: number | string;
  description: string;
  is_intent?: boolean;  // true for NLP-derived signals
}

// ── Input context for models ──────────────────────────────────────────────────
export interface ContactContext {
  id: UUID;
  tenant_id: UUID;
  first_name: string;
  last_name: string;
  type: string;
  status: string;
  created_at: Date;
  last_contacted_at?: Date;
  // Existing scores
  buyer_probability: number;
  seller_probability: number;
  engagement_score: number;
  relationship_health: number;
  // Augmented
  activities: ActivitySummary[];
  messages: MessageSummary[];
  deals: DealSummary[];
  pattern?: BehavioralPatternRow;
}

export interface ActivitySummary {
  id: UUID;
  type: string;
  occurred_at: Date;
  body?: string;
}

export interface MessageSummary {
  id: UUID;
  channel: string;
  direction: string;
  body: string;
  sent_at: Date;
}

export interface DealSummary {
  id: UUID;
  stage: string;
  type: string;
  price?: number;
  probability: number;
  risk_score: number;
  failure_probability: number;
  expected_close_date?: Date;
  updated_at: Date;
  days_in_stage?: number;
}

export interface BehavioralPatternRow {
  activity_rate_7d: number;
  activity_rate_30d: number;
  activity_rate_90d: number;
  activity_rate_180d: number;
  engagement_trend: EngagementTrend;
  trend_change_pct: number;
  seller_intent_score: number;
  buyer_intent_score: number;
  last_activity_gap_days: number;
  similar_contact_ids: UUID[];
}

// ── Intent phrase definitions ─────────────────────────────────────────────────
export interface IntentPhrase {
  phrase: string;
  weight: number;
  category: 'seller' | 'buyer' | 'cold' | 'reactivation' | 'investor';
}

// ── Batch run metadata ────────────────────────────────────────────────────────
export interface PredictionBatchStats {
  tenant_id: UUID;
  run_id: string;
  contacts_processed: number;
  predictions_created: number;
  predictions_updated: number;
  high_prob_count: number;  // probability > 0.7
  duration_ms: number;
}
