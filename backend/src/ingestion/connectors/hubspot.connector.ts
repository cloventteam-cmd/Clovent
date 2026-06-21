/**
 * HubSpot CRM Connector
 *
 * API: HubSpot CRM v3 (OAuth2 / Private App tokens)
 * Rate limit: 100 req / 10s (free), 150/s (paid)
 * Contacts endpoint: GET /crm/v3/objects/contacts
 * Deals endpoint:    GET /crm/v3/objects/deals
 * Webhooks:          POST /crm/v3/webhooks (HMAC-SHA256 signature)
 */
import crypto from 'crypto';
import { BaseCrmConnector } from './base.connector';
import type {
  CrmCredentials, SyncCursor, ConnectorPage,
  NormalizedContact, NormalizedDeal, WebhookEvent, CrmType,
} from '../types';
import { normalizePhone, normalizeEmail } from '../../shared/utils';

const HS_BASE = 'https://api.hubapi.com';

// HubSpot contact properties to fetch
const CONTACT_PROPS = [
  'firstname', 'lastname', 'email', 'phone', 'mobilephone',
  'city', 'state', 'zip', 'country', 'company',
  'lifecyclestage', 'hs_lead_status', 'leadsource',
  'hs_object_id', 'lastmodifieddate', 'createdate',
  'hubspot_owner_id', 'notes_last_updated',
].join(',');

const DEAL_PROPS = [
  'dealname', 'dealstage', 'amount', 'pipeline',
  'closedate', 'hs_object_id', 'hs_lastmodifieddate',
  'dealtype', 'leadsource', 'description',
].join(',');

// Map HubSpot lifecycle stages → CLOVENT contact types
const LIFECYCLE_MAP: Record<string, string> = {
  lead: 'lead',
  marketingqualifiedlead: 'lead',
  salesqualifiedlead: 'lead',
  opportunity: 'lead',
  customer: 'client',
  evangelist: 'client',
  other: 'lead',
};

// Map HubSpot deal stages → CLOVENT deal stages (configurable per portal)
const DEAL_STAGE_MAP: Record<string, string> = {
  appointmentscheduled: 'active',
  qualifiedtobuy: 'active',
  presentationscheduled: 'active',
  decisionmakerboughtin: 'nurture',
  contractsent: 'under_contract',
  closedwon: 'closed_won',
  closedlost: 'closed_lost',
};

export class HubSpotConnector extends BaseCrmConnector {
  readonly crmType: CrmType = 'hubspot';

  constructor() {
    super();
    this.init('hubspot');
  }

  async testConnection(creds: CrmCredentials): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.httpGet<unknown>(
        `${HS_BASE}/crm/v3/objects/contacts?limit=1&properties=email`,
        this.authHeaders(creds),
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async refreshToken(creds: CrmCredentials): Promise<Partial<CrmCredentials>> {
    if (!creds.client_id || !creds.client_secret || !creds.refresh_token) {
      return {}; // private app tokens don't expire
    }

    const data = await this.httpPost<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
    }>('https://api.hubapi.com/oauth/v1/token', {}, {
      grant_type: 'refresh_token',
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
    });

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_expires_at: new Date(Date.now() + data.expires_in * 1000),
    };
  }

  async fetchContactPage(
    creds: CrmCredentials,
    cursor: SyncCursor,
    pageSize: number,
  ): Promise<ConnectorPage<NormalizedContact>> {
    const params = new URLSearchParams({
      limit: String(Math.min(pageSize, 100)),
      properties: CONTACT_PROPS,
      sorts: 'lastmodifieddate',
    });

    if (cursor.contacts_page_token) {
      params.set('after', cursor.contacts_page_token);
    } else if (cursor.contacts_updated_after) {
      // Use filterGroups for incremental sync
      const filterBody = {
        filterGroups: [{
          filters: [{
            propertyName: 'lastmodifieddate',
            operator: 'GTE',
            value: new Date(cursor.contacts_updated_after).getTime().toString(),
          }],
        }],
        properties: CONTACT_PROPS.split(','),
        limit: Math.min(pageSize, 100),
        after: cursor.contacts_page_token,
        sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
      };

      const res = await this.httpPost<HsSearchResponse>(
        `${HS_BASE}/crm/v3/objects/contacts/search`,
        this.authHeaders(creds),
        filterBody,
      );
      return this.mapContactSearchResponse(res);
    }

    const res = await this.httpGet<HsListResponse>(
      `${HS_BASE}/crm/v3/objects/contacts?${params}`,
      this.authHeaders(creds),
    );
    return this.mapContactListResponse(res);
  }

  async fetchDealPage(
    creds: CrmCredentials,
    cursor: SyncCursor,
    pageSize: number,
  ): Promise<ConnectorPage<NormalizedDeal>> {
    let res: HsListResponse | HsSearchResponse;

    if (cursor.deals_updated_after) {
      res = await this.httpPost<HsSearchResponse>(
        `${HS_BASE}/crm/v3/objects/deals/search`,
        this.authHeaders(creds),
        {
          filterGroups: [{
            filters: [{
              propertyName: 'hs_lastmodifieddate',
              operator: 'GTE',
              value: new Date(cursor.deals_updated_after).getTime().toString(),
            }],
          }],
          properties: DEAL_PROPS.split(','),
          limit: Math.min(pageSize, 100),
          after: cursor.deals_page_token,
        },
      );
    } else {
      const params = new URLSearchParams({
        limit: String(Math.min(pageSize, 100)),
        properties: DEAL_PROPS,
        ...(cursor.deals_page_token ? { after: cursor.deals_page_token } : {}),
      });
      res = await this.httpGet<HsListResponse>(
        `${HS_BASE}/crm/v3/objects/deals?${params}`,
        this.authHeaders(creds),
      );
    }

    return this.mapDealResponse(res as HsSearchResponse);
  }

  parseWebhook(
    rawBody: string,
    headers: Record<string, string>,
    secret?: string,
  ): WebhookEvent | null {
    // HubSpot webhook signature: X-HubSpot-Signature-v3
    if (secret) {
      const sig = headers['x-hubspot-signature-v3'] || headers['x-hubspot-signature'];
      if (!this.verifySignature(rawBody, sig, secret, headers['x-hubspot-request-timestamp'])) {
        return null; // invalid signature
      }
    }

    try {
      const events = JSON.parse(rawBody) as Array<{
        subscriptionType: string;
        objectId: number;
        propertyName?: string;
        propertyValue?: string;
        eventId: number;
        occurredAt: number;
        objectType: string;
      }>;

      // Take the first event (we process one at a time)
      const e = events[0];
      if (!e) return null;

      return {
        crm_type: 'hubspot',
        event_type: e.subscriptionType,
        external_id: String(e.objectId),
        payload: e as unknown as Record<string, unknown>,
        timestamp: new Date(e.occurredAt),
      };
    } catch {
      return null;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────
  private authHeaders(creds: CrmCredentials): Record<string, string> {
    const token = creds.access_token || creds.api_key;
    return { Authorization: `Bearer ${token}` };
  }

  private verifySignature(body: string, sig: string, secret: string, timestamp?: string): boolean {
    if (!sig) return false;
    // v3 signature: HMAC-SHA256(secret, <method><uri><body><timestamp>)
    // For simplicity, use v1: HMAC-SHA256(secret, body)
    const expected = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  }

  private mapContactListResponse(res: HsListResponse): ConnectorPage<NormalizedContact> {
    const records = res.results.map(r => this.normalizeContact(r));
    return {
      records,
      next_cursor: res.paging?.next?.after,
      has_more: !!res.paging?.next?.after,
      total_fetched: records.length,
    };
  }

  private mapContactSearchResponse(res: HsSearchResponse): ConnectorPage<NormalizedContact> {
    const records = res.results.map(r => this.normalizeContact(r));
    return {
      records,
      next_cursor: res.paging?.next?.after,
      has_more: !!res.paging?.next?.after,
      total_fetched: records.length,
    };
  }

  private mapDealResponse(res: HsSearchResponse): ConnectorPage<NormalizedDeal> {
    const records = res.results.map(r => this.normalizeDeal(r));
    return {
      records,
      next_cursor: res.paging?.next?.after,
      has_more: !!res.paging?.next?.after,
      total_fetched: records.length,
    };
  }

  private normalizeContact(r: HsObject): NormalizedContact {
    const p = r.properties;
    return {
      external_id: r.id,
      external_source: 'hubspot',
      first_name: String(p.firstname ?? ''),
      last_name: String(p.lastname ?? ''),
      email: normalizeEmail(String(p.email ?? '')) ?? undefined,
      phone: normalizePhone(String(p.phone ?? '')) ?? normalizePhone(String(p.mobilephone ?? '')) ?? undefined,
      city: p.city ? String(p.city) : undefined,
      state: p.state ? String(p.state) : undefined,
      zip: p.zip ? String(p.zip) : undefined,
      type: LIFECYCLE_MAP[String(p.lifecyclestage ?? '').toLowerCase()] ?? 'lead',
      source: p.leadsource ? String(p.leadsource) : 'hubspot',
      tags: ['hubspot'],
      custom_fields: { hs_object_id: r.id, hs_owner_id: p.hubspot_owner_id },
    };
  }

  private normalizeDeal(r: HsObject): NormalizedDeal {
    const p = r.properties;
    return {
      external_id: r.id,
      external_source: 'hubspot',
      name: String(p.dealname ?? `HubSpot Deal ${r.id}`),
      type: 'buyer',
      stage: DEAL_STAGE_MAP[String(p.dealstage ?? '').toLowerCase()] ?? 'active',
      price: p.amount ? Math.round(parseFloat(String(p.amount)) * 100) : undefined,
      expected_close_date: p.closedate ? String(p.closedate).split('T')[0] : undefined,
      source: 'hubspot',
      custom_fields: { hs_deal_id: r.id, hs_pipeline: p.pipeline },
    };
  }
}

// ── HubSpot API response types ────────────────────────────────────────────────
interface HsObject {
  id: string;
  properties: Record<string, unknown>;
}

interface HsListResponse {
  results: HsObject[];
  paging?: { next?: { after?: string } };
}

type HsSearchResponse = HsListResponse & { total: number };
