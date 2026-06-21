/**
 * Credential repository.
 *
 * Credentials are AES-256-GCM encrypted at rest. Only decrypted in-memory
 * when the connector needs them. The raw JSON never touches logs.
 */
import crypto from 'crypto';
import { query, queryOne, queryMany } from '../../db/client';
export { queryMany }; // re-export for use in routes
import { config } from '../../shared/config';
import type { UUID } from '../../shared/types';
import type { CrmCredentials, CrmType, SyncCursor, CrmSyncSettings } from '../types';

// ── Encryption helpers ────────────────────────────────────────────────────────
// Key derived from JWT secret (first 32 bytes → 256 bits)
const ENC_KEY = Buffer.from(
  config.jwt.secret.padEnd(32, '0').slice(0, 32),
  'utf8',
);

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes
  // Format: <iv(12)><tag(16)><ciphertext> → base64
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

function decrypt(encoded: string): string {
  const buf = Buffer.from(encoded, 'base64url');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// ── DB row type ───────────────────────────────────────────────────────────────
interface CredentialRow {
  id: UUID;
  tenant_id: UUID;
  crm_type: CrmType;
  label: string;
  credentials_enc: string;
  settings: CrmSyncSettings;
  sync_cursor: string | null;
  last_synced_at: Date | null;
  next_sync_at: Date | null;
  is_active: boolean;
  created_by: UUID | null;
  created_at: Date;
  updated_at: Date;
}

// ── Mappers ───────────────────────────────────────────────────────────────────
function rowToCredentials(row: CredentialRow): CrmCredentials {
  let decrypted: Record<string, unknown> = {};
  try { decrypted = JSON.parse(decrypt(row.credentials_enc)); }
  catch { /* malformed enc — return empty */ }

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    crm_type: row.crm_type,
    label: row.label,
    access_token: decrypted.access_token as string | undefined,
    refresh_token: decrypted.refresh_token as string | undefined,
    api_key: decrypted.api_key as string | undefined,
    instance_url: decrypted.instance_url as string | undefined,
    portal_id: decrypted.portal_id as string | undefined,
    subdomain: decrypted.subdomain as string | undefined,
    base_url: decrypted.base_url as string | undefined,
    client_id: decrypted.client_id as string | undefined,
    client_secret: decrypted.client_secret as string | undefined,
    token_expires_at: decrypted.token_expires_at
      ? new Date(decrypted.token_expires_at as string)
      : undefined,
    settings: row.settings,
    sync_cursor: row.sync_cursor ? JSON.parse(row.sync_cursor) : undefined,
    last_synced_at: row.last_synced_at ?? undefined,
  };
}

// ── Repository ────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS: CrmSyncSettings = {
  sync_interval_min: 60,
  entity_types: ['contacts', 'deals'],
  contact_batch_size: 100,
  deal_batch_size: 100,
  max_records_per_sync: 10_000,
  webhook_enabled: false,
};

export async function createCredential(
  tenantId: UUID,
  userId: UUID,
  input: {
    crm_type: CrmType;
    label: string;
    credentials: Record<string, unknown>;
    settings?: Partial<CrmSyncSettings>;
  },
): Promise<CrmCredentials> {
  const credEnc = encrypt(JSON.stringify(input.credentials));
  const settings = { ...DEFAULT_SETTINGS, ...input.settings };

  const row = await queryOne<CredentialRow>(
    `INSERT INTO crm_credentials
       (tenant_id, crm_type, label, credentials_enc, settings, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [tenantId, input.crm_type, input.label, credEnc, JSON.stringify(settings), userId],
  );
  if (!row) throw new Error('Failed to create CRM credential');
  return rowToCredentials(row);
}

export async function findCredential(
  tenantId: UUID,
  credentialId: UUID,
): Promise<CrmCredentials | null> {
  const row = await queryOne<CredentialRow>(
    'SELECT * FROM crm_credentials WHERE tenant_id = $1 AND id = $2',
    [tenantId, credentialId],
  );
  return row ? rowToCredentials(row) : null;
}

export async function listCredentials(tenantId: UUID): Promise<CrmCredentials[]> {
  const rows = await queryMany<CredentialRow>(
    'SELECT * FROM crm_credentials WHERE tenant_id = $1 ORDER BY created_at DESC',
    [tenantId],
  );
  return rows.map(rowToCredentials);
}

export async function findCredentialsDueForSync(limit = 200): Promise<CrmCredentials[]> {
  const rows = await queryMany<CredentialRow>(
    `SELECT * FROM crm_credentials
     WHERE is_active = true
       AND (next_sync_at IS NULL OR next_sync_at <= NOW())
     ORDER BY next_sync_at ASC NULLS FIRST
     LIMIT $1`,
    [limit],
  );
  return rows.map(rowToCredentials);
}

export async function updateAfterSync(
  credentialId: UUID,
  newCursor: SyncCursor,
  intervalMin: number,
): Promise<void> {
  await query(
    `UPDATE crm_credentials SET
       sync_cursor = $2,
       last_synced_at = NOW(),
       next_sync_at = NOW() + ($3 || ' minutes')::interval
     WHERE id = $1`,
    [credentialId, JSON.stringify(newCursor), intervalMin],
  );
}

export async function updateTokens(
  credentialId: UUID,
  updates: { access_token?: string; refresh_token?: string; token_expires_at?: Date },
): Promise<void> {
  // Fetch current, decrypt, merge, re-encrypt
  const row = await queryOne<CredentialRow>(
    'SELECT credentials_enc FROM crm_credentials WHERE id = $1',
    [credentialId],
  );
  if (!row) return;

  let current: Record<string, unknown> = {};
  try { current = JSON.parse(decrypt(row.credentials_enc)); } catch { /* ignore */ }

  const merged = {
    ...current,
    ...updates,
    token_expires_at: updates.token_expires_at?.toISOString(),
  };
  const credEnc = encrypt(JSON.stringify(merged));

  await query('UPDATE crm_credentials SET credentials_enc = $1 WHERE id = $2', [credEnc, credentialId]);
}

export async function deactivateCredential(tenantId: UUID, credentialId: UUID): Promise<void> {
  await query(
    'UPDATE crm_credentials SET is_active = false WHERE tenant_id = $1 AND id = $2',
    [tenantId, credentialId],
  );
}

// ── Sync log helpers ──────────────────────────────────────────────────────────
export async function createSyncLog(
  tenantId: UUID,
  credentialId: UUID,
  crmType: CrmType,
  syncType: string,
): Promise<UUID> {
  const row = await queryOne<{ id: UUID }>(
    `INSERT INTO crm_sync_logs (tenant_id, credential_id, crm_type, sync_type)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [tenantId, credentialId, crmType, syncType],
  );
  return row!.id;
}

export async function completeSyncLog(
  logId: UUID,
  stats: { fetched: number; queued: number; errors: number },
  newCursor: SyncCursor,
  importId?: UUID,
): Promise<void> {
  await query(
    `UPDATE crm_sync_logs SET
       status = 'completed', completed_at = NOW(),
       stats = $2, new_cursor = $3, import_id = $4
     WHERE id = $1`,
    [logId, JSON.stringify(stats), JSON.stringify(newCursor), importId ?? null],
  );
}

export async function failSyncLog(logId: UUID, error: string): Promise<void> {
  await query(
    `UPDATE crm_sync_logs SET status = 'failed', completed_at = NOW(), error = $2 WHERE id = $1`,
    [logId, error],
  );
}
