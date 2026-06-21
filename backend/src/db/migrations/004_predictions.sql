-- CLOVENT Phase 4 — AI Prediction Engine Tables

-- ── Predictions (one row per contact+type+run) ────────────────────────────────
CREATE TABLE IF NOT EXISTS predictions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id       UUID REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id          UUID REFERENCES deals(id) ON DELETE SET NULL,
  prediction_type  TEXT NOT NULL CHECK (prediction_type IN (
    'seller_30d','seller_60d','seller_90d',
    'buyer_30d','buyer_60d','buyer_90d',
    'reactivation_30d','reactivation_60d',
    'deal_failure','going_cold'
  )),
  probability      NUMERIC(5,4) NOT NULL DEFAULT 0,   -- 0-1 predicted likelihood
  confidence       NUMERIC(5,4) NOT NULL DEFAULT 0,   -- 0-1 model confidence
  horizon_days     INTEGER NOT NULL,                  -- prediction window
  signals          JSONB NOT NULL DEFAULT '[]',       -- driving signals audit trail
  model_version    TEXT NOT NULL DEFAULT '1.0',
  comparables_used INTEGER NOT NULL DEFAULT 0,        -- # similar contacts used
  expires_at       TIMESTAMPTZ,
  is_actioned      BOOLEAN NOT NULL DEFAULT false,
  actioned_at      TIMESTAMPTZ,
  outcome          TEXT CHECK (outcome IN ('correct','incorrect','unknown')),
  batch_run_id     TEXT,                              -- links predictions from same run
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_predictions_tenant   ON predictions(tenant_id, prediction_type, probability DESC);
CREATE INDEX idx_predictions_contact  ON predictions(contact_id, prediction_type, created_at DESC)
  WHERE contact_id IS NOT NULL;
CREATE INDEX idx_predictions_deal     ON predictions(deal_id, created_at DESC)
  WHERE deal_id IS NOT NULL;
CREATE INDEX idx_predictions_active   ON predictions(tenant_id, probability DESC, expires_at)
  WHERE is_actioned = false;
CREATE INDEX idx_predictions_batch    ON predictions(batch_run_id) WHERE batch_run_id IS NOT NULL;

-- ── Intent signals cache (NLP phrase matches from messages) ───────────────────
CREATE TABLE IF NOT EXISTS intent_signals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  signal_category TEXT NOT NULL CHECK (signal_category IN ('seller','buyer','cold','reactivation','investor')),
  phrase_matched  TEXT NOT NULL,
  message_id      UUID REFERENCES messages(id) ON DELETE SET NULL,
  activity_id     UUID REFERENCES activities(id) ON DELETE SET NULL,
  weight          NUMERIC(4,3) NOT NULL DEFAULT 0,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decayed_weight  NUMERIC(4,3),                      -- weight after temporal decay
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '90 days',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Functional unique index: one match per phrase per contact per day
CREATE UNIQUE INDEX IF NOT EXISTS uix_intent_daily
  ON intent_signals(contact_id, signal_category, phrase_matched, (detected_at::date));
CREATE INDEX idx_intent_contact  ON intent_signals(contact_id, signal_category, detected_at DESC);
CREATE INDEX idx_intent_active   ON intent_signals(tenant_id, expires_at) WHERE expires_at > NOW();

-- ── Behavioral patterns (aggregated per contact for trend analysis) ───────────
CREATE TABLE IF NOT EXISTS behavioral_patterns (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id             UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Activity rate windows
  activity_rate_7d       NUMERIC(8,4) NOT NULL DEFAULT 0,   -- activities per day (7d window)
  activity_rate_30d      NUMERIC(8,4) NOT NULL DEFAULT 0,
  activity_rate_90d      NUMERIC(8,4) NOT NULL DEFAULT 0,
  activity_rate_180d     NUMERIC(8,4) NOT NULL DEFAULT 0,
  -- Trend direction
  engagement_trend       TEXT NOT NULL DEFAULT 'stable' CHECK (engagement_trend IN ('rising','stable','declining','dormant','reactivating')),
  trend_change_pct       NUMERIC(7,2) NOT NULL DEFAULT 0,   -- % change 30d vs 90d
  -- Message intent aggregate
  seller_intent_score    NUMERIC(5,4) NOT NULL DEFAULT 0,
  buyer_intent_score     NUMERIC(5,4) NOT NULL DEFAULT 0,
  -- Pattern timestamps
  last_activity_gap_days INTEGER NOT NULL DEFAULT 0,        -- days since last activity
  peak_activity_date     DATE,                              -- when was contact most active
  dormant_since          DATE,                              -- when they went quiet
  reactivated_at         DATE,                              -- when they came back
  -- Comparable similarity
  similar_contact_ids    UUID[] NOT NULL DEFAULT '{}',      -- top-5 pgvector neighbors
  computed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(contact_id)
);
CREATE INDEX idx_behavioral_tenant  ON behavioral_patterns(tenant_id, engagement_trend);
CREATE INDEX idx_behavioral_contact ON behavioral_patterns(contact_id);
CREATE INDEX idx_behavioral_intent  ON behavioral_patterns(tenant_id, seller_intent_score DESC, buyer_intent_score DESC);

CREATE TRIGGER trg_predictions_updated
  BEFORE UPDATE ON predictions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
