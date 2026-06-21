// Deal stage weights for probability calculation
export const DEAL_STAGE_PROBABILITIES: Record<string, number> = {
  lead: 10,
  nurture: 20,
  active: 40,
  under_contract: 65,
  inspection: 70,
  appraisal: 75,
  financing: 80,
  clear_to_close: 90,
  closed_won: 100,
  closed_lost: 0,
  withdrawn: 0,
};

// Scoring weights for contact scoring engine
export const SCORING_WEIGHTS = {
  recency: {
    contacted_7d: 0.30,
    contacted_30d: 0.20,
    contacted_90d: 0.10,
    contacted_180d: 0.05,
    no_contact: 0,
  },
  activity_type: {
    call: 0.25,
    meeting: 0.30,
    showing: 0.40,
    email: 0.10,
    sms: 0.08,
    note: 0.05,
  },
  deal_signals: {
    active_deal: 0.50,
    past_deal: 0.20,
    no_deal: 0,
  },
  engagement_decay: 0.85, // per 30-day period
  referral_bonus: 0.15,
} as const;

// Opportunity detection thresholds
export const OPPORTUNITY_THRESHOLDS = {
  likely_seller: {
    min_relationship_health: 0.6,
    min_activity_gap_days: 180,
    min_score: 0.5,
  },
  likely_buyer: {
    min_engagement_score: 0.4,
    recent_showing_days: 60,
    min_score: 0.45,
  },
  reactivation: {
    min_gap_days: 120,
    max_gap_days: 730,
    had_past_deal: true,
  },
  referral_opportunity: {
    min_referral_probability: 0.5,
    min_relationship_health: 0.7,
  },
} as const;

// Deal risk thresholds
export const RISK_THRESHOLDS = {
  inspection: { days_no_update: 5, max_issues: 3 },
  appraisal: { days_pending: 14, gap_threshold: 0.05 },
  financing: { days_pending: 21, min_score: 620 },
  closing: { days_remaining: 3, missing_docs: 2 },
} as const;

// CRM field maps
export const CRM_FIELD_MAPS = {
  salesforce: {
    FirstName: 'first_name',
    LastName: 'last_name',
    Email: 'email',
    Phone: 'phone',
    MobilePhone: 'phone_alt',
    MailingCity: 'city',
    MailingState: 'state',
    MailingPostalCode: 'zip',
    LeadSource: 'source',
  },
  hubspot: {
    firstname: 'first_name',
    lastname: 'last_name',
    email: 'email',
    phone: 'phone',
    city: 'city',
    state: 'state',
    zip: 'zip',
    hs_lead_status: 'status',
  },
  followupboss: {
    'First Name': 'first_name',
    'Last Name': 'last_name',
    'Email': 'email',
    'Phone': 'phone',
    'City': 'city',
    'State': 'state',
    'Zip': 'zip',
    'Stage': 'type',
    'Source': 'source',
  },
  kvcore: {
    first_name: 'first_name',
    last_name: 'last_name',
    email: 'email',
    phone_1: 'phone',
    phone_2: 'phone_alt',
    city: 'city',
    state: 'state',
    zip_code: 'zip',
    lead_type: 'type',
    source: 'source',
  },
} as const;

export const EMBEDDING_BATCH_SIZE = 32;
export const SCORING_BATCH_SIZE = 100;
export const MAX_REFERRAL_DEPTH = 5;
