/**
 * Notification Event Handler
 *
 * NOTIFICATION_SEND → bridge from EventBus to the BullMQ notification queue.
 * This is the single fan-out point: every module that needs to send a
 * notification emits NOTIFICATION_SEND on the event bus and this handler
 * routes it to the queue worker which resolves users and dispatches channels.
 */
import { eventBus } from '../bus';
import { EventNames } from '../types';
import { queueNotificationJob } from '../../workers/queue';
import { logger } from '../../shared/logger';

eventBus.on(EventNames.NOTIFICATION_SEND, async (payload) => {
  logger.debug(
    { type: payload.type, user_id: payload.user_id, channels: payload.channels },
    'Pipeline: NOTIFICATION_SEND → queue',
  );

  await queueNotificationJob({
    tenant_id: payload.tenant_id,
    user_id: payload.user_id,
    type: payload.type,
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
    entity_type: payload.entity_type,
    entity_id: payload.entity_id,
    channels: payload.channels,
  });
});
