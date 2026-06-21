import { query, queryOne, queryMany } from '../client';
import type { Deal, UUID, PaginatedResult } from '../../shared/types';
import { paginate } from '../../shared/utils';

export async function findDeals(
  tenantId: UUID,
  filter: { stage?: string; owner_id?: string; contact_id?: string } = {},
  page = 1,
  perPage = 25,
): Promise<PaginatedResult<Deal>> {
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  let idx = 2;

  if (filter.stage) { conditions.push(`stage = $${idx++}`); params.push(filter.stage); }
  if (filter.owner_id) { conditions.push(`owner_id = $${idx++}`); params.push(filter.owner_id); }
  if (filter.contact_id) { conditions.push(`contact_id = $${idx++}`); params.push(filter.contact_id); }

  const where = conditions.join(' AND ');
  const offset = (page - 1) * perPage;

  const [countResult, dataResult] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*) FROM deals WHERE ${where}`, params),
    queryMany<Deal>(
      `SELECT * FROM deals WHERE ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, perPage, offset],
    ),
  ]);

  return paginate(dataResult, parseInt(countResult.rows[0].count, 10), page, perPage);
}

export async function findDealById(tenantId: UUID, id: UUID): Promise<Deal | null> {
  return queryOne<Deal>('SELECT * FROM deals WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
}

export async function createDeal(tenantId: UUID, data: Partial<Deal>): Promise<Deal> {
  const result = await query<Deal>(
    `INSERT INTO deals (
      tenant_id, owner_id, contact_id, property_id, name, type, stage,
      pipeline, price, commission_rate, probability, expected_close_date,
      tags, custom_fields, source, external_id, external_source, import_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    RETURNING *`,
    [
      tenantId, data.owner_id ?? null, data.contact_id ?? null,
      data.property_id ?? null, data.name ?? 'Untitled Deal',
      data.type ?? 'buyer', data.stage ?? 'lead',
      data.pipeline ?? 'residential', data.price ?? null,
      data.commission_rate ?? null, data.probability ?? 10,
      (data as any).expected_close_date ?? null,
      data.tags ?? [],
      JSON.stringify(data.custom_fields ?? {}),
      data.source ?? null, data.external_id ?? null,
      data.external_source ?? null, data.import_id ?? null,
    ],
  );
  return result.rows[0];
}

export async function updateDeal(tenantId: UUID, id: UUID, data: Partial<Deal>): Promise<Deal | null> {
  const fields: string[] = [];
  const params: unknown[] = [tenantId, id];
  let idx = 3;

  const allowed = ['stage', 'price', 'probability', 'expected_close_date', 'actual_close_date',
    'commission_rate', 'commission_amount', 'lost_reason', 'notes', 'tags', 'custom_fields',
    'risk_score', 'failure_probability'];

  for (const key of allowed) {
    if (key in data) { fields.push(`${key} = $${idx++}`); params.push((data as any)[key]); }
  }

  if (fields.length === 0) return findDealById(tenantId, id);
  return queryOne<Deal>(
    `UPDATE deals SET ${fields.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
    params,
  );
}

export async function updateDealRisk(
  tenantId: UUID,
  id: UUID,
  riskScore: number,
  failureProbability: number,
): Promise<void> {
  await query(
    'UPDATE deals SET risk_score = $3, failure_probability = $4 WHERE tenant_id = $1 AND id = $2',
    [tenantId, id, riskScore, failureProbability],
  );
}

export async function getDealsAtRisk(tenantId: UUID, minRisk = 0.5): Promise<Deal[]> {
  return queryMany<Deal>(
    `SELECT d.*, c.first_name || ' ' || c.last_name AS contact_name
     FROM deals d
     LEFT JOIN contacts c ON c.id = d.contact_id
     WHERE d.tenant_id = $1 AND d.risk_score >= $2
       AND d.stage NOT IN ('closed_won','closed_lost','withdrawn')
     ORDER BY d.risk_score DESC`,
    [tenantId, minRisk],
  );
}

export async function getPipelineStats(tenantId: UUID): Promise<{
  stage: string;
  count: number;
  total_value: number;
  weighted_value: number;
}[]> {
  return queryMany(
    `SELECT stage,
            COUNT(*) AS count,
            COALESCE(SUM(price),0) AS total_value,
            COALESCE(SUM(price * probability / 100),0) AS weighted_value
     FROM deals
     WHERE tenant_id = $1 AND stage NOT IN ('closed_lost','withdrawn')
     GROUP BY stage
     ORDER BY array_position(
       ARRAY['lead','nurture','active','under_contract','inspection',
             'appraisal','financing','clear_to_close','closed_won'],
       stage
     )`,
    [tenantId],
  ) as any;
}
