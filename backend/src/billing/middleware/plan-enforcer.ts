/**
 * Plan Enforcement Middleware — Three-level soft cap system.
 *
 * Levels (configurable per plan via soft_caps):
 *   80%  → BILLING_WARNING (notification, request still allowed)
 *   95%  → USAGE_THRESHOLD (stronger notification, request still allowed)
 *  100%  → PLAN_LIMIT_REACHED (402 blocked) × hard_pct
 *          Enterprise uses 110% hard cap (10% burst tolerance)
 *
 * No Infinity bypass anywhere — all limits are finite numbers.
 * High Enterprise limits mean enforcement rarely triggers, but it always runs.
 */
import type { Request, Response, NextFunction } from 'express';
import {
  getLimits, getFeatures, getSoftCaps, isWithinSoftCap, usagePct,
  isAtThreshold, getMinPlanForFeature, hasFeature, type PlanId,
  type PlanFeatureFlags,
} from '../plans';
import { getUsage, trackUsage, getTenantPlan, type MetricType } from '../usage-tracker';
import { eventBus } from '../../events/bus';
import { EventNames } from '../../events/types';
import { queryOne } from '../../db/client';
import { config } from '../../shared/config';
import { logger } from '../../shared/logger';

// ── Metric → limit key + period ───────────────────────────────────────────────
interface MetricMapping {
  limit_key: keyof ReturnType<typeof getLimits>;
  period: 'hour' | 'day' | 'month';
  use_db_count?: boolean;  // true = query DB for absolute count instead of rate
}

const METRIC_MAP: Partial<Record<MetricType, MetricMapping>> = {
  contacts_created:   { limit_key: 'contacts_total',            period: 'month', use_db_count: true },
  imports_started:    { limit_key: 'imports_per_month',         period: 'month' },
  ingestion_records:  { limit_key: 'ingestion_records_per_day', period: 'day' },
  predictions_run:    { limit_key: 'predictions_per_day',       period: 'day' },
  campaigns_sent:     { limit_key: 'active_campaigns',          period: 'day' },
  ai_completions:     { limit_key: 'ai_completions_per_day',    period: 'day' },
  api_calls:          { limit_key: 'api_calls_per_hour',        period: 'hour' },
  worker_jobs:        { limit_key: 'worker_jobs_per_hour',      period: 'hour' },
  webhook_received:   { limit_key: 'webhook_events_per_hour',   period: 'hour' },
};

// ── Usage limit gate ──────────────────────────────────────────────────────────
export function requirePlan(metric: MetricType) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!config.saas.enforcePlans) { next(); return; }

    const tenantId = req.auth?.tenant_id;
    if (!tenantId) { next(); return; }

    try {
      const planId   = await getTenantPlan(tenantId) as PlanId;
      const limits   = getLimits(planId);
      const softCaps = getSoftCaps(planId);
      const mapping  = METRIC_MAP[metric];

      if (!mapping) { next(); return; }

      const limit = limits[mapping.limit_key] as number;

      // Get current usage
      let current: number;
      if (mapping.use_db_count) {
        const row = await queryOne<{ n: string }>(
          "SELECT COUNT(*)::text AS n FROM contacts WHERE tenant_id = $1 AND status != 'archived'",
          [tenantId],
        );
        current = parseInt(row?.n ?? '0', 10);
      } else {
        current = await getUsage(tenantId, metric, mapping.period);
      }

      const pct = usagePct(current, limit);

      // ── Level 3: HARD BLOCK (at hard_pct of limit) ────────────────────────
      if (!isWithinSoftCap(current, limit, softCaps.hard_pct)) {
        logger.warn(
          { tenant_id: tenantId, metric, current, limit, pct: pct.toFixed(1), plan: planId },
          'Plan enforcement: HARD LIMIT',
        );

        await eventBus.emit(EventNames.PLAN_LIMIT_REACHED as any, {
          tenant_id: tenantId, metric, current, limit, pct, plan: planId,
        }).catch(() => {});

        res.status(402).json({
          success: false,
          error: `Usage limit reached: ${metric.replace(/_/g, ' ')} (${current.toLocaleString()}/${limit.toLocaleString()})`,
          code: 'PLAN_LIMIT_EXCEEDED',
          upgrade_url: '/billing',
          current_plan: planId,
          current_usage: current,
          plan_limit: limit,
          usage_pct: Math.round(pct),
        });
        return;
      }

      // ── Level 2: USAGE_THRESHOLD (95%) — stronger warning, allow request ──
      if (isAtThreshold(current, limit, softCaps.threshold_pct)) {
        logger.info(
          { tenant_id: tenantId, metric, pct: pct.toFixed(1), plan: planId },
          'Plan enforcement: USAGE_THRESHOLD',
        );
        eventBus.emit(EventNames.USAGE_THRESHOLD as any, {
          tenant_id: tenantId, metric, current, limit, pct, plan: planId,
        }).catch(() => {});
      }
      // ── Level 1: BILLING_WARNING (80%) — early notification ───────────────
      else if (isAtThreshold(current, limit, softCaps.warning_pct)) {
        eventBus.emit(EventNames.BILLING_WARNING as any, {
          tenant_id: tenantId,
          warning_type: 'approaching_limit',
          metric, current, limit,
          pct_used: Math.round(pct),
          plan: planId,
        }).catch(() => {});
      }

      next();
    } catch (err) {
      logger.error({ err, metric }, 'Plan enforcement: check failed — allowing request');
      next();
    }
  };
}

// ── Feature flag gate ─────────────────────────────────────────────────────────
export function requireFeature(feature: keyof PlanFeatureFlags) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!config.saas.enforcePlans) { next(); return; }

    const tenantId = req.auth?.tenant_id;
    if (!tenantId) { next(); return; }

    try {
      const planId = await getTenantPlan(tenantId) as PlanId;
      if (hasFeature(planId, feature)) { next(); return; }

      const minPlan = getMinPlanForFeature(feature);
      logger.info({ tenant_id: tenantId, feature, plan: planId, required: minPlan }, 'Feature gate: denied');

      res.status(403).json({
        success: false,
        error: `This feature requires the ${minPlan.charAt(0).toUpperCase() + minPlan.slice(1)} plan or higher`,
        code: 'FEATURE_NOT_AVAILABLE',
        feature,
        current_plan: planId,
        required_plan: minPlan,
        upgrade_url: '/billing',
      });
    } catch (err) {
      logger.error({ err, feature }, 'Feature gate: check failed — allowing request');
      next();
    }
  };
}

// ── Per-tenant concurrent worker limit gate ───────────────────────────────────
// Applied before queuing imports/predictions to prevent queue flooding.
export function requireConcurrencySlot(slotType: 'imports' | 'predictions') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!config.saas.enforcePlans) { next(); return; }

    const tenantId = req.auth?.tenant_id;
    if (!tenantId) { next(); return; }

    try {
      const planId = await getTenantPlan(tenantId) as PlanId;
      const limits = getLimits(planId);
      const maxConcurrent = slotType === 'imports'
        ? limits.max_concurrent_imports
        : limits.max_concurrent_predictions;

      // Check active jobs from BullMQ for this tenant
      const { queryOne: dbQuery } = await import('../../db/client');
      const activeRow = await dbQuery<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM imports
         WHERE tenant_id = $1 AND status = 'committing'`,
        [tenantId],
      );
      const active = parseInt(activeRow?.n ?? '0', 10);

      if (active >= maxConcurrent) {
        res.status(429).json({
          success: false,
          error: `Concurrency limit reached: ${active}/${maxConcurrent} ${slotType} running`,
          code: 'CONCURRENCY_LIMIT',
          current_plan: planId,
          active_jobs: active,
          max_concurrent: maxConcurrent,
          retry_after_seconds: 30,
        });
        return;
      }

      next();
    } catch (err) {
      next();
    }
  };
}

// ── Usage tracking post-response ──────────────────────────────────────────────
export function trackUsageAfter(metric: MetricType, count = 1) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const tenantId = (req as any).auth?.tenant_id;
    res.on('finish', () => {
      if (tenantId && res.statusCode < 400) {
        trackUsage(tenantId, metric, count);
      }
    });
    next();
  };
}
