/**
 * AI Business Operator Panel
 *
 * Renders the daily AI briefing: top actions, who to contact,
 * revenue forecast, and deals at risk. Data from GET /api/ai/briefing.
 * Auto-refreshes every 5 minutes via useAiBriefing hook.
 */
import React from 'react';
import { useAiBriefing } from '../hooks/useAiBriefing';
import type { BriefingAction, BriefingContact, BriefingRisk, RevenueForecast } from '../types';

export function AiOperatorPanel() {
  const { briefing, loading, error, lastFetch, refresh } = useAiBriefing();

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--bg-panel)', borderLeft: '1px solid var(--border)',
    }}>
      {/* Header */}
      <div className="panel-hdr">
        <span className="panel-hdr-title" style={{ color: 'var(--cyan)' }}>AI OPERATOR</span>
        <button
          onClick={refresh}
          style={{
            background: 'transparent', border: 'none',
            color: loading ? 'var(--text-4)' : 'var(--cyan)',
            cursor: 'pointer', fontSize: '9px',
          }}
          title="Refresh briefing"
        >
          {loading ? '...' : '⟳'}
        </button>
      </div>

      {/* Date stamp */}
      {briefing && (
        <div style={{
          padding: '3px 10px', borderBottom: '1px solid var(--border)',
          color: 'var(--text-4)', fontSize: '8px', flexShrink: 0,
        }}>
          {briefing.date} · GENERATED {new Date(briefing.generated_at).toLocaleTimeString('en-US', { hour12: false })}
        </div>
      )}

      {/* Error state */}
      {error && !briefing && (
        <div style={{ padding: '12px 10px', color: 'var(--red)', fontSize: 'var(--sz-xs)' }}>
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading && !briefing && (
        <div style={{ padding: '12px 10px', color: 'var(--text-4)', fontSize: 'var(--sz-xs)' }}>
          Generating daily briefing...
        </div>
      )}

      {/* Content */}
      {briefing && (
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {/* Summary */}
          {briefing.summary && (
            <div style={{
              padding: '6px 10px', borderBottom: '1px solid var(--border)',
              color: 'var(--text-2)', fontSize: 'var(--sz-xs)', lineHeight: '1.5',
              fontStyle: 'italic',
            }}>
              "{briefing.summary.slice(0, 120)}{briefing.summary.length > 120 ? '...' : ''}"
            </div>
          )}

          {/* Revenue Forecast */}
          {briefing.revenue_forecast && (
            <>
              <div className="section-label" style={{ color: 'var(--cyan)' }}>REVENUE FORECAST</div>
              <RevenueForecastBlock f={briefing.revenue_forecast} />
            </>
          )}

          {/* Who to contact */}
          {briefing.who_to_contact?.length > 0 && (
            <>
              <div className="section-label" style={{ color: 'var(--amber)' }}>WHO TO CONTACT NOW</div>
              {briefing.who_to_contact.slice(0, 6).map((c, i) => (
                <ContactRow key={c.contact_id + i} contact={c} rank={i + 1} />
              ))}
            </>
          )}

          {/* Top actions */}
          {briefing.top_actions?.length > 0 && (
            <>
              <div className="section-label" style={{ color: 'var(--green)' }}>TOP ACTIONS TODAY</div>
              {briefing.top_actions.slice(0, 8).map((a, i) => (
                <ActionRow key={i} action={a} />
              ))}
            </>
          )}

          {/* Deals at risk */}
          {briefing.deals_at_risk?.length > 0 && (
            <>
              <div className="section-label" style={{ color: 'var(--red)' }}>DEALS AT RISK</div>
              {briefing.deals_at_risk.slice(0, 5).map((d, i) => (
                <RiskDealRow key={d.deal_id + i} risk={d} />
              ))}
            </>
          )}

          {/* Footer */}
          <div style={{ padding: '8px 10px', color: 'var(--text-4)', fontSize: '7px' }}>
            Last updated: {lastFetch?.toLocaleTimeString('en-US', { hour12: false }) ?? '—'} · Auto-refresh 5m
          </div>
        </div>
      )}
    </div>
  );
}

function RevenueForecastBlock({ f }: { f: RevenueForecast }) {
  return (
    <div style={{ padding: '5px 10px 6px', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 8px' }}>
        <ForecastMetric label="THIS MONTH" value={fmt$(Number(f.this_month_projected))} color="var(--green)" />
        <ForecastMetric label="NEXT MONTH" value={fmt$(Number(f.next_month_projected))} color="var(--cyan)" />
        <ForecastMetric label="PIPELINE" value={fmt$(Number(f.pipeline_value))} color="var(--blue)" />
        <ForecastMetric
          label="AT RISK ⚠"
          value={fmt$(Number(f.deals_at_risk_value))}
          color={Number(f.deals_at_risk_value) > 0 ? 'var(--red)' : 'var(--text-3)'}
        />
      </div>
      {Number(f.weighted_pipeline) > 0 && (
        <div style={{ marginTop: '4px', color: 'var(--text-3)', fontSize: 'var(--sz-xs)' }}>
          Weighted pipeline: <span style={{ color: 'var(--cyan)' }}>{fmt$(Number(f.weighted_pipeline))}</span>
        </div>
      )}
    </div>
  );
}

function ForecastMetric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div style={{ color: 'var(--text-4)', fontSize: '7px', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ color, fontSize: 'var(--sz-sm)', fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function ContactRow({ contact: c, rank }: { contact: BriefingContact; rank: number }) {
  const score = Number(c.score ?? 0);

  return (
    <div className="row">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
        <span style={{ color: 'var(--text-4)', fontSize: '8px', paddingTop: '2px', minWidth: '10px' }}>
          {rank}.
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-1)', fontSize: 'var(--sz-sm)', fontWeight: 700 }}>
              {c.contact_name}
            </span>
            <span style={{ color: scoreColor(score), fontSize: 'var(--sz-sm)', fontWeight: 700 }}>
              {Math.round(score * 100)}%
            </span>
          </div>
          <div className="trunc" style={{ color: 'var(--text-3)', fontSize: 'var(--sz-xs)' }}>
            {c.reason}
            {c.last_contact_days_ago != null && (
              <span style={{ color: c.last_contact_days_ago > 14 ? 'var(--amber)' : 'var(--text-4)' }}>
                {' '}· {c.last_contact_days_ago}d ago
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionRow({ action: a }: { action: BriefingAction }) {
  const typeColor: Record<string, string> = {
    task_overdue: 'var(--red)',
    opportunity_likely_buyer: 'var(--blue)',
    opportunity_likely_seller: 'var(--amber)',
    deal_stalled: 'var(--amber)',
  };
  const color = typeColor[a.type] ?? 'var(--green)';

  return (
    <div className="row" style={{ paddingLeft: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '5px' }}>
        <span style={{ color, fontSize: '8px', paddingTop: '2px' }}>►</span>
        <div style={{ minWidth: 0 }}>
          <div className="trunc" style={{ color: 'var(--text-1)', fontSize: 'var(--sz-sm)' }}>
            {a.title}
          </div>
          {a.description && (
            <div className="trunc" style={{ color: 'var(--text-3)', fontSize: 'var(--sz-xs)' }}>
              {a.description.slice(0, 55)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RiskDealRow({ risk: r }: { risk: BriefingRisk }) {
  const color = Number(r.risk_score) > 0.7 ? 'var(--red)' : 'var(--amber)';
  return (
    <div className="row">
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span className="trunc" style={{ color: 'var(--text-1)', fontSize: 'var(--sz-sm)', maxWidth: '130px' }}>
          {r.deal_name}
        </span>
        <span style={{ color, fontSize: 'var(--sz-sm)', fontWeight: 700 }}>
          {Math.round(Number(r.risk_score) * 100)}%
        </span>
      </div>
      <div style={{ color: 'var(--text-3)', fontSize: 'var(--sz-xs)' }}>
        {r.top_risk?.slice(0, 40)}
        {r.days_to_close != null && (
          <span style={{ color: Number(r.days_to_close) < 5 ? 'var(--red)' : 'var(--text-4)' }}>
            {' '}· {r.days_to_close}d close
          </span>
        )}
      </div>
    </div>
  );
}

function fmt$(cents: number): string {
  if (!cents) return '$0';
  const d = cents / 100;
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(1)}M`;
  if (d >= 1_000)     return `$${(d / 1_000).toFixed(0)}K`;
  return `$${d.toFixed(0)}`;
}

function scoreColor(s: number): string {
  if (s > 0.75) return 'var(--green)';
  if (s > 0.5)  return 'var(--amber)';
  return 'var(--text-3)';
}
