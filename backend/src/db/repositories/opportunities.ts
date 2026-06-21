import { query, queryOne, queryMany } from '../client';
import type { Opportunity, UUID, PaginatedResult } from '../../shared/types';
import { paginate } from '../../shared/utils';

export async function createOpportunity(
  tenantId: UUID,
  data: Partial<Opportunity>,
): Promise<Opportunity> {
  const result = await query<Opportunity>(
    `INSERT INTO opportunities (
      tenant_id, contact_id, deal_id, type, priority, status,
      score, confidence, title, description, recommended_action,
      signals, expires_at, job_run_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    RETURNING *`,
    [
      tenantId, data.contact_id ?? null, data.deal_id ?? null,
      data.type ?? 'likely_buyer', data.priority ?? 'medium',
      data.status ?? 'open', data.score ?? 0, data.confidence ?? 0,
      data.title ?? '', data.description ?? null,
      data.recommended_action ?? null,
      JSON.stringify(data.signals ?? []),
      data.expires_at ?? null, data.job_run_id ?? null,
    ],
  );
  return result.rows[0];
}

export async function findOpenOpportunities(
  tenantId: UUID,
  page = 1,
  perPage = 25,
): Promise<PaginatedResult<Opportunity>> {
  const offset = (page - 1) * perPage;
  const [countRes, dataRes] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*) FROM opportunities WHERE tenant_id = $1 AND status = 'open'`,
      [tenantId],
    ),
    queryMany<Opportunity>(
      `SELECT o.*, c.first_name || ' ' || c.last_name AS contact_name
       FROM opportunities o
       LEFT JOIN contacts c ON c.id = o.contact_id
       WHERE o.tenant_id = $1 AND o.status = 'open'
       ORDER BY o.score DESC, o.priority DESC
       LIMIT $2 OFFSET $3`,
      [tenantId, perPage, offset],
    ),
  ]);
  return paginate(dataRes, parseInt(countRes.rows[0].count, 10), page, perPage);
}

export async function findOpportunitiesByContact(
  tenantId: UUID,
  contactId: UUID,
): Promise<Opportunity[]> {
  return queryMany<Opportunity>(
    `SELECT * FROM opportunities
     WHERE tenant_id = $1 AND contact_id = $2 AND status = 'open'
     ORDER BY score DESC`,
    [tenantId, contactId],
  );
}

export async function dismissOpportunity(
  tenantId: UUID,
  id: UUID,
  userId: UUID,
): Promise<void> {
  await query(
    `UPDATE opportunities SET status = 'dismissed', actioned_at = NOW(), actioned_by = $3
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, userId],
  );
}

export async function expireOldOpportunities(tenantId: UUID): Promise<number> {
  const result = await query(
    `UPDATE opportunities SET status = 'expired'
     WHERE tenant_id = $1 AND status = 'open' AND expires_at < NOW()`,
    [tenantId],
  );
  return result.rowCount ?? 0;
}

export async function deduplicateOpportunity(
  tenantId: UUID,
  contactId: UUID,
  type: string,
): Promise<boolean> {
  const existing = await queryOne(
    `SELECT id FROM opportunities
     WHERE tenant_id = $1 AND contact_id = $2 AND type = $3 AND status = 'open'`,
    [tenantId, contactId, type],
  );
  return existing !== null;
}
