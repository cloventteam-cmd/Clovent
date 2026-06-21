/**
 * SSE Event Broadcaster
 *
 * Bridges the internal EventBus → connected SSE clients.
 * Multi-tenant: each client receives only events for their tenant_id.
 *
 * Architecture:
 *   EventBus.emit(event) → broadcaster.fanout(tenantId, event)
 *     → iterate tenant's client set → res.write(SSE frame)
 *
 * Tenant isolation is enforced at registration AND at fanout —
 * no cross-tenant data ever reaches a client.
 */
import type { Response } from 'express';
import { eventBus } from '../events/bus';
import { EventNames } from '../events/types';
import { uuid } from '../shared/utils';
import { logger } from '../shared/logger';

// ── Event filter: only these events are streamed to the dashboard ─────────────
export const STREAMED_EVENTS = [
  EventNames.CONTACT_CREATED,
  EventNames.CONTACT_UPDATED,
  EventNames.CONTACT_SCORED,
  EventNames.DEAL_CREATED,
  EventNames.DEAL_STAGE_CHANGED,
  EventNames.DEAL_RISK_DETECTED,
  EventNames.DEAL_CLOSED,
  EventNames.OPPORTUNITY_DETECTED,
  EventNames.ACTIVITY_CREATED,
  EventNames.MESSAGE_RECEIVED,
  EventNames.IMPORT_COMPLETED,
  EventNames.NOTIFICATION_SEND,
  EventNames.CRM_SYNC_COMPLETED,
  // Phase 4 — Predictions
  EventNames.CONTACT_PREDICTION_UPDATED,
  EventNames.PREDICTION_BATCH_COMPLETED,
  EventNames.PREDICTION_UPDATED,
] as const;

export type StreamedEventName = typeof STREAMED_EVENTS[number];

// ── SSE frame format ──────────────────────────────────────────────────────────
export interface StreamEvent {
  id: string;           // for SSE Last-Event-ID replay
  type: string;
  payload: unknown;
  ts: string;           // ISO timestamp
}

function toSSEFrame(ev: StreamEvent): string {
  return `id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`;
}

// ── Connected client registry ─────────────────────────────────────────────────
interface SseClient {
  clientId: string;
  userId: string;
  res: Response;
  connectedAt: Date;
  eventCount: number;
}

class EventBroadcaster {
  // tenant_id → Map<clientId, SseClient>
  private tenants = new Map<string, Map<string, SseClient>>();
  private wired = false;

  /** Register a new SSE connection. Returns clientId for later cleanup. */
  register(tenantId: string, userId: string, res: Response): string {
    const clientId = uuid();

    if (!this.tenants.has(tenantId)) {
      this.tenants.set(tenantId, new Map());
    }
    this.tenants.get(tenantId)!.set(clientId, {
      clientId, userId, res,
      connectedAt: new Date(),
      eventCount: 0,
    });

    logger.info(
      { tenant_id: tenantId, client_id: clientId, total_clients: this.totalClients() },
      'SSE: client connected',
    );

    return clientId;
  }

  unregister(tenantId: string, clientId: string): void {
    const client = this.tenants.get(tenantId)?.get(clientId);
    if (!client) return;

    const duration = Math.round((Date.now() - client.connectedAt.getTime()) / 1000);
    this.tenants.get(tenantId)!.delete(clientId);
    if (this.tenants.get(tenantId)!.size === 0) this.tenants.delete(tenantId);

    logger.info(
      { tenant_id: tenantId, client_id: clientId, duration_s: duration, events_sent: client.eventCount },
      'SSE: client disconnected',
    );
  }

  /** Send an event to all clients in a specific tenant. */
  fanout(tenantId: string, eventName: string, payload: unknown): void {
    const clients = this.tenants.get(tenantId);
    if (!clients || clients.size === 0) return;

    const frame = toSSEFrame({
      id: uuid(),
      type: eventName,
      payload,
      ts: new Date().toISOString(),
    });

    const dead: string[] = [];

    for (const [clientId, client] of clients) {
      try {
        client.res.write(frame);
        client.eventCount++;
      } catch {
        dead.push(clientId);
      }
    }

    // Purge dead connections
    for (const id of dead) this.unregister(tenantId, id);
  }

  /** Send a heartbeat to all clients of a tenant (or all tenants). */
  heartbeat(tenantId?: string): void {
    const frame = ': heartbeat\n\n';
    const targets = tenantId ? [this.tenants.get(tenantId)] : [...this.tenants.values()];
    for (const clients of targets) {
      if (!clients) continue;
      for (const [, client] of clients) {
        try { client.res.write(frame); } catch { /* removed by next fanout */ }
      }
    }
  }

  totalClients(): number {
    let n = 0;
    for (const c of this.tenants.values()) n += c.size;
    return n;
  }

  stats(): { tenants: number; clients: number; per_tenant: Record<string, number> } {
    const per_tenant: Record<string, number> = {};
    for (const [tid, clients] of this.tenants) per_tenant[tid.slice(0, 8)] = clients.size;
    return { tenants: this.tenants.size, clients: this.totalClients(), per_tenant };
  }

  // ── Wire event bus → broadcaster ────────────────────────────────────────────
  // Called once during bootstrap. Must run AFTER pipeline handlers are registered.
  wire(): void {
    if (this.wired) return;
    this.wired = true;

    for (const eventName of STREAMED_EVENTS) {
      eventBus.on(eventName as any, async (payload: any) => {
        const tenantId = payload?.tenant_id;
        if (tenantId) {
          this.fanout(tenantId, eventName, payload);
        }
      });
    }

    // Global heartbeat every 25s (browser SSE timeout is typically 30s)
    setInterval(() => this.heartbeat(), 25_000).unref();

    logger.info({ events: STREAMED_EVENTS.length }, 'SSE broadcaster: wired to event bus');
  }
}

export const eventBroadcaster = new EventBroadcaster();
