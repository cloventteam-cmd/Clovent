import React, { useEffect, useState, useCallback, useRef } from 'react';
import { LoginScreen } from './components/LoginScreen';
import { PricingTable } from './components/PricingTable';
import { StatusBar } from './components/StatusBar';
import { LiveFeed } from './components/LiveFeed';
import { LeadsPanel } from './components/LeadsPanel';
import { PipelinePanel } from './components/PipelinePanel';
import { OpportunityPanel } from './components/OpportunityPanel';
import { AiOperatorPanel } from './components/AiOperatorPanel';
import { useEventBatch, useEpm } from './hooks/useEventBatch';
import { streamClient } from './lib/stream';
import { api, getToken, setToken } from './lib/api';

// Active panel for keyboard navigation
type ActivePanel = 'feed' | 'leads' | 'pipeline' | 'oppty' | 'ai';
const PANEL_KEYS: Record<string, ActivePanel> = {
  f: 'feed', l: 'leads', p: 'pipeline', o: 'oppty', a: 'ai',
};

interface AuthState {
  user: Record<string, unknown> | null;
  org: Record<string, unknown> | null;
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ user: null, org: null });
  const [booting, setBooting] = useState(true);
  const [connStatus, setConnStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting');
  const [activePanel, setActivePanel] = useState<ActivePanel>('feed');
  const [showPricing, setShowPricing] = useState(false);
  const [currentPlan, setCurrentPlan] = useState<string>('starter');

  // High-performance batched event state
  const { events, newIds } = useEventBatch();
  const epm = useEpm();

  // Restore session
  useEffect(() => {
    const token = getToken();
    if (token) {
      api.me()
        .then(r => setAuth({ user: r.data.user, org: r.data.organization }))
        .catch(() => setToken(null))
        .finally(() => setBooting(false));
    } else {
      setBooting(false);
    }
  }, []);

  // Connect SSE when authenticated
  useEffect(() => {
    if (!auth.user) return;
    streamClient.onStatus(setConnStatus);
    streamClient.connect();
    // Load current plan
    api.subscription().then(r => setCurrentPlan(r.data?.current_plan ?? 'starter')).catch(() => {});
    return () => streamClient.disconnect();
  }, [!!auth.user]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'Escape') { setShowPricing(false); return; }
      if (e.key === 'b' || e.key === 'B') { setShowPricing(p => !p); return; }
      const panel = PANEL_KEYS[e.key.toLowerCase()];
      if (panel) setActivePanel(panel);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  if (booting) {
    return (
      <div style={{
        minHeight: '100vh', background: 'var(--bg)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--green)', fontSize: 'var(--sz-md)',
      }}>
        INITIALIZING CLOVENT...
      </div>
    );
  }

  if (!auth.user) {
    return <LoginScreen onLogin={(user, org) => setAuth({ user, org })} />;
  }

  const orgName  = String((auth.org as any)?.name ?? '');
  const userEmail = String((auth.user as any)?.email ?? '');

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      background: 'var(--bg)', overflow: 'hidden',
    }}>
      {/* Status bar */}
      <StatusBar
        status={connStatus}
        epm={epm}
        totalEvents={events.length}
        orgName={orgName}
        userEmail={userEmail}
      />

      {/* 5-column dashboard grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '280px 210px 220px 200px 230px',
        flex: 1,
        overflow: 'hidden',
        minWidth: '1140px',
      }}>
        {/* Panel 1 — Live Feed */}
        <PanelWrapper active={activePanel === 'feed'} onClick={() => setActivePanel('feed')}>
          <LiveFeed events={events} newIds={newIds} />
        </PanelWrapper>

        {/* Panel 2 — Leads Intelligence */}
        <PanelWrapper active={activePanel === 'leads'} onClick={() => setActivePanel('leads')}>
          <LeadsPanel />
        </PanelWrapper>

        {/* Panel 3 — Deal Pipeline */}
        <PanelWrapper active={activePanel === 'pipeline'} onClick={() => setActivePanel('pipeline')}>
          <PipelinePanel />
        </PanelWrapper>

        {/* Panel 4 — Opportunity Radar */}
        <PanelWrapper active={activePanel === 'oppty'} onClick={() => setActivePanel('oppty')}>
          <OpportunityPanel />
        </PanelWrapper>

        {/* Panel 5 — AI Business Operator */}
        <PanelWrapper active={activePanel === 'ai'} onClick={() => setActivePanel('ai')}>
          <AiOperatorPanel />
        </PanelWrapper>
      </div>

      {/* Pricing table overlay */}
      {showPricing && (
        <PricingTable
          currentPlan={currentPlan}
          onClose={() => setShowPricing(false)}
          onUpgrade={async (planId, period) => {
            try {
              const res = await api.checkout(planId, period);
              if (res.success && res.data?.url) window.location.href = res.data.url;
            } catch (err) {
              console.error('Checkout failed:', err);
            }
          }}
        />
      )}

      {/* Bottom info bar */}
      <div style={{
        height: '20px', background: 'var(--bg)', borderTop: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', padding: '0 12px',
        gap: '16px', flexShrink: 0, overflow: 'hidden',
      }}>
        <span style={{ color: connStatus === 'connected' ? 'var(--green)' : 'var(--red)', fontSize: '8px' }}>
          {connStatus === 'connected' ? '● SSE LIVE' : '○ RECONNECTING'}
        </span>
        <span style={{ color: 'var(--text-4)', fontSize: '7px' }}>NO POLLING · TENANT ISOLATED · REAL-TIME ONLY</span>
        <button
          onClick={() => setShowPricing(true)}
          style={{
            background: 'transparent', border: '1px solid var(--border-hi)',
            color: 'var(--text-3)', fontSize: '7px', padding: '1px 6px',
            cursor: 'pointer', letterSpacing: '0.08em',
          }}
        >
          {currentPlan.toUpperCase()} PLAN · <kbd style={{ fontSize: '7px' }}>B</kbd> BILLING
        </button>
        <span style={{ marginLeft: 'auto', color: 'var(--text-4)', fontSize: '7px' }}>
          {userEmail} · {(auth.org as any)?.plan?.toUpperCase() ?? 'PRO'}
        </span>
      </div>
    </div>
  );
}

// Panel wrapper: highlights active panel with subtle border
function PanelWrapper({ children, active, onClick }: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        height: '100%',
        overflow: 'hidden',
        outline: active ? '1px solid var(--green-dim)' : 'none',
        outlineOffset: '-1px',
        position: 'relative',
        cursor: 'default',
      }}
    >
      {children}
    </div>
  );
}
