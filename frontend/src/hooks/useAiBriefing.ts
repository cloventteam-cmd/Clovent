import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../lib/api';
import type { AiBriefing } from '../types';

const REFRESH_MS = 5 * 60_000; // auto-refresh every 5 min

export function useAiBriefing() {
  const [briefing, setBriefing] = useState<AiBriefing | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const fetch = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.briefing();
      if (res.success) {
        setBriefing(res.data);
        setLastFetch(new Date());
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    timer.current = setInterval(fetch, REFRESH_MS);
    return () => clearInterval(timer.current);
  }, [fetch]);

  return { briefing, loading, error, lastFetch, refresh: fetch };
}
