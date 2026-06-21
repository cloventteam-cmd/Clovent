/**
 * Correlation ID Store — AsyncLocalStorage propagation
 *
 * Every inbound HTTP request gets a unique correlation ID.
 * All events, DB queries, and logs in the same async call chain
 * automatically inherit it — no manual threading required.
 *
 * Usage:
 *   correlationStore.run(id, () => { ... all async work here ... });
 *   correlationStore.getId()  // anywhere in the chain
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

interface Context {
  correlationId: string;
  tenantId?: string;
  userId?: string;
  source: 'api' | 'worker' | 'cron' | 'webhook' | 'system';
}

export const correlationStore = new AsyncLocalStorage<Context>();

export function newCorrelationId(): string {
  return randomUUID();
}

export function getContext(): Context | undefined {
  return correlationStore.getStore();
}

export function getCorrelationId(): string {
  return correlationStore.getStore()?.correlationId ?? 'no-correlation';
}

export function getTenantId(): string | undefined {
  return correlationStore.getStore()?.tenantId;
}

export function runWithContext<T>(
  ctx: Context,
  fn: () => T,
): T {
  return correlationStore.run(ctx, fn);
}

export function enrichLogContext(): Record<string, string | undefined> {
  const ctx = correlationStore.getStore();
  if (!ctx) return {};
  return {
    cid: ctx.correlationId,
    tenant: ctx.tenantId,
    uid: ctx.userId,
    src: ctx.source,
  };
}
