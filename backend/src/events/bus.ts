import EventEmitter from 'eventemitter3';
import type { Redis } from 'ioredis';
import { logger } from '../shared/logger';
import type { EventName, EventPayloadMap, BaseEventPayload } from './types';
import { uuid } from '../shared/utils';
import { incrementEvent } from '../observability/event-metrics';
import { getCorrelationId, getTenantId } from '../observability/correlation';

type Handler<T> = (payload: T) => Promise<void> | void;

const REDIS_CHANNEL = 'clovent:events';

class EventBus {
  private emitter = new EventEmitter();
  private publisher: Redis | null = null;
  private subscriber: Redis | null = null;
  private middlewares: Array<(name: EventName, payload: BaseEventPayload) => Promise<void>> = [];
  private processId = uuid().slice(0, 8);

  connectRedis(publisher: Redis, subscriber: Redis): void {
    this.publisher = publisher;
    this.subscriber = subscriber;

    this.subscriber.subscribe(REDIS_CHANNEL, (err) => {
      if (err) {
        logger.error({ err }, 'EventBus: Redis subscribe failed — in-memory only');
        this.publisher = null;
        this.subscriber = null;
        return;
      }
      logger.info('EventBus: Redis pub/sub connected');
    });

    this.subscriber.on('message', (_channel: string, raw: string) => {
      try {
        const { name, payload, originPid } = JSON.parse(raw) as {
          name: EventName; payload: BaseEventPayload; originPid: string;
        };
        if (originPid === this.processId) return; // already fired locally
        this._emitLocal(name, payload as any);
      } catch (err) {
        logger.error({ err }, 'EventBus: failed to parse Redis message');
      }
    });
  }

  use(middleware: (name: EventName, payload: BaseEventPayload) => Promise<void>): void {
    this.middlewares.push(middleware);
  }

  on<K extends EventName>(event: K, handler: Handler<EventPayloadMap[K]>): void {
    this.emitter.on(event, handler as Handler<unknown>);
    logger.debug({ event, handlers: this.emitter.listenerCount(event) }, 'EventBus: handler registered');
  }

  off<K extends EventName>(event: K, handler: Handler<EventPayloadMap[K]>): void {
    this.emitter.off(event, handler as Handler<unknown>);
  }

  async emit<K extends EventName>(
    event: K,
    payload: Omit<EventPayloadMap[K], 'occurred_at' | 'correlation_id'> & {
      occurred_at?: Date;
      correlation_id?: string;
    },
  ): Promise<void> {
    const enriched = {
      ...payload,
      occurred_at: payload.occurred_at ?? new Date(),
      // Inherit correlation from async context if not explicitly provided
      correlation_id: payload.correlation_id ?? getCorrelationId(),
    } as EventPayloadMap[K];

    // Track metrics (non-blocking — synchronous Map increment)
    const tenantId = (enriched as BaseEventPayload).tenant_id ?? getTenantId();
    incrementEvent(event, tenantId);

    // Run middlewares
    for (const mw of this.middlewares) {
      try { await mw(event, enriched as BaseEventPayload); }
      catch (err) { logger.error({ err, event }, 'EventBus: middleware error'); }
    }

    // Cross-process delivery via Redis
    if (this.publisher) {
      try {
        await this.publisher.publish(
          REDIS_CHANNEL,
          JSON.stringify({ name: event, payload: enriched, originPid: this.processId }),
        );
      } catch (err) {
        logger.warn({ err, event }, 'EventBus: Redis publish failed — local delivery only');
      }
    }

    // Always deliver locally (same process, zero latency)
    await this._emitLocal(event, enriched);
  }

  private async _emitLocal<K extends EventName>(event: K, payload: EventPayloadMap[K]): Promise<void> {
    const listeners = this.emitter.listeners(event) as Handler<EventPayloadMap[K]>[];

    logger.debug(
      {
        event,
        tenant_id: (payload as BaseEventPayload).tenant_id,
        cid: (payload as BaseEventPayload).correlation_id,
        handlers: listeners.length,
      },
      `EventBus: ${event}`,
    );

    await Promise.allSettled(
      listeners.map(async (listener) => {
        try { await listener(payload); }
        catch (err) { logger.error({ err, event }, `EventBus: handler threw for ${event}`); }
      }),
    );
  }

  listenerCount(event: EventName): number {
    return this.emitter.listenerCount(event);
  }
}

export const eventBus = new EventBus();

// Audit middleware — structured log for every event
eventBus.use(async (name, payload) => {
  logger.debug(
    {
      event: name,
      cid: payload.correlation_id,
      tenant: payload.tenant_id,
    },
    'AUDIT',
  );
});
