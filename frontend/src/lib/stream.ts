import type { StreamEvent } from '../types';
import { getToken } from './api';

type EventHandler = (event: StreamEvent) => void;
type StatusHandler = (status: 'connecting' | 'connected' | 'disconnected' | 'error') => void;

export class StreamClient {
  private es: EventSource | null = null;
  private handlers = new Set<EventHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30_000;
  private dead = false;
  private eventsReceived = 0;

  connect(): void {
    if (this.dead) return;
    const token = getToken();
    if (!token) return;

    this.emit_status('connecting');

    const url = `/api/stream?token=${encodeURIComponent(token)}`;
    this.es = new EventSource(url);

    this.es.onopen = () => {
      this.reconnectDelay = 1000;
      this.emit_status('connected');
    };

    this.es.onmessage = (e) => {
      try {
        const event: StreamEvent = JSON.parse(e.data);
        this.eventsReceived++;
        for (const h of this.handlers) h(event);
      } catch { /* ignore malformed frames */ }
    };

    this.es.onerror = () => {
      this.es?.close();
      this.es = null;
      this.emit_status('error');

      if (!this.dead) {
        setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
          this.connect();
        }, this.reconnectDelay);
      }
    };
  }

  disconnect(): void {
    this.dead = true;
    this.es?.close();
    this.es = null;
    this.emit_status('disconnected');
  }

  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  getStats() { return { eventsReceived: this.eventsReceived }; }

  private emit_status(s: Parameters<StatusHandler>[0]): void {
    for (const h of this.statusHandlers) h(s);
  }
}

export const streamClient = new StreamClient();
