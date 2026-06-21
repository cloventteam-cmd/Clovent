import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { getRecentActivities, createActivity } from '../../db/repositories/activities';
import { eventBus } from '../../events/bus';
import { EventNames } from '../../events/types';

const router = Router();
router.use(requireAuth);

// GET /activities — recent activities feed
router.get('/', async (req, res, next) => {
  try {
    const since = req.query.since
      ? new Date(req.query.since as string)
      : new Date(Date.now() - 7 * 86400000);

    const activities = await getRecentActivities(req.auth.tenant_id, since);
    res.json({ success: true, data: activities });
  } catch (err) { next(err); }
});

// POST /activities
router.post('/', async (req, res, next) => {
  try {
    const data = z.object({
      type: z.enum(['call','email','sms','note','meeting','showing','offer','contract','inspection','appraisal','closing','task_completed']),
      contact_id: z.string().uuid().optional(),
      deal_id: z.string().uuid().optional(),
      direction: z.enum(['inbound','outbound']).optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
      duration_sec: z.number().optional(),
      outcome: z.string().optional(),
      occurred_at: z.string().datetime().optional(),
      metadata: z.record(z.unknown()).default({}),
    }).parse(req.body);

    const activity = await createActivity(req.auth.tenant_id, {
      ...data,
      user_id: req.auth.user_id,
      occurred_at: data.occurred_at ? new Date(data.occurred_at) : new Date(),
    });

    await eventBus.emit(EventNames.ACTIVITY_CREATED, {
      tenant_id: req.auth.tenant_id,
      activity_id: activity.id,
      contact_id: activity.contact_id,
      deal_id: activity.deal_id,
      activity_type: activity.type,
    });

    res.status(201).json({ success: true, data: activity });
  } catch (err) { next(err); }
});

export default router;
