/**
 * Notification Worker
 *
 * Consumes NOTIFICATION_SEND jobs from the queue.
 * For each target user:
 *   1. Writes an in-app notification row to the notifications table
 *   2. Sends an email via EmailService (real API or mock)
 *
 * User ID special values resolved here (deal_owner, contact_owner, import_owner, all)
 */
import type { Job } from 'bullmq';
import { createWorker, type NotificationJobData } from './queue';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { query, queryMany } from '../db/client';
import { sendEmail, buildNotificationEmail } from '../services/email.service';

async function resolveUserIds(data: NotificationJobData): Promise<Array<{ id: string; email: string }>> {
  const { tenant_id, user_id, entity_type, entity_id } = data;

  if (user_id === 'all') {
    return queryMany<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE tenant_id = $1 AND is_active = true AND role IN ('owner','admin','agent')",
      [tenant_id],
    );
  }

  if (user_id === 'deal_owner' && entity_type === 'deal' && entity_id) {
    const users = await queryMany<{ id: string; email: string }>(
      `SELECT u.id, u.email FROM users u
       JOIN deals d ON d.owner_id = u.id
       WHERE d.id = $1 AND d.tenant_id = $2`,
      [entity_id, tenant_id],
    );
    if (users.length > 0) return users;
  }

  if (user_id === 'contact_owner' && entity_type === 'contact' && entity_id) {
    const users = await queryMany<{ id: string; email: string }>(
      `SELECT u.id, u.email FROM users u
       JOIN contacts c ON c.owner_id = u.id
       WHERE c.id = $1 AND c.tenant_id = $2`,
      [entity_id, tenant_id],
    );
    if (users.length > 0) return users;
  }

  if (user_id === 'contact_owner' && entity_type === 'opportunity' && entity_id) {
    const users = await queryMany<{ id: string; email: string }>(
      `SELECT u.id, u.email FROM users u
       JOIN contacts c ON c.owner_id = u.id
       JOIN opportunities o ON o.contact_id = c.id
       WHERE o.id = $1 AND o.tenant_id = $2`,
      [entity_id, tenant_id],
    );
    if (users.length > 0) return users;
  }

  if (user_id === 'import_owner' && entity_type === 'import' && entity_id) {
    const users = await queryMany<{ id: string; email: string }>(
      `SELECT u.id, u.email FROM users u
       JOIN imports i ON i.user_id = u.id
       WHERE i.id = $1 AND i.tenant_id = $2`,
      [entity_id, tenant_id],
    );
    if (users.length > 0) return users;
  }

  // Fallback: resolve as a direct user ID
  const direct = await queryMany<{ id: string; email: string }>(
    'SELECT id, email FROM users WHERE id = $1 AND tenant_id = $2 AND is_active = true',
    [user_id, tenant_id],
  );
  if (direct.length > 0) return direct;

  // Last resort: owners
  return queryMany<{ id: string; email: string }>(
    "SELECT id, email FROM users WHERE tenant_id = $1 AND role = 'owner' AND is_active = true LIMIT 3",
    [tenant_id],
  );
}

async function processNotificationJob(job: Job<NotificationJobData>): Promise<void> {
  const {
    tenant_id, type, title, body, data = {},
    entity_type, entity_id, channels,
  } = job.data;

  // Resolve which users to notify
  const targets = await resolveUserIds(job.data);

  if (targets.length === 0) {
    logger.warn({ type, tenant_id }, 'Notification worker: no target users found');
    return;
  }

  logger.info(
    { type, title, targets: targets.length, channels },
    'Notification worker: dispatching',
  );

  await Promise.all(
    targets.map(async (user) => {
      // ── In-app notification ──────────────────────────────────────────────
      if (channels.includes('in_app')) {
        await query(
          `INSERT INTO notifications
           (tenant_id, user_id, type, title, body, data, entity_type, entity_id, channel)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'in_app')`,
          [
            tenant_id, user.id, type, title,
            body ?? null,
            JSON.stringify(data),
            entity_type ?? null,
            entity_id ?? null,
          ],
        );
        logger.debug({ user_id: user.id, type }, 'In-app notification created');
      }

      // ── Email notification ───────────────────────────────────────────────
      if (channels.includes('email') && user.email) {
        const org = await query<{ name: string }>(
          'SELECT name FROM organizations WHERE id = $1',
          [tenant_id],
        ).then(r => r.rows[0]);

        const { subject, html, text } = buildNotificationEmail({
          type,
          title,
          body: body ?? '',
          data,
          tenant_name: org?.name ?? 'CLOVENT',
        });

        const result = await sendEmail({
          to: user.email,
          subject,
          html,
          text,
          tenant_id,
          contact_id: entity_type === 'contact' ? entity_id : undefined,
          metadata: { notification_type: type, user_id: user.id },
        });

        logger.info(
          { user_id: user.id, email: user.email, provider: result.provider, success: result.success },
          'Email notification sent',
        );
      }
    }),
  );
}

export function startNotificationWorker(): void {
  createWorker<NotificationJobData>(config.queues.notification, processNotificationJob, 15);
  logger.info({ queue: config.queues.notification, concurrency: 15 }, 'Notification worker started');
}
