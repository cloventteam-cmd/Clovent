import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requirePlan, trackUsageAfter } from '../../billing/middleware/plan-enforcer';
import { getContacts, getContact, addContact, modifyContact, logActivity } from '../../services/contact.service';
import { getActivitiesForContact } from '../../db/repositories/activities';
import { findOpportunitiesByContact } from '../../db/repositories/opportunities';
import { AIMemorySystem } from '../../ai/memory/system';
import { RelationshipGraph } from '../../modules/relationship-graph/graph';
import { parsePageParams } from '../../shared/utils';
import { queueScoringJob } from '../../workers/queue';

const router = Router();
router.use(requireAuth);

const ContactSchema = z.object({
  first_name: z.string().default(''),
  last_name: z.string().default(''),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  phone_alt: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  type: z.enum(['lead','client','past_client','referral_partner','vendor','investor']).default('lead'),
  status: z.enum(['active','inactive','archived','do_not_contact']).default('active'),
  source: z.string().optional(),
  tags: z.array(z.string()).default([]),
  custom_fields: z.record(z.unknown()).default({}),
  owner_id: z.string().uuid().optional(),
});

const ActivitySchema = z.object({
  type: z.enum(['call','email','sms','note','meeting','showing','offer','contract','inspection','appraisal','closing','task_completed']),
  direction: z.enum(['inbound','outbound']).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  duration_sec: z.number().optional(),
  outcome: z.string().optional(),
  deal_id: z.string().uuid().optional(),
  occurred_at: z.string().datetime().optional(),
});

// GET /contacts
router.get('/', async (req, res, next) => {
  try {
    const { page, perPage } = parsePageParams(req.query as any);
    const filter = {
      type: req.query.type as string,
      status: req.query.status as string,
      owner_id: req.query.owner_id as string,
      tag: req.query.tag as string,
      search: req.query.search as string,
    };
    const result = await getContacts(req.auth.tenant_id, filter, page, perPage);
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// POST /contacts
router.post('/', requirePlan('contacts_created'), trackUsageAfter('contacts_created'), async (req, res, next) => {
  try {
    const data = ContactSchema.parse(req.body);
    const contact = await addContact(req.auth.tenant_id, req.auth.user_id, data as any);
    res.status(201).json({ success: true, data: contact });
  } catch (err) { next(err); }
});

// GET /contacts/:id
router.get('/:id', async (req, res, next) => {
  try {
    const contact = await getContact(req.auth.tenant_id, req.params.id);
    res.json({ success: true, data: contact });
  } catch (err) { next(err); }
});

// PATCH /contacts/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const data = ContactSchema.partial().parse(req.body);
    const contact = await modifyContact(req.auth.tenant_id, req.auth.user_id, req.params.id, data as any);
    res.json({ success: true, data: contact });
  } catch (err) { next(err); }
});

// GET /contacts/:id/activities
router.get('/:id/activities', async (req, res, next) => {
  try {
    const activities = await getActivitiesForContact(req.auth.tenant_id, req.params.id);
    res.json({ success: true, data: activities });
  } catch (err) { next(err); }
});

// POST /contacts/:id/activities
router.post('/:id/activities', async (req, res, next) => {
  try {
    const data = ActivitySchema.parse(req.body);
    const activity = await logActivity(req.auth.tenant_id, req.auth.user_id, req.params.id, data as any);
    res.status(201).json({ success: true, data: activity });
  } catch (err) { next(err); }
});

// GET /contacts/:id/opportunities
router.get('/:id/opportunities', async (req, res, next) => {
  try {
    const opps = await findOpportunitiesByContact(req.auth.tenant_id, req.params.id);
    res.json({ success: true, data: opps });
  } catch (err) { next(err); }
});

// GET /contacts/:id/network
router.get('/:id/network', async (req, res, next) => {
  try {
    const graph = new RelationshipGraph(req.auth.tenant_id);
    const network = await graph.getNetwork(req.params.id, 2);
    res.json({ success: true, data: network });
  } catch (err) { next(err); }
});

// POST /contacts/:id/rescore
router.post('/:id/rescore', async (req, res, next) => {
  try {
    await queueScoringJob({ tenant_id: req.auth.tenant_id, contact_id: req.params.id }, 1);
    res.json({ success: true, message: 'Scoring job queued' });
  } catch (err) { next(err); }
});

export default router;
