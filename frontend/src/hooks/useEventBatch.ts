/**
 * High-performance batched event hook.
 *
 * Collects stream events and flushes to React state at most once per animation
 * frame (~16ms / 60fps). Under 1000+ EPM bursts this prevents continuous
 * re-renders while keeping the UI visually smooth.
 *
 * Ring buffer: evicts oldest events once MAX_ITEMS is reached.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { streamClient } from '../lib/stream';
import type { StreamEvent } from '../types';

const MAX_ITEMS = 500;
const FLUSH_MS  = 16;   // ~60fps

export function useEventBatch() {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const buffer  = useRef<StreamEvent[]>([]);
  const timer   = useRef<ReturnType<typeof setTimeout>>();
  const newIds  = useRef(new Set<string>());  // for flash effect

  const flush = useCallback(() => {
    if (buffer.current.length === 0) return;
    const batch = buffer.current.splice(0);
    batch.forEach(e => newIds.current.add(e.id));
    setEvents(prev => [...batch, ...prev].slice(0, MAX_ITEMS));
    // Clear flash markers after animation
    setTimeout(() => batch.forEach(e => newIds.current.delete(e.id)), 700);
  }, []);

  useEffect(() => {
    return streamClient.on((event: StreamEvent) => {
      buffer.current.push(event);
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, FLUSH_MS);
    });
  }, [flush]);

  return { events, newIds: newIds.current };
}

// Typed hook: watches stream for specific event types, maintains separate state
export function useStreamState<T>(
  types: string[],
  reducer: (prev: T, event: StreamEvent) => T,
  initial: T,
): T {
  const [state, setState] = useState<T>(initial);
  const typeSet = useRef(new Set(types));

  useEffect(() => {
    typeSet.current = new Set(types);
  }, [types.join(',')]);

  useEffect(() => {
    return streamClient.on((event: StreamEvent) => {
      if (typeSet.current.has(event.type)) {
        setState(prev => reducer(prev, event));
      }
    });
  }, [reducer]);

  return state;
}

// EPM tracker: counts events per minute using a sliding window
export function useEpm(): number {
  const [epm, setEpm] = useState(0);
  const times = useRef<number[]>([]);

  useEffect(() => {
    const unsub = streamClient.on(() => {
      times.current.push(Date.now());
    });
    const ticker = setInterval(() => {
      const cutoff = Date.now() - 60_000;
      times.current = times.current.filter(t => t > cutoff);
      setEpm(times.current.length);
    }, 3_000);
    return () => { unsub(); clearInterval(ticker); };
  }, []);

  return epm;
}
