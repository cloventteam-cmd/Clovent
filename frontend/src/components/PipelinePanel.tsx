import React from 'react';
import { usePipeline } from '../hooks/usePipeline';
import type { PipelineStage, DealRisk } from '../types';

const STAGE_ORDER = [
  ['lead',           'LEAD'],
  ['nurture',        'NURTURE'],
  ['active',         'ACTIVE'],
  ['under_contract', 'CONTRACT'],
  ['inspection',     'INSPECT'],
  ['appraisal',      'APPRAISAL'],
  ['financing',      'FINANCE'],
  ['clear_to_close', 'CTC'],
  ['closed_won',     'WON ✓'],
];

export function PipelinePanel() {
  const { stages, risks } = usePipeline();

  const stageMap = Object.fromEntries(stages.map(s => [s.stage, s]));
  const maxCount = Math.max(...stages.map(s => Number(s.count) || 0), 1);
  const totalValue = stages.reduce((sum, s) => sum + (Number(s.value) || 0), 0);
  const weightedValue = stages.reduce(
    (sum, s) => sum + (Number(s.value) || 0) * (STAGE_PROB[s.stage] ?? 0.3),
    0,
  );

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--bg-panel)', borderLeft: '1px solid var(--border)',
    }}>
      <div className="panel-hdr">
        <span className="panel-hdr-title" style={{ color: 'var(--blue)' }}>PIPELINE</span>
        <span style={{ color: 'var(--blue)', fontSize: 'var(--sz-xs)', fontWeight: 700 }}>
          {fmt$(totalValue)}
        </span>
      </div>

      {/* Stage bars */}
      <div style={{ padding: '4px 0', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {STAGE_ORDER.map(([key, label]) => {
          const s = stageMap[key];
          const count = Number(s?.count ?? 0);
          const risk  = Number(s?.avg_risk ?? 0);
          const stageColor = key === 'closed_won' ? 'var(--green)'
            : risk > 0.6 ? 'var(--red)'
            : risk > 0.35 ? 'var(--amber)'
            : 'var(--blue)';

          const barW = Math.round((count / maxCount) * 10);

          return (
            <div key={key} style={{
              display: 'grid',
              gridTemplateColumns: '58px 1fr 22px',
              padding: '2px 10px',
              alignItems: 'center',
              gap: '6px',
            }}>
              <span style={{ color: 'var(--text-3)', fontSize: 'var(--sz-xs)', textAlign: 'right' }}>
                {label}
              </span>
              <div>
                <span className="score-bar" style={{ color: stageColor }}>
                  {'█'.repeat(barW)}
                </span>
                <span className="score-bar" style={{ color: 'var(--border)' }}>
                  {'█'.repeat(10 - barW)}
                </span>
                {risk > 0.4 && (
                  <span style={{ color: 'var(--amber)', fontSize: '7px', marginLeft: '3px' }}>⚠</span>
                )}
              </div>
              <span style={{ color: count > 0 ? stageColor : 'var(--text-4)', fontSize: 'var(--sz-sm)', textAlign: 'right', fontWeight: 700 }}>
                {count || '—'}
              </span>
            </div>
          );
        })}
      </div>

      {/* Summary metrics */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr',
        padding: '6px 10px', gap: '4px 8px',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <Metric label="PIPELINE" value={fmt$(totalValue)} color="var(--blue)" />
        <Metric label="WEIGHTED" value={fmt$(weightedValue)} color="var(--cyan)" />
        <Metric label="DEALS" value={String(stages.reduce((s, p) => s + Number(p.count ?? 0), 0))} color="var(--text-2)" />
        <Metric label="AT RISK" value={String(risks.filter(r => Number(r.risk_score) > 0.5).length)} color={risks.filter(r => Number(r.risk_score) > 0.5).length > 0 ? 'var(--red)' : 'var(--text-2)'} />
      </div>

      {/* At-risk deals */}
      {risks.length > 0 && (
        <>
          <div className="section-label" style={{ color: 'var(--red)' }}>AT RISK</div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {risks.map(d => <RiskRow key={d.id} deal={d} />)}
          </div>
        </>
      )}
      {risks.length === 0 && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: 'var(--text-4)', fontSize: 'var(--sz-xs)' }}>No deals at risk</span>
        </div>
      )}
    </div>
  );
}

function RiskRow({ deal: d }: { deal: DealRisk }) {
  const risk  = Number(d.risk_score ?? 0);
  const color = risk > 0.7 ? 'var(--red)' : risk > 0.5 ? 'var(--amber)' : 'var(--text-2)';
  const dtc   = d.expected_close_date
    ? Math.floor((new Date(d.expected_close_date).getTime() - Date.now()) / 86400000)
    : null;

  return (
    <div className="row">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="trunc" style={{ color: 'var(--text-1)', fontSize: 'var(--sz-sm)', maxWidth: '130px' }}>
          {d.name}
        </span>
        <span style={{ color, fontSize: 'var(--sz-sm)', fontWeight: 700 }}>
          {Math.round(risk * 100)}%
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
        <span style={{ color: 'var(--text-3)', fontSize: 'var(--sz-xs)' }}>
          {(d.stage ?? '').toUpperCase()} · {(d.category ?? 'RISK').toUpperCase()}
        </span>
        {dtc !== null && (
          <span style={{ color: dtc < 7 ? 'var(--red)' : 'var(--text-3)', fontSize: 'var(--sz-xs)' }}>
            {dtc < 0 ? `${Math.abs(dtc)}d PAST` : `${dtc}d`}
          </span>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div style={{ color: 'var(--text-4)', fontSize: '7px', letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ color, fontSize: 'var(--sz-sm)', fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function fmt$(cents: number): string {
  const d = cents / 100;
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(1)}M`;
  if (d >= 1_000)     return `$${(d / 1_000).toFixed(0)}K`;
  return `$${d.toFixed(0)}`;
}

const STAGE_PROB: Record<string, number> = {
  lead: 0.1, nurture: 0.2, active: 0.4, under_contract: 0.65,
  inspection: 0.7, appraisal: 0.75, financing: 0.8,
  clear_to_close: 0.9, closed_won: 1,
};
