import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { requireFeature } from '../../billing/middleware/plan-enforcer';
import { ai } from '../../ai/layer';
import { AIMemorySystem } from '../../ai/memory/system';
import { BusinessOperator } from '../../ai/operator/business-operator';
import { queryOne, query } from '../../db/client';
import { findContactById } from '../../db/repositories/contacts';

const router = Router();
router.use(requireAuth);

const memory = new AIMemorySystem();

// POST /ai/ask — semantic memory query
router.post('/ask', async (req, res, next) => {
  try {
    const { question, entity_types, contact_id, limit } = z.object({
      question: z.string().min(1).max(500),
      entity_types: z.array(z.string()).optional(),
      contact_id: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(20).default(10),
    }).parse(req.body);

    const results = await memory.query({
      tenant_id: req.auth.tenant_id,
      question,
      entity_types,
      contact_id,
      limit,
    });

    res.json({ success: true, data: { question, results } });
  } catch (err) { next(err); }
});

// POST /ai/contacts/:id/ask — ask about a specific contact
router.post('/contacts/:id/ask', async (req, res, next) => {
  try {
    const { question } = z.object({ question: z.string().min(1).max(500) }).parse(req.body);
    const contact = await findContactById(req.auth.tenant_id, req.params.id);
    if (!contact) { res.status(404).json({ success: false, error: 'Contact not found' }); return; }

    const result = await memory.answerAboutContact(req.auth.tenant_id, req.params.id, question);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// POST /ai/contacts/:id/message — generate a follow-up message
router.post('/contacts/:id/message', async (req, res, next) => {
  try {
    const { purpose, channel } = z.object({
      purpose: z.string().min(1),
      channel: z.enum(['email','sms']).default('email'),
    }).parse(req.body);

    const contact = await findContactById(req.auth.tenant_id, req.params.id);
    if (!contact) { res.status(404).json({ success: false, error: 'Contact not found' }); return; }

    const message = await ai.generateContactMessage(contact, purpose, channel);
    res.json({ success: true, data: { message, channel, contact_id: req.params.id } });
  } catch (err) { next(err); }
});

// GET /ai/briefing — requires Growth+ (ai_business_operator feature)
router.get('/briefing', requireFeature('ai_business_operator'), async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const existing = await queryOne(
      'SELECT * FROM daily_briefings WHERE tenant_id = $1 AND date = $2',
      [req.auth.tenant_id, today],
    );

    if (existing) {
      res.json({ success: true, data: existing });
      return;
    }

    // Generate on-demand if not yet created
    const operator = new BusinessOperator(req.auth.tenant_id);
    const briefing = await operator.generateDailyBriefing(new Date());

    const saved = await query(
      `INSERT INTO daily_briefings (
        tenant_id, date, top_actions, who_to_contact, deals_at_risk,
        revenue_forecast, summary, generated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (tenant_id, date)
      DO UPDATE SET top_actions = EXCLUDED.top_actions, who_to_contact = EXCLUDED.who_to_contact,
        deals_at_risk = EXCLUDED.deals_at_risk, revenue_forecast = EXCLUDED.revenue_forecast,
        summary = EXCLUDED.summary, generated_at = EXCLUDED.generated_at
      RETURNING *`,
      [
        req.auth.tenant_id, today,
        JSON.stringify(briefing.top_actions), JSON.stringify(briefing.who_to_contact),
        JSON.stringify(briefing.deals_at_risk), JSON.stringify(briefing.revenue_forecast),
        briefing.summary, briefing.generated_at,
      ],
    );

    res.json({ success: true, data: saved.rows[0] });
  } catch (err) { next(err); }
});

// POST /ai/complete — raw AI completion (for custom use)
router.post('/complete', async (req, res, next) => {
  try {
    const { prompt, max_tokens } = z.object({
      prompt: z.string().min(1).max(4000),
      max_tokens: z.number().int().min(1).max(2000).default(500),
    }).parse(req.body);

    const result = await ai.complete(prompt, max_tokens);
    res.json({ success: true, data: { result } });
  } catch (err) { next(err); }
});

// GET /ai/search — semantic similarity search
router.get('/search', async (req, res, next) => {
  try {
    const { q, types, limit } = z.object({
      q: z.string().min(1),
      types: z.string().optional(),
      limit: z.string().default('10'),
    }).parse(req.query);

    const entityTypes = types ? types.split(',') : undefined;
    const results = await memory.query({
      tenant_id: req.auth.tenant_id,
      question: q,
      entity_types: entityTypes,
      limit: parseInt(limit, 10),
    });

    res.json({ success: true, data: results });
  } catch (err) { next(err); }
});

export default router;
