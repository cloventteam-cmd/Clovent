/**
 * Ingestion Event Handler
 *
 * Handles IMPORT_REQUESTED emitted by CRM connectors.
 *
 * This is the bridge from the ingestion layer into the existing import pipeline:
 *   connector emits IMPORT_REQUESTED
 *     → this handler creates/updates an Import record
 *     → inserts normalized rows into import_rows (pre-mapped, no re-mapping needed)
 *     → queues the import job (which runs ImportEngine.commit())
 *     → commit triggers CONTACT_CREATED → scoring → opportunity → notifications
 *
 * Never writes contacts/deals directly — always goes through the existing pipeline.
 */
import { eventBus } from '../bus';
import { EventNames } from '../types';
import { logger } from '../../shared/logger';
import { query, queryOne } from '../../db/client';
import { queueImportJob } from '../../workers/queue';
import type { ImportRequestedPayload, NormalizedContact, NormalizedDeal } from '../../ingestion/types';

// In-memory map: (tenant_id + credential_id + sync session) → import_id
// This groups batches from the same sync run into one import record.
const activeImports = new Map<string, string>(); // key → import_id

function batchKey(p: ImportRequestedPayload): string {
  return `${p.tenant_id}:${p.credential_id}:${p.entity_type}`;
}

eventBus.on(EventNames.IMPORT_REQUESTED as any, async (rawPayload: unknown) => {
  const payload = rawPayload as ImportRequestedPayload;

  logger.info(
    {
      crm: payload.crm_type,
      entity: payload.entity_type,
      batch: payload.batch_index,
      rows: payload.rows.length,
      last: payload.is_last_batch,
    },
    'Ingestion: IMPORT_REQUESTED received',
  );

  const key = batchKey(payload);

  // ── Ensure import record exists for this sync session ─────────────────────
  let importId = activeImports.get(key);

  if (!importId) {
    const importName = `${payload.crm_type} ${payload.entity_type} ${payload.sync_type} sync`;

    const row = await queryOne<{ id: string }>(
      `INSERT INTO imports (
         tenant_id, name, source_type, status, field_mapping, options
       ) VALUES ($1,$2,$3,'committing',$4,$5)
       RETURNING id`,
      [
        payload.tenant_id,
        importName,
        payload.crm_type,
        // Identity field_mapping: CLOVENT fields already normalized by connector
        JSON.stringify({ _ingestion_mode: 'pre_normalized' }),
        JSON.stringify({
          crm_type: payload.crm_type,
          sync_type: payload.sync_type,
          entity_type: payload.entity_type,
          credential_id: payload.credential_id,
        }),
      ],
    );

    if (!row) {
      logger.error({ crm: payload.crm_type }, 'Ingestion: failed to create import record');
      return;
    }

    importId = row.id;
    activeImports.set(key, importId);
    logger.debug({ import_id: importId, crm: payload.crm_type }, 'Ingestion: import record created');
  }

  // ── Insert normalized rows into import_rows ───────────────────────────────
  if (payload.rows.length > 0) {
    const baseOffset = payload.batch_index * 10_000; // ensures unique row_index across batches

    // Build bulk insert
    const valueSets: string[] = [];
    const params: unknown[] = [payload.tenant_id, importId];
    let idx = 3;

    for (let i = 0; i < payload.rows.length; i++) {
      const row = payload.rows[i] as NormalizedContact | NormalizedDeal;
      const rowIndex = baseOffset + i;
      valueSets.push(`($1,$2,$${idx++},$${idx++},$${idx++})`);
      params.push(rowIndex, JSON.stringify(row), JSON.stringify(row)); // raw=mapped for pre-normalized
    }

    await query(
      `INSERT INTO import_rows (tenant_id, import_id, row_index, raw_data, mapped_data)
       VALUES ${valueSets.join(',')}
       ON CONFLICT DO NOTHING`,
      params,
    );
  }

  // ── On last batch: trigger the import commit worker ───────────────────────
  if (payload.is_last_batch) {
    logger.info({ import_id: importId, crm: payload.crm_type }, 'Ingestion: all batches received — queuing commit');

    // Update total count
    const countRow = await queryOne<{ cnt: string }>(
      'SELECT COUNT(*) AS cnt FROM import_rows WHERE import_id = $1',
      [importId],
    );
    const total = parseInt(countRow?.cnt ?? '0', 10);

    await query(
      `UPDATE imports SET stats = $2 WHERE id = $1`,
      [importId, JSON.stringify({ total, processed: 0, created: 0, updated: 0, skipped: 0, errors: 0 })],
    );

    // Queue the import job — ImportEngine.commit() runs and emits CONTACT_CREATED per row
    const jobId = await queueImportJob({
      tenant_id: payload.tenant_id,
      import_id: importId,
    });

    logger.info({ import_id: importId, job_id: jobId, total_rows: total }, 'Ingestion: import job queued');

    // Update sync log if available
    if (payload.log_id) {
      await query(
        'UPDATE crm_sync_logs SET import_id = $2 WHERE id = $1',
        [payload.log_id, importId],
      ).catch(() => {}); // non-fatal
    }

    // Clean up active import tracking
    activeImports.delete(key);
  }
});
