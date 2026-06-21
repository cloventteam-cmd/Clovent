import type { UUID } from '../shared/types';

// ── Core CRM types ────────────────────────────────────────────────────────────
export type CrmType = 'hubspot' | 'salesforce' | 'followupboss' | 'kvcore' | 'generic_rest';
export type SyncType = 'full' | 'incremental' | 'webhook';
export type EntityType = 'contacts' | 'deals';

// ── Connector credentials (decrypted, in-memory only) ─────────────────────────
export interface CrmCredentials {
  id: UUID;
  tenant_id: UUID;
  crm_type: CrmType;
  label: string;
  // OAuth / API key fields (decrypted)
  access_token?: string;
  refresh_token?: string;
  api_key?: string;
  instance_url?: string;    // Salesforce base URL
  portal_id?: string;       // HubSpot portal
  subdomain?: string;       // FUB subdomain
  base_url?: string;        // Generic REST
  client_id?: string;
  client_secret?: string;
  token_expires_at?: Date;
  // Settings
  settings: CrmSyncSettings;
  sync_cursor?: SyncCursor;
  last_synced_at?: Date;
}

export interface CrmSyncSettings {
  sync_interval_min: number;           // 15 = every 15 min
  entity_types: EntityType[];          // which entities to sync
  contact_batch_size: number;          // records per API page
  deal_batch_size: number;
  max_records_per_sync: number;        // safety cap (0 = unlimited)
  webhook_enabled: boolean;
  owner_id?: UUID;                     // assign synced contacts to this agent
  tags?: string[];                     // auto-tag synced contacts
}

export interface SyncCursor {
  contacts_updated_after?: string;     // ISO timestamp
  deals_updated_after?: string;
  contacts_page_token?: string;
  deals_page_token?: string;
  contacts_total_synced?: number;
  deals_total_synced?: number;
  sync_started_at?: string;
}

// ── Normalized row (what connectors emit — CLOVENT field names) ───────────────
export interface NormalizedContact {
  external_id: string;
  external_source: CrmType;
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  phone_alt?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  type?: string;
  status?: string;
  source?: string;
  tags?: string[];
  custom_fields?: Record<string, unknown>;
  // Deal fields when contact is part of a deal record
  deal_name?: string;
  deal_stage?: string;
  deal_value?: number;
}

export interface NormalizedDeal {
  external_id: string;
  external_source: CrmType;
  contact_external_id?: string;        // link back to contact
  name: string;
  type?: string;
  stage?: string;
  price?: number;
  probability?: number;
  expected_close_date?: string;
  source?: string;
  custom_fields?: Record<string, unknown>;
}

// ── Connector page result (single page of records from CRM API) ───────────────
export interface ConnectorPage<T> {
  records: T[];
  next_cursor?: string;                // pagination token for next page
  has_more: boolean;
  total_fetched: number;
}

// ── Sync result per connector run ─────────────────────────────────────────────
export interface SyncResult {
  contacts_fetched: number;
  deals_fetched: number;
  batches_emitted: number;
  errors: Array<{ entity: string; external_id: string; error: string }>;
  new_cursor: SyncCursor;
  duration_ms: number;
}

// ── IMPORT_REQUESTED event payload ────────────────────────────────────────────
// This is what every connector emits — never writes to DB directly.
export interface ImportRequestedPayload {
  tenant_id: UUID;
  credential_id: UUID;
  crm_type: CrmType;
  sync_type: SyncType;
  entity_type: EntityType;
  rows: NormalizedContact[] | NormalizedDeal[];
  batch_index: number;
  is_last_batch: boolean;
  new_cursor?: SyncCursor;
  log_id?: UUID;                       // crm_sync_logs row for tracking
}

// ── Webhook inbound ───────────────────────────────────────────────────────────
export interface WebhookEvent {
  crm_type: CrmType;
  event_type: string;
  external_id: string;
  payload: Record<string, unknown>;
  timestamp: Date;
}

// ── Connector interface ───────────────────────────────────────────────────────
export interface ICrmConnector {
  readonly crmType: CrmType;

  /** Test that the credentials are valid and the API is reachable */
  testConnection(creds: CrmCredentials): Promise<{ ok: boolean; error?: string }>;

  /** Refresh OAuth access token if expired */
  refreshToken(creds: CrmCredentials): Promise<Partial<CrmCredentials>>;

  /** Fetch one page of contacts updated since cursor */
  fetchContactPage(
    creds: CrmCredentials,
    cursor: SyncCursor,
    pageSize: number,
  ): Promise<ConnectorPage<NormalizedContact>>;

  /** Fetch one page of deals updated since cursor */
  fetchDealPage(
    creds: CrmCredentials,
    cursor: SyncCursor,
    pageSize: number,
  ): Promise<ConnectorPage<NormalizedDeal>>;

  /** Parse a raw webhook payload into a normalized event */
  parseWebhook(
    rawBody: string,
    headers: Record<string, string>,
    secret?: string,
  ): WebhookEvent | null;
}

// ── CRM sync queue job data ───────────────────────────────────────────────────
export interface CrmSyncJobData {
  tenant_id: UUID;
  credential_id: UUID;
  crm_type: CrmType;
  sync_type: SyncType;
  entity_types: EntityType[];
  log_id?: UUID;
}
