import { Router } from 'express';
import { z } from 'zod';
import { registerOrganization, login, refreshTokens, revokeRefreshToken } from '../../services/auth.service';
import { requireAuth } from '../middleware/auth';
import { queryOne } from '../../db/client';

const router = Router();

const RegisterSchema = z.object({
  org_name: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(8),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  slug: z.string().min(1),
});

// POST /auth/register
router.post('/register', async (req, res, next) => {
  try {
    const data = RegisterSchema.parse(req.body);
    const result = await registerOrganization(data);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /auth/login
router.post('/login', async (req, res, next) => {
  try {
    const data = LoginSchema.parse(req.body);
    const org = await queryOne<{ id: string }>(
      'SELECT id FROM organizations WHERE slug = $1 AND is_active = true',
      [data.slug],
    );
    if (!org) {
      res.status(404).json({ success: false, error: 'Organization not found' });
      return;
    }
    const result = await login(org.id, data.email, data.password);
    res.json({ success: true, data: result });
  } catch (err: any) {
    if (err.message === 'Invalid credentials') {
      res.status(401).json({ success: false, error: err.message });
      return;
    }
    next(err);
  }
});

// POST /auth/refresh
router.post('/refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      res.status(400).json({ success: false, error: 'refresh_token required' });
      return;
    }
    const result = await refreshTokens(refresh_token);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(401).json({ success: false, error: 'Invalid refresh token' });
  }
});

// POST /auth/logout
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await revokeRefreshToken(req.auth.user_id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /auth/me
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await queryOne(
      'SELECT id, tenant_id, email, first_name, last_name, role, avatar_url, settings FROM users WHERE id = $1',
      [req.auth.user_id],
    );
    const org = await queryOne(
      'SELECT id, name, slug, plan, settings, timezone FROM organizations WHERE id = $1',
      [req.auth.tenant_id],
    );
    res.json({ success: true, data: { user, organization: org } });
  } catch (err) {
    next(err);
  }
});

export default router;
