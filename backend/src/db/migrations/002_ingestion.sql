-- CLOVENT Phase 2 — CRM Ingestion Tables
-- Run after 001_initial.sql

-- ── CRM Credentials (one row per connected CRM per tenant) ───────────────────
CREATE TABLE IF NOT EXISTS crm_credentials (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  crm_type         TEXT NOT NULL CHECK (crm_type IN ('hubspot','salesforce','followupboss','kvcore','generic_rest')),
  label            TEXT NOT NULL DEFAULT '',        -- human label e.g. "Production HubSpot"
  credentials_enc  TEXT NOT NULL,                   -- AES-256-GCM encrypted JSON blob
  settings         JSONB NOT NULL DEFAULT '{}',     -- sync_interval_min, entity_types, etc.
  is_active        BOOLEAN NOT NULL DEFAULT true,
  sync_cursor      TEXT,                            -- last incremental checkpoint (JSON)
  last_synced_at   TIMESTAMPTZ,
  next_sync_at     TIMESTAMPTZ,                     -- computed: last_synced_at + interval
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, crm_type, label)
);
CREATE INDEX idx_crm_creds_tenant     ON crm_credentials(tenant_id);
CREATE INDEX idx_crm_creds_active     ON crm_credentials(is_active, next_sync_at)
  WHERE is_active = true;

-- ── Sync Logs (audit trail for every sync run) ────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_sync_logs (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  credential_id    UUID NOT NULL REFERENCES crm_credentials(id) ON DELETE CASCADE,
  import_id        UUID REFERENCES imports(id) ON DELETE SET NULL,
  crm_type         TEXT NOT NULL,
  sync_type        TEXT NOT NULL CHECK (sync_type IN ('full','incremental','webhook')),
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','partial')),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  stats            JSONB NOT NULL DEFAULT '{"fetched":0,"queued":0,"errors":0}',
  error            TEXT,
  new_cursor       TEXT,                            -- cursor saved after successful sync
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_crm_sync_logs_cred ON crm_sync_logs(credential_id, started_at DESC);
CREATE INDEX idx_crm_sync_logs_tenant ON crm_sync_logs(tenant_id, started_at DESC);

-- ── Webhook Events (raw inbound webhook log) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_webhook_events (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID REFERENCES organizations(id) ON DELETE CASCADE,
  credential_id    UUID REFERENCES crm_credentials(id) ON DELETE SET NULL,
  crm_type         TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}',
  signature        TEXT,
  processed        BOOLEAN NOT NULL DEFAULT false,
  processed_at     TIMESTAMPTZ,
  import_id        UUID REFERENCES imports(id) ON DELETE SET NULL,
  error            TEXT,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_webhook_events_cred    ON crm_webhook_events(credential_id, received_at DESC);
CREATE INDEX idx_webhook_events_pending ON crm_webhook_events(processed, received_at)
  WHERE processed = false;

CREATE TRIGGER trg_crm_credentials_updated_at
  BEFORE UPDATE ON crm_credentials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
