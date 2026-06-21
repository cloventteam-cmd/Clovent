/**
 * Prediction API
 *
 * GET  /predictions                     — list open predictions for tenant
 * GET  /predictions/contacts/:id        — predictions for a specific contact
 * POST /predictions/run                 — trigger manual batch run
 * POST /predictions/contacts/:id/run    — trigger single contact prediction
 * GET  /predictions/stats               — summary stats
 * PATCH /predictions/:id/outcome        — mark prediction correct/incorrect (feedback loop)
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth';
import { requireFeature } from '../../billing/middleware/plan-enforcer';
import { queryMany, queryOne, query } from '../../db/client';
import { queuePredictionJob } from '../../workers/queue';
import { parsePageParams } from '../../shared/utils';

const router = Router();
router.use(requireAuth);

// GET /predictions
router.get('/', async (req, res, next) => {
  try {
    const { page, perPage } = parsePageParams(req.query as any);
    const type = req.query.type as string | undefined;
    const minProb = parseFloat(req.query.min_probability as string ?? '0.4');

    const conditions = ['p.tenant_id = $1', `p.probability >= $2`, `p.is_actioned = false`];
    const params: unknown[] = [req.auth.tenant_id, minProb];
    let idx = 3;

    if (type) { conditions.push(`p.prediction_type = $${idx++}`); params.push(type); }

    const where = conditions.join(' AND ');
    const offset = (page - 1) * perPage;

    const [countRes, dataRes] = await Promise.all([
      query<{ count: string }>(
        `SELECT COUNT(*) FROM predictions p WHERE ${where}`,
        params,
      ),
      queryMany(
        `SELECT p.*, c.first_name, c.last_name, c.email
         FROM predictions p
         LEFT JOIN contacts c ON c.id = p.contact_id
         WHERE ${where}
         ORDER BY p.probability DESC, p.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, perPage, offset],
      ),
    ]);

    res.json({
      success: true,
      data: dataRes,
      total: parseInt(countRes.rows[0].count, 10),
      page, per_page: perPage,
    });
  } catch (err) { next(err); }
});

// GET /predictions/contacts/:id
router.get('/contacts/:id', async (req, res, next) => {
  try {
    const preds = await queryMany(
      `SELECT * FROM predictions
       WHERE tenant_id = $1 AND contact_id = $2
       ORDER BY created_at DESC LIMIT 20`,
      [req.auth.tenant_id, req.params.id],
    );
    res.json({ success: true, data: preds });
  } catch (err) { next(err); }
});

// GET /predictions/stats
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await queryMany(
      `SELECT prediction_type,
              COUNT(*)::int AS total,
              AVG(probability)::numeric(4,3) AS avg_probability,
              COUNT(*) FILTER (WHERE probability > 0.7)::int AS high_prob_count,
              MAX(created_at) AS last_run
       FROM predictions
       WHERE tenant_id = $1 AND is_actioned = false
       GROUP BY prediction_type
       ORDER BY avg_probability DESC`,
      [req.auth.tenant_id],
    );

    const behavPatterns = await queryMany(
      `SELECT engagement_trend, COUNT(*)::int AS count
       FROM behavioral_patterns
       WHERE tenant_id = $1
       GROUP BY engagement_trend
       ORDER BY count DESC`,
      [req.auth.tenant_id],
    );

    res.json({ success: true, data: { predictions: stats, behavioral_patterns: behavPatterns } });
  } catch (err) { next(err); }
});

// POST /predictions/run — manual trigger (owner/admin only, Growth+ required)
router.post('/run', requireRole('owner', 'admin'), requireFeature('ai_predictions'), async (req, res, next) => {
  try {
    const { prediction_type } = z.object({
      prediction_type: z.enum(['full', 'seller', 'buyer', 'reactivation', 'deal_failure']).default('full'),
    }).parse(req.body);

    const jobId = await queuePredictionJob({
      tenant_id: req.auth.tenant_id,
      prediction_type,
    });

    res.json({ success: true, data: { job_id: jobId, prediction_type, status: 'queued' } });
  } catch (err) { next(err); }
});

// POST /predictions/contacts/:id/run
router.post('/contacts/:id/run', async (req, res, next) => {
  try {
    const jobId = await queuePredictionJob({
      tenant_id: req.auth.tenant_id,
      contact_id: req.params.id,
      prediction_type: 'full',
    });

    res.json({ success: true, data: { job_id: jobId, contact_id: req.params.id } });
  } catch (err) { next(err); }
});

// PATCH /predictions/:id/outcome — feedback loop
router.patch('/:id/outcome', async (req, res, next) => {
  try {
    const { outcome } = z.object({
      outcome: z.enum(['correct', 'incorrect', 'unknown']),
    }).parse(req.body);

    await query(
      `UPDATE predictions SET outcome = $3, is_actioned = true, actioned_at = NOW()
       WHERE tenant_id = $1 AND id = $2`,
      [req.auth.tenant_id, req.params.id, outcome],
    );

    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
