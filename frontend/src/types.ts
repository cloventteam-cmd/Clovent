// ── Stream frame ──────────────────────────────────────────────────────────────
export interface StreamEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  ts: string;
}

// ── Domain ────────────────────────────────────────────────────────────────────
export interface Contact {
  id: string;
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  type: string;
  status: string;
  buyer_probability:    number;
  seller_probability:   number;
  investor_probability: number;
  referral_probability: number;
  engagement_score:     number;
  relationship_health:  number;
  tags: string[];
  last_contacted_at?: string;
}

export interface PipelineStage {
  stage:    string;
  count:    number;
  value:    number;
  avg_risk: number;
}

export interface DealRisk {
  id: string;
  name: string;
  stage: string;
  risk_score: number;
  failure_probability: number;
  price?: number;
  category?: string;
  description?: string;
  expected_close_date?: string;
}

export interface Opportunity {
  id: string;
  type: string;
  priority: string;
  score: number;
  title: string;
  description?: string;
  recommended_action?: string;
  first_name?: string;
  last_name?: string;
  contact_id?: string;
}

// ── AI Briefing ───────────────────────────────────────────────────────────────
export interface BriefingAction {
  priority: number;
  type: string;
  title: string;
  description: string;
  entity_type?: string;
  entity_id?: string;
  suggested_message?: string;
}

export interface BriefingContact {
  contact_id: string;
  contact_name: string;
  reason: string;
  score: number;
  last_contact_days_ago?: number;
  opportunity_id?: string;
}

export interface BriefingRisk {
  deal_id: string;
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

export interface AiBriefing {
  id: string;
  date: string;
  top_actions: BriefingAction[];
  who_to_contact: BriefingContact[];
  deals_at_risk: BriefingRisk[];
  revenue_forecast: RevenueForecast;
  summary?: string;
  generated_at: string;
}

// ── Feed display ──────────────────────────────────────────────────────────────
export interface FeedItem {
  id: string;
  type: string;
  label: string;
  severity: Severity;
  line1: string;
  line2?: string;
  badge?: string;
  badgeClass?: string;
  score?: number;
  ts: string;
  isNew?: boolean;
}

// ── Severity ─────────────────────────────────────────────────────────────────
export type Severity = 'green' | 'amber' | 'red' | 'blue' | 'cyan' | 'purple' | 'muted';

export interface EventMeta {
  label: string;
  severity: Severity;
  icon: string;
}

export const EVENT_META: Record<string, EventMeta> = {
  'contact.created':      { label: 'CONTACT',    severity: 'blue',   icon: '●' },
  'contact.updated':      { label: 'UPDATED',    severity: 'blue',   icon: '◈' },
  'contact.scored':       { label: 'SCORED',     severity: 'green',  icon: '▲' },
  'deal.created':         { label: 'NEW DEAL',   severity: 'cyan',   icon: '◆' },
  'deal.stage_changed':   { label: 'STAGE',      severity: 'cyan',   icon: '▶' },
  'deal.risk_detected':   { label: 'RISK',       severity: 'red',    icon: '⚠' },
  'deal.closed':          { label: 'CLOSED',     severity: 'green',  icon: '✓' },
  'opportunity.detected': { label: 'OPPTY',      severity: 'purple', icon: '◉' },
  'activity.created':     { label: 'ACTIVITY',   severity: 'muted',  icon: '○' },
  'message.received':     { label: 'MSG IN',     severity: 'amber',  icon: '◇' },
  'import.completed':     { label: 'IMPORT',     severity: 'cyan',   icon: '▣' },
  'notification.send':    { label: 'ALERT',      severity: 'amber',  icon: '!' },
  'crm.sync_completed':   { label: 'CRM SYNC',   severity: 'muted',  icon: '⟳' },
  'system.connected':     { label: 'LIVE',       severity: 'green',  icon: '●' },
  'snapshot.complete':    { label: 'SNAPSHOT',   severity: 'muted',  icon: '◈' },
};

export const SEV_COLOR: Record<Severity, string> = {
  green:  'var(--green)',
  amber:  'var(--amber)',
  red:    'var(--red)',
  blue:   'var(--blue)',
  cyan:   'var(--cyan)',
  purple: 'var(--purple)',
  muted:  'var(--text-3)',
};
