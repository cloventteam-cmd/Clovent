/**
 * CLOVENT Plan Definitions
 *
 * CORE PRINCIPLE: The product FEELS unlimited to users,
 * but every limit is technically bounded and enforced.
 *
 * No `Infinity` or `Number.POSITIVE_INFINITY` anywhere.
 * Enterprise uses very high numbers with soft-cap enforcement.
 *
 *  $49  Starter    — entry access, light AI, hard limits
 *  $99  Growth     — full AI brain, high limits (main product)
 * $199  Pro        — power teams, very high limits + priority
 * $499  Enterprise — brokerage platform, extremely high limits + fair-use caps
 */

export type PlanId = 'starter' | 'growth' | 'pro' | 'enterprise';

// ── Usage limits (ALL finite — no Infinity anywhere) ──────────────────────────
export interface PlanLimits {
  // Data
  contacts_total:              number;
  imports_per_month:           number;
  ingestion_records_per_day:   number;  // total CRM records ingested per day

  // Campaigns
  campaigns_total:             number;
  active_campaigns:            number;

  // AI
  predictions_per_day:         number;
  ai_completions_per_day:      number;

  // API
  api_calls_per_hour:          number;

  // Workers (per-tenant concurrency)
  max_concurrent_imports:      number;
  max_concurrent_predictions:  number;
  worker_jobs_per_hour:        number;  // total BullMQ jobs dispatched per hour

  // Team
  team_members:                number;
  teams:                       number;
  crm_connections:             number;

  // Storage (MB)
  storage_mb:                  number;

  // Webhook inbound rate
  webhook_events_per_hour:     number;
}

// Soft cap thresholds — at what % to warn vs hard-block
export interface SoftCapConfig {
  warning_pct:   number;  // emit BILLING_WARNING
  threshold_pct: number;  // emit USAGE_THRESHOLD (stronger warning)
  hard_pct:      number;  // emit PLAN_LIMIT_REACHED + 402 block
}

export const DEFAULT_SOFT_CAPS: SoftCapConfig = {
  warning_pct:   80,
  threshold_pct: 95,
  hard_pct:      100,
};

// Enterprise uses softer enforcement: warn early, hard block much later
export const ENTERPRISE_SOFT_CAPS: SoftCapConfig = {
  warning_pct:   70,
  threshold_pct: 90,
  hard_pct:      110,   // 10% burst tolerance before hard block
};

// ── Feature flags ─────────────────────────────────────────────────────────────
export interface PlanFeatureFlags {
  ai_basic_scoring:      boolean;
  ai_predictions:        boolean;
  ai_opportunity_radar:  boolean;
  ai_business_operator:  boolean;
  ai_intent_detection:   boolean;
  crm_ingestion:         boolean;
  webhook_ingestion:     boolean;
  bulk_import:           boolean;
  automation_engine:     boolean;
  ai_message_generation: boolean;
  real_time_stream:      boolean;
  pipeline_analytics:    boolean;
  advanced_analytics:    boolean;
  revenue_forecasting:   boolean;
  multi_user:            boolean;
  multi_team:            boolean;
  priority_processing:   boolean;
  rbac_custom_roles:     boolean;
  audit_logs:            boolean;
  enterprise_sso:        boolean;
  dedicated_support:     boolean;
  anomaly_detection:     boolean;  // usage anomaly alerts (Enterprise)
  auto_scaling_workers:  boolean;  // dynamic worker provisioning (Enterprise)
}

// ── Plan ──────────────────────────────────────────────────────────────────────
export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  description: string;
  monthly_price_usd: number;
  annual_price_usd: number;
  annual_savings_pct: number;
  stripe_monthly_price_id: string;
  stripe_annual_price_id: string;
  limits: PlanLimits;
  soft_caps: SoftCapConfig;
  features: PlanFeatureFlags;
  feature_bullets: string[];
  highlighted: boolean;
  badge?: string;
  color: string;
}

function env(key: string) { return process.env[key] ?? ''; }

export const PLANS: Record<PlanId, Plan> = {

  // ── Starter $49/mo ──────────────────────────────────────────────────────────
  starter: {
    id: 'starter',
    name: 'Starter',
    tagline: 'Entry access + basic AI insights',
    description: 'Perfect for solo agents getting started. Hard limits ensure safe onboarding.',
    monthly_price_usd: 49,
    annual_price_usd: 39,
    annual_savings_pct: 20,
    stripe_monthly_price_id: env('STRIPE_STARTER_MONTHLY_PRICE_ID'),
    stripe_annual_price_id:  env('STRIPE_STARTER_ANNUAL_PRICE_ID'),
    soft_caps: { warning_pct: 70, threshold_pct: 90, hard_pct: 100 },
    limits: {
      contacts_total:              1_000,
      imports_per_month:              10,
      ingestion_records_per_day:     500,
      campaigns_total:                 5,
      active_campaigns:                2,
      predictions_per_day:            50,
      ai_completions_per_day:         25,
      api_calls_per_hour:            200,
      max_concurrent_imports:          1,
      max_concurrent_predictions:      1,
      worker_jobs_per_hour:          100,
      team_members:                    1,
      teams:                           0,
      crm_connections:                 0,
      storage_mb:                  1_024,   // 1 GB
      webhook_events_per_hour:         0,
    },
    features: {
      ai_basic_scoring:      true,
      ai_predictions:        false,
      ai_opportunity_radar:  false,
      ai_business_operator:  false,
      ai_intent_detection:   false,
      crm_ingestion:         false,
      webhook_ingestion:     false,
      bulk_import:           true,
      automation_engine:     false,
      ai_message_generation: false,
      real_time_stream:      false,
      pipeline_analytics:    false,
      advanced_analytics:    false,
      revenue_forecasting:   false,
      multi_user:            false,
      multi_team:            false,
      priority_processing:   false,
      rbac_custom_roles:     false,
      audit_logs:            false,
      enterprise_sso:        false,
      dedicated_support:     false,
      anomaly_detection:     false,
      auto_scaling_workers:  false,
    },
    feature_bullets: [
      '1,000 contacts',
      '10 imports / month',
      'AI contact scoring (basic)',
      'Activity tracking + deal pipeline',
      '5 campaigns (2 active)',
      'Email support',
    ],
    highlighted: false,
    color: '#00aaff',
  },

  // ── Growth $99/mo (MAIN PRODUCT) ────────────────────────────────────────────
  growth: {
    id: 'growth',
    name: 'Growth',
    tagline: 'The complete AI brain for real estate',
    description: 'Full AI intelligence with high limits — the core CLOVENT experience.',
    monthly_price_usd: 99,
    annual_price_usd: 79,
    annual_savings_pct: 20,
    stripe_monthly_price_id: env('STRIPE_GROWTH_MONTHLY_PRICE_ID'),
    stripe_annual_price_id:  env('STRIPE_GROWTH_ANNUAL_PRICE_ID'),
    soft_caps: { warning_pct: 80, threshold_pct: 95, hard_pct: 100 },
    limits: {
      contacts_total:             25_000,
      imports_per_month:             100,
      ingestion_records_per_day:  10_000,
      campaigns_total:                50,
      active_campaigns:               10,
      predictions_per_day:         5_000,
      ai_completions_per_day:        500,
      api_calls_per_hour:          2_000,
      max_concurrent_imports:          5,
      max_concurrent_predictions:      5,
      worker_jobs_per_hour:        2_000,
      team_members:                    5,
      teams:                           0,
      crm_connections:                 3,
      storage_mb:                 20_480,   // 20 GB
      webhook_events_per_hour:       500,
    },
    features: {
      ai_basic_scoring:      true,
      ai_predictions:        true,
      ai_opportunity_radar:  true,
      ai_business_operator:  true,
      ai_intent_detection:   true,
      crm_ingestion:         true,
      webhook_ingestion:     true,
      bulk_import:           true,
      automation_engine:     true,
      ai_message_generation: true,
      real_time_stream:      true,
      pipeline_analytics:    true,
      advanced_analytics:    false,
      revenue_forecasting:   false,
      multi_user:            true,
      multi_team:            false,
      priority_processing:   false,
      rbac_custom_roles:     false,
      audit_logs:            false,
      enterprise_sso:        false,
      dedicated_support:     false,
      anomaly_detection:     false,
      auto_scaling_workers:  false,
    },
    feature_bullets: [
      '25,000 contacts',
      '100 imports / month · 10K records/day ingestion',
      'FULL AI prediction engine (seller/buyer/risk/reactivation)',
      'Opportunity radar (7 signal types)',
      'AI Business Operator — daily briefing',
      'CRM ingestion (HubSpot, Salesforce, FUB)',
      'Email + SMS automation campaigns',
      'Real-time live dashboard (SSE)',
      'AI message generation + NLP intent detection',
      '5 team members · 3 CRM connections',
      'Priority email support',
    ],
    highlighted: true,
    badge: 'BEST VALUE',
    color: '#00ff41',
  },

  // ── Pro $199/mo ─────────────────────────────────────────────────────────────
  pro: {
    id: 'pro',
    name: 'Pro',
    tagline: 'Scale, teams, and advanced intelligence',
    description: 'Everything in Growth with very high limits, priority processing, and multi-team support.',
    monthly_price_usd: 199,
    annual_price_usd: 159,
    annual_savings_pct: 20,
    stripe_monthly_price_id: env('STRIPE_PRO_MONTHLY_PRICE_ID'),
    stripe_annual_price_id:  env('STRIPE_PRO_ANNUAL_PRICE_ID'),
    soft_caps: { warning_pct: 80, threshold_pct: 95, hard_pct: 100 },
    limits: {
      contacts_total:            100_000,
      imports_per_month:             500,
      ingestion_records_per_day:  50_000,
      campaigns_total:               200,
      active_campaigns:               50,
      predictions_per_day:        25_000,
      ai_completions_per_day:      2_500,
      api_calls_per_hour:          5_000,
      max_concurrent_imports:         10,
      max_concurrent_predictions:     10,
      worker_jobs_per_hour:       10_000,
      team_members:                   20,
      teams:                           5,
      crm_connections:                10,
      storage_mb:                102_400,   // 100 GB
      webhook_events_per_hour:     2_000,
    },
    features: {
      ai_basic_scoring:      true,
      ai_predictions:        true,
      ai_opportunity_radar:  true,
      ai_business_operator:  true,
      ai_intent_detection:   true,
      crm_ingestion:         true,
      webhook_ingestion:     true,
      bulk_import:           true,
      automation_engine:     true,
      ai_message_generation: true,
      real_time_stream:      true,
      pipeline_analytics:    true,
      advanced_analytics:    true,
      revenue_forecasting:   true,
      multi_user:            true,
      multi_team:            true,
      priority_processing:   true,
      rbac_custom_roles:     false,
      audit_logs:            false,
      enterprise_sso:        false,
      dedicated_support:     false,
      anomaly_detection:     false,
      auto_scaling_workers:  false,
    },
    feature_bullets: [
      '100,000 contacts',
      '500 imports / month · 50K records/day',
      'Everything in Growth',
      'Advanced analytics + revenue forecasting',
      '20 team members · 5 teams',
      'Priority job queue processing',
      'All 10 CRM connectors',
      '100 GB storage',
      'Phone support',
    ],
    highlighted: false,
    color: '#ffaa00',
  },

  // ── Enterprise $499/mo ───────────────────────────────────────────────────────
  // NOT unlimited — uses extremely high numbers + soft-cap burst tolerance.
  // Fair-use policy enforced at 110% of stated limit.
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'Brokerage-grade platform — effectively unlimited, technically safe',
    description: 'For large brokerages. Extremely high limits with fair-use enforcement and anomaly detection.',
    monthly_price_usd: 499,
    annual_price_usd: 399,
    annual_savings_pct: 20,
    stripe_monthly_price_id: env('STRIPE_ENTERPRISE_MONTHLY_PRICE_ID'),
    stripe_annual_price_id:  env('STRIPE_ENTERPRISE_ANNUAL_PRICE_ID'),
    soft_caps: ENTERPRISE_SOFT_CAPS,   // 70%/90%/110% — generous burst window
    limits: {
      contacts_total:          1_000_000,   // 1M contacts
      imports_per_month:           5_000,
      ingestion_records_per_day:  500_000,
      campaigns_total:             10_000,
      active_campaigns:              1_000,
      predictions_per_day:         500_000,
      ai_completions_per_day:       50_000,
      api_calls_per_hour:           20_000,
      max_concurrent_imports:           25,
      max_concurrent_predictions:       25,
      worker_jobs_per_hour:        100_000,
      team_members:                  2_000,
      teams:                           200,
      crm_connections:                  50,
      storage_mb:                1_048_576,  // 1 TB
      webhook_events_per_hour:      20_000,
    },
    features: {
      ai_basic_scoring:      true,
      ai_predictions:        true,
      ai_opportunity_radar:  true,
      ai_business_operator:  true,
      ai_intent_detection:   true,
      crm_ingestion:         true,
      webhook_ingestion:     true,
      bulk_import:           true,
      automation_engine:     true,
      ai_message_generation: true,
      real_time_stream:      true,
      pipeline_analytics:    true,
      advanced_analytics:    true,
      revenue_forecasting:   true,
      multi_user:            true,
      multi_team:            true,
      priority_processing:   true,
      rbac_custom_roles:     true,
      audit_logs:            true,
      enterprise_sso:        true,
      dedicated_support:     true,
      anomaly_detection:     true,   // usage spike detection
      auto_scaling_workers:  true,   // dynamic worker provisioning
    },
    feature_bullets: [
      '1,000,000 contacts (with fair-use enforcement)',
      '5,000 imports / month · 500K records/day',
      'Everything in Pro',
      'Full RBAC (custom roles + permissions)',
      'Complete audit trail',
      '2,000 team members · 200 teams',
      'Usage anomaly detection + alerting',
      'Dynamic auto-scaling worker support',
      'Enterprise SSO / SAML',
      '1 TB storage',
      'Dedicated CSM + SLA (99.9% uptime)',
      'White-label option',
    ],
    highlighted: false,
    color: '#8855ff',
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
export function getPlan(planId: PlanId | string): Plan {
  return PLANS[planId as PlanId] ?? PLANS.starter;
}

export function getLimits(planId: PlanId | string): PlanLimits {
  return getPlan(planId).limits;
}

export function getSoftCaps(planId: PlanId | string): SoftCapConfig {
  return getPlan(planId).soft_caps;
}

export function getFeatures(planId: PlanId | string): PlanFeatureFlags {
  return getPlan(planId).features;
}

export function hasFeature(planId: PlanId | string, feature: keyof PlanFeatureFlags): boolean {
  return getFeatures(planId)[feature] ?? false;
}

// All limits are now finite — these helpers remain but never receive Infinity
export function isWithinLimit(current: number, limit: number): boolean {
  return current < limit;
}

export function isWithinSoftCap(current: number, limit: number, hardPct: number): boolean {
  return current < limit * (hardPct / 100);
}

export function usagePct(current: number, limit: number): number {
  return Math.min((current / limit) * 100, 999); // cap display at 999%
}

export function isAtThreshold(current: number, limit: number, thresholdPct: number): boolean {
  return usagePct(current, limit) >= thresholdPct;
}

export function formatLimit(limit: number): string {
  if (limit >= 1_000_000) return `${(limit / 1_000_000).toFixed(0)}M`;
  if (limit >= 1_000)     return `${(limit / 1_000).toFixed(0)}K`;
  return limit.toLocaleString();
}

export function formatLimitFull(limit: number, planId?: PlanId | string): string {
  const formatted = formatLimit(limit);
  // For Enterprise, add "fair use" note on very large limits
  if (planId === 'enterprise' && limit >= 100_000) {
    return `${formatted} *`;
  }
  return formatted;
}

export function getMinPlanForFeature(feature: keyof PlanFeatureFlags): PlanId {
  for (const planId of PLAN_ORDER) {
    if (PLANS[planId].features[feature]) return planId;
  }
  return 'enterprise';
}

export const PLAN_ORDER: PlanId[] = ['starter', 'growth', 'pro', 'enterprise'];

export function isPlanAtLeast(current: PlanId | string, minimum: PlanId): boolean {
  return PLAN_ORDER.indexOf(current as PlanId) >= PLAN_ORDER.indexOf(minimum);
}
