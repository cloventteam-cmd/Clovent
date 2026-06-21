import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { getDeals, getDeal, addDeal, moveDealStage, getPipeline } from '../../services/deal.service';
import { getActivitiesForDeal } from '../../db/repositories/activities';
import { queryMany } from '../../db/client';
import { getDealsAtRisk } from '../../db/repositories/deals';
import { parsePageParams } from '../../shared/utils';

const router = Router();
router.use(requireAuth);

const DealSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['buyer','seller','lease','referral','investment']).default('buyer'),
  stage: z.enum(['lead','nurture','active','under_contract','inspection','appraisal','financing','clear_to_close','closed_won','closed_lost','withdrawn']).default('lead'),
  pipeline: z.string().default('residential'),
  price: z.number().int().optional(),
  commission_rate: z.number().optional(),
  probability: z.number().int().min(0).max(100).default(25),
  expected_close_date: z.string().optional(),
  contact_id: z.string().uuid().optional(),
  property_id: z.string().uuid().optional(),
  owner_id: z.string().uuid().optional(),
  tags: z.array(z.string()).default([]),
  custom_fields: z.record(z.unknown()).default({}),
  source: z.string().optional(),
  notes: z.string().optional(),
});

// GET /deals
router.get('/', async (req, res, next) => {
  try {
    const { page, perPage } = parsePageParams(req.query as any);
    const filter = {
      stage: req.query.stage as string,
      owner_id: req.query.owner_id as string,
      contact_id: req.query.contact_id as string,
    };
    const result = await getDeals(req.auth.tenant_id, filter, page, perPage);
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// GET /deals/pipeline
router.get('/pipeline', async (req, res, next) => {
  try {
    const stats = await getPipeline(req.auth.tenant_id);
    res.json({ success: true, data: stats });
  } catch (err) { next(err); }
});

// GET /deals/at-risk
router.get('/at-risk', async (req, res, next) => {
  try {
    const minRisk = parseFloat(req.query.min_risk as string ?? '0.4');
    const deals = await getDealsAtRisk(req.auth.tenant_id, minRisk);
    res.json({ success: true, data: deals });
  } catch (err) { next(err); }
});

// POST /deals
router.post('/', async (req, res, next) => {
  try {
    const data = DealSchema.parse(req.body);
    const deal = await addDeal(req.auth.tenant_id, req.auth.user_id, data as any);
    res.status(201).json({ success: true, data: deal });
  } catch (err) { next(err); }
});

// GET /deals/:id
router.get('/:id', async (req, res, next) => {
  try {
    const deal = await getDeal(req.auth.tenant_id, req.params.id);
    res.json({ success: true, data: deal });
  } catch (err) { next(err); }
});

// PATCH /deals/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const data = DealSchema.partial().parse(req.body);
    const { updateDeal } = await import('../../db/repositories/deals');
    const deal = await updateDeal(req.auth.tenant_id, req.params.id, data as any);
    res.json({ success: true, data: deal });
  } catch (err) { next(err); }
});

// POST /deals/:id/stage
router.post('/:id/stage', async (req, res, next) => {
  try {
    const { stage } = z.object({ stage: z.string() }).parse(req.body);
    const deal = await moveDealStage(req.auth.tenant_id, req.auth.user_id, req.params.id, stage);
    res.json({ success: true, data: deal });
  } catch (err) { next(err); }
});

// GET /deals/:id/activities
router.get('/:id/activities', async (req, res, next) => {
  try {
    const activities = await getActivitiesForDeal(req.auth.tenant_id, req.params.id);
    res.json({ success: true, data: activities });
  } catch (err) { next(err); }
});

// GET /deals/:id/risks
router.get('/:id/risks', async (req, res, next) => {
  try {
    const risks = await queryMany(
      'SELECT * FROM deal_risks WHERE deal_id = $1 ORDER BY risk_score DESC',
      [req.params.id],
    );
    res.json({ success: true, data: risks });
  } catch (err) { next(err); }
});

export default router;
