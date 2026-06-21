export type UUID = string;
export type Tenant = { id: UUID; name: string; slug: string; plan: string };

// ─── Base ─────────────────────────────────────────────────────────────────────
export interface BaseEntity {
  id: UUID;
  tenant_id: UUID;
  created_at: Date;
  updated_at: Date;
}

// ─── Users ────────────────────────────────────────────────────────────────────
export type UserRole = 'owner' | 'admin' | 'agent' | 'viewer';
export interface User extends BaseEntity {
  email: string;
  first_name: string;
  last_name: string;
  role: UserRole;
  avatar_url?: string;
  phone?: string;
  is_active: boolean;
  last_login_at?: Date;
  settings: Record<string, unknown>;
}

// ─── Contacts ─────────────────────────────────────────────────────────────────
export type ContactType = 'lead' | 'client' | 'past_client' | 'referral_partner' | 'vendor' | 'investor';
export type ContactStatus = 'active' | 'inactive' | 'archived' | 'do_not_contact';
export interface Contact extends BaseEntity {
  owner_id?: UUID;
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  phone_alt?: string;
  city?: string;
  state?: string;
  zip?: string;
  type: ContactType;
  status: ContactStatus;
  source?: string;
  tags: string[];
  custom_fields: Record<string, unknown>;
  buyer_probability: number;
  seller_probability: number;
  investor_probability: number;
  referral_probability: number;
  engagement_score: number;
  relationship_health: number;
  external_id?: string;
  external_source?: string;
  import_id?: UUID;
  last_contacted_at?: Date;
  next_followup_at?: Date;
}

// ─── Deals ────────────────────────────────────────────────────────────────────
export type DealType = 'buyer' | 'seller' | 'lease' | 'referral' | 'investment';
export type DealStage =
  | 'lead' | 'nurture' | 'active' | 'under_contract'
  | 'inspection' | 'appraisal' | 'financing' | 'clear_to_close'
  | 'closed_won' | 'closed_lost' | 'withdrawn';

export interface Deal extends BaseEntity {
  owner_id?: UUID;
  contact_id?: UUID;
  property_id?: UUID;
  name: string;
  type: DealType;
  stage: DealStage;
  pipeline: string;
  price?: number;
  commission_rate?: number;
  commission_amount?: number;
  probability: number;
  risk_score: number;
  failure_probability: number;
  expected_close_date?: Date;
  actual_close_date?: Date;
  lost_reason?: string;
  notes?: string;
  tags: string[];
  custom_fields: Record<string, unknown>;
  source?: string;
  external_id?: string;
  external_source?: string;
  import_id?: UUID;
}

// ─── Activities ───────────────────────────────────────────────────────────────
export type ActivityType =
  | 'call' | 'email' | 'sms' | 'note' | 'meeting' | 'showing'
  | 'offer' | 'contract' | 'inspection' | 'appraisal' | 'closing'
  | 'task_completed' | 'import' | 'system';

export interface Activity extends BaseEntity {
  user_id?: UUID;
  contact_id?: UUID;
  deal_id?: UUID;
  type: ActivityType;
  direction?: 'inbound' | 'outbound';
  subject?: string;
  body?: string;
  duration_sec?: number;
  outcome?: string;
  metadata: Record<string, unknown>;
  occurred_at: Date;
}

// ─── Opportunities ────────────────────────────────────────────────────────────
export type OpportunityType =
  | 'likely_seller' | 'likely_buyer' | 'reactivation'
  | 'referral_opportunity' | 'deal_risk' | 'investment_opportunity' | 'upsell';

export interface Opportunity extends BaseEntity {
  contact_id?: UUID;
  deal_id?: UUID;
  type: OpportunityType;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'actioned' | 'dismissed' | 'expired' | 'converted';
  score: number;
  confidence: number;
  title: string;
  description?: string;
  recommended_action?: string;
  signals: OpportunitySignal[];
  expires_at?: Date;
  job_run_id?: string;
}

export interface OpportunitySignal {
  type: string;
  weight: number;
  value: unknown;
  description: string;
}

// ─── Imports ──────────────────────────────────────────────────────────────────
export type ImportSourceType =
  | 'csv' | 'excel' | 'salesforce' | 'hubspot'
  | 'followupboss' | 'kvcore' | 'gmail' | 'outlook' | 'twilio' | 'manual';

export interface Import extends BaseEntity {
  user_id?: UUID;
  name: string;
  source_type: ImportSourceType;
  status: 'pending' | 'previewing' | 'preview_ready' | 'committing' | 'completed' | 'failed' | 'cancelled';
  file_path?: string;
  original_filename?: string;
  field_mapping: FieldMapping;
  options: Record<string, unknown>;
  stats: ImportStats;
  error_log: ImportError[];
  preview_data?: ImportPreviewRow[];
  job_id?: string;
}

export interface FieldMapping {
  [targetField: string]: string | MappingRule;
}

export interface MappingRule {
  source_field: string;
  transform?: 'lowercase' | 'uppercase' | 'phone_normalize' | 'date_parse' | 'boolean' | 'trim';
  default_value?: unknown;
}

export interface ImportStats {
  total: number;
  processed?: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
}

export interface ImportError {
  row: number;
  field?: string;
  message: string;
}

export interface ImportPreviewRow {
  index: number;
  raw: Record<string, string>;
  mapped: Record<string, unknown>;
  issues: string[];
  action: 'create' | 'update' | 'skip' | 'merge';
  match_id?: UUID;
}

// ─── Notifications ────────────────────────────────────────────────────────────
export type NotificationType =
  | 'hot_lead' | 'deal_risk' | 'opportunity' | 'daily_summary'
  | 'task_due' | 'campaign_complete' | 'import_complete' | 'system' | 'mention';

export interface Notification extends BaseEntity {
  user_id: UUID;
  type: NotificationType;
  title: string;
  body?: string;
  data: Record<string, unknown>;
  is_read: boolean;
  read_at?: Date;
  entity_type?: string;
  entity_id?: UUID;
  channel: 'in_app' | 'email' | 'push' | 'sms';
}

// ─── Scoring ──────────────────────────────────────────────────────────────────
export interface ContactScores {
  buyer_probability: number;
  seller_probability: number;
  investor_probability: number;
  referral_probability: number;
  engagement_score: number;
  relationship_health: number;
  signals: ScoringSignal[];
}

export interface ScoringSignal {
  type: string;
  weight: number;
  value: number;
  description: string;
}

// ─── API ──────────────────────────────────────────────────────────────────────
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface AuthPayload {
  user_id: UUID;
  tenant_id: UUID;
  role: UserRole;
  email: string;
}

// ─── Campaign ─────────────────────────────────────────────────────────────────
export interface Campaign extends BaseEntity {
  owner_id?: UUID;
  name: string;
  description?: string;
  type: 'email' | 'sms' | 'multi_channel' | 'drip';
  status: 'draft' | 'scheduled' | 'active' | 'paused' | 'completed' | 'archived';
  segment_rules: SegmentRule[];
  trigger_rules: TriggerRule[];
  sequence: CampaignStep[];
  settings: Record<string, unknown>;
  stats: CampaignStats;
}

export interface SegmentRule {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'in' | 'not_in';
  value: unknown;
}

export interface TriggerRule {
  event: string;
  conditions: SegmentRule[];
  delay_minutes?: number;
}

export interface CampaignStep {
  step: number;
  type: 'email' | 'sms' | 'wait' | 'condition';
  template_id?: string;
  delay_hours?: number;
  subject?: string;
  body_template?: string;
  condition?: SegmentRule[];
}

export interface CampaignStats {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  replied: number;
  unsubscribed: number;
}

// ─── Deal Risk ────────────────────────────────────────────────────────────────
export type DealRiskCategory = 'inspection' | 'appraisal' | 'financing' | 'title' | 'closing' | 'buyer' | 'seller' | 'market';

export interface DealRisk extends BaseEntity {
  deal_id: UUID;
  category: DealRiskCategory;
  severity: 'low' | 'medium' | 'high' | 'critical';
  risk_score: number;
  failure_probability: number;
  description: string;
  signals: OpportunitySignal[];
  is_resolved: boolean;
  resolved_at?: Date;
  resolution_note?: string;
}

// ─── Daily Briefing ───────────────────────────────────────────────────────────
export interface DailyBriefing {
  id: UUID;
  tenant_id: UUID;
  date: Date;
  top_actions: BriefingAction[];
  who_to_contact: BriefingContact[];
  deals_at_risk: BriefingDealRisk[];
  revenue_forecast: RevenueForecast;
  summary?: string;
  generated_at: Date;
}

export interface BriefingAction {
  priority: number;
  type: string;
  title: string;
  description: string;
  entity_type?: string;
  entity_id?: UUID;
  suggested_message?: string;
}

export interface BriefingContact {
  contact_id: UUID;
  contact_name: string;
  reason: string;
  score: number;
  last_contact_days_ago?: number;
  opportunity_id?: UUID;
}

export interface BriefingDealRisk {
  deal_id: UUID;
  deal_name: string;
  risk_score: number;
  top_risk: string;
  days_to_close?: number;
}

export interface RevenueForecast {
  this_month_projected: number;
  next_month_projected: number;
  pipeline_value: number;
  weighted_pipeline: number;
  deals_at_risk_value: number;
}
