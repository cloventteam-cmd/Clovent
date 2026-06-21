import React, { useRef, useEffect, useState, useMemo } from 'react';
import type { StreamEvent, FeedItem, Severity } from '../types';
import { EVENT_META, SEV_COLOR } from '../types';

interface Props {
  events: StreamEvent[];
  newIds: Set<string>;
}

// Event types that can be filtered
const FILTER_GROUPS = [
  { key: 'all',     label: 'ALL' },
  { key: 'contact', label: 'CONTACTS' },
  { key: 'deal',    label: 'DEALS' },
  { key: 'oppty',   label: 'OPPTYS' },
  { key: 'system',  label: 'SYS' },
];

const FILTER_MAP: Record<string, string[]> = {
  all:     [],
  contact: ['contact.created', 'contact.updated', 'contact.scored'],
  deal:    ['deal.created', 'deal.stage_changed', 'deal.risk_detected', 'deal.closed'],
  oppty:   ['opportunity.detected'],
  system:  ['import.completed', 'crm.sync_completed', 'notification.send'],
};

export function LiveFeed({ events, newIds }: Props) {
  const [filter, setFilter] = useState('all');
  const scrollRef = useRef<HTMLDivElement>(null);
  const atTop = useRef(true);

  const items = useMemo(() => {
    const allowed = FILTER_MAP[filter];
    const list = allowed.length ? events.filter(e => allowed.includes(e.type)) : events;
    return list.map(toFeedItem);
  }, [events, filter]);

  // Auto-scroll to top when new items arrive (if user is already at top)
  useEffect(() => {
    if (atTop.current && scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [items.length]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    atTop.current = e.currentTarget.scrollTop < 40;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-panel)' }}>
      {/* Header */}
      <div className="panel-hdr">
        <span className="panel-hdr-title" style={{ color: 'var(--green)' }}>
          ● LIVE FEED
        </span>
        <span className="panel-hdr-count">{items.length} / {events.length}</span>
      </div>

      {/* Filter tabs */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid var(--border)',
        padding: '0 4px',
        flexShrink: 0,
      }}>
        {FILTER_GROUPS.map(g => (
          <button
            key={g.key}
            onClick={() => setFilter(g.key)}
            style={{
              background: 'transparent',
              border: 'none',
              borderBottom: `2px solid ${filter === g.key ? 'var(--green)' : 'transparent'}`,
              color: filter === g.key ? 'var(--green)' : 'var(--text-3)',
              padding: '3px 8px',
              fontSize: '8px',
              letterSpacing: '0.08em',
              cursor: 'pointer',
              fontWeight: filter === g.key ? 700 : 400,
            }}
          >
            {g.label}
          </button>
        ))}
      </div>

      {/* Feed scroll area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ overflowY: 'auto', flex: 1 }}
      >
        {items.length === 0 && (
          <div style={{ padding: '20px 12px', color: 'var(--text-4)', fontSize: 'var(--sz-xs)' }}>
            Waiting for events...
          </div>
        )}
        {items.map(item => (
          <FeedRow key={item.id} item={item} isNew={newIds.has(item.id)} />
        ))}
      </div>
    </div>
  );
}

function FeedRow({ item, isNew }: { item: FeedItem; isNew: boolean }) {
  const color = SEV_COLOR[item.severity as Severity ?? 'muted'];
  const time = item.ts.slice(11, 19); // HH:MM:SS

  return (
    <div
      className={`row${isNew ? ' flash' : ''}`}
      style={{ display: 'grid', gridTemplateColumns: '54px 1fr', gap: '4px', paddingTop: '5px', paddingBottom: '5px' }}
    >
      {/* Timestamp column */}
      <div style={{ paddingTop: '1px' }}>
        <div style={{ color: 'var(--text-4)', fontSize: '8px', lineHeight: '13px' }}>{time}</div>
        <div style={{ color, fontSize: '8px', lineHeight: '13px' }}>{item.label}</div>
      </div>

      {/* Content column */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', lineHeight: '14px' }}>
          <span style={{ color, fontSize: 'var(--sz-sm)' }}>{item.line1}</span>
          {item.badge && (
            <span className={`badge badge-${item.badgeClass ?? 'blue'}`}>{item.badge}</span>
          )}
          {item.score !== undefined && (
            <span style={{ color: scoreColor(item.score), fontSize: '9px', fontWeight: 700 }}>
              {Math.round(Number(item.score) * 100)}%
            </span>
          )}
        </div>
        {item.line2 && (
          <div style={{ color: 'var(--text-3)', fontSize: 'var(--sz-xs)', lineHeight: '13px', marginTop: '1px' }}>
            {item.line2}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Event → FeedItem ──────────────────────────────────────────────────────────
function toFeedItem(e: StreamEvent): FeedItem {
  const meta = EVENT_META[e.type] ?? { label: e.type.split('.').pop()?.toUpperCase() ?? 'EVT', severity: 'muted', icon: '·' };
  const p    = e.payload;

  const name = (p.first_name || p.last_name)
    ? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()
    : undefined;

  let line1 = '', line2: string | undefined, badge: string | undefined, badgeClass: string | undefined;
  let score: number | undefined;

  switch (e.type) {
    case 'contact.created':
      line1 = name ?? String(p.contact_id ?? '').slice(0, 8);
      line2 = `via ${String(p.source ?? 'manual')}`;
      break;

    case 'contact.scored': {
      const sc = p.scores as any;
      const top = Math.max(sc?.buyer_probability ?? 0, sc?.seller_probability ?? 0, sc?.engagement_score ?? 0);
      line1 = String(p.contact_id ?? '').slice(0, 8);
      score = top;
      badge = top > 0.8 ? 'HOT' : top > 0.6 ? 'WARM' : undefined;
      badgeClass = top > 0.8 ? 'red' : 'amber';
      break;
    }

    case 'deal.created':
      line1 = String(p.name ?? p.deal_id ?? '').slice(0, 28);
      line2 = String(p.stage ?? 'lead').toUpperCase();
      break;

    case 'deal.stage_changed':
      line1 = `${String(p.from_stage ?? '').toUpperCase()} → ${String(p.to_stage ?? '').toUpperCase()}`;
      line2 = String(p.deal_id ?? '').slice(0, 8);
      break;

    case 'deal.risk_detected': {
      const risk = Number(p.risk_score ?? 0);
      line1 = String(p.deal_id ?? '').slice(0, 12);
      line2 = (p.categories as string[] | undefined)?.join(' · ')?.toUpperCase();
      score = risk;
      badge = risk > 0.7 ? 'CRIT' : risk > 0.5 ? 'HIGH' : 'MED';
      badgeClass = risk > 0.7 ? 'red' : 'amber';
      break;
    }

    case 'deal.closed':
      line1 = String(p.outcome ?? '').toUpperCase();
      line2 = String(p.deal_id ?? '').slice(0, 8);
      badge = p.outcome === 'won' ? 'WON' : 'LOST';
      badgeClass = p.outcome === 'won' ? 'green' : 'red';
      break;

    case 'opportunity.detected':
      line1 = String(p.type ?? '').replace(/_/g, ' ').toUpperCase();
      line2 = name ?? String(p.contact_id ?? '').slice(0, 8);
      score = Number(p.score ?? 0);
      badge = String(p.priority ?? '').toUpperCase();
      badgeClass = p.priority === 'high' || p.priority === 'critical' ? 'purple' : 'blue';
      break;

    case 'activity.created':
      line1 = String(p.activity_type ?? 'activity').toUpperCase();
      line2 = name ?? String(p.contact_id ?? '').slice(0, 8);
      break;

    case 'import.completed': {
      const stats = p.stats as any;
      line1 = `+${stats?.created ?? 0} contacts`;
      line2 = `${stats?.errors ?? 0} errors`;
      break;
    }

    case 'notification.send':
      line1 = String(p.title ?? '').slice(0, 32);
      line2 = String(p.type ?? '').toUpperCase();
      break;

    case 'system.connected':
      line1 = 'Stream connected';
      break;

    case 'snapshot.complete':
      line1 = 'Initial data loaded';
      break;

    default:
      line1 = e.type;
      line2 = JSON.stringify(p).slice(0, 32);
  }

  return { id: e.id, type: e.type, label: meta.label, line1, line2, badge, badgeClass, score, severity: meta.severity, ts: e.ts };
}

function scoreColor(s: number): string {
  s = Number(s);
  if (s > 0.75) return 'var(--green)';
  if (s > 0.5)  return 'var(--amber)';
  return 'var(--text-3)';
}
