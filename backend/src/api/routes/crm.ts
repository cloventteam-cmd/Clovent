/**
 * CRM Connector API
 *
 * Endpoints:
 *   GET    /crm/connections               list all CRM credentials for tenant
 *   POST   /crm/connections               connect a new CRM
 *   GET    /crm/connections/:id           get credential details (no secrets)
 *   DELETE /crm/connections/:id           deactivate a CRM connection
 *   POST   /crm/connections/:id/sync      trigger manual sync
 *   POST   /crm/connections/:id/test      test connection
 *   GET    /crm/connections/:id/logs      sync history
 *
 *   POST   /crm/webhooks/hubspot/:tenantId       HubSpot webhook
 *   POST   /crm/webhooks/salesforce/:tenantId    Salesforce webhook
 *   POST   /crm/webhooks/followupboss/:tenantId  Follow Up Boss webhook
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth';
import {
  createCredential, listCredentials, findCredential,
  deactivateCredential,
} from '../../ingestion/db/credentials';
import { getConnector, listSupportedCrms } from '../../ingestion/registry';
import { queueCrmSyncJob } from '../../workers/queue';
import { query, queryMany as dbQueryMany } from '../../db/client';
import { handleHubSpotWebhook } from '../../ingestion/webhooks/hubspot.webhook';
import { handleSalesforceWebhook } from '../../ingestion/webhooks/salesforce.webhook';
import { handleFollowUpBossWebhook } from '../../ingestion/webhooks/followupboss.webhook';

const router = Router();

// ── Authenticated CRM management endpoints ────────────────────────────────────
router.use('/connections', requireAuth);

// GET /crm/connections
router.get('/connections', async (req, res, next) => {
  try {
    const creds = await listCredentials(req.auth.tenant_id);
    // Strip sensitive fields before returning
    const safe = creds.map(({ access_token, refresh_token, api_key, client_secret, ...rest }) => rest);
    res.json({ success: true, data: safe });
  } catch (err) { next(err); }
});

// POST /crm/connections
router.post('/connections', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const body = z.object({
      crm_type: z.enum(['hubspot', 'salesforce', 'followupboss', 'kvcore', 'generic_rest']),
      label: z.string().min(1).max(100),
      credentials: z.record(z.unknown()),
      settings: z.object({
        sync_interval_min: z.number().int().min(5).default(60),
        entity_types: z.array(z.enum(['contacts', 'deals'])).default(['contacts', 'deals']),
        contact_batch_size: z.number().int().min(1).max(500).default(100),
        deal_batch_size: z.number().int().min(1).max(500).default(100),
        max_records_per_sync: z.number().int().min(0).default(10_000),
        webhook_enabled: z.boolean().default(false),
        owner_id: z.string().uuid().optional(),
        tags: z.array(z.string()).optional(),
      }).optional(),
    }).parse(req.body);

    const cred = await createCredential(
      req.auth.tenant_id,
      req.auth.user_id,
      { crm_type: body.crm_type, label: body.label, credentials: body.credentials, settings: body.settings },
    );

    const { access_token, refresh_token, api_key, client_secret, ...safe } = cred;
    res.status(201).json({ success: true, data: safe });
  } catch (err) { next(err); }
});

// GET /crm/connections/:id
router.get('/connections/:id', async (req, res, next) => {
  try {
    const cred = await findCredential(req.auth.tenant_id, req.params.id);
    if (!cred) { res.status(404).json({ success: false, error: 'Not found' }); return; }
    const { access_token, refresh_token, api_key, client_secret, ...safe } = cred;
    res.json({ success: true, data: safe });
  } catch (err) { next(err); }
});

// DELETE /crm/connections/:id
router.delete('/connections/:id', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    await deactivateCredential(req.auth.tenant_id, req.params.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /crm/connections/:id/test
router.post('/connections/:id/test', async (req, res, next) => {
  try {
    const cred = await findCredential(req.auth.tenant_id, req.params.id);
    if (!cred) { res.status(404).json({ success: false, error: 'Not found' }); return; }

    const connector = getConnector(cred.crm_type);
    const result = await connector.testConnection(cred);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// POST /crm/connections/:id/sync
router.post('/connections/:id/sync', requireRole('owner', 'admin', 'agent'), async (req, res, next) => {
  try {
    const { sync_type, entity_types } = z.object({
      sync_type: z.enum(['full', 'incremental']).default('incremental'),
      entity_types: z.array(z.enum(['contacts', 'deals'])).optional(),
    }).parse(req.body);

    const cred = await findCredential(req.auth.tenant_id, req.params.id);
    if (!cred) { res.status(404).json({ success: false, error: 'Not found' }); return; }

    const jobId = await queueCrmSyncJob({
      tenant_id: req.auth.tenant_id,
      credential_id: req.params.id,
      crm_type: cred.crm_type,
      sync_type,
      entity_types: entity_types ?? cred.settings.entity_types,
    });

    res.json({ success: true, data: { job_id: jobId, crm_type: cred.crm_type, sync_type } });
  } catch (err) { next(err); }
});

// GET /crm/connections/:id/logs
router.get('/connections/:id/logs', async (req, res, next) => {
  try {
    const logs = await dbQueryMany(
      `SELECT id, crm_type, sync_type, status, started_at, completed_at, stats, error
       FROM crm_sync_logs WHERE credential_id = $1 ORDER BY started_at DESC LIMIT 50`,
      [req.params.id],
    );
    res.json({ success: true, data: logs });
  } catch (err) { next(err); }
});

// GET /crm/supported
router.get('/supported', requireAuth, (req, res) => {
  res.json({ success: true, data: listSupportedCrms() });
});

// ── Webhook endpoints (no auth — verified by HMAC) ────────────────────────────
// Capture raw body for signature verification
const rawBodyMiddleware = (req: any, _res: any, next: any) => {
  let raw = '';
  req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
  req.on('end', () => { req.rawBody = raw; next(); });
};

router.post('/webhooks/hubspot/:tenantId',      rawBodyMiddleware, handleHubSpotWebhook);
router.post('/webhooks/salesforce/:tenantId',   rawBodyMiddleware, handleSalesforceWebhook);
router.post('/webhooks/followupboss/:tenantId', rawBodyMiddleware, handleFollowUpBossWebhook);

export default router;
