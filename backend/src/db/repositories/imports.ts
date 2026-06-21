import { query, queryOne, queryMany } from '../client';
import type { Import, ImportStats, ImportError, UUID } from '../../shared/types';

export async function createImport(tenantId: UUID, data: Partial<Import>): Promise<Import> {
  const result = await query<Import>(
    `INSERT INTO imports (
      tenant_id, user_id, name, source_type, status,
      file_path, file_size, original_filename, field_mapping, options
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *`,
    [
      tenantId, data.user_id ?? null, data.name ?? 'Import',
      data.source_type ?? 'csv', data.status ?? 'pending',
      data.file_path ?? null, (data as any).file_size ?? null,
      data.original_filename ?? null,
      JSON.stringify(data.field_mapping ?? {}),
      JSON.stringify(data.options ?? {}),
    ],
  );
  return result.rows[0];
}

export async function findImportById(tenantId: UUID, id: UUID): Promise<Import | null> {
  return queryOne<Import>('SELECT * FROM imports WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
}

export async function updateImportStatus(
  tenantId: UUID,
  id: UUID,
  status: Import['status'],
  extras: Partial<{ job_id: string; started_at: Date; completed_at: Date }> = {},
): Promise<void> {
  const fields = ['status = $3'];
  const params: unknown[] = [tenantId, id, status];
  let idx = 4;

  if (extras.job_id) { fields.push(`job_id = $${idx++}`); params.push(extras.job_id); }
  if (extras.started_at) { fields.push(`started_at = $${idx++}`); params.push(extras.started_at); }
  if (extras.completed_at) { fields.push(`completed_at = $${idx++}`); params.push(extras.completed_at); }

  await query(
    `UPDATE imports SET ${fields.join(', ')} WHERE tenant_id = $1 AND id = $2`,
    params,
  );
}

export async function updateImportStats(
  tenantId: UUID,
  id: UUID,
  stats: ImportStats,
): Promise<void> {
  await query(
    'UPDATE imports SET stats = $3 WHERE tenant_id = $1 AND id = $2',
    [tenantId, id, JSON.stringify(stats)],
  );
}

export async function setImportPreview(
  tenantId: UUID,
  id: UUID,
  preview: unknown[],
): Promise<void> {
  await query(
    `UPDATE imports SET preview_data = $3, status = 'preview_ready'
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, JSON.stringify(preview)],
  );
}

export async function updateFieldMapping(
  tenantId: UUID,
  id: UUID,
  mapping: Record<string, unknown>,
): Promise<void> {
  await query(
    'UPDATE imports SET field_mapping = $3 WHERE tenant_id = $1 AND id = $2',
    [tenantId, id, JSON.stringify(mapping)],
  );
}

export async function insertImportRows(
  tenantId: UUID,
  importId: UUID,
  rows: Array<{ row_index: number; raw_data: unknown; mapped_data: unknown }>,
): Promise<void> {
  if (rows.length === 0) return;
  const values = rows.map(
    (r, i) => `($1,$2,$${3 + i * 3},$${4 + i * 3},$${5 + i * 3})`,
  );
  const params: unknown[] = [tenantId, importId];
  for (const r of rows) {
    params.push(r.row_index, JSON.stringify(r.raw_data), JSON.stringify(r.mapped_data));
  }
  await query(
    `INSERT INTO import_rows (tenant_id, import_id, row_index, raw_data, mapped_data)
     VALUES ${values.join(',')}`,
    params,
  );
}

export async function markImportRowResult(
  importId: UUID,
  rowIndex: number,
  status: string,
  entityType?: string,
  entityId?: UUID,
  error?: string,
): Promise<void> {
  await query(
    `UPDATE import_rows SET status = $3, entity_type = $4, entity_id = $5, error = $6
     WHERE import_id = $1 AND row_index = $2`,
    [importId, rowIndex, status, entityType ?? null, entityId ?? null, error ?? null],
  );
}

export async function getImportHistory(
  tenantId: UUID,
  limit = 20,
): Promise<Import[]> {
  return queryMany<Import>(
    `SELECT * FROM imports WHERE tenant_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit],
  );
}
