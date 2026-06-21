import React, { useState } from 'react';
import { useContacts } from '../hooks/useContacts';
import type { Contact } from '../types';

type Tab = 'hot' | 'buyers' | 'sellers' | 'all';

export function LeadsPanel() {
  const contacts = useContacts();
  const [tab, setTab] = useState<Tab>('hot');

  const filtered = contacts.filter(c => {
    if (tab === 'hot')     return topScore(c) > 0.6;
    if (tab === 'buyers')  return Number(c.buyer_probability) > 0.4;
    if (tab === 'sellers') return Number(c.seller_probability) > 0.4;
    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-panel)', borderLeft: '1px solid var(--border)' }}>
      {/* Header */}
      <div className="panel-hdr">
        <span className="panel-hdr-title" style={{ color: 'var(--amber)' }}>LEADS</span>
        <span className="panel-hdr-count">{filtered.length}</span>
      </div>

      {/* Tabs */}
      <Tabs tab={tab} onChange={setTab} contacts={contacts} />

      {/* List */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {filtered.slice(0, 25).map(c => <LeadRow key={c.id} contact={c} />)}
        {filtered.length === 0 && (
          <div style={{ padding: '16px 10px', color: 'var(--text-4)', fontSize: 'var(--sz-xs)' }}>
            No contacts in this segment
          </div>
        )}
      </div>
    </div>
  );
}

function Tabs({ tab, onChange, contacts }: { tab: Tab; onChange: (t: Tab) => void; contacts: Contact[] }) {
  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'hot',     label: 'HOT',    count: contacts.filter(c => topScore(c) > 0.6).length },
    { key: 'buyers',  label: 'BUYERS', count: contacts.filter(c => Number(c.buyer_probability) > 0.4).length },
    { key: 'sellers', label: 'SELLERS',count: contacts.filter(c => Number(c.seller_probability) > 0.4).length },
    { key: 'all',     label: 'ALL',    count: contacts.length },
  ];

  return (
    <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 2px', flexShrink: 0 }}>
      {tabs.map(t => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            borderBottom: `2px solid ${tab === t.key ? 'var(--amber)' : 'transparent'}`,
            color: tab === t.key ? 'var(--amber)' : 'var(--text-3)',
            padding: '3px 2px',
            fontSize: '8px',
            letterSpacing: '0.06em',
            cursor: 'pointer',
            fontWeight: tab === t.key ? 700 : 400,
          }}
        >
          {t.label} <span style={{ color: 'var(--text-4)' }}>{t.count}</span>
        </button>
      ))}
    </div>
  );
}

function LeadRow({ contact: c }: { contact: Contact }) {
  const top   = topScore(c);
  const isHot = top > 0.75;
  const isWarm = top > 0.5;
  const color = isHot ? 'var(--green)' : isWarm ? 'var(--amber)' : 'var(--text-3)';
  const name = `${c.first_name} ${c.last_name}`.trim() || c.id.slice(0, 8);
  const signal = Number(c.buyer_probability) >= Number(c.seller_probability) ? 'BUY' : 'SELL';

  return (
    <div
      className="row"
      style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px', alignItems: 'start' }}
    >
      {/* Left: name + metadata */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ color: isHot ? 'var(--green)' : isWarm ? 'var(--amber)' : 'var(--text-4)', fontSize: '8px' }}>
            {isHot ? '▲' : isWarm ? '▲' : '▼'}
          </span>
          <span className="trunc" style={{ color: isHot ? 'var(--text-1)' : 'var(--text-2)', fontSize: 'var(--sz-sm)', fontWeight: isHot ? 700 : 400 }}>
            {name}
          </span>
          <span style={{ fontSize: '7px', color: 'var(--text-4)', border: '1px solid var(--border-hi)', padding: '0 2px' }}>
            {signal}
          </span>
        </div>

        {/* Score bars */}
        <div style={{ marginTop: '3px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {Number(c.buyer_probability) > 0.1 && (
            <ScoreLine label="B" value={Number(c.buyer_probability)} color="var(--blue)" />
          )}
          {Number(c.seller_probability) > 0.1 && (
            <ScoreLine label="S" value={Number(c.seller_probability)} color="var(--amber)" />
          )}
          {Number(c.engagement_score) > 0.1 && (
            <ScoreLine label="E" value={Number(c.engagement_score)} color="var(--cyan)" />
          )}
        </div>
      </div>

      {/* Right: top score % */}
      <div style={{ textAlign: 'right', paddingTop: '2px' }}>
        <div style={{ color, fontSize: 'var(--sz-sm)', fontWeight: 700 }}>
          {Math.round(top * 100)}%
        </div>
        {c.type && (
          <div style={{ color: 'var(--text-4)', fontSize: '7px', marginTop: '2px' }}>
            {c.type.replace('_', ' ').toUpperCase()}
          </div>
        )}
      </div>
    </div>
  );
}

function ScoreLine({ label, value, color }: { label: string; value: number; color: string }) {
  const blocks = Math.max(1, Math.round(value * 8));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
      <span style={{ color: 'var(--text-4)', fontSize: '7px', width: '6px' }}>{label}</span>
      <span className="score-bar" style={{ color }}>
        {'█'.repeat(blocks)}
        <span style={{ color: 'var(--border)' }}>{'█'.repeat(8 - blocks)}</span>
      </span>
    </div>
  );
}

function topScore(c: Contact): number {
  return Math.max(
    Number(c.buyer_probability)    ?? 0,
    Number(c.seller_probability)   ?? 0,
    Number(c.engagement_score)     ?? 0,
  );
}
