/**
 * Billing Event Handlers
 *
 * PLAN_UPGRADED        → notify user, update org plan
 * PLAN_LIMIT_REACHED   → notify owner
 * BILLING_WARNING      → notify owner (approaching limit)
 * SUBSCRIPTION_CANCELLED → notify, downgrade to starter
 */
import { eventBus } from '../bus';
import { EventNames } from '../types';
import { logger } from '../../shared/logger';
import { getPlan } from '../../billing/plans';

eventBus.on(EventNames.PLAN_UPGRADED as any, async (payload: any) => {
  const { tenant_id, old_plan, new_plan, source } = payload;

  logger.info({ tenant_id, old_plan, new_plan, source }, 'Billing: plan upgraded');

  await eventBus.emit(EventNames.NOTIFICATION_SEND as any, {
    tenant_id,
    user_id: 'all',
    type: 'system',
    title: `Plan upgraded to ${new_plan.toUpperCase()}`,
    body: `Your CLOVENT plan has been upgraded from ${old_plan} to ${new_plan}. New limits are now active.`,
    data: { old_plan, new_plan, event: 'plan_upgraded' },
    channels: ['in_app', 'email'],
  });
});

eventBus.on(EventNames.PLAN_LIMIT_REACHED as any, async (payload: any) => {
  const { tenant_id, metric, current, limit, plan } = payload;

  logger.warn({ tenant_id, metric, current, limit, plan }, 'Billing: plan limit reached');

  await eventBus.emit(EventNames.NOTIFICATION_SEND as any, {
    tenant_id,
    user_id: 'all',
    type: 'system',
    title: `${plan.toUpperCase()} plan limit reached`,
    body: `You've reached the ${metric.replace(/_/g, ' ')} limit (${current}/${limit}). Upgrade your plan to continue.`,
    data: { metric, current, limit, plan, upgrade_url: '/billing/upgrade' },
    channels: ['in_app', 'email'],
  });
});

eventBus.on(EventNames.BILLING_WARNING as any, async (payload: any) => {
  const { tenant_id, warning_type, metric, pct_used, plan } = payload;

  if (warning_type === 'approaching_limit' && metric) {
    logger.info({ tenant_id, metric, pct_used, plan }, 'Billing: approaching limit');

    await eventBus.emit(EventNames.NOTIFICATION_SEND as any, {
      tenant_id,
      user_id: 'all',
      type: 'system',
      title: `${Math.round(pct_used ?? 0)}% of plan limit used`,
      body: `${metric.replace(/_/g, ' ')} is at ${Math.round(pct_used ?? 0)}% of your ${plan} plan limit.`,
      data: { metric, pct_used, plan },
      channels: ['in_app'],
    });
  }

  if (warning_type === 'payment_failed') {
    await eventBus.emit(EventNames.NOTIFICATION_SEND as any, {
      tenant_id,
      user_id: 'all',
      type: 'system',
      title: 'Payment failed',
      body: 'Your subscription payment failed. Please update your payment method to avoid service interruption.',
      data: { warning_type },
      channels: ['in_app', 'email'],
    });
  }
});

// USAGE_THRESHOLD (95%) — stronger pre-limit notification
eventBus.on(EventNames.USAGE_THRESHOLD as any, async (payload: any) => {
  const { tenant_id, metric, current, limit, pct, plan } = payload;

  logger.warn({ tenant_id, metric, pct: pct?.toFixed(1), plan }, 'Billing: usage threshold 95%');

  const plan_obj = getPlan(plan);
  await eventBus.emit(EventNames.NOTIFICATION_SEND as any, {
    tenant_id,
    user_id: 'all',
    type: 'system',
    title: `⚠ ${Math.round(pct)}% of ${plan_obj.name} limit used`,
    body: `${metric.replace(/_/g, ' ')} is at ${Math.round(pct)}% of your ${plan_obj.name} plan limit (${current?.toLocaleString()}/${limit?.toLocaleString()}). Upgrade soon to avoid interruption.`,
    data: { metric, current, limit, pct, plan, event: 'usage_threshold', upgrade_url: '/billing' },
    channels: ['in_app', 'email'],
  });
});

// USAGE_ANOMALY — Enterprise spike detection
eventBus.on(EventNames.USAGE_ANOMALY as any, async (payload: any) => {
  const { tenant_id, spikes } = payload;

  logger.warn({ tenant_id, spike_count: spikes?.length }, 'Billing: usage anomaly detected');

  await eventBus.emit(EventNames.NOTIFICATION_SEND as any, {
    tenant_id,
    user_id: 'all',
    type: 'system',
    title: 'Usage Anomaly Detected',
    body: `Unusual usage spike detected: ${spikes?.map((s: any) => `${s.metric} (${s.ratio?.toFixed(1)}× typical)`).join(', ')}`,
    data: { spikes, event: 'usage_anomaly' },
    channels: ['in_app', 'email'],
  });
});

eventBus.on(EventNames.SUBSCRIPTION_CANCELLED as any, async (payload: any) => {
  const { tenant_id } = payload;

  logger.warn({ tenant_id }, 'Billing: subscription cancelled');

  await eventBus.emit(EventNames.NOTIFICATION_SEND as any, {
    tenant_id,
    user_id: 'all',
    type: 'system',
    title: 'Subscription cancelled',
    body: 'Your CLOVENT subscription has been cancelled. Your data is safe — resubscribe anytime to restore access.',
    data: { event: 'subscription_cancelled' },
    channels: ['in_app', 'email'],
  });
});
