import { query, queryOne, queryMany } from '../client';
import type { Activity, UUID } from '../../shared/types';

export async function createActivity(tenantId: UUID, data: Partial<Activity>): Promise<Activity> {
  const result = await query<Activity>(
    `INSERT INTO activities (
      tenant_id, user_id, contact_id, deal_id, type, direction,
      subject, body, duration_sec, outcome, metadata, occurred_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING *`,
    [
      tenantId, data.user_id ?? null, data.contact_id ?? null,
      data.deal_id ?? null, data.type ?? 'note',
      data.direction ?? null, data.subject ?? null,
      data.body ?? null, data.duration_sec ?? null,
      data.outcome ?? null,
      JSON.stringify(data.metadata ?? {}),
      data.occurred_at ?? new Date(),
    ],
  );
  return result.rows[0];
}

export async function getActivitiesForContact(
  tenantId: UUID,
  contactId: UUID,
  limit = 50,
): Promise<Activity[]> {
  return queryMany<Activity>(
    `SELECT * FROM activities
     WHERE tenant_id = $1 AND contact_id = $2
     ORDER BY occurred_at DESC LIMIT $3`,
    [tenantId, contactId, limit],
  );
}

export async function getActivitiesForDeal(
  tenantId: UUID,
  dealId: UUID,
  limit = 50,
): Promise<Activity[]> {
  return queryMany<Activity>(
    `SELECT * FROM activities
     WHERE tenant_id = $1 AND deal_id = $2
     ORDER BY occurred_at DESC LIMIT $3`,
    [tenantId, dealId, limit],
  );
}

export async function getRecentActivities(
  tenantId: UUID,
  since: Date,
): Promise<Activity[]> {
  return queryMany<Activity>(
    `SELECT * FROM activities
     WHERE tenant_id = $1 AND occurred_at >= $2
     ORDER BY occurred_at DESC`,
    [tenantId, since],
  );
}

export async function getContactActivitySummary(
  tenantId: UUID,
  contactId: UUID,
): Promise<{
  total_count: number;
  last_activity_at: Date | null;
  types: Record<string, number>;
}> {
  const result = await queryMany<{ type: string; count: string; last_at: Date }>(
    `SELECT type, COUNT(*) AS count, MAX(occurred_at) AS last_at
     FROM activities
     WHERE tenant_id = $1 AND contact_id = $2
     GROUP BY type`,
    [tenantId, contactId],
  );

  const types: Record<string, number> = {};
  let total = 0;
  let lastAt: Date | null = null;

  for (const row of result) {
    types[row.type] = parseInt(String(row.count), 10);
    total += types[row.type];
    if (!lastAt || row.last_at > lastAt) lastAt = row.last_at;
  }

  return { total_count: total, last_activity_at: lastAt, types };
}
