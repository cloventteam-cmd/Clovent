/**
 * Admin / Enterprise API
 *
 * GET  /admin/teams              — list teams
 * POST /admin/teams              — create team
 * POST /admin/teams/:id/members  — add member
 * GET  /admin/audit-logs         — audit log search (owner/admin only)
 * GET  /admin/usage              — usage snapshot for tenant
 * GET  /admin/permissions        — RBAC permission matrix
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth';
import { query, queryMany, queryOne } from '../../db/client';
import { parsePageParams } from '../../shared/utils';

const router = Router();
router.use(requireAuth);

// ─── Teams ────────────────────────────────────────────────────────────────────

// GET /admin/teams
router.get('/teams', async (req, res, next) => {
  try {
    const teams = await queryMany(
      `SELECT t.*, COUNT(tm.user_id)::int AS member_count
       FROM teams t
       LEFT JOIN team_members tm ON tm.team_id = t.id
       WHERE t.tenant_id = $1
       GROUP BY t.id
       ORDER BY t.created_at DESC`,
      [req.auth.tenant_id],
    );
    res.json({ success: true, data: teams });
  } catch (err) { next(err); }
});

// POST /admin/teams
router.post('/teams', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const { name, settings } = z.object({
      name: z.string().min(1).max(80),
      settings: z.record(z.unknown()).default({}),
    }).parse(req.body);

    const team = await queryOne(
      `INSERT INTO teams (tenant_id, name, settings, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.auth.tenant_id, name, JSON.stringify(settings), req.auth.user_id],
    );
    res.status(201).json({ success: true, data: team });
  } catch (err) { next(err); }
});

// POST /admin/teams/:id/members
router.post('/teams/:id/members', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const { user_id, role } = z.object({
      user_id: z.string().uuid(),
      role:    z.enum(['lead', 'member', 'readonly']).default('member'),
    }).parse(req.body);

    // Verify user belongs to this tenant
    const user = await queryOne(
      'SELECT id FROM users WHERE id = $1 AND tenant_id = $2',
      [user_id, req.auth.tenant_id],
    );
    if (!user) { res.status(404).json({ success: false, error: 'User not found' }); return; }

    const member = await queryOne(
      `INSERT INTO team_members (team_id, user_id, tenant_id, role)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING *`,
      [req.params.id, user_id, req.auth.tenant_id, role],
    );
    res.status(201).json({ success: true, data: member });
  } catch (err) { next(err); }
});

// DELETE /admin/teams/:id/members/:userId
router.delete('/teams/:id/members/:userId', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    await query(
      'DELETE FROM team_members WHERE team_id = $1 AND user_id = $2',
      [req.params.id, req.params.userId],
    );
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ─── Audit Logs ───────────────────────────────────────────────────────────────

// GET /admin/audit-logs
router.get('/audit-logs', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const { page, perPage } = parsePageParams(req.query as any);
    const { action, user_id, entity_type, since } = req.query;

    const conditions = ['a.tenant_id = $1'];
    const params: unknown[] = [req.auth.tenant_id];
    let idx = 2;

    if (action)      { conditions.push(`a.action = $${idx++}`);      params.push(action); }
    if (user_id)     { conditions.push(`a.user_id = $${idx++}`);     params.push(user_id); }
    if (entity_type) { conditions.push(`a.entity_type = $${idx++}`); params.push(entity_type); }
    if (since)       { conditions.push(`a.created_at >= $${idx++}`); params.push(since); }

    const where = conditions.join(' AND ');
    const offset = (page - 1) * perPage;

    const [countRes, logs] = await Promise.all([
      query<{ count: string }>(`SELECT COUNT(*) FROM audit_logs a WHERE ${where}`, params),
      queryMany(
        `SELECT a.*, u.email AS user_email, u.first_name || ' ' || u.last_name AS user_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
         WHERE ${where}
         ORDER BY a.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, perPage, offset],
      ),
    ]);

    res.json({
      success: true,
      data: logs,
      total: parseInt(countRes.rows[0].count, 10),
      page, per_page: perPage,
    });
  } catch (err) { next(err); }
});

// ─── RBAC permission matrix ───────────────────────────────────────────────────

const PERMISSION_MATRIX = {
  owner: {
    contacts: ['read', 'write', 'delete'],
    deals: ['read', 'write', 'delete'],
    campaigns: ['read', 'write', 'delete', 'launch'],
    imports: ['read', 'write'],
    predictions: ['read', 'trigger'],
    billing: ['read', 'write'],
    users: ['read', 'write', 'delete'],
    teams: ['read', 'write', 'delete'],
    audit_logs: ['read'],
    crm: ['read', 'write', 'delete'],
  },
  admin: {
    contacts: ['read', 'write', 'delete'],
    deals: ['read', 'write', 'delete'],
    campaigns: ['read', 'write', 'launch'],
    imports: ['read', 'write'],
    predictions: ['read', 'trigger'],
    billing: ['read'],
    users: ['read', 'write'],
    teams: ['read', 'write'],
    audit_logs: ['read'],
    crm: ['read', 'write'],
  },
  agent: {
    contacts: ['read', 'write'],
    deals: ['read', 'write'],
    campaigns: ['read'],
    imports: ['read'],
    predictions: ['read'],
    billing: [],
    users: ['read'],
    teams: ['read'],
    audit_logs: [],
    crm: ['read'],
  },
  viewer: {
    contacts: ['read'],
    deals: ['read'],
    campaigns: ['read'],
    imports: [],
    predictions: ['read'],
    billing: [],
    users: ['read'],
    teams: ['read'],
    audit_logs: [],
    crm: [],
  },
} as const;

router.get('/permissions', (req, res) => {
  const role = req.auth.role;
  res.json({
    success: true,
    data: {
      role,
      permissions: PERMISSION_MATRIX[role as keyof typeof PERMISSION_MATRIX] ?? PERMISSION_MATRIX.viewer,
    },
  });
});

// ─── Usage for this tenant ────────────────────────────────────────────────────

router.get('/usage', async (req, res, next) => {
  try {
    const { getUsageSummary, getTenantPlan } = await import('../../billing/usage-tracker');
    const { getLimits, usagePct, formatLimit } = await import('../../billing/plans');
    const { PlanId } = await import('../../billing/plans') as any;

    const [usage, planId] = await Promise.all([
      getUsageSummary(req.auth.tenant_id),
      getTenantPlan(req.auth.tenant_id),
    ]);

    const limits = getLimits(planId as any);

    // Last 7 days of snapshots
    const history = await queryMany(
      `SELECT snapshot_date, contacts_total, imports_month, predictions_day, api_calls_day
       FROM usage_snapshots
       WHERE tenant_id = $1 AND snapshot_date >= NOW() - INTERVAL '7 days'
       ORDER BY snapshot_date DESC`,
      [req.auth.tenant_id],
    );

    res.json({
      success: true,
      data: { current_plan: planId, current: usage, limits, history },
    });
  } catch (err) { next(err); }
});

export default router;
