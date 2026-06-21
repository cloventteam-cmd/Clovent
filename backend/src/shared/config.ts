import 'dotenv/config';

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string = ''): string {
  return process.env[key] ?? fallback;
}

export const config = {
  env: optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '3000'), 10),
  isDev: optional('NODE_ENV', 'development') === 'development',

  db: {
    url: optional('DATABASE_URL', 'postgresql://clovent:clovent_secret@localhost:5432/clovent'),
    poolMin: 2,
    poolMax: 20,
  },

  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
  },

  jwt: {
    secret: optional('JWT_SECRET', 'dev_jwt_secret_change_in_production_min_64_chars_xxxxxxxxxxxxxxxx'),
    refreshSecret: optional('JWT_REFRESH_SECRET', 'dev_refresh_secret_change_in_prod_min_64_chars_xxxxxxxxxxxxxxx'),
    expiresIn: optional('JWT_EXPIRES_IN', '15m'),
    refreshExpiresIn: optional('JWT_REFRESH_EXPIRES_IN', '7d'),
  },

  storage: {
    bucket: optional('S3_BUCKET', 'clovent-uploads'),
    region: optional('S3_REGION', 'auto'),
    accessKey: optional('S3_ACCESS_KEY'),
    secretKey: optional('S3_SECRET_KEY'),
    endpoint: optional('S3_ENDPOINT'),
  },

  ai: {
    provider: optional('AI_PROVIDER', 'local'),
    openaiKey: optional('OPENAI_API_KEY'),
    anthropicKey: optional('ANTHROPIC_API_KEY'),
    embeddingDim: 1536,
    modelVersion: '1.0',
  },

  email: {
    provider: optional('EMAIL_PROVIDER', 'resend'),
    apiKey: optional('EMAIL_API_KEY'),
    from: optional('EMAIL_FROM', 'noreply@clovent.ai'),
  },

  sms: {
    accountSid: optional('TWILIO_ACCOUNT_SID'),
    authToken: optional('TWILIO_AUTH_TOKEN'),
    fromNumber: optional('TWILIO_FROM_NUMBER'),
  },

  features: {
    aiScoring: optional('ENABLE_AI_SCORING', 'true') === 'true',
    emailAutomation: optional('ENABLE_EMAIL_AUTOMATION', 'true') === 'true',
    smsAutomation: optional('ENABLE_SMS_AUTOMATION', 'false') === 'true',
  },

  stripe: {
    secretKey:        optional('STRIPE_SECRET_KEY'),
    webhookSecret:    optional('STRIPE_WEBHOOK_SECRET'),
    publishableKey:   optional('STRIPE_PUBLISHABLE_KEY'),
    trialDays:        parseInt(optional('STRIPE_TRIAL_DAYS', '14'), 10),
    // Price IDs (set after running: npx tsx src/billing/stripe-setup.ts)
    starterMonthly:   optional('STRIPE_STARTER_MONTHLY_PRICE_ID'),
    starterAnnual:    optional('STRIPE_STARTER_ANNUAL_PRICE_ID'),
    growthMonthly:    optional('STRIPE_GROWTH_MONTHLY_PRICE_ID'),
    growthAnnual:     optional('STRIPE_GROWTH_ANNUAL_PRICE_ID'),
    proMonthly:       optional('STRIPE_PRO_MONTHLY_PRICE_ID'),
    proAnnual:        optional('STRIPE_PRO_ANNUAL_PRICE_ID'),
    enterpriseMonthly:optional('STRIPE_ENTERPRISE_MONTHLY_PRICE_ID'),
    enterpriseAnnual: optional('STRIPE_ENTERPRISE_ANNUAL_PRICE_ID'),
  },

  saas: {
    // Warn when usage hits this % of plan limit
    usageWarnPct:  parseInt(optional('USAGE_WARN_PCT', '80'), 10),
    // Snapshot daily usage at this cron schedule
    snapshotCron:  optional('USAGE_SNAPSHOT_CRON', '0 0 * * *'), // midnight
    // Enable plan enforcement (set false for dev)
    enforcePlans:  optional('ENFORCE_PLANS', 'true') === 'true',
  },

  imports: {
    maxFileSizeMb: parseInt(optional('IMPORT_MAX_FILE_SIZE_MB', '100'), 10),
    batchSize: parseInt(optional('IMPORT_BATCH_SIZE', '500'), 10),
  },

  queues: (() => {
    const pfx = process.env.QUEUE_PREFIX ?? 'clovent';
    return {
      import:       `${pfx}-import`,
      scoring:      `${pfx}-scoring`,
      opportunity:  `${pfx}-opportunity`,
      campaign:     `${pfx}-campaign`,
      notification: `${pfx}-notification`,
      embedding:    `${pfx}-embedding`,
      dealRisk:     `${pfx}-deal-risk`,
      probability:  `${pfx}-probability`,
      crmSync:      `${pfx}-crm-sync`,
      prediction:   `${pfx}-prediction`,
    };
  })(),

  jobs: {
    opportunityScanCron: '0 6 * * *',    // 6 AM daily
    dealRiskScanCron: '0 * * * *',        // hourly
    dailyBriefingCron: '0 7 * * *',       // 7 AM daily
    scoringBatchCron: '0 */4 * * *',      // every 4 hours
    campaignProcessCron: '*/5 * * * *',   // every 5 minutes
  },
} as const;
