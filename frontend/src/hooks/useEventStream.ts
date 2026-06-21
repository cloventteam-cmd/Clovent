import { useEffect, useRef, useState, useCallback } from 'react';
import { streamClient } from '../lib/stream';
import type { StreamEvent } from '../types';

const MAX_FEED = 200;

export function useEventStream() {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting');
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [epm, setEpm] = useState(0);  // events per minute

  const recentTs = useRef<number[]>([]);

  const push = useCallback((event: StreamEvent) => {
    setEvents(prev => [event, ...prev].slice(0, MAX_FEED));
    // EPM tracking
    const now = Date.now();
    recentTs.current = [...recentTs.current.filter(t => now - t < 60_000), now];
    setEpm(recentTs.current.length);
  }, []);

  useEffect(() => {
    const unsub = streamClient.on(push);
    const unsubStatus = streamClient.onStatus(setStatus);
    return () => { unsub(); unsubStatus(); };
  }, [push]);

  // EPM decay
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      recentTs.current = recentTs.current.filter(t => now - t < 60_000);
      setEpm(recentTs.current.length);
    }, 5_000);
    return () => clearInterval(t);
  }, []);

  return { status, events, epm };
}

// Typed event hook — filters stream to specific event types
export function useStreamEvents<T extends Record<string, unknown>>(
  types: string[],
  maxItems = 50,
) {
  const [items, setItems] = useState<Array<T & { _ts: string }>>([]);

  useEffect(() => {
    const typeSet = new Set(types);
    return streamClient.on((event: StreamEvent) => {
      if (typeSet.has(event.type)) {
        setItems(prev => [
          { ...(event.payload as T), _ts: event.ts },
          ...prev,
        ].slice(0, maxItems));
      }
    });
  }, [types.join(','), maxItems]);

  return items;
}
