import { query, queryOne, queryMany } from '../client';
import type { Contact, UUID, PaginatedResult, ContactScores } from '../../shared/types';
import { paginate } from '../../shared/utils';

interface ContactFilter {
  type?: string;
  status?: string;
  owner_id?: string;
  tag?: string;
  search?: string;
}

export async function findContacts(
  tenantId: UUID,
  filter: ContactFilter = {},
  page = 1,
  perPage = 25,
): Promise<PaginatedResult<Contact>> {
  const conditions: string[] = ['c.tenant_id = $1', "c.status != 'archived'"];
  const params: unknown[] = [tenantId];
  let idx = 2;

  if (filter.type) { conditions.push(`c.type = $${idx++}`); params.push(filter.type); }
  if (filter.status) { conditions.push(`c.status = $${idx++}`); params.push(filter.status); }
  if (filter.owner_id) { conditions.push(`c.owner_id = $${idx++}`); params.push(filter.owner_id); }
  if (filter.tag) { conditions.push(`$${idx++} = ANY(c.tags)`); params.push(filter.tag); }
  if (filter.search) {
    conditions.push(`(c.first_name || ' ' || c.last_name || ' ' || COALESCE(c.email,'') ILIKE $${idx++})`);
    params.push(`%${filter.search}%`);
  }

  const where = conditions.join(' AND ');
  const offset = (page - 1) * perPage;

  const [countResult, dataResult] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) FROM contacts c WHERE ${where}`, params),
    queryMany<Contact>(
      `SELECT * FROM contacts c WHERE ${where}
       ORDER BY c.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, perPage, offset],
    ),
  ]);

  return paginate(dataResult, parseInt(countResult.rows[0].count, 10), page, perPage);
}

export async function findContactById(tenantId: UUID, id: UUID): Promise<Contact | null> {
  return queryOne<Contact>(
    'SELECT * FROM contacts WHERE tenant_id = $1 AND id = $2',
    [tenantId, id],
  );
}

export async function findContactByEmail(tenantId: UUID, email: string): Promise<Contact | null> {
  return queryOne<Contact>(
    'SELECT * FROM contacts WHERE tenant_id = $1 AND email = $2',
    [tenantId, email.toLowerCase()],
  );
}

export async function findContactByPhone(tenantId: UUID, phone: string): Promise<Contact | null> {
  return queryOne<Contact>(
    'SELECT * FROM contacts WHERE tenant_id = $1 AND (phone = $2 OR phone_alt = $2)',
    [tenantId, phone],
  );
}

export async function findContactByExternal(
  tenantId: UUID,
  externalSource: string,
  externalId: string,
): Promise<Contact | null> {
  return queryOne<Contact>(
    'SELECT * FROM contacts WHERE tenant_id = $1 AND external_source = $2 AND external_id = $3',
    [tenantId, externalSource, externalId],
  );
}

export async function createContact(
  tenantId: UUID,
  data: Partial<Contact>,
): Promise<Contact> {
  const result = await query<Contact>(
    `INSERT INTO contacts (
      tenant_id, owner_id, first_name, last_name, email, phone, phone_alt,
      city, state, zip, type, status, source, source_detail, tags,
      custom_fields, external_id, external_source, import_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    RETURNING *`,
    [
      tenantId, data.owner_id ?? null,
      data.first_name ?? '', data.last_name ?? '',
      data.email ?? null, data.phone ?? null, data.phone_alt ?? null,
      (data as any).city ?? null, (data as any).state ?? null, (data as any).zip ?? null,
      data.type ?? 'lead', data.status ?? 'active',
      data.source ?? null, (data as any).source_detail ?? null,
      data.tags ?? [],
      JSON.stringify(data.custom_fields ?? {}),
      data.external_id ?? null, data.external_source ?? null,
      data.import_id ?? null,
    ],
  );
  return result.rows[0];
}

export async function updateContact(
  tenantId: UUID,
  id: UUID,
  data: Partial<Contact>,
): Promise<Contact | null> {
  const fields: string[] = [];
  const params: unknown[] = [tenantId, id];
  let idx = 3;

  const allowed: (keyof Contact)[] = [
    'first_name', 'last_name', 'email', 'phone', 'phone_alt',
    'type', 'status', 'source', 'tags', 'custom_fields',
    'owner_id', 'last_contacted_at', 'next_followup_at',
  ] as any;

  for (const key of allowed) {
    if (key in data) {
      fields.push(`${key} = $${idx++}`);
      params.push((data as any)[key]);
    }
  }

  if (fields.length === 0) return findContactById(tenantId, id);

  return queryOne<Contact>(
    `UPDATE contacts SET ${fields.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    params,
  );
}

export async function updateContactScores(
  tenantId: UUID,
  contactId: UUID,
  scores: ContactScores,
): Promise<void> {
  await query(
    `UPDATE contacts SET
      buyer_probability = $3, seller_probability = $4,
      investor_probability = $5, referral_probability = $6,
      engagement_score = $7, relationship_health = $8
    WHERE tenant_id = $1 AND id = $2`,
    [
      tenantId, contactId,
      scores.buyer_probability, scores.seller_probability,
      scores.investor_probability, scores.referral_probability,
      scores.engagement_score, scores.relationship_health,
    ],
  );

  await query(
    `INSERT INTO contact_scores (
      tenant_id, contact_id, buyer_probability, seller_probability,
      investor_probability, referral_probability, engagement_score,
      relationship_health, signals
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      tenantId, contactId,
      scores.buyer_probability, scores.seller_probability,
      scores.investor_probability, scores.referral_probability,
      scores.engagement_score, scores.relationship_health,
      JSON.stringify(scores.signals),
    ],
  );
}

export async function getContactsForScoring(
  tenantId: UUID,
  limit = 100,
  offset = 0,
): Promise<Contact[]> {
  return queryMany<Contact>(
    `SELECT * FROM contacts
     WHERE tenant_id = $1 AND status = 'active'
     ORDER BY updated_at ASC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
}

export async function getTopContactsByScore(
  tenantId: UUID,
  scoreType: 'buyer_probability' | 'seller_probability' | 'referral_probability',
  limit = 10,
): Promise<Contact[]> {
  return queryMany<Contact>(
    `SELECT * FROM contacts
     WHERE tenant_id = $1 AND status = 'active' AND ${scoreType} > 0
     ORDER BY ${scoreType} DESC
     LIMIT $2`,
    [tenantId, limit],
  );
}
