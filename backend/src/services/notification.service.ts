import { query, queryMany } from '../db/client';
import type { Notification, UUID } from '../shared/types';

export async function getNotifications(
  userId: UUID,
  tenantId: UUID,
  options: { unread_only?: boolean; limit?: number } = {},
): Promise<Notification[]> {
  const { unread_only = false, limit = 50 } = options;

  const conditions = ['tenant_id = $1', 'user_id = $2'];
  const params: unknown[] = [tenantId, userId];
  let idx = 3;

  if (unread_only) {
    conditions.push(`is_read = false`);
  }

  return queryMany<Notification>(
    `SELECT * FROM notifications
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${idx}`,
    [...params, limit],
  );
}

export async function markRead(
  userId: UUID,
  tenantId: UUID,
  notificationIds?: UUID[],
): Promise<void> {
  if (notificationIds && notificationIds.length > 0) {
    await query(
      `UPDATE notifications SET is_read = true, read_at = NOW()
       WHERE tenant_id = $1 AND user_id = $2 AND id = ANY($3::uuid[])`,
      [tenantId, userId, notificationIds],
    );
  } else {
    // Mark all
    await query(
      'UPDATE notifications SET is_read = true, read_at = NOW() WHERE tenant_id = $1 AND user_id = $2',
      [tenantId, userId],
    );
  }
}

export async function getUnreadCount(userId: UUID, tenantId: UUID): Promise<number> {
  const result = await query<{ count: string }>(
    'SELECT COUNT(*) FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND is_read = false',
    [tenantId, userId],
  );
  return parseInt(result.rows[0].count, 10);
}
