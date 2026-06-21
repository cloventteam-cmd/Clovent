/**
 * Audit Logger Middleware
 *
 * Records every mutating API action (POST/PUT/PATCH/DELETE) to the audit_logs table.
 * Captures: user, tenant, action, entity, changes, IP, correlation_id, status.
 *
 * Non-blocking: write happens after response is sent.
 * Read-only requests (GET) are NOT logged (too noisy).
 */
import type { Request, Response, NextFunction } from 'express';
import { query } from '../../db/client';
import { getCorrelationId } from '../../observability/correlation';
import { logger } from '../../shared/logger';

// Map (method + path pattern) → action name
function inferAction(method: string, path: string): string {
  const parts = path.split('/').filter(Boolean);
  const resource = parts[1] ?? parts[0] ?? 'unknown';
  const actionMap: Record<string, string> = {
    POST:   `${resource}.create`,
    PUT:    `${resource}.update`,
    PATCH:  `${resource}.update`,
    DELETE: `${resource}.delete`,
  };
  return actionMap[method] ?? `${method.toLowerCase()}.${resource}`;
}

function inferEntityType(path: string): string | null {
  const parts = path.split('/').filter(Boolean);
  // /api/contacts/123 → contacts
  // /api/deals/123/stage → deals
  return parts[1] ?? null;
}

function inferEntityId(path: string): string | null {
  const parts = path.split('/').filter(Boolean);
  // /api/contacts/uuid → uuid
  if (parts.length >= 3) {
    const candidate = parts[2];
    if (/^[0-9a-f-]{36}$/i.test(candidate)) return candidate;
  }
  return null;
}

const SKIP_PATHS = new Set([
  '/health', '/health/db', '/health/redis', '/health/workers', '/health/metrics',
  '/api/stream', '/api/auth/refresh',
]);

const SKIP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function auditLog(req: Request, res: Response, next: NextFunction): void {
  if (SKIP_METHODS.has(req.method) || SKIP_PATHS.has(req.path)) {
    next();
    return;
  }

  const auth = (req as any).auth;
  const startTs = Date.now();

  res.on('finish', () => {
    const tenantId   = auth?.tenant_id;
    const userId     = auth?.user_id;
    if (!tenantId && !userId) return; // skip unauthenticated (login, webhooks)

    const status  = res.statusCode < 400 ? 'success'
      : res.statusCode === 403 ? 'denied' : 'error';

    const action      = inferAction(req.method, req.path);
    const entityType  = inferEntityType(req.path);
    const entityId    = inferEntityId(req.path);
    const cid         = getCorrelationId();

    // Non-blocking write
    setImmediate(() => {
      query(
        `INSERT INTO audit_logs
           (tenant_id, user_id, action, entity_type, entity_id,
            ip_address, user_agent, correlation_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          tenantId ?? null, userId ?? null, action,
          entityType, entityId,
          req.ip, req.headers['user-agent']?.slice(0, 200) ?? null,
          cid, status,
        ],
      ).catch(err => logger.error({ err }, 'AuditLog: write failed'));
    });
  });

  next();
}

// Structured audit log for explicit actions (e.g. plan changes, data exports)
export async function writeAuditLog(params: {
  tenantId: string;
  userId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  changes?: Record<string, unknown>;
  status?: 'success' | 'denied' | 'error';
}): Promise<void> {
  await query(
    `INSERT INTO audit_logs
       (tenant_id, user_id, action, entity_type, entity_id, changes, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      params.tenantId, params.userId ?? null, params.action,
      params.entityType ?? null, params.entityId ?? null,
      params.changes ? JSON.stringify(params.changes) : null,
      params.status ?? 'success',
    ],
  ).catch(err => logger.error({ err }, 'AuditLog: explicit write failed'));
}
