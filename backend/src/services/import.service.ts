import { parseCsv, detectCsvMapping } from '../imports/parsers/csv.parser';
import { parseExcel } from '../imports/parsers/excel.parser';
import { normalizeSalesforceRows, extractSalesforceExternalId } from '../imports/parsers/crm/salesforce.parser';
import { normalizeHubSpotRows } from '../imports/parsers/crm/hubspot.parser';
import { normalizeFubRows } from '../imports/parsers/crm/followupboss.parser';
import { normalizeKvCoreRows } from '../imports/parsers/crm/kvcore.parser';
import { ImportEngine } from '../imports/engine';
import { FieldMapper } from '../imports/field-mapper';
import {
  createImport, findImportById, updateImportStatus,
  setImportPreview, insertImportRows, updateFieldMapping,
  getImportHistory,
} from '../db/repositories/imports';
import { queueImportJob } from '../workers/queue';
import { eventBus } from '../events/bus';
import { EventNames } from '../events/types';
import type { Import, UUID, ImportSourceType } from '../shared/types';
import { logger } from '../shared/logger';

export async function startImport(
  tenantId: UUID,
  userId: UUID,
  params: {
    name: string;
    sourceType: ImportSourceType;
    filePath?: string;
    originalFilename?: string;
    fileSize?: number;
  },
): Promise<Import> {
  const importRecord = await createImport(tenantId, {
    user_id: userId,
    name: params.name,
    source_type: params.sourceType,
    file_path: params.filePath,
    original_filename: params.originalFilename,
    file_size: params.fileSize,
  } as any);

  return importRecord;
}

export async function generatePreview(
  tenantId: UUID,
  importId: UUID,
): Promise<{ preview: unknown[]; detected_mapping: Record<string, unknown>; total_rows: number }> {
  const importRecord = await findImportById(tenantId, importId);
  if (!importRecord) throw new Error('Import not found');
  if (!importRecord.file_path) throw new Error('No file attached to import');

  await updateImportStatus(tenantId, importId, 'previewing');

  let rows: Record<string, string>[] = [];

  if (importRecord.source_type === 'csv') {
    const result = await parseCsv(importRecord.file_path);
    rows = result.rows;
  } else if (importRecord.source_type === 'excel') {
    const result = await parseExcel(importRecord.file_path);
    rows = result.rows;
  }

  // Apply CRM-specific normalization
  rows = applyCrmNormalization(rows, importRecord.source_type);

  // Detect mapping from first row headers
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const detectedMapping = FieldMapper.detectMapping(headers, importRecord.source_type);

  // Generate preview
  const engine = new ImportEngine(tenantId, {
    ...importRecord,
    field_mapping: detectedMapping,
  } as Import);

  const preview = await engine.preview(rows, 20);

  await setImportPreview(tenantId, importId, preview);
  await updateFieldMapping(tenantId, importId, detectedMapping);

  // Store all rows for commit
  const rowsToStore = rows.map((r, i) => ({
    row_index: i,
    raw_data: r,
    mapped_data: {},
  }));

  await insertImportRows(tenantId, importId, rowsToStore);

  return {
    preview,
    detected_mapping: detectedMapping,
    total_rows: rows.length,
  };
}

export async function commitImport(
  tenantId: UUID,
  importId: UUID,
  userId: UUID,
  fieldMapping?: Record<string, unknown>,
): Promise<{ job_id: string }> {
  const importRecord = await findImportById(tenantId, importId);
  if (!importRecord) throw new Error('Import not found');
  if (!['preview_ready', 'pending'].includes(importRecord.status)) {
    throw new Error(`Import cannot be committed from status: ${importRecord.status}`);
  }

  // Apply custom mapping if provided
  if (fieldMapping) {
    await updateFieldMapping(tenantId, importId, fieldMapping);
  }

  const jobId = await queueImportJob({ tenant_id: tenantId, import_id: importId, user_id: userId });

  await updateImportStatus(tenantId, importId, 'committing', { job_id: jobId });

  await eventBus.emit(EventNames.IMPORT_STARTED, {
    tenant_id: tenantId,
    import_id: importId,
    source_type: importRecord.source_type,
    total_rows: importRecord.stats.total,
  });

  return { job_id: jobId };
}

export async function getImport(tenantId: UUID, importId: UUID): Promise<Import> {
  const record = await findImportById(tenantId, importId);
  if (!record) throw new Error('Import not found');
  return record;
}

export async function listImports(tenantId: UUID): Promise<Import[]> {
  return getImportHistory(tenantId);
}

function applyCrmNormalization(
  rows: Record<string, string>[],
  sourceType: ImportSourceType,
): Record<string, string>[] {
  switch (sourceType) {
    case 'salesforce': return normalizeSalesforceRows(rows);
    case 'hubspot': return normalizeHubSpotRows(rows);
    case 'followupboss': return normalizeFubRows(rows);
    case 'kvcore': return normalizeKvCoreRows(rows);
    default: return rows;
  }
}
