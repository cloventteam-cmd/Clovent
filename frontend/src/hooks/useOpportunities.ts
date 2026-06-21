import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { streamClient } from '../lib/stream';
import type { Opportunity, StreamEvent } from '../types';

const MAX = 40;

export function useOpportunities() {
  const [items, setItems] = useState<Opportunity[]>([]);

  useEffect(() => {
    api.opportunities().then(r => setItems(r.data ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    return streamClient.on((e: StreamEvent) => {
      if (e.type === 'snapshot.opportunities') {
        setItems(sortByScore(e.payload as unknown as Opportunity[]));
        return;
      }
      if (e.type === 'opportunity.detected') {
        const p = e.payload as any;
        setItems(prev => {
          if (prev.find(o => o.id === p.opportunity_id)) return prev;
          return sortByScore([
            {
              id: p.opportunity_id, type: p.type, priority: p.priority,
              score: Number(p.score), title: p.title ?? p.type,
            },
            ...prev,
          ].slice(0, MAX));
        });
      }
    });
  }, []);

  return items;
}

function sortByScore(items: Opportunity[]): Opportunity[] {
  return [...items].sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
}
