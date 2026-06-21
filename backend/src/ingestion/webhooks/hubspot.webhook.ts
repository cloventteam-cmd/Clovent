/**
 * HubSpot webhook endpoint handler.
 * Called by src/api/routes/crm.ts for POST /crm/webhooks/hubspot/:tenantId
 */
import type { Request, Response } from 'express';
import { syncEngine } from '../sync-engine';
import { query } from '../../db/client';
import { logger } from '../../shared/logger';

export async function handleHubSpotWebhook(req: Request, res: Response): Promise<void> {
  const { tenantId } = req.params;
  const rawBody = (req as any).rawBody as string ?? JSON.stringify(req.body);
  const headers = Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v ?? '')]),
  );

  // Resolve credential for this tenant + hubspot
  const row = await query<{ id: string }>(
    `SELECT id FROM crm_credentials WHERE tenant_id = $1 AND crm_type = 'hubspot' AND is_active = true LIMIT 1`,
    [tenantId],
  ).then(r => r.rows[0]).catch(() => null);

  if (!row) {
    res.status(404).json({ error: 'No active HubSpot credential for this tenant' });
    return;
  }

  // Acknowledge immediately (HubSpot requires <5s response)
  res.status(200).send('OK');

  // Process asynchronously after responding
  setImmediate(async () => {
    const result = await syncEngine.runWebhook({
      tenantId,
      credentialId: row.id,
      rawBody,
      headers,
    });
    if (!result.processed) {
      logger.warn({ tenantId, error: result.error }, 'HubSpot webhook not processed');
    }
  });
}
