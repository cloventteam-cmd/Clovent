import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { streamClient } from '../lib/stream';
import type { Contact, StreamEvent } from '../types';

const MAX = 30;

export function useContacts() {
  const [contacts, setContacts] = useState<Contact[]>([]);

  useEffect(() => {
    api.contacts('status=active&order_by=score').then(r => {
      const list: Contact[] = (r.data ?? []);
      setContacts(sortByScore(list).slice(0, MAX));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    return streamClient.on((e: StreamEvent) => {
      if (e.type === 'snapshot.contacts') {
        setContacts(sortByScore(e.payload as unknown as Contact[]).slice(0, MAX));
        return;
      }
      if (e.type === 'contact.scored') {
        const p = e.payload as any;
        setContacts(prev => {
          const next = prev.map(c => c.id === p.contact_id ? { ...c, ...p.scores } : c);
          return sortByScore(next);
        });
        return;
      }
      if (e.type === 'contact.created') {
        const p = e.payload as any;
        setContacts(prev => [{
          id: p.contact_id ?? '', first_name: '—', last_name: 'NEW',
          type: 'lead', status: 'active', tags: [],
          buyer_probability: 0, seller_probability: 0,
          investor_probability: 0, referral_probability: 0,
          engagement_score: 0, relationship_health: 0.5,
        }, ...prev].slice(0, MAX));
      }
    });
  }, []);

  return contacts;
}

function sortByScore(contacts: Contact[]): Contact[] {
  return [...contacts].sort(
    (a, b) => Math.max(b.buyer_probability ?? 0, b.seller_probability ?? 0, b.engagement_score ?? 0)
            - Math.max(a.buyer_probability ?? 0, a.seller_probability ?? 0, a.engagement_score ?? 0),
  );
}
