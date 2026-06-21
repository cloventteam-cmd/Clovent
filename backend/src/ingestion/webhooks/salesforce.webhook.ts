/**
 * Salesforce webhook/outbound message handler.
 * POST /crm/webhooks/salesforce/:tenantId
 */
import type { Request, Response } from 'express';
import { syncEngine } from '../sync-engine';
import { query } from '../../db/client';
import { logger } from '../../shared/logger';

export async function handleSalesforceWebhook(req: Request, res: Response): Promise<void> {
  const { tenantId } = req.params;
  const rawBody = (req as any).rawBody ?? JSON.stringify(req.body);
  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v ?? '')]),
  );

  const row = await query<{ id: string }>(
    `SELECT id FROM crm_credentials WHERE tenant_id = $1 AND crm_type = 'salesforce' AND is_active = true LIMIT 1`,
    [tenantId],
  ).then(r => r.rows[0]).catch(() => null);

  if (!row) {
    res.status(404).json({ error: 'No active Salesforce credential' });
    return;
  }

  // Salesforce Outbound Messages expect a specific SOAP ack
  // For REST-based Change Data Capture, a 200 is sufficient
  res.status(200).json({ acknowledged: true });

  setImmediate(async () => {
    const result = await syncEngine.runWebhook({
      tenantId,
      credentialId: row.id,
      rawBody: typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody),
      headers,
    });
    if (!result.processed) {
      logger.warn({ tenantId, error: result.error }, 'Salesforce webhook not processed');
    }
  });
}
