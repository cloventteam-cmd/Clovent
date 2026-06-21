/**
 * Salesforce CRM Connector
 *
 * API: Salesforce REST API v57 (OAuth2 web server flow)
 * Rate limits: varies by org edition (20-100 req/s)
 * Contacts: GET /services/data/v57.0/query?q=SOQL
 * Deals (Opportunities): same pattern
 * Webhooks: Streaming API / Change Data Capture (complex) — webhook via Platform Events
 */
import crypto from 'crypto';
import { BaseCrmConnector } from './base.connector';
import type {
  CrmCredentials, SyncCursor, ConnectorPage,
  NormalizedContact, NormalizedDeal, WebhookEvent, CrmType,
} from '../types';
import { normalizePhone, normalizeEmail } from '../../shared/utils';

const SF_API_VERSION = 'v57.0';

const CONTACT_FIELDS = [
  'Id', 'FirstName', 'LastName', 'Email', 'Phone', 'MobilePhone',
  'MailingCity', 'MailingState', 'MailingPostalCode', 'MailingCountry',
  'LeadSource', 'Title', 'Department', 'Account.Name',
  'LastModifiedDate', 'CreatedDate', 'OwnerId',
].join(', ');

const OPPORTUNITY_FIELDS = [
  'Id', 'Name', 'StageName', 'Amount', 'CloseDate',
  'Probability', 'Type', 'LeadSource', 'OwnerId',
  'Contact__r.Id', 'LastModifiedDate',
].join(', ');

// Map Salesforce opportunity stages → CLOVENT deal stages
const SF_STAGE_MAP: Record<string, string> = {
  'Prospecting': 'lead',
  'Qualification': 'nurture',
  'Needs Analysis': 'nurture',
  'Value Proposition': 'active',
  'Id. Decision Makers': 'active',
  'Perception Analysis': 'active',
  'Proposal/Price Quote': 'active',
  'Negotiation/Review': 'under_contract',
  'Closed Won': 'closed_won',
  'Closed Lost': 'closed_lost',
};

export class SalesforceConnector extends BaseCrmConnector {
  readonly crmType: CrmType = 'salesforce';

  constructor() {
    super();
    this.init('salesforce');
  }

  private base(creds: CrmCredentials): string {
    return `${creds.instance_url}/services/data/${SF_API_VERSION}`;
  }

  private headers(creds: CrmCredentials): Record<string, string> {
    return { Authorization: `Bearer ${creds.access_token}` };
  }

  async testConnection(creds: CrmCredentials): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.httpGet<unknown>(`${this.base(creds)}/limits`, this.headers(creds));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async refreshToken(creds: CrmCredentials): Promise<Partial<CrmCredentials>> {
    if (!creds.client_id || !creds.client_secret || !creds.refresh_token) return {};

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
    });

    const res = await fetch('https://login.salesforce.com/services/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) throw new Error(`SF token refresh failed: ${await res.text()}`);
    const data = await res.json() as { access_token: string; instance_url: string };

    return {
      access_token: data.access_token,
      instance_url: data.instance_url,
      token_expires_at: new Date(Date.now() + 2 * 3600 * 1000), // SF tokens last ~2h
    };
  }

  async fetchContactPage(
    creds: CrmCredentials,
    cursor: SyncCursor,
    pageSize: number,
  ): Promise<ConnectorPage<NormalizedContact>> {
    const since = cursor.contacts_updated_after
      ? `AND LastModifiedDate >= ${cursor.contacts_updated_after}`
      : '';

    const soql = `SELECT ${CONTACT_FIELDS} FROM Contact WHERE IsDeleted = false ${since} ORDER BY LastModifiedDate ASC LIMIT ${pageSize} OFFSET ${cursor.contacts_page_token ? parseInt(cursor.contacts_page_token, 10) : 0}`;

    const res = await this.httpGet<SfQueryResult<SfContact>>(
      `${this.base(creds)}/query?q=${encodeURIComponent(soql)}`,
      this.headers(creds),
    );

    const records = res.records.map(r => this.normalizeContact(r));
    const offset = (cursor.contacts_page_token ? parseInt(cursor.contacts_page_token, 10) : 0) + records.length;
    const hasMore = !res.done || !!res.nextRecordsUrl;
    const nextPageToken = hasMore ? String(offset) : undefined;

    return { records, next_cursor: nextPageToken, has_more: hasMore, total_fetched: records.length };
  }

  async fetchDealPage(
    creds: CrmCredentials,
    cursor: SyncCursor,
    pageSize: number,
  ): Promise<ConnectorPage<NormalizedDeal>> {
    const since = cursor.deals_updated_after
      ? `AND LastModifiedDate >= ${cursor.deals_updated_after}`
      : '';

    const soql = `SELECT ${OPPORTUNITY_FIELDS} FROM Opportunity WHERE IsDeleted = false ${since} ORDER BY LastModifiedDate ASC LIMIT ${pageSize} OFFSET ${cursor.deals_page_token ? parseInt(cursor.deals_page_token, 10) : 0}`;

    const res = await this.httpGet<SfQueryResult<SfOpportunity>>(
      `${this.base(creds)}/query?q=${encodeURIComponent(soql)}`,
      this.headers(creds),
    );

    const records = res.records.map(r => this.normalizeDeal(r));
    const offset = (cursor.deals_page_token ? parseInt(cursor.deals_page_token, 10) : 0) + records.length;
    const hasMore = !res.done;

    return { records, next_cursor: hasMore ? String(offset) : undefined, has_more: hasMore, total_fetched: records.length };
  }

  parseWebhook(
    rawBody: string,
    headers: Record<string, string>,
    secret?: string,
  ): WebhookEvent | null {
    // Salesforce Outbound Messages arrive as SOAP XML.
    // For simplicity, we handle JSON-format Platform Events.
    try {
      const body = JSON.parse(rawBody) as {
        event?: { type: string; createdDate: string };
        sobject?: Record<string, unknown>;
        Id?: string;
      };

      if (!body.sobject || !body.Id) return null;

      return {
        crm_type: 'salesforce',
        event_type: body.event?.type ?? 'update',
        external_id: body.Id,
        payload: body.sobject,
        timestamp: body.event?.createdDate ? new Date(body.event.createdDate) : new Date(),
      };
    } catch {
      return null;
    }
  }

  private normalizeContact(r: SfContact): NormalizedContact {
    return {
      external_id: r.Id,
      external_source: 'salesforce',
      first_name: r.FirstName ?? '',
      last_name: r.LastName ?? '',
      email: normalizeEmail(r.Email ?? '') ?? undefined,
      phone: normalizePhone(r.Phone ?? '') ?? normalizePhone(r.MobilePhone ?? '') ?? undefined,
      city: r.MailingCity ?? undefined,
      state: r.MailingState ?? undefined,
      zip: r.MailingPostalCode ?? undefined,
      country: r.MailingCountry ?? undefined,
      source: r.LeadSource ?? 'salesforce',
      type: 'lead',
      tags: ['salesforce'],
      custom_fields: { sf_id: r.Id, sf_account: r.Account?.Name, sf_owner: r.OwnerId },
    };
  }

  private normalizeDeal(r: SfOpportunity): NormalizedDeal {
    return {
      external_id: r.Id,
      external_source: 'salesforce',
      name: r.Name,
      type: 'buyer',
      stage: SF_STAGE_MAP[r.StageName] ?? 'active',
      price: r.Amount ? Math.round(r.Amount * 100) : undefined,
      probability: r.Probability,
      expected_close_date: r.CloseDate ?? undefined,
      source: r.LeadSource ?? 'salesforce',
      custom_fields: { sf_id: r.Id, sf_stage: r.StageName },
    };
  }
}

// ── Salesforce API types ──────────────────────────────────────────────────────
interface SfQueryResult<T> {
  records: T[];
  totalSize: number;
  done: boolean;
  nextRecordsUrl?: string;
}

interface SfContact {
  Id: string;
  FirstName?: string;
  LastName: string;
  Email?: string;
  Phone?: string;
  MobilePhone?: string;
  MailingCity?: string;
  MailingState?: string;
  MailingPostalCode?: string;
  MailingCountry?: string;
  LeadSource?: string;
  OwnerId?: string;
  Account?: { Name?: string };
}

interface SfOpportunity {
  Id: string;
  Name: string;
  StageName: string;
  Amount?: number;
  CloseDate?: string;
  Probability?: number;
  Type?: string;
  LeadSource?: string;
  OwnerId?: string;
}
