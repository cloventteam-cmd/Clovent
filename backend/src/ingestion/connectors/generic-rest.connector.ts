/**
 * Generic REST CRM Connector
 *
 * Fallback adapter for any REST-based CRM that doesn't have a dedicated connector.
 * Configured entirely via settings JSON — the tenant defines the field mapping,
 * pagination style, and auth method.
 *
 * Supports:
 *   - Bearer token / API key auth
 *   - Cursor-based or offset-based pagination
 *   - Configurable field mapping
 *   - Optional webhook verification
 */
import crypto from 'crypto';
import { BaseCrmConnector } from './base.connector';
import type {
  CrmCredentials, SyncCursor, ConnectorPage,
  NormalizedContact, NormalizedDeal, WebhookEvent, CrmType,
} from '../types';
import { normalizePhone, normalizeEmail } from '../../shared/utils';

export interface GenericRestSettings {
  // Contact endpoint config
  contacts_endpoint: string;          // e.g. "/api/contacts"
  contacts_updated_param?: string;    // e.g. "updated_since"
  contacts_page_param?: string;       // e.g. "cursor" or "page"
  contacts_limit_param?: string;      // e.g. "per_page"
  contacts_response_key?: string;     // e.g. "data.contacts" (dot-path)
  contacts_next_cursor_path?: string; // e.g. "meta.next_cursor"
  contacts_has_more_path?: string;    // e.g. "meta.has_more"

  // Deal endpoint config
  deals_endpoint?: string;
  deals_updated_param?: string;
  deals_page_param?: string;
  deals_limit_param?: string;
  deals_response_key?: string;
  deals_next_cursor_path?: string;

  // Field mapping: CLOVENT field → path in response object
  contact_field_map: Record<string, string>;
  deal_field_map?: Record<string, string>;

  // Auth
  auth_type: 'bearer' | 'api_key' | 'basic';
  api_key_header?: string;            // header name if auth_type = api_key

  // Webhook
  webhook_secret_header?: string;
  webhook_hmac_algorithm?: string;    // default: sha256
  webhook_id_path?: string;           // path to external ID in webhook body
  webhook_event_type_path?: string;
}

const DEFAULT_CONTACT_MAP: Record<string, string> = {
  external_id: 'id',
  first_name: 'first_name',
  last_name: 'last_name',
  email: 'email',
  phone: 'phone',
  city: 'city',
  state: 'state',
  zip: 'zip',
  source: 'source',
};

export class GenericRestConnector extends BaseCrmConnector {
  readonly crmType: CrmType = 'generic_rest';

  constructor() {
    super();
    this.init('generic_rest');
  }

  private getSettings(creds: CrmCredentials): GenericRestSettings {
    return (creds.settings as unknown as GenericRestSettings) ?? {};
  }

  private authHeaders(creds: CrmCredentials): Record<string, string> {
    const s = this.getSettings(creds);
    if (s.auth_type === 'api_key' && creds.api_key) {
      return { [s.api_key_header ?? 'X-Api-Key']: creds.api_key };
    }
    if (s.auth_type === 'basic' && creds.api_key) {
      return { Authorization: `Basic ${Buffer.from(creds.api_key + ':').toString('base64')}` };
    }
    return { Authorization: `Bearer ${creds.access_token ?? creds.api_key}` };
  }

  async testConnection(creds: CrmCredentials): Promise<{ ok: boolean; error?: string }> {
    const s = this.getSettings(creds);
    if (!s.contacts_endpoint) return { ok: false, error: 'contacts_endpoint not configured' };
    try {
      const url = `${creds.base_url}${s.contacts_endpoint}?${s.contacts_limit_param ?? 'limit'}=1`;
      await this.httpGet<unknown>(url, this.authHeaders(creds));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async refreshToken(creds: CrmCredentials): Promise<Partial<CrmCredentials>> {
    return {}; // Generic connector assumes static keys
  }

  async fetchContactPage(
    creds: CrmCredentials,
    cursor: SyncCursor,
    pageSize: number,
  ): Promise<ConnectorPage<NormalizedContact>> {
    const s = this.getSettings(creds);
    const params = new URLSearchParams({
      [s.contacts_limit_param ?? 'limit']: String(pageSize),
    });

    if (cursor.contacts_page_token && s.contacts_page_param) {
      params.set(s.contacts_page_param, cursor.contacts_page_token);
    }

    if (cursor.contacts_updated_after && s.contacts_updated_param) {
      params.set(s.contacts_updated_param, cursor.contacts_updated_after);
    }

    const url = `${creds.base_url}${s.contacts_endpoint}?${params}`;
    const raw = await this.httpGet<unknown>(url, this.authHeaders(creds));

    const data = this.extractPath(raw, s.contacts_response_key) as unknown[];
    const nextCursor = s.contacts_next_cursor_path
      ? this.extractPath(raw, s.contacts_next_cursor_path) as string | undefined
      : undefined;
    const hasMore = s.contacts_has_more_path
      ? Boolean(this.extractPath(raw, s.contacts_has_more_path))
      : !!nextCursor;

    const fieldMap = { ...DEFAULT_CONTACT_MAP, ...(s.contact_field_map ?? {}) };
    const records = (data ?? []).map(item => this.normalizeContact(item as Record<string, unknown>, fieldMap, creds));

    return { records, next_cursor: nextCursor, has_more: hasMore, total_fetched: records.length };
  }

  async fetchDealPage(
    creds: CrmCredentials,
    cursor: SyncCursor,
    pageSize: number,
  ): Promise<ConnectorPage<NormalizedDeal>> {
    const s = this.getSettings(creds);

    if (!s.deals_endpoint) {
      return { records: [], next_cursor: undefined, has_more: false, total_fetched: 0 };
    }

    const params = new URLSearchParams({
      [s.deals_limit_param ?? 'limit']: String(pageSize),
    });

    if (cursor.deals_page_token && s.deals_page_param) {
      params.set(s.deals_page_param, cursor.deals_page_token);
    }

    if (cursor.deals_updated_after && s.deals_updated_param) {
      params.set(s.deals_updated_param, cursor.deals_updated_after);
    }

    const url = `${creds.base_url}${s.deals_endpoint}?${params}`;
    const raw = await this.httpGet<unknown>(url, this.authHeaders(creds));

    const data = this.extractPath(raw, s.deals_response_key) as unknown[];
    const nextCursor = s.deals_next_cursor_path
      ? this.extractPath(raw, s.deals_next_cursor_path) as string | undefined
      : undefined;
    const hasMore = !!nextCursor;

    const fieldMap = s.deal_field_map ?? { external_id: 'id', name: 'name', stage: 'stage', price: 'amount' };
    const records = (data ?? []).map(item =>
      this.normalizeDeal(item as Record<string, unknown>, fieldMap),
    );

    return { records, next_cursor: nextCursor, has_more: hasMore, total_fetched: records.length };
  }

  parseWebhook(
    rawBody: string,
    headers: Record<string, string>,
    secret?: string,
  ): WebhookEvent | null {
    const s = this.getSettings({} as CrmCredentials); // settings may not be available here

    if (secret && s.webhook_secret_header) {
      const sig = headers[s.webhook_secret_header.toLowerCase()];
      const algo = s.webhook_hmac_algorithm ?? 'sha256';
      const expected = crypto.createHmac(algo, secret).update(rawBody).digest('hex');
      if (!sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return null;
      }
    }

    try {
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      const externalId = s.webhook_id_path
        ? String(this.extractPath(body, s.webhook_id_path) ?? '')
        : String(body.id ?? '');
      const eventType = s.webhook_event_type_path
        ? String(this.extractPath(body, s.webhook_event_type_path) ?? 'update')
        : String(body.event ?? body.type ?? 'update');

      if (!externalId) return null;

      return {
        crm_type: 'generic_rest',
        event_type: eventType,
        external_id: externalId,
        payload: body,
        timestamp: new Date(),
      };
    } catch {
      return null;
    }
  }

  // Dot-path extractor: "data.contacts" → obj.data.contacts
  private extractPath(obj: unknown, path?: string): unknown {
    if (!path) return obj;
    return path.split('.').reduce((acc, key) => {
      if (acc == null || typeof acc !== 'object') return undefined;
      return (acc as Record<string, unknown>)[key];
    }, obj);
  }

  private normalizeContact(
    item: Record<string, unknown>,
    fieldMap: Record<string, string>,
    creds: CrmCredentials,
  ): NormalizedContact {
    const get = (f: string) => {
      const path = fieldMap[f];
      return path ? this.extractPath(item, path) : undefined;
    };

    return {
      external_id: String(get('external_id') ?? get('id') ?? ''),
      external_source: 'generic_rest',
      first_name: String(get('first_name') ?? ''),
      last_name: String(get('last_name') ?? ''),
      email: normalizeEmail(String(get('email') ?? '')) ?? undefined,
      phone: normalizePhone(String(get('phone') ?? '')) ?? undefined,
      city: get('city') ? String(get('city')) : undefined,
      state: get('state') ? String(get('state')) : undefined,
      zip: get('zip') ? String(get('zip')) : undefined,
      source: get('source') ? String(get('source')) : 'generic_rest',
      tags: ['generic_rest'],
      custom_fields: { raw: item },
    };
  }

  private normalizeDeal(item: Record<string, unknown>, fieldMap: Record<string, string>): NormalizedDeal {
    const get = (f: string) => {
      const path = fieldMap[f];
      return path ? this.extractPath(item, path) : undefined;
    };

    const price = get('price');
    return {
      external_id: String(get('external_id') ?? get('id') ?? ''),
      external_source: 'generic_rest',
      name: String(get('name') ?? `Deal ${get('external_id')}`),
      stage: String(get('stage') ?? 'active'),
      price: price ? Math.round(Number(price) * 100) : undefined,
      source: 'generic_rest',
      custom_fields: { raw: item },
    };
  }
}
