-- CLOVENT Phase 5 — SaaS Monetization + Scaling Tables

-- ── Subscriptions (one active row per tenant) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id               UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_customer_id      TEXT UNIQUE,
  stripe_subscription_id  TEXT UNIQUE,
  stripe_price_id         TEXT,
  plan                    TEXT NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter','growth','enterprise')),
  status                  TEXT NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('trialing','active','past_due','cancelled','paused','unpaid')),
  trial_start             TIMESTAMPTZ,
  trial_end               TIMESTAMPTZ,
  current_period_start    TIMESTAMPTZ,
  current_period_end      TIMESTAMPTZ,
  cancel_at_period_end    BOOLEAN NOT NULL DEFAULT false,
  cancelled_at            TIMESTAMPTZ,
  seats                   INTEGER NOT NULL DEFAULT 3,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_subscriptions_stripe_cust ON subscriptions(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX idx_subscriptions_status      ON subscriptions(status);

-- ── Usage metrics (hourly rollup per tenant per feature) ──────────────────────
CREATE TABLE IF NOT EXISTS usage_metrics (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  metric_type    TEXT NOT NULL CHECK (metric_type IN (
    'api_calls','contacts_created','imports_started','predictions_run',
    'campaigns_sent','crm_syncs','ai_completions','worker_jobs',
    'events_emitted','webhook_received'
  )),
  period_start   TIMESTAMPTZ NOT NULL,
  period_type    TEXT NOT NULL DEFAULT 'hour' CHECK (period_type IN ('hour','day','month')),
  count          INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, metric_type, period_start, period_type)
);
CREATE INDEX idx_usage_tenant  ON usage_metrics(tenant_id, metric_type, period_start DESC);
CREATE INDEX idx_usage_type    ON usage_metrics(metric_type, period_start DESC);

-- ── Usage snapshots (daily totals for billing) ────────────────────────────────
CREATE TABLE IF NOT EXISTS usage_snapshots (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  snapshot_date  DATE NOT NULL,
  contacts_total INTEGER NOT NULL DEFAULT 0,
  deals_total    INTEGER NOT NULL DEFAULT 0,
  api_calls_day  INTEGER NOT NULL DEFAULT 0,
  imports_month  INTEGER NOT NULL DEFAULT 0,
  predictions_day INTEGER NOT NULL DEFAULT 0,
  campaigns_active INTEGER NOT NULL DEFAULT 0,
  team_members   INTEGER NOT NULL DEFAULT 0,
  storage_bytes  BIGINT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, snapshot_date)
);
CREATE INDEX idx_snapshots_tenant ON usage_snapshots(tenant_id, snapshot_date DESC);

-- ── Audit logs (every action, every user) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  action         TEXT NOT NULL,             -- e.g. 'contact.create', 'deal.delete'
  entity_type    TEXT,
  entity_id      UUID,
  changes        JSONB,                     -- before/after diff for mutations
  ip_address     TEXT,
  user_agent     TEXT,
  correlation_id TEXT,
  status         TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success','denied','error')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_tenant  ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX idx_audit_user    ON audit_logs(user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX idx_audit_entity  ON audit_logs(entity_type, entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX idx_audit_action  ON audit_logs(tenant_id, action, created_at DESC);

-- ── Teams (sub-groups within an org) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teams (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  settings   JSONB NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, name)
);
CREATE INDEX idx_teams_tenant ON teams(tenant_id);

-- ── Team members ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS team_members (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  team_id   UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('lead','member','readonly')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(team_id, user_id)
);
CREATE INDEX idx_team_members_team ON team_members(team_id);
CREATE INDEX idx_team_members_user ON team_members(user_id);

-- ── Billing events log ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_events (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID REFERENCES organizations(id) ON DELETE SET NULL,
  stripe_event_id   TEXT UNIQUE,
  event_type        TEXT NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}',
  processed         BOOLEAN NOT NULL DEFAULT false,
  processed_at      TIMESTAMPTZ,
  error             TEXT,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_billing_events_tenant  ON billing_events(tenant_id, received_at DESC);
CREATE INDEX idx_billing_events_pending ON billing_events(processed, received_at) WHERE processed = false;

CREATE TRIGGER trg_subscriptions_updated
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_teams_updated
  BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
