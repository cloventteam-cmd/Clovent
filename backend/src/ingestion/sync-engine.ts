/**
 * CRM Sync Engine
 *
 * Orchestrates a single sync run for one CRM credential.
 * Stateless — all state is in the DB (sync_cursor, crm_sync_logs).
 *
 * Flow:
 *   1. Load credential + decrypt tokens
 *   2. Refresh OAuth token if near expiry
 *   3. For each entity type (contacts, deals):
 *      a. Page through CRM API respecting rate limits
 *      b. Emit IMPORT_REQUESTED per batch (never writes DB directly)
 *   4. Update sync cursor + schedule next run
 */
import type { CrmCredentials, SyncType, EntityType, SyncCursor } from './types';
import { getConnector } from './registry';
import {
  findCredential, updateAfterSync, updateTokens,
  createSyncLog, completeSyncLog, failSyncLog,
} from './db/credentials';
import { logger } from '../shared/logger';
import type { UUID } from '../shared/types';

const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // refresh 5 min before expiry

export class SyncEngine {
  async run(params: {
    tenantId: UUID;
    credentialId: UUID;
    syncType: SyncType;
    entityTypes: EntityType[];
    logId?: UUID;
  }): Promise<{ success: boolean; stats: { fetched: number; batches: number } }> {
    const { tenantId, credentialId, syncType, entityTypes } = params;
    const logId = params.logId ?? await createSyncLog(tenantId, credentialId, 'unknown' as any, syncType);

    const creds = await findCredential(tenantId, credentialId);
    if (!creds) {
      await failSyncLog(logId, 'Credential not found');
      return { success: false, stats: { fetched: 0, batches: 0 } };
    }

    const connector = getConnector(creds.crm_type);
    const startMs = Date.now();
    let totalFetched = 0;
    let totalBatches = 0;
    let finalCursor: SyncCursor = creds.sync_cursor ?? {};

    logger.info(
      { tenant_id: tenantId, cred_id: credentialId, crm: creds.crm_type, sync_type: syncType, entities: entityTypes },
      'SyncEngine: starting sync run',
    );

    try {
      // ── Refresh OAuth token if near expiry ──────────────────────────────────
      if (creds.token_expires_at) {
        const msLeft = creds.token_expires_at.getTime() - Date.now();
        if (msLeft < TOKEN_REFRESH_THRESHOLD_MS) {
          logger.info({ crm: creds.crm_type }, 'SyncEngine: refreshing OAuth token');
          const updated = await connector.refreshToken(creds);
          if (updated.access_token) {
            await updateTokens(credentialId, updated);
            // Merge into local copy for this run
            Object.assign(creds, updated);
          }
        }
      }

      // ── For full sync, clear the cursor ────────────────────────────────────
      if (syncType === 'full') {
        finalCursor = {};
        logger.info({ crm: creds.crm_type }, 'SyncEngine: full sync — clearing cursor');
      }

      // ── Sync each entity type ───────────────────────────────────────────────
      for (const entityType of entityTypes) {
        const opts = {
          batchSize: entityType === 'contacts' ? creds.settings.contact_batch_size : creds.settings.deal_batch_size,
          maxRecords: creds.settings.max_records_per_sync,
        };

        // Temporarily apply the current cursor
        const runCreds = { ...creds, sync_cursor: finalCursor };

        if (entityType === 'contacts') {
          const result = await (connector as any).syncContacts(runCreds, logId, opts);
          totalFetched += result.fetched;
          totalBatches += result.batches;
          finalCursor = { ...finalCursor, ...result.newCursor };
          logger.info(
            { fetched: result.fetched, batches: result.batches, crm: creds.crm_type },
            'SyncEngine: contacts synced',
          );
        }

        if (entityType === 'deals') {
          const result = await (connector as any).syncDeals(runCreds, logId, opts);
          totalFetched += result.fetched;
          totalBatches += result.batches;
          finalCursor = { ...finalCursor, ...result.newCursor };
          logger.info(
            { fetched: result.fetched, batches: result.batches, crm: creds.crm_type },
            'SyncEngine: deals synced',
          );
        }
      }

      // ── Persist the new cursor ──────────────────────────────────────────────
      await updateAfterSync(credentialId, finalCursor, creds.settings.sync_interval_min);

      await completeSyncLog(
        logId,
        { fetched: totalFetched, queued: totalBatches, errors: 0 },
        finalCursor,
      );

      const elapsed = Date.now() - startMs;
      logger.info(
        { crm: creds.crm_type, fetched: totalFetched, batches: totalBatches, elapsed_ms: elapsed },
        'SyncEngine: sync run complete',
      );

      return { success: true, stats: { fetched: totalFetched, batches: totalBatches } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, crm: creds.crm_type }, 'SyncEngine: sync run failed');
      await failSyncLog(logId, message);
      return { success: false, stats: { fetched: totalFetched, batches: totalBatches } };
    }
  }

  async runWebhook(params: {
    tenantId: UUID;
    credentialId: UUID;
    rawBody: string;
    headers: Record<string, string>;
  }): Promise<{ processed: boolean; error?: string }> {
    const { tenantId, credentialId, rawBody, headers } = params;

    const creds = await findCredential(tenantId, credentialId);
    if (!creds) return { processed: false, error: 'Credential not found' };

    const connector = getConnector(creds.crm_type);
    const webhookSecret = (creds.settings as any).webhook_secret as string | undefined;

    const event = connector.parseWebhook(rawBody, headers, webhookSecret);
    if (!event) return { processed: false, error: 'Invalid webhook or signature mismatch' };

    logger.info(
      { crm: creds.crm_type, event_type: event.event_type, external_id: event.external_id },
      'SyncEngine: processing webhook',
    );

    // For webhook events, emit a single-record IMPORT_REQUESTED
    // Fetch the full record to get normalized data
    try {
      const entityType: EntityType = event.event_type.toLowerCase().includes('deal') ? 'deals' : 'contacts';
      const cursor: SyncCursor = { contacts_updated_after: event.timestamp.toISOString() };
      const logId = await createSyncLog(tenantId, credentialId, creds.crm_type, 'webhook');

      // Sync just the single updated entity
      const runCreds = { ...creds, sync_cursor: cursor };
      if (entityType === 'contacts') {
        await (connector as any).syncContacts(runCreds, logId, { batchSize: 1, maxRecords: 1 });
      } else {
        await (connector as any).syncDeals(runCreds, logId, { batchSize: 1, maxRecords: 1 });
      }

      await completeSyncLog(logId, { fetched: 1, queued: 1, errors: 0 }, cursor);
      return { processed: true };
    } catch (err) {
      return { processed: false, error: (err as Error).message };
    }
  }
}

export const syncEngine = new SyncEngine();
