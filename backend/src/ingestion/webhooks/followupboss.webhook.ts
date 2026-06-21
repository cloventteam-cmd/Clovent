/**
 * Follow Up Boss webhook handler.
 * POST /crm/webhooks/followupboss/:tenantId
 */
import type { Request, Response } from 'express';
import { syncEngine } from '../sync-engine';
import { query } from '../../db/client';
import { logger } from '../../shared/logger';

export async function handleFollowUpBossWebhook(req: Request, res: Response): Promise<void> {
  const { tenantId } = req.params;
  const rawBody = (req as any).rawBody ?? JSON.stringify(req.body);
  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v ?? '')]),
  );

  const row = await query<{ id: string }>(
    `SELECT id FROM crm_credentials WHERE tenant_id = $1 AND crm_type = 'followupboss' AND is_active = true LIMIT 1`,
    [tenantId],
  ).then(r => r.rows[0]).catch(() => null);

  if (!row) {
    res.status(404).json({ error: 'No active Follow Up Boss credential' });
    return;
  }

  // FUB expects 200 immediately
  res.status(200).send('OK');

  setImmediate(async () => {
    const result = await syncEngine.runWebhook({
      tenantId,
      credentialId: row.id,
      rawBody: typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody),
      headers,
    });
    if (!result.processed) {
      logger.warn({ tenantId, error: result.error }, 'FUB webhook not processed');
    }
  });
}
