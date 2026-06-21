/**
 * Billing API
 *
 * GET  /billing/plans              — list all plans + features
 * GET  /billing/subscription       — current subscription status
 * GET  /billing/usage              — current usage vs limits
 * POST /billing/checkout           — create Stripe checkout session
 * POST /billing/portal             — create Stripe billing portal URL
 * POST /billing/cancel             — cancel at period end
 *
 * POST /webhooks/stripe            — Stripe webhook (no auth — verified by signature)
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth';
import { PLANS, getPlan, getLimits, getFeatures, usagePct, formatLimit, formatLimitFull, PLAN_ORDER } from '../../billing/plans';
import { queryOne } from '../../db/client';
import {
  createCheckoutSession, createPortalSession,
  getSubscription, handleStripeWebhook,
} from '../../billing/service';
import { getUsageSummary, getTenantPlan } from '../../billing/usage-tracker';
import { query } from '../../db/client';
import type { PlanId } from '../../billing/plans';

const router = Router();

// ── GET /billing/plans ─────────────────────────────────────────────────────────
router.get('/plans', async (_req, res, next) => {
  try {
    const plans = PLAN_ORDER.map(id => {
      const p = PLANS[id];
      return {
        id: p.id,
        name: p.name,
        tagline: p.tagline,
        description: p.description,
        monthly_price_usd: p.monthly_price_usd,
        annual_price_usd: p.annual_price_usd,
        annual_savings_pct: p.annual_savings_pct,
        feature_bullets: p.feature_bullets,
        feature_flags: p.features,
        highlighted: p.highlighted,
        badge: p.badge ?? null,
        color: p.color,
        limits: {
          contacts_total:             formatLimitFull(p.limits.contacts_total, p.id),
          imports_per_month:          formatLimitFull(p.limits.imports_per_month, p.id),
          ingestion_records_per_day:  formatLimitFull(p.limits.ingestion_records_per_day, p.id),
          campaigns_total:            formatLimitFull(p.limits.campaigns_total, p.id),
          active_campaigns:           formatLimitFull(p.limits.active_campaigns, p.id),
          predictions_per_day:        formatLimitFull(p.limits.predictions_per_day, p.id),
          ai_completions_per_day:     formatLimitFull(p.limits.ai_completions_per_day, p.id),
          team_members:               formatLimitFull(p.limits.team_members, p.id),
          teams:                      formatLimitFull(p.limits.teams, p.id),
          crm_connections:            formatLimitFull(p.limits.crm_connections, p.id),
          api_calls_per_hour:         formatLimitFull(p.limits.api_calls_per_hour, p.id),
          worker_jobs_per_hour:       formatLimitFull(p.limits.worker_jobs_per_hour, p.id),
          storage_mb:                 `${formatLimit(p.limits.storage_mb)} MB`,
          webhook_events_per_hour:    formatLimitFull(p.limits.webhook_events_per_hour, p.id),
        },
        soft_caps: p.soft_caps,
        fair_use_note: p.id === 'enterprise'
          ? 'Enterprise limits include 10% burst tolerance. Fair-use enforcement applies above stated limits.'
          : null,
      };
    });
    res.json({ success: true, data: plans });
  } catch (err) { next(err); }
});

// ── GET /billing/subscription ──────────────────────────────────────────────────
router.get('/subscription', requireAuth, async (req, res, next) => {
  try {
    const sub  = await getSubscription(req.auth.tenant_id);
    const plan = await getTenantPlan(req.auth.tenant_id);

    res.json({
      success: true,
      data: {
        subscription: sub,
        current_plan: plan,
        plan_details: getPlan(plan as PlanId),
        is_configured: !!sub?.stripe_subscription_id,
      },
    });
  } catch (err) { next(err); }
});

// ── GET /billing/usage ─────────────────────────────────────────────────────────
router.get('/usage', requireAuth, async (req, res, next) => {
  try {
    const tenantId = req.auth.tenant_id;
    const planId   = await getTenantPlan(tenantId) as PlanId;
    const limits   = getLimits(planId);
    const usage    = await getUsageSummary(tenantId);

    const metrics = [
      { key: 'contacts',    label: 'Contacts',            current: usage.contacts_total,       limit: limits.contacts_total,         pct: usagePct(usage.contacts_total, limits.contacts_total) },
      { key: 'imports',     label: 'Imports this month',  current: usage.imports_this_month,   limit: limits.imports_per_month,      pct: usagePct(usage.imports_this_month, limits.imports_per_month) },
      { key: 'predictions', label: 'Predictions today',   current: usage.predictions_today,    limit: limits.predictions_per_day,    pct: usagePct(usage.predictions_today, limits.predictions_per_day) },
      { key: 'api_hour',    label: 'API calls this hour', current: usage.api_calls_this_hour,  limit: limits.api_calls_per_hour,     pct: usagePct(usage.api_calls_this_hour, limits.api_calls_per_hour) },
      { key: 'campaigns',   label: 'Active campaigns',    current: usage.campaigns_active,     limit: limits.active_campaigns,       pct: usagePct(usage.campaigns_active, limits.active_campaigns) },
      { key: 'team',        label: 'Team members',        current: usage.team_members,         limit: limits.team_members,           pct: usagePct(usage.team_members, limits.team_members) },
    ].map(m => ({
      ...m,
      limit_display: formatLimit(m.limit),
      status: m.pct >= 100 ? 'exceeded' : m.pct >= 80 ? 'warning' : 'ok',
    }));

    res.json({ success: true, data: { current_plan: planId, metrics } });
  } catch (err) { next(err); }
});

// ── POST /billing/checkout ─────────────────────────────────────────────────────
router.post('/checkout', requireAuth, requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const { plan_id, billing_period } = z.object({
      plan_id:        z.enum(['starter', 'growth', 'enterprise']),
      billing_period: z.enum(['monthly', 'annual']).default('monthly'),
    }).parse(req.body);

    const me = await queryOne<{ email: string; name: string; org_name: string }>(
      `SELECT u.email, u.first_name || ' ' || u.last_name AS name,
              o.name AS org_name
       FROM users u JOIN organizations o ON o.id = u.tenant_id
       WHERE u.id = $1`,
      [req.auth.user_id],
    );

    const origin = req.headers.origin ?? 'http://localhost:5173';

    const session = await createCheckoutSession({
      tenantId:     req.auth.tenant_id,
      planId:       plan_id as PlanId,
      email:        me?.email ?? '',
      orgName:      me?.org_name ?? '',
      billingPeriod: billing_period,
      successUrl:   `${origin}/billing/success`,
      cancelUrl:    `${origin}/billing`,
    });

    res.json({ success: true, data: session });
  } catch (err) { next(err); }
});

// ── POST /billing/portal ───────────────────────────────────────────────────────
router.post('/portal', requireAuth, requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const origin = req.headers.origin ?? 'http://localhost:5173';
    const session = await createPortalSession({
      tenantId:  req.auth.tenant_id,
      returnUrl: `${origin}/billing`,
    });
    res.json({ success: true, data: session });
  } catch (err) { next(err); }
});

// ── POST /billing/cancel ───────────────────────────────────────────────────────
router.post('/cancel', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const sub = await getSubscription(req.auth.tenant_id);
    if (!sub?.stripe_subscription_id) {
      res.status(400).json({ success: false, error: 'No active subscription to cancel' });
      return;
    }

    const stripe = await import('../../billing/stripe').then(m => m.getStripe());
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    await query(
      'UPDATE subscriptions SET cancel_at_period_end = true WHERE tenant_id = $1',
      [req.auth.tenant_id],
    );

    res.json({ success: true, message: 'Subscription will cancel at end of billing period' });
  } catch (err) { next(err); }
});

// ── POST /webhooks/stripe (no auth — signature verified internally) ────────────
export const stripeWebhookRouter = Router();

stripeWebhookRouter.post('/stripe',
  // Need raw body for signature verification — don't parse as JSON
  (req: any, res, next) => {
    // Capture raw body (req.body should already be a Buffer from server.ts raw middleware)
    const rawBody = (req as any).rawBody ?? JSON.stringify(req.body);
    const signature = req.headers['stripe-signature'] as string ?? '';

    handleStripeWebhook(rawBody, signature)
      .then(() => res.json({ received: true }))
      .catch((err: Error) => {
        if (err.message.includes('signature')) {
          res.status(400).json({ error: err.message });
        } else {
          next(err);
        }
      });
  },
);

export default router;
