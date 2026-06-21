import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth';
import { query, queryMany, queryOne } from '../../db/client';
import { SegmentationEngine } from '../../modules/automation/segmentation';
import { queueCampaignStepJob } from '../../workers/queue';
import { parsePageParams } from '../../shared/utils';

const router = Router();
router.use(requireAuth);

const CampaignSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(['email','sms','multi_channel','drip']).default('email'),
  segment_rules: z.array(z.object({
    field: z.string(),
    operator: z.enum(['eq','neq','gt','lt','gte','lte','contains','in','not_in']),
    value: z.unknown(),
  })).default([]),
  trigger_rules: z.array(z.object({
    event: z.string(),
    conditions: z.array(z.unknown()).default([]),
    delay_minutes: z.number().optional(),
  })).default([]),
  sequence: z.array(z.object({
    step: z.number(),
    type: z.enum(['email','sms','wait','condition']),
    subject: z.string().optional(),
    body_template: z.string().optional(),
    delay_hours: z.number().optional(),
  })).default([]),
  settings: z.record(z.unknown()).default({}),
  scheduled_at: z.string().datetime().optional(),
});

// GET /campaigns
router.get('/', async (req, res, next) => {
  try {
    const { page, perPage } = parsePageParams(req.query as any);
    const campaigns = await queryMany(
      `SELECT * FROM campaigns WHERE tenant_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.auth.tenant_id, perPage, (page - 1) * perPage],
    );
    res.json({ success: true, data: campaigns });
  } catch (err) { next(err); }
});

// POST /campaigns
router.post('/', requireRole('owner', 'admin', 'agent'), async (req, res, next) => {
  try {
    const data = CampaignSchema.parse(req.body);
    const result = await query(
      `INSERT INTO campaigns (
        tenant_id, owner_id, name, description, type, status,
        segment_rules, trigger_rules, sequence, settings, scheduled_at
      ) VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10)
      RETURNING *`,
      [
        req.auth.tenant_id, req.auth.user_id,
        data.name, data.description ?? null, data.type,
        JSON.stringify(data.segment_rules), JSON.stringify(data.trigger_rules),
        JSON.stringify(data.sequence), JSON.stringify(data.settings),
        data.scheduled_at ?? null,
      ],
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

// GET /campaigns/:id
router.get('/:id', async (req, res, next) => {
  try {
    const campaign = await queryOne(
      'SELECT * FROM campaigns WHERE tenant_id = $1 AND id = $2',
      [req.auth.tenant_id, req.params.id],
    );
    if (!campaign) { res.status(404).json({ success: false, error: 'Not found' }); return; }
    res.json({ success: true, data: campaign });
  } catch (err) { next(err); }
});

// POST /campaigns/:id/launch — evaluate segment and enroll contacts
router.post('/:id/launch', requireRole('owner', 'admin', 'agent'), async (req, res, next) => {
  try {
    const campaign = await queryOne<any>(
      'SELECT * FROM campaigns WHERE tenant_id = $1 AND id = $2',
      [req.auth.tenant_id, req.params.id],
    );
    if (!campaign) { res.status(404).json({ success: false, error: 'Not found' }); return; }

    const segEngine = new SegmentationEngine(req.auth.tenant_id);
    const rules = Array.isArray(campaign.segment_rules) ? campaign.segment_rules : [];
    const contactIds = await segEngine.evaluateContacts(rules);

    // Enroll each contact
    let enrolled = 0;
    for (const contactId of contactIds) {
      await query(
        `INSERT INTO campaign_contacts (tenant_id, campaign_id, contact_id, status)
         VALUES ($1,$2,$3,'active')
         ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
        [req.auth.tenant_id, req.params.id, contactId],
      );
      await queueCampaignStepJob({
        tenant_id: req.auth.tenant_id,
        campaign_id: req.params.id,
        contact_id: contactId,
        step: 0,
      });
      enrolled++;
    }

    await query(
      "UPDATE campaigns SET status = 'active', started_at = NOW() WHERE id = $1",
      [req.params.id],
    );

    res.json({ success: true, data: { enrolled, campaign_id: req.params.id } });
  } catch (err) { next(err); }
});

// POST /campaigns/:id/pause
router.post('/:id/pause', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    await query(
      "UPDATE campaigns SET status = 'paused' WHERE tenant_id = $1 AND id = $2",
      [req.auth.tenant_id, req.params.id],
    );
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
