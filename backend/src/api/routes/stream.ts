/**
 * SSE Stream Endpoint
 *
 * GET /api/stream          — authenticated via ?token=<jwt> (EventSource can't set headers)
 * GET /api/stream/stats    — current connection counts (internal monitoring)
 *
 * Protocol: Server-Sent Events (text/event-stream)
 *
 * Initial messages on connect:
 *   1. "connected" system event with session info
 *   2. Snapshot of current pipeline/contacts/deals (REST hydration)
 *
 * All subsequent messages are real-time events pushed by the broadcaster.
 */
import { Router, type Response as ExpressResponse } from 'express';
import { verifyAccessToken } from '../../services/auth.service';
import { eventBroadcaster } from '../../realtime/broadcaster';
import { requireAuth } from '../middleware/auth';
import { queryMany } from '../../db/client';
import { logger } from '../../shared/logger';

const router = Router();

// ── SSE stream ────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  // Auth via query param (EventSource API doesn't support custom headers)
  const token = req.query.token as string | undefined;
  if (!token) {
    res.status(401).json({ error: 'Missing token query param' });
    return;
  }

  let auth: ReturnType<typeof verifyAccessToken>;
  try {
    auth = verifyAccessToken(token);
  } catch {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  const { tenant_id, user_id, role } = auth;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');  // disable nginx buffering
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Register with broadcaster (gets own client ID)
  const clientId = eventBroadcaster.register(tenant_id, user_id, res);

  // Send "connected" event immediately
  const connectedFrame = `data: ${JSON.stringify({
    id: clientId,
    type: 'system.connected',
    payload: { tenant_id, user_id, role, client_id: clientId },
    ts: new Date().toISOString(),
  })}\n\n`;
  res.write(connectedFrame);

  // Send initial snapshot asynchronously (hydrates dashboard without extra REST calls)
  sendSnapshot(tenant_id, res).catch(err =>
    logger.warn({ err }, 'SSE: snapshot send failed'),
  );

  // Cleanup on disconnect
  req.on('close', () => {
    eventBroadcaster.unregister(tenant_id, clientId);
  });
});

// ── /stream/stats ─────────────────────────────────────────────────────────────
router.get('/stats', requireAuth, (_req, res) => {
  res.json({ success: true, data: eventBroadcaster.stats() });
});

// ── Initial snapshot payload ──────────────────────────────────────────────────
// Sends the current DB state as a batch of "snapshot.*" events so the
// dashboard is populated immediately without separate REST calls.
async function sendSnapshot(tenantId: string, res: ExpressResponse): Promise<void> {
  const write = (type: string, payload: unknown) => {
    try {
      (res as any).write(`data: ${JSON.stringify({ id: 'snapshot', type, payload, ts: new Date().toISOString() })}\n\n`);
    } catch { /* client gone */ }
  };

  try {
    // Hot contacts (top 15 by score)
    const hotContacts = await queryMany(
      `SELECT id, first_name, last_name, email, buyer_probability, seller_probability,
              engagement_score, relationship_health, type, status, tags, last_contacted_at
       FROM contacts
       WHERE tenant_id = $1 AND status = 'active'
       ORDER BY GREATEST(buyer_probability, seller_probability, engagement_score) DESC
       LIMIT 15`,
      [tenantId],
    );
    write('snapshot.contacts', hotContacts);

    // Pipeline summary
    const pipeline = await queryMany(
      `SELECT stage, COUNT(*) AS count, COALESCE(SUM(price),0) AS value,
              AVG(risk_score) AS avg_risk
       FROM deals
       WHERE tenant_id = $1 AND stage NOT IN ('closed_lost','withdrawn')
       GROUP BY stage`,
      [tenantId],
    );
    write('snapshot.pipeline', pipeline);

    // Open opportunities
    const opportunities = await queryMany(
      `SELECT o.id, o.type, o.priority, o.score, o.title, o.recommended_action,
              c.first_name, c.last_name
       FROM opportunities o
       LEFT JOIN contacts c ON c.id = o.contact_id
       WHERE o.tenant_id = $1 AND o.status = 'open'
       ORDER BY o.score DESC LIMIT 20`,
      [tenantId],
    );
    write('snapshot.opportunities', opportunities);

    // Recent activities (last 20)
    const activities = await queryMany(
      `SELECT a.id, a.type, a.subject, a.occurred_at,
              c.first_name, c.last_name
       FROM activities a
       LEFT JOIN contacts c ON c.id = a.contact_id
       WHERE a.tenant_id = $1
       ORDER BY a.occurred_at DESC LIMIT 20`,
      [tenantId],
    );
    write('snapshot.activities', activities);

    // At-risk deals
    const risks = await queryMany(
      `SELECT d.id, d.name, d.stage, d.risk_score, d.failure_probability, d.price,
              dr.category, dr.description
       FROM deals d
       LEFT JOIN deal_risks dr ON dr.deal_id = d.id AND dr.is_resolved = false
       WHERE d.tenant_id = $1 AND d.risk_score > 0.3
       ORDER BY d.risk_score DESC LIMIT 10`,
      [tenantId],
    );
    write('snapshot.risks', risks);

    write('snapshot.complete', { ts: new Date().toISOString() });
  } catch (err) {
    logger.error({ err, tenant_id: tenantId }, 'SSE: snapshot query failed');
  }
}

export default router;
