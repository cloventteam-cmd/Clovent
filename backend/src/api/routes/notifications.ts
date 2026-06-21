import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { getNotifications, markRead, getUnreadCount } from '../../services/notification.service';

const router = Router();
router.use(requireAuth);

// GET /notifications
router.get('/', async (req, res, next) => {
  try {
    const { unread_only, limit } = z.object({
      unread_only: z.string().optional().transform(v => v === 'true'),
      limit: z.string().optional().transform(v => v ? parseInt(v, 10) : 50),
    }).parse(req.query);

    const notifications = await getNotifications(
      req.auth.user_id,
      req.auth.tenant_id,
      { unread_only: unread_only ?? false, limit: limit ?? 50 },
    );
    res.json({ success: true, data: notifications });
  } catch (err) { next(err); }
});

// GET /notifications/count
router.get('/count', async (req, res, next) => {
  try {
    const count = await getUnreadCount(req.auth.user_id, req.auth.tenant_id);
    res.json({ success: true, data: { unread: count } });
  } catch (err) { next(err); }
});

// POST /notifications/read
router.post('/read', async (req, res, next) => {
  try {
    const { ids } = z.object({
      ids: z.array(z.string().uuid()).optional(),
    }).parse(req.body);

    await markRead(req.auth.user_id, req.auth.tenant_id, ids);
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
