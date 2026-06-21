/**
 * Base connector — shared HTTP fetch with retry, timeout, and rate limiting.
 * All CRM connectors extend this class.
 */
import type {
  ICrmConnector, CrmCredentials, SyncCursor, SyncResult,
  ConnectorPage, NormalizedContact, NormalizedDeal,
  WebhookEvent, CrmType, EntityType, ImportRequestedPayload,
} from '../types';
import { RateLimiter } from '../rate-limiter';
import { eventBus } from '../../events/bus';
import { EventNames } from '../../events/types';
import { logger } from '../../shared/logger';
import { chunk } from '../../shared/utils';

const FETCH_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

export abstract class BaseCrmConnector implements ICrmConnector {
  abstract readonly crmType: CrmType;

  protected rateLimiter!: RateLimiter;

  protected init(crmType: CrmType): void {
    this.rateLimiter = new RateLimiter(crmType);
  }

  // ── Must be implemented by each connector ──────────────────────────────────
  abstract testConnection(creds: CrmCredentials): Promise<{ ok: boolean; error?: string }>;
  abstract refreshToken(creds: CrmCredentials): Promise<Partial<CrmCredentials>>;
  abstract fetchContactPage(creds: CrmCredentials, cursor: SyncCursor, pageSize: number): Promise<ConnectorPage<NormalizedContact>>;
  abstract fetchDealPage(creds: CrmCredentials, cursor: SyncCursor, pageSize: number): Promise<ConnectorPage<NormalizedDeal>>;
  abstract parseWebhook(rawBody: string, headers: Record<string, string>, secret?: string): WebhookEvent | null;

  // ── Shared full sync orchestration ─────────────────────────────────────────
  async syncContacts(
    creds: CrmCredentials,
    logId: string,
    opts: { batchSize?: number; maxRecords?: number } = {},
  ): Promise<{ fetched: number; batches: number; newCursor: SyncCursor }> {
    const batchSize = opts.batchSize ?? creds.settings.contact_batch_size;
    const maxRecords = opts.maxRecords ?? creds.settings.max_records_per_sync;
    let cursor: SyncCursor = creds.sync_cursor ?? {};
    let totalFetched = 0;
    let batchIndex = 0;
    let hasMore = true;

    while (hasMore) {
      if (maxRecords > 0 && totalFetched >= maxRecords) {
        logger.info({ totalFetched, maxRecords }, 'CRM sync: max_records cap reached');
        break;
      }

      await this.rateLimiter.throttle();

      const page = await this.fetchContactPage(creds, cursor, batchSize);
      hasMore = page.has_more;
      totalFetched += page.records.length;

      if (page.records.length > 0) {
        await this.emitBatch({
          creds,
          logId,
          entityType: 'contacts',
          records: page.records,
          batchIndex: batchIndex++,
          isLastBatch: !page.has_more,
          newCursor: page.next_cursor ? { ...cursor, contacts_page_token: page.next_cursor } : cursor,
        });
      }

      if (page.next_cursor) {
        cursor = { ...cursor, contacts_page_token: page.next_cursor };
      } else {
        // Update the "updated_after" cursor to now so next sync is incremental
        cursor = {
          ...cursor,
          contacts_updated_after: new Date().toISOString(),
          contacts_page_token: undefined,
        };
        break;
      }
    }

    return { fetched: totalFetched, batches: batchIndex, newCursor: cursor };
  }

  async syncDeals(
    creds: CrmCredentials,
    logId: string,
    opts: { batchSize?: number; maxRecords?: number } = {},
  ): Promise<{ fetched: number; batches: number; newCursor: SyncCursor }> {
    const batchSize = opts.batchSize ?? creds.settings.deal_batch_size;
    const maxRecords = opts.maxRecords ?? creds.settings.max_records_per_sync;
    let cursor: SyncCursor = creds.sync_cursor ?? {};
    let totalFetched = 0;
    let batchIndex = 0;
    let hasMore = true;

    while (hasMore) {
      if (maxRecords > 0 && totalFetched >= maxRecords) break;

      await this.rateLimiter.throttle();

      const page = await this.fetchDealPage(creds, cursor, batchSize);
      hasMore = page.has_more;
      totalFetched += page.records.length;

      if (page.records.length > 0) {
        await this.emitBatch({
          creds,
          logId,
          entityType: 'deals',
          records: page.records,
          batchIndex: batchIndex++,
          isLastBatch: !page.has_more,
          newCursor: page.next_cursor ? { ...cursor, deals_page_token: page.next_cursor } : cursor,
        });
      }

      if (page.next_cursor) {
        cursor = { ...cursor, deals_page_token: page.next_cursor };
      } else {
        cursor = {
          ...cursor,
          deals_updated_after: new Date().toISOString(),
          deals_page_token: undefined,
        };
        break;
      }
    }

    return { fetched: totalFetched, batches: batchIndex, newCursor: cursor };
  }

  // ── Emit IMPORT_REQUESTED (the ONLY event connectors write) ────────────────
  private async emitBatch(params: {
    creds: CrmCredentials;
    logId: string;
    entityType: EntityType;
    records: NormalizedContact[] | NormalizedDeal[];
    batchIndex: number;
    isLastBatch: boolean;
    newCursor: SyncCursor;
  }): Promise<void> {
    const payload: ImportRequestedPayload = {
      tenant_id: params.creds.tenant_id,
      credential_id: params.creds.id,
      crm_type: params.creds.crm_type,
      sync_type: params.creds.sync_cursor ? 'incremental' : 'full',
      entity_type: params.entityType,
      rows: params.records,
      batch_index: params.batchIndex,
      is_last_batch: params.isLastBatch,
      new_cursor: params.newCursor,
      log_id: params.logId,
    };

    await eventBus.emit(EventNames.IMPORT_REQUESTED as any, payload);

    logger.info(
      {
        crm_type: params.creds.crm_type,
        entity: params.entityType,
        batch: params.batchIndex,
        records: params.records.length,
        last: params.isLastBatch,
      },
      'Connector: IMPORT_REQUESTED emitted',
    );
  }

  // ── HTTP helper with retry + timeout ──────────────────────────────────────
  protected async httpGet<T>(
    url: string,
    headers: Record<string, string>,
    retries = MAX_RETRIES,
  ): Promise<T> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const res = await fetch(url, { headers, signal: controller.signal });
        clearTimeout(timer);

        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
          logger.warn({ url, retryAfter }, 'CRM API rate limit hit — backing off');
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          continue;
        }

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        }

        return await res.json() as T;
      } catch (err) {
        if (attempt === retries) throw err;
        const backoff = 1000 * 2 ** (attempt - 1);
        logger.warn({ url, attempt, backoff }, 'CRM API retry');
        await new Promise(r => setTimeout(r, backoff));
      }
    }
    throw new Error(`Failed after ${retries} retries: ${url}`);
  }

  protected async httpPost<T>(
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return await res.json() as T;
  }
}
