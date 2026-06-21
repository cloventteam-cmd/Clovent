/**
 * HTTP Request Logger Middleware
 *
 * - Assigns a correlation ID to every request (X-Correlation-ID header or generated)
 * - Attaches tenant_id and user_id to the async context once auth runs
 * - Logs method, path, status, duration on response finish
 * - Tracks request count per tenant for rate monitoring
 * - Serializes response body size for bandwidth tracking
 */
import type { Request, Response, NextFunction } from 'express';
import { newCorrelationId, runWithContext, correlationStore } from './correlation';
import { incrementEvent } from './event-metrics';
import { logger } from '../shared/logger';
import { trackUsage } from '../billing/usage-tracker';

const SKIP_PATHS = new Set(['/health', '/health/db', '/health/redis', '/health/workers']);

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  if (SKIP_PATHS.has(req.path)) {
    next();
    return;
  }

  const correlationId = (req.headers['x-correlation-id'] as string) ?? newCorrelationId();
  const start = Date.now();

  // Expose correlation ID to caller
  res.setHeader('X-Correlation-ID', correlationId);

  // Run the entire request inside the correlation context
  runWithContext(
    {
      correlationId,
      tenantId: undefined, // enriched later by auth middleware
      userId: undefined,
      source: 'api',
    },
    () => {
      // Patch req.auth setter to capture tenant/user once auth middleware fires
      const originalAuth = (req as any).__auth_setter_installed;
      if (!originalAuth) {
        (req as any).__auth_setter_installed = true;
        let _auth: any;
        Object.defineProperty(req, 'auth', {
          get() { return _auth; },
          set(value) {
            _auth = value;
            const ctx = correlationStore.getStore();
            if (ctx && value?.tenant_id) {
              ctx.tenantId = value.tenant_id;
              ctx.userId = value.user_id;
            }
          },
          configurable: true,
          enumerable: true,
        });
      }

      res.on('finish', () => {
        const duration = Date.now() - start;
        const ctx = correlationStore.getStore();
        const tenantId = ctx?.tenantId;

        const logFn = res.statusCode >= 500 ? logger.error.bind(logger)
          : res.statusCode >= 400 ? logger.warn.bind(logger)
          : logger.info.bind(logger);

        logFn(
          {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration_ms: duration,
            cid: correlationId,
            tenant: tenantId,
            uid: ctx?.userId,
            ip: req.ip,
            ua: req.headers['user-agent']?.slice(0, 80),
          },
          'HTTP request',
        );

        // Track per-tenant API usage (observability + billing)
        if (tenantId) {
          incrementEvent('api.request', tenantId);
          trackUsage(tenantId, 'api_calls');  // billing quota counter
          if (res.statusCode >= 500) incrementEvent('api.error_5xx', tenantId);
          if (res.statusCode >= 400 && res.statusCode < 500) incrementEvent('api.error_4xx', tenantId);
        }
      });

      next();
    },
  );
}

/**
 * Per-tenant rate limiter (max N requests per window, keyed by tenant_id from JWT).
 * Falls back to IP-based limit for unauthenticated requests.
 */
import rateLimit from 'express-rate-limit';

export function tenantRateLimiter(maxPerWindow = 300, windowMs = 60_000) {
  return rateLimit({
    windowMs,
    max: maxPerWindow,
    keyGenerator: (req) => (req as any).auth?.tenant_id ?? req.ip ?? 'unknown',
    skip: (req) => SKIP_PATHS.has(req.path),
    handler: (req, res) => {
      const tenantId = (req as any).auth?.tenant_id;
      logger.warn({ tenant: tenantId, path: req.path, ip: req.ip }, 'Rate limit exceeded');
      res.status(429).json({
        success: false,
        error: 'Too many requests — please slow down',
        retry_after_ms: windowMs,
      });
    },
    standardHeaders: true,
    legacyHeaders: false,
  });
}
