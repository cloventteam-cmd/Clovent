-- CLOVENT Phase 3 — Observability & Production Hardening Tables

-- ── Event log (append-only; partitioned by month in production) ───────────────
CREATE TABLE IF NOT EXISTS event_logs (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID,                          -- null = system event
  event_name     TEXT NOT NULL,
  correlation_id TEXT,
  payload        JSONB,
  source         TEXT,                          -- 'api' | 'worker' | 'cron' | 'webhook'
  duration_ms    INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_event_logs_tenant   ON event_logs(tenant_id, created_at DESC) WHERE tenant_id IS NOT NULL;
CREATE INDEX idx_event_logs_name     ON event_logs(event_name, created_at DESC);
CREATE INDEX idx_event_logs_cid      ON event_logs(correlation_id) WHERE correlation_id IS NOT NULL;

-- ── Event metrics — hourly rollup per tenant per event type ───────────────────
CREATE TABLE IF NOT EXISTS event_metrics (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_name     TEXT NOT NULL,
  period_start   TIMESTAMPTZ NOT NULL,          -- truncated to hour
  count          INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, event_name, period_start)
);
CREATE INDEX idx_event_metrics_tenant ON event_metrics(tenant_id, period_start DESC);
CREATE INDEX idx_event_metrics_name   ON event_metrics(event_name, period_start DESC);

-- ── Job failures — dead letter queue audit table ──────────────────────────────
CREATE TABLE IF NOT EXISTS job_failures (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  queue_name     TEXT NOT NULL,
  job_id         TEXT NOT NULL,
  job_name       TEXT NOT NULL,
  data           JSONB,
  error          TEXT,
  stack          TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  tenant_id      UUID,
  reprocessed    BOOLEAN NOT NULL DEFAULT false,
  reprocessed_at TIMESTAMPTZ,
  reprocess_job_id TEXT,
  failed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(queue_name, job_id)
);
CREATE INDEX idx_job_failures_queue   ON job_failures(queue_name, failed_at DESC);
CREATE INDEX idx_job_failures_tenant  ON job_failures(tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX idx_job_failures_pending ON job_failures(reprocessed, failed_at DESC) WHERE reprocessed = false;

-- ── System health snapshots (written by the cron every minute) ────────────────
CREATE TABLE IF NOT EXISTS health_snapshots (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  status      TEXT NOT NULL CHECK (status IN ('healthy','degraded','down')),
  db_ok       BOOLEAN NOT NULL,
  redis_ok    BOOLEAN NOT NULL,
  worker_ok   BOOLEAN NOT NULL,
  queues      JSONB NOT NULL DEFAULT '{}',
  metrics     JSONB NOT NULL DEFAULT '{}',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_health_snapshots_time ON health_snapshots(captured_at DESC);

-- ── Error tracking — internal error store (no Sentry dependency) ─────────────
CREATE TABLE IF NOT EXISTS error_events (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fingerprint    TEXT NOT NULL,                 -- sha256(type+message) for dedup
  type           TEXT NOT NULL,
  message        TEXT NOT NULL,
  stack          TEXT,
  context        JSONB NOT NULL DEFAULT '{}',
  tenant_id      UUID,
  source         TEXT,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  count          INTEGER NOT NULL DEFAULT 1,
  resolved       BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX idx_error_events_fp ON error_events(fingerprint);
CREATE INDEX idx_error_events_tenant    ON error_events(tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX idx_error_events_unres     ON error_events(last_seen_at DESC) WHERE resolved = false;
