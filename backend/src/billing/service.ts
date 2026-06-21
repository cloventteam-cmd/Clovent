/**
 * Billing Service
 *
 * Manages subscription lifecycle:
 *   - create/retrieve Stripe customers
 *   - create checkout sessions
 *   - handle webhook events
 *   - update local subscription state
 */
import { getStripe, constructWebhookEvent } from './stripe';
import { PLANS, getPlan, type PlanId } from './plans';
import { eventBus } from '../events/bus';
import { EventNames } from '../events/types';
import { query, queryOne } from '../db/client';
import { logger } from '../shared/logger';
import { config } from '../shared/config';
import type { UUID } from '../shared/types';

// ── Subscription helpers ──────────────────────────────────────────────────────
export async function getSubscription(tenantId: UUID): Promise<Record<string, unknown> | null> {
  return queryOne(
    'SELECT * FROM subscriptions WHERE tenant_id = $1',
    [tenantId],
  );
}

export async function ensureCustomer(tenantId: UUID, email: string, orgName: string): Promise<string> {
  const existing = await queryOne<{ stripe_customer_id: string }>(
    'SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = $1',
    [tenantId],
  );

  if (existing?.stripe_customer_id) return existing.stripe_customer_id;

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email,
    name: orgName,
    metadata: { tenant_id: tenantId },
  });

  // Upsert subscription record with customer ID
  await query(
    `INSERT INTO subscriptions (tenant_id, stripe_customer_id, plan, status)
     VALUES ($1,$2,'starter','trialing')
     ON CONFLICT (tenant_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`,
    [tenantId, customer.id],
  );

  return customer.id;
}

export async function createCheckoutSession(params: {
  tenantId: UUID;
  planId: PlanId;
  email: string;
  orgName: string;
  billingPeriod: 'monthly' | 'annual';
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string; session_id: string }> {
  const plan = getPlan(params.planId);
  const priceId = params.billingPeriod === 'annual'
    ? plan.stripe_annual_price_id
    : plan.stripe_monthly_price_id;

  if (!priceId) {
    // Dev/mock mode: return a fake checkout URL so the API doesn't error
    const mockSessionId = `mock_cs_${Date.now().toString(36)}`;
    logger.warn(
      { plan: params.planId, period: params.billingPeriod },
      'Billing: Stripe price ID not configured — returning mock checkout URL',
    );
    return {
      url: `${params.successUrl.split('/billing')[0]}/billing/mock-checkout?plan=${params.planId}&session=${mockSessionId}`,
      session_id: mockSessionId,
    };
  }

  const customerId = await ensureCustomer(params.tenantId, params.email, params.orgName);
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: config.stripe.trialDays,
      metadata: { tenant_id: params.tenantId, plan: params.planId },
    },
    metadata: { tenant_id: params.tenantId, plan: params.planId },
    success_url: `${params.successUrl}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: params.cancelUrl,
    allow_promotion_codes: true,
  });

  logger.info(
    { tenant_id: params.tenantId, plan: params.planId, period: params.billingPeriod },
    'Billing: checkout session created',
  );

  return { url: session.url, session_id: session.id };
}

export async function createPortalSession(params: {
  tenantId: UUID;
  returnUrl: string;
}): Promise<{ url: string }> {
  const sub = await queryOne<{ stripe_customer_id: string }>(
    'SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = $1',
    [params.tenantId],
  );

  if (!sub?.stripe_customer_id) {
    throw new Error('No Stripe customer found — subscribe first');
  }

  const stripe = getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: params.returnUrl,
  });

  return { url: session.url };
}

// ── Webhook handler ───────────────────────────────────────────────────────────
export async function handleStripeWebhook(
  rawBody: string,
  signature: string,
): Promise<void> {
  let event: any;
  try {
    event = constructWebhookEvent(rawBody, signature, config.stripe.webhookSecret);
  } catch (err) {
    logger.warn({ err }, 'Billing: invalid webhook signature');
    throw new Error('Invalid webhook signature');
  }

  // Store event for idempotency
  const existing = await queryOne(
    'SELECT id FROM billing_events WHERE stripe_event_id = $1',
    [event.id ?? 'mock'],
  );
  if (existing) {
    logger.debug({ event_id: event.id }, 'Billing: duplicate webhook — skipping');
    return;
  }

  await query(
    'INSERT INTO billing_events (stripe_event_id, event_type, payload) VALUES ($1,$2,$3)',
    [event.id ?? `mock_${Date.now()}`, event.type, JSON.stringify(event)],
  );

  logger.info({ event_type: event.type }, 'Billing: webhook received');

  try {
    await dispatchWebhookEvent(event);
    await query(
      'UPDATE billing_events SET processed = true, processed_at = NOW() WHERE stripe_event_id = $1',
      [event.id ?? `mock_${Date.now()}`],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await query(
      'UPDATE billing_events SET error = $2 WHERE stripe_event_id = $1',
      [event.id ?? `mock_${Date.now()}`, msg],
    );
    throw err;
  }
}

async function dispatchWebhookEvent(event: any): Promise<void> {
  const obj = event.data?.object ?? {};
  const tenantId = obj.metadata?.tenant_id ?? await resolveTenantFromCustomer(obj.customer);

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(obj, tenantId);
      break;

    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(obj, tenantId);
      break;

    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(obj, tenantId);
      break;

    case 'invoice.payment_failed':
      await handlePaymentFailed(obj, tenantId);
      break;

    case 'invoice.paid':
      await handleInvoicePaid(obj, tenantId);
      break;

    default:
      logger.debug({ event_type: event.type }, 'Billing: unhandled webhook event');
  }
}

async function handleCheckoutCompleted(session: any, tenantId?: string): Promise<void> {
  if (!tenantId) return;

  const planId = session.metadata?.plan ?? 'starter';
  const stripe = getStripe();

  // Fetch the subscription from Stripe
  const sub = session.subscription
    ? await stripe.subscriptions.retrieve(session.subscription)
    : null;

  await activateSubscription(tenantId, planId, sub);

  await eventBus.emit(EventNames.PLAN_UPGRADED as any, {
    tenant_id: tenantId,
    old_plan: 'starter',
    new_plan: planId,
    source: 'checkout',
  });
}

async function handleSubscriptionUpdated(sub: any, tenantId?: string): Promise<void> {
  if (!tenantId || !sub.id) return;

  const priceId = sub.items?.data?.[0]?.price?.id;
  const planId  = resolvePlanFromPrice(priceId) ?? 'starter';
  const oldPlan = await getCurrentPlan(tenantId);

  await updateSubscriptionRecord(tenantId, sub, planId);

  if (oldPlan !== planId) {
    await eventBus.emit(EventNames.PLAN_UPGRADED as any, {
      tenant_id: tenantId,
      old_plan: oldPlan,
      new_plan: planId,
      source: 'subscription_update',
    });
  }
}

async function handleSubscriptionDeleted(sub: any, tenantId?: string): Promise<void> {
  if (!tenantId) return;

  await query(
    `UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW()
     WHERE tenant_id = $1`,
    [tenantId],
  );

  // Downgrade org to starter plan
  await query('UPDATE organizations SET plan = \'starter\' WHERE id = $1', [tenantId]);

  await eventBus.emit(EventNames.SUBSCRIPTION_CANCELLED as any, {
    tenant_id: tenantId,
    reason: 'stripe_deletion',
  });
}

async function handlePaymentFailed(invoice: any, tenantId?: string): Promise<void> {
  if (!tenantId) return;
  await query(
    'UPDATE subscriptions SET status = \'past_due\' WHERE tenant_id = $1',
    [tenantId],
  );

  await eventBus.emit(EventNames.BILLING_WARNING as any, {
    tenant_id: tenantId,
    warning_type: 'payment_failed',
    amount: invoice.amount_due,
  });
}

async function handleInvoicePaid(invoice: any, tenantId?: string): Promise<void> {
  if (!tenantId) return;
  await query(
    'UPDATE subscriptions SET status = \'active\' WHERE tenant_id = $1 AND status = \'past_due\'',
    [tenantId],
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function activateSubscription(
  tenantId: string,
  planId: string,
  stripeSub: any,
): Promise<void> {
  await query(
    `INSERT INTO subscriptions
       (tenant_id, stripe_subscription_id, plan, status,
        current_period_start, current_period_end)
     VALUES ($1,$2,$3,'active',$4,$5)
     ON CONFLICT (tenant_id) DO UPDATE SET
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       plan = EXCLUDED.plan, status = 'active',
       current_period_start = EXCLUDED.current_period_start,
       current_period_end = EXCLUDED.current_period_end`,
    [
      tenantId,
      stripeSub?.id ?? null,
      planId,
      stripeSub ? new Date(stripeSub.current_period_start * 1000) : null,
      stripeSub ? new Date(stripeSub.current_period_end   * 1000) : null,
    ],
  );

  await query('UPDATE organizations SET plan = $2 WHERE id = $1', [tenantId, planId]);
}

async function updateSubscriptionRecord(tenantId: string, sub: any, planId: string): Promise<void> {
  await query(
    `UPDATE subscriptions SET
       plan = $2, status = $3,
       current_period_start = $4, current_period_end = $5,
       cancel_at_period_end = $6
     WHERE tenant_id = $1`,
    [
      tenantId, planId, sub.status,
      sub.current_period_start ? new Date(sub.current_period_start * 1000) : null,
      sub.current_period_end   ? new Date(sub.current_period_end   * 1000) : null,
      sub.cancel_at_period_end ?? false,
    ],
  );
  await query('UPDATE organizations SET plan = $2 WHERE id = $1', [tenantId, planId]);
}

async function resolveTenantFromCustomer(customerId?: string): Promise<string | undefined> {
  if (!customerId) return undefined;
  const row = await queryOne<{ tenant_id: string }>(
    'SELECT tenant_id FROM subscriptions WHERE stripe_customer_id = $1',
    [customerId],
  );
  return row?.tenant_id;
}

async function getCurrentPlan(tenantId: string): Promise<string> {
  const org = await queryOne<{ plan: string }>('SELECT plan FROM organizations WHERE id = $1', [tenantId]);
  return org?.plan ?? 'starter';
}

function resolvePlanFromPrice(priceId?: string): PlanId | null {
  if (!priceId) return null;
  for (const plan of Object.values(PLANS)) {
    if (plan.stripe_monthly_price_id === priceId || plan.stripe_annual_price_id === priceId) {
      return plan.id;
    }
  }
  return null;
}
