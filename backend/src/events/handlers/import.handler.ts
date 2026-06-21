/**
 * Import Event Handlers
 *
 * IMPORT_COMPLETED → notify user + trigger batch scoring for all new contacts
 * IMPORT_FAILED    → mark failed + notify user
 */
import { eventBus } from '../bus';
import { EventNames } from '../types';
import { logger } from '../../shared/logger';
import { updateImportStatus } from '../../db/repositories/imports';
import { queryMany } from '../../db/client';

eventBus.on(EventNames.IMPORT_COMPLETED, async (payload) => {
  const { tenant_id, import_id, stats } = payload;

  logger.info({ import_id, stats }, 'Pipeline: IMPORT_COMPLETED → notify + batch scoring');

  // Mark DB as completed
  await updateImportStatus(tenant_id, import_id, 'completed', {
    completed_at: new Date(),
  });

  // Notify the importing user
  await eventBus.emit(EventNames.NOTIFICATION_SEND, {
    tenant_id,
    user_id: 'import_owner',
    type: 'import_complete',
    title: 'Import Complete',
    body: `${stats.created} created · ${stats.updated} updated · ${stats.errors} errors`,
    data: { import_id, stats },
    entity_type: 'import',
    entity_id: import_id,
    channels: ['in_app', 'email'],
  });

  // Resolve all contacts created by this import and trigger scoring
  const imported = await queryMany<{ id: string }>(
    'SELECT id FROM contacts WHERE tenant_id = $1 AND import_id = $2 LIMIT 2000',
    [tenant_id, import_id],
  );

  const contactIds = imported.map(c => c.id);

  logger.info({ count: contactIds.length, import_id }, 'Pipeline: queueing batch scoring for imported contacts');

  // Use batch_requested event so the handler fans it out to the scoring queue
  await eventBus.emit(EventNames.SCORING_BATCH_REQUESTED, {
    tenant_id,
    contact_ids: contactIds,
  });
});

eventBus.on(EventNames.IMPORT_FAILED, async (payload) => {
  const { tenant_id, import_id, error } = payload;
  logger.error({ import_id, error }, 'Pipeline: IMPORT_FAILED');

  await updateImportStatus(tenant_id, import_id, 'failed');

  await eventBus.emit(EventNames.NOTIFICATION_SEND, {
    tenant_id,
    user_id: 'import_owner',
    type: 'import_complete',
    title: 'Import Failed',
    body: `Import could not be completed: ${error.slice(0, 120)}`,
    data: { import_id, error },
    entity_type: 'import',
    entity_id: import_id,
    channels: ['in_app'],
  });
});
