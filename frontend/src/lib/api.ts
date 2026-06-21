import type { AiBriefing } from '../types';

const BASE = '/api';

let _token: string | null = localStorage.getItem('clovent_token');

export function setToken(t: string | null): void {
  _token = t;
  t ? localStorage.setItem('clovent_token', t) : localStorage.removeItem('clovent_token');
}
export function getToken(): string | null { return _token; }

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(_token ? { Authorization: `Bearer ${_token}` } : {}),
      ...opts.headers,
    },
  });
  if (res.status === 401) { setToken(null); window.location.reload(); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const api = {
  login: (slug: string, email: string, password: string) =>
    req<any>('/auth/login', { method: 'POST', body: JSON.stringify({ slug, email, password }) }),

  me: () => req<any>('/auth/me'),

  contacts: (qs = '') => req<any>(`/contacts?per_page=25${qs ? '&' + qs : ''}`),

  pipeline: () => req<any>('/deals/pipeline'),

  dealsAtRisk: (min = 0.35) => req<any>(`/deals/at-risk?min_risk=${min}&per_page=10`),

  opportunities: (page = 1) => req<any>(`/opportunities?page=${page}&per_page=25`),

  plans: () => req<{ success: boolean; data: any[] }>('/billing/plans'),

  subscription: () => req<any>('/billing/subscription'),

  billingUsage: () => req<any>('/billing/usage'),

  checkout: (plan_id: string, billing_period: string) =>
    req<any>('/billing/checkout', {
      method: 'POST',
      body: JSON.stringify({ plan_id, billing_period }),
    }),

  briefing: (): Promise<{ success: boolean; data: AiBriefing }> =>
    req<{ success: boolean; data: AiBriefing }>('/ai/briefing'),

  streamStats: () => req<any>('/stream/stats'),

  health: (): Promise<any> => fetch('/health/metrics').then(r => r.json()),

  recentActivities: (since?: string) =>
    req<any>(`/activities${since ? '?since=' + since : ''}`),
};
