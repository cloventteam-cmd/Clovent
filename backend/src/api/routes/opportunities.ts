import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import {
  findOpenOpportunities,
  dismissOpportunity,
} from '../../db/repositories/opportunities';
import { queueOpportunityJob } from '../../workers/queue';
import { query } from '../../db/client';
import { parsePageParams } from '../../shared/utils';
import { eventBus } from '../../events/bus';
import { EventNames } from '../../events/types';

const router = Router();
router.use(requireAuth);

// GET /opportunities
router.get('/', async (req, res, next) => {
  try {
    const { page, perPage } = parsePageParams(req.query as any);
    const result = await findOpenOpportunities(req.auth.tenant_id, page, perPage);
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// POST /opportunities/scan — trigger manual scan
router.post('/scan', async (req, res, next) => {
  try {
    await queueOpportunityJob({ tenant_id: req.auth.tenant_id });
    res.json({ success: true, message: 'Opportunity scan queued' });
  } catch (err) { next(err); }
});

// GET /opportunities/:id
router.get('/:id', async (req, res, next) => {
  try {
    const opp = await query(
      'SELECT * FROM opportunities WHERE tenant_id = $1 AND id = $2',
      [req.auth.tenant_id, req.params.id],
    );
    if (!opp.rows[0]) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    res.json({ success: true, data: opp.rows[0] });
  } catch (err) { next(err); }
});

// POST /opportunities/:id/dismiss
router.post('/:id/dismiss', async (req, res, next) => {
  try {
    await dismissOpportunity(req.auth.tenant_id, req.params.id, req.auth.user_id);
    await eventBus.emit(EventNames.OPPORTUNITY_ACTIONED, {
      tenant_id: req.auth.tenant_id,
      opportunity_id: req.params.id,
      user_id: req.auth.user_id,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /opportunities/:id/convert
router.post('/:id/convert', async (req, res, next) => {
  try {
    await query(
      `UPDATE opportunities SET status = 'converted', actioned_at = NOW(), actioned_by = $3
       WHERE tenant_id = $1 AND id = $2`,
      [req.auth.tenant_id, req.params.id, req.auth.user_id],
    );
    await eventBus.emit(EventNames.OPPORTUNITY_ACTIONED, {
      tenant_id: req.auth.tenant_id,
      opportunity_id: req.params.id,
      user_id: req.auth.user_id,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
