import type { Import, ImportStats, UUID } from '../shared/types';
import { FieldMapper } from './field-mapper';
import { DuplicateDetector } from './dedup';
import { EntityMerger } from './merger';
import { Normalizer } from './normalizer';
import { createContact, updateContact } from '../db/repositories/contacts';
import { createDeal } from '../db/repositories/deals';
import { createActivity } from '../db/repositories/activities';
import { markImportRowResult, updateImportStats } from '../db/repositories/imports';
import { eventBus } from '../events/bus';
import { EventNames } from '../events/types';
import { logger } from '../shared/logger';
import { chunk } from '../shared/utils';
import { config } from '../shared/config';
import type { ImportPreviewRow } from '../shared/types';

export class ImportEngine {
  private tenantId: UUID;
  private importRecord: Import;
  private mapper: FieldMapper;
  private dedup: DuplicateDetector;
  private merger: EntityMerger;
  private normalizer: Normalizer;

  constructor(tenantId: UUID, importRecord: Import) {
    this.tenantId = tenantId;
    this.importRecord = importRecord;
    this.mapper = new FieldMapper(importRecord.field_mapping, importRecord.source_type);
    this.dedup = new DuplicateDetector(tenantId);
    this.merger = new EntityMerger(tenantId);
    this.normalizer = new Normalizer();
  }

  // Preview first N rows without committing
  async preview(rawRows: Record<string, string>[], limit = 20): Promise<ImportPreviewRow[]> {
    const preview: ImportPreviewRow[] = [];
    const rows = rawRows.slice(0, limit);

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      const mapped = this.mapper.map(raw);
      const normalized = this.normalizer.normalize(mapped);
      const issues: string[] = this.validateRow(normalized);

      const match = await this.dedup.findMatch(normalized);
      let action: ImportPreviewRow['action'] = 'create';
      let matchId: UUID | undefined;

      if (match) {
        action = match.mergeStrategy === 'update' ? 'update' : 'merge';
        matchId = match.existingId;
      }

      preview.push({ index: i, raw, mapped: normalized, issues, action, match_id: matchId });
    }

    return preview;
  }

  // Full commit: process all rows
  async commit(onProgress?: (pct: number) => void): Promise<ImportStats> {
    const stats: ImportStats = {
      total: 0,
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
    };

    // Get all rows from import_rows table
    const { queryMany } = await import('../db/client');
    const rows = await queryMany<{ row_index: number; raw_data: Record<string, string>; mapped_data: Record<string, unknown> }>(
      'SELECT row_index, raw_data, mapped_data FROM import_rows WHERE import_id = $1 ORDER BY row_index',
      [this.importRecord.id],
    );

    stats.total = rows.length;
    const batches = chunk(rows, config.imports.batchSize);

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];

      await Promise.all(
        batch.map(async (row) => {
          try {
            const result = await this.processRow(row.row_index, row.raw_data);
            stats.processed = (stats.processed ?? 0) + 1;

            if (result.action === 'created') stats.created++;
            else if (result.action === 'updated') stats.updated++;
            else stats.skipped++;

            await markImportRowResult(
              this.importRecord.id,
              row.row_index,
              result.action === 'created' ? 'created' : result.action === 'updated' ? 'updated' : 'skipped',
              result.entityType,
              result.entityId,
            );
          } catch (err) {
            stats.errors++;
            const message = err instanceof Error ? err.message : String(err);
            await markImportRowResult(
              this.importRecord.id,
              row.row_index,
              'error',
              undefined,
              undefined,
              message,
            );
            logger.error({ row_index: row.row_index, err }, 'Import row error');
          }
        }),
      );

      if (onProgress) {
        onProgress(Math.round(((batchIdx + 1) / batches.length) * 100));
      }

      await updateImportStats(this.tenantId, this.importRecord.id, { ...stats });
    }

    return stats;
  }

  private async processRow(
    rowIndex: number,
    rawData: Record<string, string>,
  ): Promise<{ action: 'created' | 'updated' | 'skipped'; entityType?: string; entityId?: UUID }> {
    const mapped = this.mapper.map(rawData);
    const normalized = this.normalizer.normalize(mapped);

    if (!normalized.first_name && !normalized.last_name && !normalized.email) {
      return { action: 'skipped' };
    }

    const match = await this.dedup.findMatch(normalized);

    if (match && match.mergeStrategy === 'skip') {
      return { action: 'skipped', entityType: 'contact', entityId: match.existingId };
    }

    if (match) {
      const strategy = match.mergeStrategy === 'skip' ? 'merge' : match.mergeStrategy;
      const merged = await this.merger.merge(match.existingId, normalized, strategy);

      await eventBus.emit(EventNames.ACTIVITY_CREATED, {
        tenant_id: this.tenantId,
        activity_id: 'pending',
        contact_id: match.existingId,
        activity_type: 'import',
      });

      return { action: 'updated', entityType: 'contact', entityId: match.existingId };
    }

    // Create new contact
    const contact = await createContact(this.tenantId, {
      ...normalized,
      import_id: this.importRecord.id,
      external_source: this.importRecord.source_type,
      external_id: normalized.external_id,
    });

    // Create activity record for import
    await createActivity(this.tenantId, {
      contact_id: contact.id,
      type: 'import',
      subject: `Imported from ${this.importRecord.source_type}`,
      metadata: { import_id: this.importRecord.id, row_index: rowIndex },
      occurred_at: new Date(),
    });

    // Emit event → triggers scoring + embedding
    await eventBus.emit(EventNames.CONTACT_CREATED, {
      tenant_id: this.tenantId,
      contact_id: contact.id,
      source: this.importRecord.source_type,
      import_id: this.importRecord.id,
    });

    return { action: 'created', entityType: 'contact', entityId: contact.id };
  }

  private validateRow(data: Record<string, unknown>): string[] {
    const issues: string[] = [];
    if (!data.first_name && !data.last_name) issues.push('Missing name');
    if (!data.email && !data.phone) issues.push('Missing email and phone');
    return issues;
  }
}
