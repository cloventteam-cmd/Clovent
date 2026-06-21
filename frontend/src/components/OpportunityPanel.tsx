import React, { useState } from 'react';
import { useOpportunities } from '../hooks/useOpportunities';
import type { Opportunity } from '../types';

const TYPE_META: Record<string, { icon: string; label: string; color: string }> = {
  likely_seller:          { icon: '◎', label: 'SELLER',   color: 'var(--amber)' },
  likely_buyer:           { icon: '◉', label: 'BUYER',    color: 'var(--blue)'  },
  reactivation:           { icon: '⟳', label: 'REACT',    color: 'var(--cyan)'  },
  referral_opportunity:   { icon: '◈', label: 'REFERRAL', color: 'var(--purple)'},
  investment_opportunity: { icon: '◆', label: 'INVEST',   color: 'var(--green)' },
  deal_risk:              { icon: '⚠', label: 'RISK',     color: 'var(--red)'   },
  upsell:                 { icon: '↑', label: 'UPSELL',   color: 'var(--cyan)'  },
};

export function OpportunityPanel() {
  const opps = useOpportunities();
  const [filter, setFilter] = useState<string>('all');

  // Count by type
  const counts: Record<string, number> = {};
  for (const o of opps) counts[o.type] = (counts[o.type] ?? 0) + 1;

  const filtered = filter === 'all' ? opps : opps.filter(o => o.type === filter);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--bg-panel)', borderLeft: '1px solid var(--border)',
    }}>
      <div className="panel-hdr">
        <span className="panel-hdr-title" style={{ color: 'var(--purple)' }}>OPPORTUNITY RADAR</span>
        <span className="panel-hdr-count">{opps.length}</span>
      </div>

      {/* Type summary grid */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr',
        padding: '5px 10px', gap: '2px 8px',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        {Object.entries(TYPE_META).map(([type, meta]) => (
          <button
            key={type}
            onClick={() => setFilter(f => f === type ? 'all' : type)}
            style={{
              background: filter === type ? `${meta.color}18` : 'transparent',
              border: `1px solid ${filter === type ? meta.color : 'transparent'}`,
              padding: '2px 4px',
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span style={{ color: (counts[type] ?? 0) > 0 ? meta.color : 'var(--text-4)', fontSize: '8px' }}>
              {meta.icon} {meta.label}
            </span>
            <span style={{ color: (counts[type] ?? 0) > 0 ? meta.color : 'var(--text-4)', fontSize: '8px', fontWeight: 700 }}>
              {counts[type] ?? 0}
            </span>
          </button>
        ))}
      </div>

      {/* List */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {filtered.slice(0, 30).map(o => <OppRow key={o.id} opp={o} />)}
        {filtered.length === 0 && (
          <div style={{ padding: '20px 10px', color: 'var(--text-4)', fontSize: 'var(--sz-xs)' }}>
            {opps.length === 0 ? 'AI scanning for opportunities...' : 'No opportunities in this category'}
          </div>
        )}
      </div>
    </div>
  );
}

function OppRow({ opp: o }: { opp: Opportunity }) {
  const meta  = TYPE_META[o.type] ?? { icon: '·', label: o.type.toUpperCase(), color: 'var(--text-3)' };
  const score = Number(o.score ?? 0);
  const color = meta.color;
  const name  = o.first_name ? `${o.first_name} ${o.last_name ?? ''}`.trim() : undefined;

  const priorityColor = o.priority === 'critical' || o.priority === 'high'
    ? 'var(--red)' : o.priority === 'medium' ? 'var(--amber)' : 'var(--text-3)';

  return (
    <div className="row">
      {/* Top row: type + score */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color, fontSize: 'var(--sz-xs)', fontWeight: 700 }}>
          {meta.icon} {meta.label}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ color: priorityColor, fontSize: '7px', border: `1px solid ${priorityColor}`, padding: '0 3px' }}>
            {(o.priority ?? 'med').toUpperCase()}
          </span>
          <span style={{ color: scoreColor(score), fontSize: 'var(--sz-sm)', fontWeight: 700 }}>
            {Math.round(score * 100)}%
          </span>
        </div>
      </div>

      {/* Contact name */}
      {name && (
        <div style={{ color: 'var(--text-2)', fontSize: 'var(--sz-sm)', marginTop: '2px' }}>{name}</div>
      )}

      {/* Recommended action */}
      {o.recommended_action && (
        <div className="trunc" style={{ color: 'var(--text-3)', fontSize: 'var(--sz-xs)', marginTop: '2px' }}>
          {String(o.recommended_action).slice(0, 48)}
        </div>
      )}
    </div>
  );
}

function scoreColor(s: number): string {
  if (s > 0.75) return 'var(--green)';
  if (s > 0.5)  return 'var(--amber)';
  return 'var(--text-3)';
}
