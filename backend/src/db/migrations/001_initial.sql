-- CLOVENT — Full PostgreSQL Schema
-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================
-- ORGANIZATIONS (Tenant Root)
-- ============================================================
CREATE TABLE organizations (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  plan          TEXT NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter','growth','enterprise')),
  settings      JSONB NOT NULL DEFAULT '{}',
  timezone      TEXT NOT NULL DEFAULT 'America/New_York',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  trial_ends_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_organizations_slug ON organizations(slug);

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email            TEXT NOT NULL,
  password_hash    TEXT NOT NULL,
  first_name       TEXT NOT NULL,
  last_name        TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('owner','admin','agent','viewer')),
  avatar_url       TEXT,
  phone            TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  last_login_at    TIMESTAMPTZ,
  email_verified   BOOLEAN NOT NULL DEFAULT false,
  settings         JSONB NOT NULL DEFAULT '{}',
  refresh_token    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, email)
);
CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_users_email ON users(email);

-- ============================================================
-- CONTACTS
-- ============================================================
CREATE TABLE contacts (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id                 UUID REFERENCES users(id) ON DELETE SET NULL,
  first_name               TEXT NOT NULL DEFAULT '',
  last_name                TEXT NOT NULL DEFAULT '',
  email                    TEXT,
  phone                    TEXT,
  phone_alt                TEXT,
  address_line1            TEXT,
  address_line2            TEXT,
  city                     TEXT,
  state                    TEXT,
  zip                      TEXT,
  country                  TEXT DEFAULT 'US',
  type                     TEXT NOT NULL DEFAULT 'lead' CHECK (type IN ('lead','client','past_client','referral_partner','vendor','investor')),
  status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived','do_not_contact')),
  source                   TEXT,
  source_detail            TEXT,
  tags                     TEXT[] NOT NULL DEFAULT '{}',
  custom_fields            JSONB NOT NULL DEFAULT '{}',
  -- Relationship scores (updated by scoring engine)
  buyer_probability        NUMERIC(5,4) NOT NULL DEFAULT 0,
  seller_probability       NUMERIC(5,4) NOT NULL DEFAULT 0,
  investor_probability     NUMERIC(5,4) NOT NULL DEFAULT 0,
  referral_probability     NUMERIC(5,4) NOT NULL DEFAULT 0,
  engagement_score         NUMERIC(5,4) NOT NULL DEFAULT 0,
  relationship_health      NUMERIC(5,4) NOT NULL DEFAULT 0.5,
  -- Import tracking
  external_id              TEXT,
  external_source          TEXT,
  import_id                UUID,
  -- Timestamps
  last_contacted_at        TIMESTAMPTZ,
  next_followup_at         TIMESTAMPTZ,
  birthday                 DATE,
  anniversary              DATE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_contacts_tenant ON contacts(tenant_id);
CREATE INDEX idx_contacts_owner ON contacts(owner_id);
CREATE INDEX idx_contacts_email ON contacts(tenant_id, email) WHERE email IS NOT NULL;
CREATE INDEX idx_contacts_phone ON contacts(tenant_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX idx_contacts_type ON contacts(tenant_id, type);
CREATE INDEX idx_contacts_status ON contacts(tenant_id, status);
CREATE INDEX idx_contacts_scores ON contacts(tenant_id, buyer_probability DESC, seller_probability DESC);
CREATE INDEX idx_contacts_tags ON contacts USING gin(tags);
CREATE INDEX idx_contacts_external ON contacts(tenant_id, external_source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_contacts_name_trgm ON contacts USING gin((first_name || ' ' || last_name) gin_trgm_ops);

-- ============================================================
-- PROPERTIES
-- ============================================================
CREATE TABLE properties (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  address_line1    TEXT NOT NULL,
  address_line2    TEXT,
  city             TEXT NOT NULL,
  state            TEXT NOT NULL,
  zip              TEXT NOT NULL,
  country          TEXT NOT NULL DEFAULT 'US',
  property_type    TEXT NOT NULL DEFAULT 'residential' CHECK (property_type IN ('residential','commercial','land','multifamily','industrial','mixed_use')),
  bedrooms         INTEGER,
  bathrooms        NUMERIC(4,1),
  sqft             INTEGER,
  lot_size         NUMERIC(10,2),
  year_built       INTEGER,
  list_price       BIGINT,
  sale_price       BIGINT,
  estimated_value  BIGINT,
  mls_number       TEXT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','sold','off_market','expired','withdrawn')),
  features         JSONB NOT NULL DEFAULT '{}',
  external_id      TEXT,
  external_source  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_properties_tenant ON properties(tenant_id);
CREATE INDEX idx_properties_status ON properties(tenant_id, status);
CREATE INDEX idx_properties_mls ON properties(tenant_id, mls_number) WHERE mls_number IS NOT NULL;

-- ============================================================
-- DEALS
-- ============================================================
CREATE TABLE deals (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  contact_id           UUID REFERENCES contacts(id) ON DELETE SET NULL,
  property_id          UUID REFERENCES properties(id) ON DELETE SET NULL,
  name                 TEXT NOT NULL,
  type                 TEXT NOT NULL DEFAULT 'buyer' CHECK (type IN ('buyer','seller','lease','referral','investment')),
  stage                TEXT NOT NULL DEFAULT 'lead' CHECK (stage IN (
    'lead','nurture','active','under_contract','inspection','appraisal',
    'financing','clear_to_close','closed_won','closed_lost','withdrawn'
  )),
  pipeline             TEXT NOT NULL DEFAULT 'residential',
  price                BIGINT,
  commission_rate      NUMERIC(6,4),
  commission_amount    BIGINT,
  probability          INTEGER NOT NULL DEFAULT 25 CHECK (probability >= 0 AND probability <= 100),
  risk_score           NUMERIC(5,4) NOT NULL DEFAULT 0,
  failure_probability  NUMERIC(5,4) NOT NULL DEFAULT 0,
  expected_close_date  DATE,
  actual_close_date    DATE,
  lost_reason          TEXT,
  notes                TEXT,
  tags                 TEXT[] NOT NULL DEFAULT '{}',
  custom_fields        JSONB NOT NULL DEFAULT '{}',
  source               TEXT,
  external_id          TEXT,
  external_source      TEXT,
  import_id            UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_deals_tenant ON deals(tenant_id);
CREATE INDEX idx_deals_owner ON deals(owner_id);
CREATE INDEX idx_deals_contact ON deals(contact_id);
CREATE INDEX idx_deals_stage ON deals(tenant_id, stage);
CREATE INDEX idx_deals_close_date ON deals(tenant_id, expected_close_date);
CREATE INDEX idx_deals_risk ON deals(tenant_id, risk_score DESC);

-- ============================================================
-- ACTIVITIES
-- ============================================================
CREATE TABLE activities (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  contact_id     UUID REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id        UUID REFERENCES deals(id) ON DELETE SET NULL,
  type           TEXT NOT NULL CHECK (type IN (
    'call','email','sms','note','meeting','showing','offer','contract',
    'inspection','appraisal','closing','task_completed','import','system'
  )),
  direction      TEXT CHECK (direction IN ('inbound','outbound')),
  subject        TEXT,
  body           TEXT,
  duration_sec   INTEGER,
  outcome        TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}',
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_activities_tenant ON activities(tenant_id);
CREATE INDEX idx_activities_contact ON activities(contact_id, occurred_at DESC);
CREATE INDEX idx_activities_deal ON activities(deal_id, occurred_at DESC);
CREATE INDEX idx_activities_type ON activities(tenant_id, type, occurred_at DESC);
CREATE INDEX idx_activities_occurred ON activities(tenant_id, occurred_at DESC);

-- ============================================================
-- TASKS
-- ============================================================
CREATE TABLE tasks (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  contact_id      UUID REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id         UUID REFERENCES deals(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  type            TEXT NOT NULL DEFAULT 'general' CHECK (type IN ('call','email','meeting','follow_up','document','general')),
  priority        TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','cancelled','snoozed')),
  due_at          TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  snoozed_until   TIMESTAMPTZ,
  ai_generated    BOOLEAN NOT NULL DEFAULT false,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tasks_tenant ON tasks(tenant_id);
CREATE INDEX idx_tasks_user ON tasks(user_id, status, due_at);
CREATE INDEX idx_tasks_contact ON tasks(contact_id);
CREATE INDEX idx_tasks_deal ON tasks(deal_id);
CREATE INDEX idx_tasks_due ON tasks(tenant_id, due_at) WHERE status = 'pending';

-- ============================================================
-- MESSAGES (Email/SMS/Chat log)
-- ============================================================
CREATE TABLE messages (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  contact_id       UUID REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id          UUID REFERENCES deals(id) ON DELETE SET NULL,
  channel          TEXT NOT NULL CHECK (channel IN ('email','sms','phone','chat','whatsapp')),
  direction        TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_address     TEXT,
  to_address       TEXT,
  subject          TEXT,
  body             TEXT NOT NULL DEFAULT '',
  html_body        TEXT,
  status           TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('draft','queued','sent','delivered','read','bounced','failed')),
  external_id      TEXT,
  thread_id        TEXT,
  campaign_id      UUID,
  metadata         JSONB NOT NULL DEFAULT '{}',
  sent_at          TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  read_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_messages_tenant ON messages(tenant_id);
CREATE INDEX idx_messages_contact ON messages(contact_id, sent_at DESC);
CREATE INDEX idx_messages_deal ON messages(deal_id);
CREATE INDEX idx_messages_campaign ON messages(campaign_id);
CREATE INDEX idx_messages_thread ON messages(thread_id) WHERE thread_id IS NOT NULL;

-- ============================================================
-- CAMPAIGNS
-- ============================================================
CREATE TABLE campaigns (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  description      TEXT,
  type             TEXT NOT NULL DEFAULT 'email' CHECK (type IN ('email','sms','multi_channel','drip')),
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','active','paused','completed','archived')),
  segment_rules    JSONB NOT NULL DEFAULT '{}',
  trigger_rules    JSONB NOT NULL DEFAULT '{}',
  sequence         JSONB NOT NULL DEFAULT '[]',
  settings         JSONB NOT NULL DEFAULT '{}',
  stats            JSONB NOT NULL DEFAULT '{"sent":0,"delivered":0,"opened":0,"clicked":0,"replied":0,"unsubscribed":0}',
  scheduled_at     TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_campaigns_tenant ON campaigns(tenant_id);
CREATE INDEX idx_campaigns_status ON campaigns(tenant_id, status);

-- ============================================================
-- CAMPAIGN CONTACTS (junction)
-- ============================================================
CREATE TABLE campaign_contacts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id   UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id    UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled','active','completed','unsubscribed','bounced')),
  current_step  INTEGER NOT NULL DEFAULT 0,
  enrolled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at  TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(campaign_id, contact_id)
);
CREATE INDEX idx_campaign_contacts_campaign ON campaign_contacts(campaign_id);
CREATE INDEX idx_campaign_contacts_contact ON campaign_contacts(contact_id);

-- ============================================================
-- REFERRALS
-- ============================================================
CREATE TABLE referrals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  referrer_id     UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  referred_id     UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id         UUID REFERENCES deals(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','converted','lost')),
  source          TEXT,
  notes           TEXT,
  referral_fee    BIGINT,
  depth           INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_referrals_tenant ON referrals(tenant_id);
CREATE INDEX idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX idx_referrals_referred ON referrals(referred_id);

-- ============================================================
-- TRANSACTIONS (Financial records)
-- ============================================================
CREATE TABLE transactions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id           UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id        UUID REFERENCES contacts(id) ON DELETE SET NULL,
  type              TEXT NOT NULL CHECK (type IN ('commission','referral_fee','bonus','expense','other')),
  amount            BIGINT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','received','disbursed','cancelled')),
  description       TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}',
  transaction_date  DATE NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_transactions_tenant ON transactions(tenant_id);
CREATE INDEX idx_transactions_deal ON transactions(deal_id);
CREATE INDEX idx_transactions_date ON transactions(tenant_id, transaction_date DESC);

-- ============================================================
-- OPPORTUNITIES (AI-detected)
-- ============================================================
CREATE TABLE opportunities (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id       UUID REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id          UUID REFERENCES deals(id) ON DELETE SET NULL,
  type             TEXT NOT NULL CHECK (type IN (
    'likely_seller','likely_buyer','reactivation','referral_opportunity',
    'deal_risk','investment_opportunity','upsell'
  )),
  priority         TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed','expired','converted')),
  score            NUMERIC(5,4) NOT NULL DEFAULT 0,
  confidence       NUMERIC(5,4) NOT NULL DEFAULT 0,
  title            TEXT NOT NULL,
  description      TEXT,
  recommended_action TEXT,
  signals          JSONB NOT NULL DEFAULT '[]',
  expires_at       TIMESTAMPTZ,
  actioned_at      TIMESTAMPTZ,
  actioned_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  job_run_id       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_opportunities_tenant ON opportunities(tenant_id, status, priority DESC);
CREATE INDEX idx_opportunities_contact ON opportunities(contact_id);
CREATE INDEX idx_opportunities_type ON opportunities(tenant_id, type, status);
CREATE INDEX idx_opportunities_score ON opportunities(tenant_id, score DESC) WHERE status = 'open';

-- ============================================================
-- IMPORTS
-- ============================================================
CREATE TABLE imports (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  source_type      TEXT NOT NULL CHECK (source_type IN ('csv','excel','salesforce','hubspot','followupboss','kvcore','gmail','outlook','twilio','manual')),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','previewing','preview_ready','committing','completed','failed','cancelled')),
  file_path        TEXT,
  file_size        BIGINT,
  original_filename TEXT,
  field_mapping    JSONB NOT NULL DEFAULT '{}',
  options          JSONB NOT NULL DEFAULT '{}',
  stats            JSONB NOT NULL DEFAULT '{"total":0,"processed":0,"created":0,"updated":0,"skipped":0,"errors":0}',
  error_log        JSONB NOT NULL DEFAULT '[]',
  preview_data     JSONB,
  job_id           TEXT,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_imports_tenant ON imports(tenant_id);
CREATE INDEX idx_imports_status ON imports(tenant_id, status);

-- ============================================================
-- IMPORT ROWS (Row-level tracking for large imports)
-- ============================================================
CREATE TABLE import_rows (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  import_id    UUID NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  row_index    INTEGER NOT NULL,
  raw_data     JSONB NOT NULL DEFAULT '{}',
  mapped_data  JSONB NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','created','updated','skipped','error','merged')),
  entity_type  TEXT CHECK (entity_type IN ('contact','deal','property','activity')),
  entity_id    UUID,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_import_rows_import ON import_rows(import_id, status);
CREATE INDEX idx_import_rows_entity ON import_rows(entity_type, entity_id) WHERE entity_id IS NOT NULL;

-- ============================================================
-- AI EMBEDDINGS (pgvector)
-- ============================================================
CREATE TABLE embeddings (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type    TEXT NOT NULL CHECK (entity_type IN ('contact','deal','activity','message','note','property')),
  entity_id      UUID NOT NULL,
  chunk_index    INTEGER NOT NULL DEFAULT 0,
  content        TEXT NOT NULL,
  embedding      vector(1536),
  metadata       JSONB NOT NULL DEFAULT '{}',
  model          TEXT NOT NULL DEFAULT 'local-tfidf',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_embeddings_tenant ON embeddings(tenant_id, entity_type);
CREATE INDEX idx_embeddings_entity ON embeddings(entity_type, entity_id);
CREATE INDEX idx_embeddings_vector ON embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================
-- CONTACT SCORES (historical)
-- ============================================================
CREATE TABLE contact_scores (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id           UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  buyer_probability    NUMERIC(5,4) NOT NULL DEFAULT 0,
  seller_probability   NUMERIC(5,4) NOT NULL DEFAULT 0,
  investor_probability NUMERIC(5,4) NOT NULL DEFAULT 0,
  referral_probability NUMERIC(5,4) NOT NULL DEFAULT 0,
  engagement_score     NUMERIC(5,4) NOT NULL DEFAULT 0,
  relationship_health  NUMERIC(5,4) NOT NULL DEFAULT 0.5,
  signals              JSONB NOT NULL DEFAULT '[]',
  model_version        TEXT NOT NULL DEFAULT '1.0',
  scored_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_contact_scores_contact ON contact_scores(contact_id, scored_at DESC);
CREATE INDEX idx_contact_scores_tenant ON contact_scores(tenant_id, scored_at DESC);

-- ============================================================
-- DEAL RISKS
-- ============================================================
CREATE TABLE deal_risks (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id             UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  category            TEXT NOT NULL CHECK (category IN ('inspection','appraisal','financing','title','closing','buyer','seller','market')),
  severity            TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  risk_score          NUMERIC(5,4) NOT NULL DEFAULT 0,
  failure_probability NUMERIC(5,4) NOT NULL DEFAULT 0,
  description         TEXT NOT NULL,
  signals             JSONB NOT NULL DEFAULT '[]',
  is_resolved         BOOLEAN NOT NULL DEFAULT false,
  resolved_at         TIMESTAMPTZ,
  resolution_note     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_deal_risks_deal ON deal_risks(deal_id, is_resolved);
CREATE INDEX idx_deal_risks_tenant ON deal_risks(tenant_id, severity) WHERE is_resolved = false;

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE notifications (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN (
    'hot_lead','deal_risk','opportunity','daily_summary','task_due',
    'campaign_complete','import_complete','system','mention'
  )),
  title        TEXT NOT NULL,
  body         TEXT,
  data         JSONB NOT NULL DEFAULT '{}',
  is_read      BOOLEAN NOT NULL DEFAULT false,
  read_at      TIMESTAMPTZ,
  entity_type  TEXT,
  entity_id    UUID,
  channel      TEXT NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app','email','push','sms')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_notifications_user ON notifications(user_id, is_read, created_at DESC);
CREATE INDEX idx_notifications_tenant ON notifications(tenant_id, created_at DESC);

-- ============================================================
-- RELATIONSHIP GRAPH (Contact ↔ Contact edges)
-- ============================================================
CREATE TABLE relationship_edges (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id       UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  target_id       UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  edge_type       TEXT NOT NULL CHECK (edge_type IN ('referral','co_buyer','family','colleague','friend','past_transaction','agent_client')),
  strength        NUMERIC(5,4) NOT NULL DEFAULT 0.5,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, source_id, target_id, edge_type)
);
CREATE INDEX idx_edges_source ON relationship_edges(source_id);
CREATE INDEX idx_edges_target ON relationship_edges(target_id);
CREATE INDEX idx_edges_tenant ON relationship_edges(tenant_id);

-- ============================================================
-- DAILY BRIEFINGS (AI Business Operator output)
-- ============================================================
CREATE TABLE daily_briefings (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  date           DATE NOT NULL,
  top_actions    JSONB NOT NULL DEFAULT '[]',
  who_to_contact JSONB NOT NULL DEFAULT '[]',
  deals_at_risk  JSONB NOT NULL DEFAULT '[]',
  revenue_forecast JSONB NOT NULL DEFAULT '{}',
  summary        TEXT,
  generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, date)
);
CREATE INDEX idx_briefings_tenant ON daily_briefings(tenant_id, date DESC);

-- ============================================================
-- UPDATED_AT TRIGGER FUNCTION
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations','users','contacts','properties','deals',
    'activities','tasks','messages','campaigns','campaign_contacts',
    'referrals','transactions','opportunities','imports',
    'embeddings','contact_scores','deal_risks','relationship_edges'
  ] LOOP
    EXECUTE format('
      CREATE TRIGGER trg_%s_updated_at
      BEFORE UPDATE ON %s
      FOR EACH ROW EXECUTE FUNCTION update_updated_at()', t, t);
  END LOOP;
END;
$$;
