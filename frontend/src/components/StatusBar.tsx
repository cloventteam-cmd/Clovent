import React, { useEffect, useState } from 'react';

interface Props {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  epm: number;
  totalEvents: number;
  orgName?: string;
  userEmail?: string;
}

const STATUS_CFG = {
  connected:    { color: 'var(--green)', label: '● LIVE' },
  connecting:   { color: 'var(--amber)', label: '○ CONNECTING' },
  disconnected: { color: 'var(--text-3)', label: '○ OFFLINE' },
  error:        { color: 'var(--red)',   label: '⚠ ERROR' },
};

export function StatusBar({ status, epm, totalEvents, orgName, userEmail }: Props) {
  const [clock, setClock] = useState(() => fmt(new Date()));
  useEffect(() => {
    const t = setInterval(() => setClock(fmt(new Date())), 1000);
    return () => clearInterval(t);
  }, []);

  const cfg = STATUS_CFG[status];

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      height: '28px',
      padding: '0 12px',
      background: 'var(--bg)',
      borderBottom: '1px solid var(--border)',
      gap: '20px',
      flexShrink: 0,
      overflow: 'hidden',
    }}>
      {/* Brand */}
      <span style={{
        color: 'var(--green)', fontWeight: 700, fontSize: '12px',
        letterSpacing: '0.15em',
      }}>
        CLOVENT
      </span>

      <Divider />

      {/* Connection status */}
      <span className={status === 'connected' ? 'live-dot' : ''} style={{
        color: cfg.color, fontSize: 'var(--sz-xs)', fontWeight: 700,
        letterSpacing: '0.08em',
      }}>
        {cfg.label}
      </span>

      {status === 'connected' && (
        <>
          <Divider />
          <Metric label="EPM" value={epm} color={epm > 10 ? 'var(--green)' : 'var(--text-2)'} />
          <Metric label="EVENTS" value={totalEvents.toLocaleString()} color="var(--blue)" />
        </>
      )}

      {orgName && (
        <>
          <Divider />
          <span style={{ color: 'var(--text-1)', fontSize: 'var(--sz-xs)', fontWeight: 700 }}>
            {orgName.toUpperCase()}
          </span>
        </>
      )}

      {/* Spacer */}
      <span style={{ flex: 1 }} />

      {/* Shortcuts hint */}
      <span style={{ color: 'var(--text-4)', fontSize: '8px' }}>
        <kbd>F</kbd> FEED &nbsp;
        <kbd>L</kbd> LEADS &nbsp;
        <kbd>P</kbd> PIPELINE &nbsp;
        <kbd>O</kbd> OPPTYS &nbsp;
        <kbd>A</kbd> AI OPS &nbsp;
        <kbd>B</kbd> BILLING
      </span>

      <Divider />

      {userEmail && (
        <span style={{ color: 'var(--text-3)', fontSize: 'var(--sz-xs)' }}>
          {userEmail}
        </span>
      )}

      <Divider />

      <span style={{ color: 'var(--cyan)', fontSize: 'var(--sz-xs)', fontFamily: 'var(--font)' }}>
        {clock}
      </span>
    </div>
  );
}

function Divider() {
  return <span style={{ color: 'var(--border-hi)' }}>│</span>;
}

function Metric({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <span style={{ fontSize: 'var(--sz-xs)' }}>
      <span style={{ color: 'var(--text-3)' }}>{label} </span>
      <span style={{ color }}>{value}</span>
    </span>
  );
}

function fmt(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour12: false });
}
