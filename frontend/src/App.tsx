import React, { useEffect, useState } from 'react';
import { LoginScreen } from './components/LoginScreen';
import { api, getToken, setToken } from './lib/api';
import type { DealRisk, PipelineStage } from './types';

type Page = 'Overview' | 'Deals' | 'Relationships' | 'Finances' | 'Calendar' | 'AI operator' | 'Opportunity radar' | 'Integrations' | 'Documents' | 'Settings';
type User = Record<string, unknown>;
type Org = Record<string, unknown>;
type Deal = Record<string, any>;

const demoDeals: Deal[] = [
  { id: 'd1', name: '482 Oakridge Drive', city: 'Modesto, CA', stage: 'Under contract', price: 685000, commission_rate: 0.025, expected_close_date: 'Apr 18, 2025', activity: 'Inspection scheduled', photo: 1 },
  { id: 'd2', name: '126 Magnolia Avenue', city: 'San Diego, CA', stage: 'Closing', price: 520000, commission_rate: 0.025, expected_close_date: 'Apr 30, 2025', activity: 'Final docs received', photo: 2 },
  { id: 'd3', name: '18 Willow Creek Lane', city: 'Modesto, CA', stage: 'In negotiation', price: 742000, commission_rate: 0.025, expected_close_date: 'May 12, 2025', activity: 'Offer countered', photo: 3 },
];
const demoMonths = [7, 11, 16, 22, 19, 29];
const navGroups: { title: string; items: Page[] }[] = [
  { title: 'Workspace', items: ['Overview', 'Deals', 'Relationships', 'Finances', 'Calendar'] },
  { title: 'Intelligence', items: ['AI operator', 'Opportunity radar'] },
  { title: 'Manage', items: ['Integrations', 'Documents', 'Settings'] },
];

export default function App() {
  const [auth, setAuth] = useState<{ user: User | null; org: Org | null }>({ user: null, org: null });
  const [booting, setBooting] = useState(true);
  const [demo, setDemo] = useState(false);
  const [page, setPage] = useState<Page>('Overview');
  const [query, setQuery] = useState('');
  const [deals, setDeals] = useState<Deal[]>([]);
  const [pipeline, setPipeline] = useState<PipelineStage[]>([]);
  const [risks, setRisks] = useState<DealRisk[]>([]);
  const [briefing, setBriefing] = useState<any>(null);
  const [loadingData, setLoadingData] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token) { setBooting(false); return; }
    api.me().then(r => setAuth({ user: r.data.user, org: r.data.organization }))
      .catch(() => setToken(null)).finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    if (!auth.user || demo) return;
    let cancelled = false;
    setLoadingData(true);
    Promise.allSettled([api.deals(), api.pipeline(), api.dealsAtRisk(), api.briefing()]).then(([d, p, r, b]) => {
      if (cancelled) return;
      if (d.status === 'fulfilled') setDeals(d.value.data ?? []);
      if (p.status === 'fulfilled') setPipeline(p.value.data ?? []);
      if (r.status === 'fulfilled') setRisks(r.value.data ?? []);
      if (b.status === 'fulfilled') setBriefing(b.value.data ?? null);
      setLoadingData(false);
    });
    return () => { cancelled = true; };
  }, [auth.user, demo]);

  if (booting) return <div className="boot-screen"><span className="boot-mark">C</span><span>Opening your Clovent workspace…</span></div>;
  if (!auth.user && !demo) return <LoginScreen onLogin={(user, org) => { setAuth({ user, org }); setDemo(false); }} onDemo={() => setDemo(true)} />;

  const shownDeals = demo ? demoDeals : deals;
  const filteredDeals = shownDeals.filter(d => `${d.name ?? ''} ${d.city ?? ''} ${d.stage ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const totalValue = demo ? 48_250 : shownDeals.reduce((sum, d) => sum + Number(d.price ?? 0) * Number(d.commission_rate ?? 0), 0);
  const activeCount = demo ? 8 : shownDeals.filter(d => !['closed_won', 'closed_lost', 'withdrawn'].includes(String(d.stage))).length;
  const taxReserve = demo ? 8_220 : Math.round(totalValue * 0.17);
  const forecast = demo ? 92_450 : Math.round(totalValue * 1.9);
  const firstName = String(auth.user?.first_name ?? 'Alex');
  const orgName = String(auth.org?.name ?? 'Your workspace');
  const activeAction = demo ? { title: 'Oakridge inspection due Friday', description: 'The home inspection is scheduled in 3 days. Review the checklist and confirm with your client.' } : briefing?.top_actions?.[0];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">C</span><span>clovent</span></div>
        <div className="side-scroll">
          {navGroups.map(group => <section className="nav-group" key={group.title}>
            <p className="nav-heading">{group.title}</p>
            {group.items.map(item => <button key={item} className={`nav-item ${page === item ? 'active' : ''}`} onClick={() => setPage(item)}>
              <NavIcon name={item} /><span>{item}</span>
            </button>)}
          </section>)}
        </div>
        <button className="nav-item more-button" onClick={() => setPage('Settings')}><span className="more-dots">•••</span><span>More</span><span className="more-chevron">›</span></button>
        <div className="sidebar-footer"><span className="online-dot" /> Workspace secured <span className="footer-lock">⌑</span></div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <label className="search-box"><SearchIcon /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search deals, contacts, properties…" /></label>
          <div className="top-actions">
            <button className={`demo-switch ${demo ? 'is-demo' : ''}`} onClick={() => setDemo(v => !v)}><DatabaseIcon />{demo ? 'Demo data on' : 'Demo data'}</button>
            <button className="icon-button notification" aria-label="Notifications"><BellIcon /><i /></button>
            <button className="profile-button" onClick={() => { if (demo) { setDemo(false); return; } setToken(null); setAuth({ user: null, org: null }); setPage('Overview'); }} aria-label={demo ? 'Exit demo' : 'Sign out'}>
              <span className="avatar">{firstName.slice(0, 1).toUpperCase()}</span><span className="profile-caret">⌄</span>
            </button>
          </div>
        </header>

        {page === 'Overview' ? <section className="dashboard-content">
          <div className="hero-card">
            <div className="hero-photo" />
            <div className="hero-shade" />
            <div className="hero-copy"><div className="hero-eyebrow">{demo ? 'DEMO WORKSPACE' : orgName}</div><h1>Good evening, <em>{firstName}.</em></h1><p>Your business is ready for its next move.</p><span className="hero-date">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span></div>
            <div className="weather"><span className="weather-location">{demo ? 'Modesto, CA' : String((auth.org?.settings as any)?.city ?? 'Your market')}</span><div className="weather-temp"><span className="weather-symbol">☾</span><strong>68°</strong><small>°F</small></div><span className="weather-copy">Partly cloudy</span><span className="weather-low">Tomorrow 74° / 52°</span><button className="weather-customize" onClick={() => setPage('Settings')}>▧ &nbsp;Customize background</button></div>
          </div>

          {demo && <div className="demo-banner"><span><strong>Demo workspace</strong> · Sample records are shown. Sign up to create your private workspace.</span><button onClick={() => setDemo(false)}>Create account <span>→</span></button></div>}

          <div className="metric-grid">
            <MetricCard icon="$" label="Expected commission" value={money(totalValue)} trend={demo ? '12%' : '—'} detail={demo ? 'vs. last month' : 'from active deals'} color="cyan" bars={[9, 14, 12, 18, 23, 30]} />
            <MetricCard icon="▤" label="Active deals" value={String(activeCount)} trend={demo ? '2' : '—'} detail={demo ? 'vs. last month' : loadingData ? 'Loading…' : 'in your pipeline'} color="slate" bars={[8, 13, 11, 17, 21, 27]} />
            <MetricCard icon="◉" label="Tax reserve" value={money(taxReserve)} trend={demo ? '8%' : '—'} detail={demo ? 'vs. last month' : 'estimated reserve'} color="slate" bars={[7, 11, 13, 16, 20, 25]} />
          </div>

          <div className="overview-grid">
            <section className="panel forecast-panel">
              <div className="panel-title-row"><div><h2><span className="title-bars">▮</span> Income forecast</h2><div className="forecast-number">{money(forecast)} <span>Total projected commission</span></div></div><button className="select-pill" onClick={() => setPage('Finances')}>Next 6 months <span>⌄</span></button></div>
              <ForecastChart values={demo ? demoMonths : liveChart(shownDeals, pipeline)} /></section>
            <section className="panel action-panel"><div className="action-heading"><div className="orb"><span /></div><div><h2>Your next best move</h2><p>Based on your deals and upcoming deadlines</p></div></div>
              {activeAction ? <div className="action-card"><span className="action-icon">▦</span><div><h3>{activeAction.title}</h3><p>{activeAction.description}</p></div><span className="action-arrow">›</span></div> : <div className="action-empty"><span className="action-icon">✦</span><div><h3>{loadingData ? 'Finding your next move…' : 'Your next best move will appear here'}</h3><p>{loadingData ? 'Reviewing your pipeline and deadlines.' : 'Add deals and activity to get personalized guidance.'}</p></div></div>}
              <div className="action-buttons"><button className="primary-button" onClick={() => setPage('Deals')}>Review deal <span>→</span></button><button className="secondary-button" onClick={() => setPage('AI operator')}>See all actions</button></div>
            </section>
          </div>

          <section className="panel deals-panel"><div className="deals-header"><h2><span className="list-icon">☷</span> Deals in motion</h2><button onClick={() => setPage('Deals')}>View all deals <span>→</span></button></div>
            <div className="deal-table-wrap"><table><thead><tr><th>Property</th><th>Stage</th><th>Est. commission</th><th>Close date</th><th>Last activity</th><th /></tr></thead><tbody>
              {filteredDeals.length ? filteredDeals.slice(0, 4).map((deal, i) => {
                const commission = Number(deal.price ?? 0) * Number(deal.commission_rate ?? 0);
                return <tr key={deal.id ?? i}><td><div className="property-cell"><div className={`property-thumb house-${i % 3}`}><span>⌂</span></div><div><strong>{deal.name ?? 'Untitled deal'}</strong><small>{deal.city ?? 'Property location'}</small></div></div></td><td><span className={`stage-pill stage-${String(deal.stage ?? '').toLowerCase().replace(/[^a-z]/g, '')}`}>{prettyStage(deal.stage)}</span></td><td className="amount-cell">{commission ? money(commission) : '—'}</td><td>{formatDate(deal.expected_close_date)}</td><td><span className="activity-primary">{demo ? (i === 0 ? '2h ago' : '1d ago') : 'Recently updated'}</span><small className="activity-secondary">{demo ? (deal.activity ?? '') : 'Latest deal activity'}</small></td><td><button className="row-more" aria-label="Deal options">•••</button></td></tr>;
              }) : <tr><td colSpan={6} className="empty-deals">{loadingData ? 'Loading your deals…' : 'No deals yet. Add your first deal to start your pipeline.'}</td></tr>}
            </tbody></table></div>
          </section>
          <footer className="dashboard-footer"><span><i className="online-dot" /> {demo ? 'DEMO MODE' : 'CONNECTED'} · PRIVATE WORKSPACE</span><span>{orgName} · {auth.user?.email as string ?? ''}</span></footer>
        </section> : <SectionPage page={page} demo={demo} deals={shownDeals} risks={risks} onBack={() => setPage('Overview')} />}
      </main>
      <button className="ask-clovent" onClick={() => setPage('AI operator')}><span className="ask-sparkle">✦</span><span>Ask Clovent anything…</span><span className="send-circle">↑</span></button>
    </div>
  );
}

function MetricCard({ icon, label, value, trend, detail, color, bars }: { icon: string; label: string; value: string; trend: string; detail: string; color: string; bars: number[] }) {
  return <section className="metric-card"><div className={`metric-icon ${color}`}>{icon}</div><div className="metric-text"><span>{label}</span><strong>{value}</strong><small><i>↑</i> {trend} &nbsp; <span>{detail}</span></small></div><div className="mini-bars">{bars.map((b, i) => <i key={i} style={{ height: `${b}px` }} />)}</div></section>;
}

function ForecastChart({ values }: { values: number[] }) {
  const points = values.length ? values : [0, 0, 0, 0, 0, 0];
  const max = Math.max(1, ...points);
  const coords = points.map((v, i) => `${40 + i * 132},${134 - (v / max) * 112}`).join(' ');
  return <div className="chart-wrap"><div className="chart-y"><span>{moneyShort(max)}</span><span>{moneyShort(max * .66)}</span><span>{moneyShort(max * .33)}</span><span>$0</span></div><svg className="chart-svg" viewBox="0 0 700 165" preserveAspectRatio="none" role="img" aria-label="Income forecast chart"><defs><linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#17d8f4" stopOpacity=".36"/><stop offset="1" stopColor="#17d8f4" stopOpacity=".02"/></linearGradient></defs>{[22,60,98,136].map(y => <line key={y} x1="40" x2="700" y1={y} y2={y} className="chart-grid"/>)}{points.map((_,i)=><line key={i} x1={40+i*132} x2={40+i*132} y1="22" y2="136" className="chart-grid vertical"/>)}<polygon points={`40,136 ${coords} 700,136`} fill="url(#chartFill)"/><polyline points={coords} fill="none" className="chart-line"/>{points.map((v,i)=><circle key={i} cx={40+i*132} cy={134-(v/max)*112} r="4.5" className="chart-dot"/>)}</svg><div className="chart-x">{['Nov','Dec','Jan','Feb','Mar','Apr'].map(m=><span key={m}>{m}</span>)}</div></div>;
}

function SectionPage({ page, demo, deals, risks, onBack }: { page: Page; demo: boolean; deals: Deal[]; risks: DealRisk[]; onBack: () => void }) {
  const subtitle: Record<Page, string> = { Overview: '', Deals: 'Track every opportunity from first contact through closing.', Relationships: 'Keep client conversations, follow-ups, and referrals in one place.', Finances: 'Monitor projected commission, expenses, and tax reserves.', Calendar: 'Keep upcoming closings and client deadlines in view.', 'AI operator': 'A practical daily brief based on your pipeline and deadlines.', 'Opportunity radar': 'Find the next opportunity in your contact and deal activity.', Integrations: 'Connect the tools you already use.', Documents: 'Keep transaction files organized with each deal.', Settings: 'Manage your workspace and preferences.' };
  const entries = page === 'Deals' ? (demo ? demoDeals : deals) : page === 'AI operator' || page === 'Opportunity radar' ? risks : [];
  return <section className="section-page"><div className="section-topline"><span>{demo ? 'DEMO WORKSPACE' : 'CLOVENT WORKSPACE'} / {page.toUpperCase()}</span><button onClick={onBack}>← Overview</button></div><h1>{page}</h1><p>{subtitle[page]}</p><div className="section-content">
    {entries.length ? entries.map((entry:any, i:number)=><article key={entry.id ?? i} className="section-row"><div><strong>{entry.name ?? entry.title ?? 'Opportunity'}</strong><small>{entry.stage ?? entry.description ?? 'Review this item in your workspace.'}</small></div><span>{entry.price ? money(entry.price * (entry.commission_rate ?? 0)) : entry.score ? `${Math.round(entry.score)} score` : 'Open'}</span></article>) : <div className="section-empty"><div className="empty-symbol">{page === 'Calendar' ? '▦' : page === 'Finances' ? '$' : '✦'}</div><h2>{page === 'Integrations' ? 'Connect your first tool' : page === 'Documents' ? 'Your deal files will live here' : `${page} is ready for your workspace`}</h2><p>{demo ? 'Explore the dashboard with sample records, or create an account to start your own workspace.' : 'Your Clovent workspace will fill in as you add your contacts, deals, and activity.'}</p><button className="primary-button" onClick={onBack}>Back to overview</button></div>}
  </div></section>;
}

function NavIcon({ name }: { name: string }) {
  const icons: Record<Page, string> = { Overview: '⌂', Deals: '▤', Relationships: '♧', Finances: '▥', Calendar: '▦', 'AI operator': '✦', 'Opportunity radar': '◎', Integrations: '⏣', Documents: '▤', Settings: '⚙' };
  return <span className={`nav-icon nav-${name.toLowerCase().replace(/ /g, '-')}`}>{icons[name as Page]}</span>;
}
function money(n: number) { return `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`; }
function moneyShort(n: number) { return n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n)}`; }
function prettyStage(s: unknown) { return String(s ?? 'New lead').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()); }
function formatDate(s: unknown) { if (!s) return '—'; const d = new Date(String(s)); return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
function liveChart(deals: Deal[], pipeline: PipelineStage[]) { const base = deals.reduce((sum,d)=>sum+Number(d.price??0)*Number(d.commission_rate??0),0) || pipeline.reduce((sum,s)=>sum+Number(s.value??0),0); return base ? [0.35,0.48,0.52,0.7,0.62,1].map(v=>Math.round(base*v)) : [0,0,0,0,0,0]; }
function SearchIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></svg>; }
function BellIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>; }
function DatabaseIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>; }
