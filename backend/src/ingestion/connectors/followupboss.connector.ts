/**
 * Follow Up Boss Connector
 *
 * API: FUB REST API v1 (API Key auth, no OAuth)
 * Base URL: https://api.followupboss.com/v1
 * Rate limit: ~30 req/min (approximate, undocumented)
 * Contacts (People): GET /people
 * Deals (Deals): GET /deals
 * Webhooks: POST /webhooks (HMAC-SHA256)
 *
 * FUB is the dominant real estate CRM — field mapping is real-estate-specific.
 */
import crypto from 'crypto';
import { BaseCrmConnector } from './base.connector';
import type {
  CrmCredentials, SyncCursor, ConnectorPage,
  NormalizedContact, NormalizedDeal, WebhookEvent, CrmType,
} from '../types';
import { normalizePhone, normalizeEmail } from '../../shared/utils';

const FUB_BASE = 'https://api.followupboss.com/v1';

// FUB stage → CLOVENT type
const FUB_STAGE_MAP: Record<string, string> = {
  'New': 'lead',
  'Attempted Contact': 'lead',
  'Active': 'lead',
  'Under Contract': 'client',
  'Past Client': 'past_client',
  'Closed': 'past_client',
  'Trash': 'inactive',
  'Active Buyer': 'lead',
  'Active Seller': 'lead',
  'Nurture': 'lead',
  'Watch': 'lead',
  'Cold': 'lead',
};

// FUB deal stage → CLOVENT deal stage
const FUB_DEAL_STAGE_MAP: Record<string, string> = {
  'Lead': 'lead',
  'Active': 'active',
  'Under Contract': 'under_contract',
  'Closed': 'closed_won',
  'Dead': 'closed_lost',
};

export class FollowUpBossConnector extends BaseCrmConnector {
  readonly crmType: CrmType = 'followupboss';

  constructor() {
    super();
    this.init('followupboss');
  }

  private headers(creds: CrmCredentials): Record<string, string> {
    // FUB uses HTTP Basic Auth with API key as username, password empty
    const encoded = Buffer.from(`${creds.api_key}:`).toString('base64');
    return { Authorization: `Basic ${encoded}`, 'Content-Type': 'application/json' };
  }

  async testConnection(creds: CrmCredentials): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.httpGet<unknown>(`${FUB_BASE}/people?limit=1`, this.headers(creds));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async refreshToken(creds: CrmCredentials): Promise<Partial<CrmCredentials>> {
    return {}; // FUB uses static API keys, no refresh needed
  }

  async fetchContactPage(
    creds: CrmCredentials,
    cursor: SyncCursor,
    pageSize: number,
  ): Promise<ConnectorPage<NormalizedContact>> {
    const params = new URLSearchParams({
      limit: String(Math.min(pageSize, 100)),
      sort: 'updatedAt',
      direction: 'asc',
    });

    if (cursor.contacts_page_token) {
      params.set('offset', cursor.contacts_page_token);
    }

    if (cursor.contacts_updated_after) {
      params.set('updatedAfter', cursor.contacts_updated_after);
    }

    const res = await this.httpGet<FubPeopleResponse>(
      `${FUB_BASE}/people?${params}`,
      this.headers(creds),
    );

    const records = (res.people ?? []).map(p => this.normalizePerson(p));
    const offset = parseInt(cursor.contacts_page_token ?? '0', 10) + records.length;
    const hasMore = records.length === Math.min(pageSize, 100);

    return {
      records,
      next_cursor: hasMore ? String(offset) : undefined,
      has_more: hasMore,
      total_fetched: records.length,
    };
  }

  async fetchDealPage(
    creds: CrmCredentials,
    cursor: SyncCursor,
    pageSize: number,
  ): Promise<ConnectorPage<NormalizedDeal>> {
    const params = new URLSearchParams({
      limit: String(Math.min(pageSize, 100)),
      sort: 'updatedAt',
      direction: 'asc',
    });

    if (cursor.deals_page_token) params.set('offset', cursor.deals_page_token);
    if (cursor.deals_updated_after) params.set('updatedAfter', cursor.deals_updated_after);

    const res = await this.httpGet<FubDealsResponse>(
      `${FUB_BASE}/deals?${params}`,
      this.headers(creds),
    );

    const records = (res.deals ?? []).map(d => this.normalizeDeal(d));
    const offset = parseInt(cursor.deals_page_token ?? '0', 10) + records.length;
    const hasMore = records.length === Math.min(pageSize, 100);

    return {
      records,
      next_cursor: hasMore ? String(offset) : undefined,
      has_more: hasMore,
      total_fetched: records.length,
    };
  }

  parseWebhook(
    rawBody: string,
    headers: Record<string, string>,
    secret?: string,
  ): WebhookEvent | null {
    // FUB webhook signature: X-FUB-Signature (HMAC-SHA256)
    if (secret) {
      const sig = headers['x-fub-signature'];
      if (!sig) return null;

      const expected = 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');

      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return null;
      }
    }

    try {
      const event = JSON.parse(rawBody) as {
        type: string;
        id: number;
        data?: Record<string, unknown>;
        timestamp?: string;
      };

      return {
        crm_type: 'followupboss',
        event_type: event.type,
        external_id: String(event.id),
        payload: event.data ?? {},
        timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
      };
    } catch {
      return null;
    }
  }

  private normalizePerson(p: FubPerson): NormalizedContact {
    // FUB stores multiple phones/emails as arrays
    const primaryEmail = p.emails?.[0]?.value;
    const primaryPhone = p.phones?.[0]?.value;
    const altPhone = p.phones?.[1]?.value;

    const nameParts = (p.name ?? '').trim().split(/\s+/);
    const firstName = nameParts[0] ?? '';
    const lastName = nameParts.slice(1).join(' ') || '';

    return {
      external_id: String(p.id),
      external_source: 'followupboss',
      first_name: firstName,
      last_name: lastName,
      email: normalizeEmail(primaryEmail ?? '') ?? undefined,
      phone: normalizePhone(primaryPhone ?? '') ?? undefined,
      phone_alt: normalizePhone(altPhone ?? '') ?? undefined,
      city: p.city ?? undefined,
      state: p.state ?? undefined,
      zip: p.zip ?? undefined,
      type: FUB_STAGE_MAP[p.stage ?? ''] ?? 'lead',
      source: p.source ?? 'followupboss',
      tags: [...(p.tags ?? []), 'followupboss'],
      custom_fields: {
        fub_id: p.id,
        fub_stage: p.stage,
        fub_agent_id: p.assignedUserId,
        fub_pipeline: p.pipeline,
      },
    };
  }

  private normalizeDeal(d: FubDeal): NormalizedDeal {
    return {
      external_id: String(d.id),
      external_source: 'followupboss',
      contact_external_id: d.personId ? String(d.personId) : undefined,
      name: d.name ?? `FUB Deal ${d.id}`,
      type: d.type === 'Listing' ? 'seller' : 'buyer',
      stage: FUB_DEAL_STAGE_MAP[d.stage ?? ''] ?? 'active',
      price: d.price ? Math.round(d.price * 100) : undefined,
      expected_close_date: d.closingDate ?? undefined,
      source: 'followupboss',
      custom_fields: { fub_deal_id: d.id, fub_type: d.type },
    };
  }
}

// ── FUB API types ─────────────────────────────────────────────────────────────
interface FubEmail { value: string; type?: string }
interface FubPhone { value: string; type?: string }

interface FubPerson {
  id: number;
  name?: string;
  emails?: FubEmail[];
  phones?: FubPhone[];
  city?: string;
  state?: string;
  zip?: string;
  stage?: string;
  source?: string;
  tags?: string[];
  pipeline?: string;
  assignedUserId?: number;
  updatedAt?: string;
}

interface FubDeal {
  id: number;
  name?: string;
  personId?: number;
  type?: string;
  stage?: string;
  price?: number;
  closingDate?: string;
  updatedAt?: string;
}

interface FubPeopleResponse { people?: FubPerson[]; totalCount?: number }
interface FubDealsResponse  { deals?: FubDeal[]; totalCount?: number }
