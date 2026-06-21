/**
 * Pricing Table — Bloomberg Terminal Style
 *
 * Shows all 4 plans side-by-side with feature comparison.
 * Highlights Growth as the "full AI brain" — main conversion target.
 * Allows toggling between monthly/annual billing.
 */
import React, { useState, useEffect } from 'react';
import { api } from '../lib/api';

interface PlanData {
  id: string;
  name: string;
  tagline: string;
  monthly_price_usd: number;
  annual_price_usd: number;
  annual_savings_pct: number;
  feature_bullets: string[];
  feature_flags: Record<string, boolean>;
  highlighted: boolean;
  badge: string | null;
  color: string;
  limits: Record<string, string>;
}

interface Props {
  currentPlan?: string;
  onUpgrade?: (planId: string, period: 'monthly' | 'annual') => void;
  onClose?: () => void;
}

const FEATURE_GROUPS = [
  {
    label: 'AI INTELLIGENCE',
    features: [
      { key: 'ai_basic_scoring',      label: 'Contact AI Scoring' },
      { key: 'ai_predictions',         label: 'Prediction Engine (30/60/90d)' },
      { key: 'ai_opportunity_radar',   label: 'Opportunity Radar' },
      { key: 'ai_business_operator',   label: 'AI Business Operator' },
      { key: 'ai_intent_detection',    label: 'NLP Intent Detection' },
    ],
  },
  {
    label: 'DATA INGESTION',
    features: [
      { key: 'bulk_import',          label: 'CSV / Excel Import' },
      { key: 'crm_ingestion',        label: 'CRM Connectors (HubSpot, SF, FUB)' },
      { key: 'webhook_ingestion',    label: 'Inbound Webhooks' },
    ],
  },
  {
    label: 'AUTOMATION',
    features: [
      { key: 'automation_engine',    label: 'Email + SMS Campaigns' },
      { key: 'ai_message_generation',label: 'AI Message Generation' },
    ],
  },
  {
    label: 'ANALYTICS + REAL-TIME',
    features: [
      { key: 'real_time_stream',     label: 'Live Dashboard (SSE)' },
      { key: 'pipeline_analytics',   label: 'Pipeline Analytics' },
      { key: 'advanced_analytics',   label: 'Advanced Dashboards' },
      { key: 'revenue_forecasting',  label: 'Revenue Forecasting' },
    ],
  },
  {
    label: 'TEAM + ENTERPRISE',
    features: [
      { key: 'multi_user',           label: 'Multi-User Access' },
      { key: 'multi_team',           label: 'Teams + Team Management' },
      { key: 'priority_processing',  label: 'Priority Job Processing' },
      { key: 'rbac_custom_roles',    label: 'Custom RBAC Roles' },
      { key: 'audit_logs',           label: 'Full Audit Trail' },
      { key: 'enterprise_sso',       label: 'SSO / SAML' },
      { key: 'dedicated_support',    label: 'Dedicated Support + SLA' },
    ],
  },
];

const LIMIT_ROWS = [
  { key: 'contacts_total',      label: 'Contacts' },
  { key: 'imports_per_month',   label: 'Imports / month' },
  { key: 'predictions_per_day', label: 'AI predictions / day' },
  { key: 'team_members',        label: 'Team members' },
  { key: 'crm_connections',     label: 'CRM connections' },
  { key: 'api_calls_per_hour',  label: 'API calls / hour' },
];

export function PricingTable({ currentPlan, onUpgrade, onClose }: Props) {
  const [plans, setPlans] = useState<PlanData[]>([]);
  const [period, setPeriod] = useState<'monthly' | 'annual'>('monthly');
  const [loading, setLoading] = useState(true);
  const [upgrading, setUpgrading] = useState<string | null>(null);

  useEffect(() => {
    api.plans().then(r => {
      setPlans(r.data ?? []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const handleUpgrade = async (planId: string) => {
    if (upgrading) return;
    setUpgrading(planId);
    try {
      await onUpgrade?.(planId, period);
    } finally {
      setUpgrading(null);
    }
  };

  if (loading) {
    return (
      <div style={{ ...overlay, justifyContent: 'center', alignItems: 'center' }}>
        <span style={{ color: 'var(--green)', fontSize: '12px' }}>LOADING PLANS...</span>
      </div>
    );
  }

  return (
    <div style={overlay}>
      <div style={container}>
        {/* Header */}
        <div style={header}>
          <div>
            <div style={{ color: 'var(--green)', fontSize: '14px', fontWeight: 700, letterSpacing: '0.15em' }}>
              CLOVENT PRICING
            </div>
            <div style={{ color: 'var(--text-3)', fontSize: '10px', marginTop: '3px' }}>
              AI scales with your business — intelligence at every tier
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            {/* Period toggle */}
            <div style={{ display: 'flex', border: '1px solid var(--border-hi)', overflow: 'hidden' }}>
              {(['monthly', 'annual'] as const).map(p => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  style={{
                    background: period === p ? 'var(--green-dim)' : 'transparent',
                    border: 'none',
                    color: period === p ? 'var(--green)' : 'var(--text-3)',
                    padding: '4px 12px',
                    cursor: 'pointer',
                    fontSize: '10px',
                    fontWeight: period === p ? 700 : 400,
                    letterSpacing: '0.08em',
                  }}
                >
                  {p.toUpperCase()}
                  {p === 'annual' && <span style={{ color: 'var(--amber)', marginLeft: '4px' }}>-20%</span>}
                </button>
              ))}
            </div>

            {onClose && (
              <button onClick={onClose} style={{
                background: 'transparent', border: '1px solid var(--border-hi)',
                color: 'var(--text-3)', padding: '4px 10px', cursor: 'pointer',
                fontSize: '10px',
              }}>
                ✕ CLOSE
              </button>
            )}
          </div>
        </div>

        {/* Plan headers */}
        <div style={{ overflowX: 'auto', flex: 1 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '800px' }}>
            <thead>
              <tr>
                <th style={{ ...th, width: '200px', textAlign: 'left' }}>
                  <span style={{ color: 'var(--text-3)', fontSize: '9px' }}>FEATURE</span>
                </th>
                {plans.map(plan => (
                  <th key={plan.id} style={{
                    ...th,
                    background: plan.highlighted ? '#001800' : 'var(--bg-panel)',
                    borderTop: plan.highlighted ? `2px solid ${plan.color}` : '2px solid transparent',
                  }}>
                    <PlanHeader
                      plan={plan}
                      period={period}
                      isCurrent={currentPlan === plan.id}
                      isUpgrading={upgrading === plan.id}
                      onUpgrade={() => handleUpgrade(plan.id)}
                    />
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {/* Usage limits section */}
              <SectionRow label="USAGE LIMITS" colCount={plans.length} />
              {LIMIT_ROWS.map(row => (
                <tr key={row.key}>
                  <td style={featureCell}>{row.label}</td>
                  {plans.map(plan => (
                    <td key={plan.id} style={{
                      ...valueCell,
                      background: plan.highlighted ? '#001800' : 'transparent',
                    }}>
                      <span style={{ color: plan.limits[row.key] === 'Unlimited' ? plan.color : 'var(--text-2)', fontSize: '10px' }}>
                        {plan.limits[row.key]}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}

              {/* Feature group sections */}
              {FEATURE_GROUPS.map(group => (
                <React.Fragment key={group.label}>
                  <SectionRow label={group.label} colCount={plans.length} />
                  {group.features.map(feature => (
                    <tr key={feature.key}>
                      <td style={featureCell}>{feature.label}</td>
                      {plans.map(plan => (
                        <td key={plan.id} style={{
                          ...valueCell,
                          background: plan.highlighted ? '#001800' : 'transparent',
                        }}>
                          <FeatureMark
                            enabled={plan.feature_flags[feature.key] ?? false}
                            color={plan.color}
                            isHighlighted={plan.highlighted}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </React.Fragment>
              ))}

              {/* CTA row */}
              <tr>
                <td style={{ ...featureCell, borderTop: '2px solid var(--border-hi)', paddingTop: '12px' }} />
                {plans.map(plan => (
                  <td key={plan.id} style={{
                    ...valueCell,
                    background: plan.highlighted ? '#001800' : 'transparent',
                    borderTop: '2px solid var(--border-hi)',
                    paddingTop: '12px',
                  }}>
                    {currentPlan !== plan.id ? (
                      <button
                        onClick={() => handleUpgrade(plan.id)}
                        disabled={!!upgrading}
                        style={{
                          width: '100%',
                          background: plan.highlighted ? plan.color + '22' : 'transparent',
                          border: `1px solid ${plan.color}`,
                          color: plan.color,
                          padding: '6px 4px',
                          cursor: upgrading ? 'default' : 'pointer',
                          fontSize: '9px',
                          fontWeight: 700,
                          letterSpacing: '0.08em',
                          opacity: upgrading && upgrading !== plan.id ? 0.5 : 1,
                        }}
                      >
                        {upgrading === plan.id ? 'REDIRECTING...' : `SELECT ${plan.name.toUpperCase()}`}
                      </button>
                    ) : (
                      <div style={{ textAlign: 'center', color: 'var(--green)', fontSize: '9px', fontWeight: 700 }}>
                        ✓ CURRENT PLAN
                      </div>
                    )}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

        {/* Footer note */}
        <div style={{
          padding: '8px 16px', borderTop: '1px solid var(--border)',
          color: 'var(--text-4)', fontSize: '8px',
          display: 'flex', justifyContent: 'space-between',
        }}>
          <span>All plans include 14-day free trial · No credit card required to start · Cancel anytime</span>
          <span>Prices in USD · Annual billing saves 20%</span>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────
function PlanHeader({ plan, period, isCurrent, isUpgrading, onUpgrade }: {
  plan: PlanData;
  period: 'monthly' | 'annual';
  isCurrent: boolean;
  isUpgrading: boolean;
  onUpgrade: () => void;
}) {
  const price = period === 'monthly' ? plan.monthly_price_usd : plan.annual_price_usd;

  return (
    <div style={{ padding: '12px 8px', textAlign: 'center' }}>
      {plan.badge && (
        <div style={{
          fontSize: '7px', fontWeight: 700, letterSpacing: '0.12em',
          color: plan.color, border: `1px solid ${plan.color}`,
          padding: '1px 6px', display: 'inline-block', marginBottom: '6px',
        }}>
          {plan.badge}
        </div>
      )}

      <div style={{ color: plan.color, fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em' }}>
        {plan.name.toUpperCase()}
      </div>

      <div style={{ marginTop: '6px' }}>
        <span style={{ color: 'var(--text-1)', fontSize: '20px', fontWeight: 700 }}>
          ${price}
        </span>
        <span style={{ color: 'var(--text-3)', fontSize: '9px' }}>/mo</span>
      </div>

      {period === 'annual' && (
        <div style={{ color: 'var(--amber)', fontSize: '8px', marginTop: '2px' }}>
          billed ${price * 12}/yr
        </div>
      )}

      <div style={{ color: 'var(--text-3)', fontSize: '8px', marginTop: '6px', lineHeight: 1.4 }}>
        {plan.tagline}
      </div>

      {isCurrent && (
        <div style={{ color: 'var(--green)', fontSize: '8px', marginTop: '6px', fontWeight: 700 }}>
          ✓ YOUR PLAN
        </div>
      )}
    </div>
  );
}

function SectionRow({ label, colCount }: { label: string; colCount: number }) {
  return (
    <tr>
      <td colSpan={colCount + 1} style={{
        padding: '6px 12px 3px',
        color: 'var(--text-4)',
        fontSize: '8px',
        fontWeight: 700,
        letterSpacing: '0.12em',
        background: 'var(--bg)',
        borderTop: '1px solid var(--border)',
        borderBottom: '1px solid var(--border)',
      }}>
        {label}
      </td>
    </tr>
  );
}

function FeatureMark({ enabled, color, isHighlighted }: {
  enabled: boolean; color: string; isHighlighted: boolean;
}) {
  if (!enabled) {
    return <span style={{ color: 'var(--text-4)', fontSize: '10px' }}>—</span>;
  }
  return (
    <span style={{
      color,
      fontSize: '10px',
      fontWeight: 700,
      textShadow: isHighlighted ? `0 0 8px ${color}40` : 'none',
    }}>
      ✓
    </span>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000,
  background: 'rgba(0,0,0,0.85)',
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
  padding: '24px',
  overflowY: 'auto',
};

const container: React.CSSProperties = {
  width: '100%', maxWidth: '1100px',
  background: 'var(--bg)',
  border: '1px solid var(--border-hi)',
  display: 'flex', flexDirection: 'column',
  maxHeight: 'calc(100vh - 48px)',
};

const header: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '14px 16px',
  borderBottom: '1px solid var(--border)',
  flexShrink: 0,
};

const th: React.CSSProperties = {
  padding: '0', borderBottom: '1px solid var(--border)',
  borderLeft: '1px solid var(--border)',
  verticalAlign: 'top',
  width: '160px',
};

const featureCell: React.CSSProperties = {
  padding: '4px 12px',
  color: 'var(--text-2)',
  fontSize: '9px',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};

const valueCell: React.CSSProperties = {
  padding: '4px 8px',
  textAlign: 'center',
  borderBottom: '1px solid var(--border)',
  borderLeft: '1px solid var(--border)',
};
