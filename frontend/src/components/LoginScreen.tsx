import React, { useState } from 'react';
import { api, setToken } from '../lib/api';

interface Props {
  onLogin: (user: Record<string, unknown>, org: Record<string, unknown>) => void;
  onDemo: () => void;
}

type Mode = 'login' | 'signup';

export function LoginScreen({ onLogin, onDemo }: Props) {
  const [mode, setMode] = useState<Mode>('login');
  const [form, setForm] = useState({ org_name: '', first_name: '', last_name: '', slug: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      if (mode === 'signup') {
        const res = await api.register({ org_name: form.org_name, first_name: form.first_name, last_name: form.last_name, email: form.email, password: form.password });
        setToken(res.data.access_token);
      } else {
        const res = await api.login(form.slug, form.email, form.password);
        setToken(res.data.access_token);
      }
      const me = await api.me();
      onLogin(me.data.user, me.data.organization);
    } catch (err) {
      setToken(null);
      setError((err as Error).message || 'Could not connect. Try again.');
    } finally {
      setLoading(false);
    }
  };

  const update = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [field]: e.target.value }));

  return <main className="auth-screen">
    <div className="auth-glow auth-glow-one" /><div className="auth-glow auth-glow-two" />
    <div className="auth-layout">
      <section className="auth-brand-side">
        <div className="brand auth-brand"><span className="brand-mark">C</span><span>clovent</span></div>
        <div className="auth-pitch"><span className="auth-kicker">AI REAL ESTATE OPERATING SYSTEM</span><h1>See the full picture.<br/><em>Make your next move.</em></h1><p>Deals, relationships, and decisions connected in one workspace built for your business.</p><div className="auth-preview-card"><div className="preview-orb"><span /></div><div><strong>Your business, in motion</strong><small>Pipeline · relationships · intelligence</small></div><span className="preview-pulse" /></div></div>
        <div className="auth-footnote">PRIVATE WORKSPACE · BUILT FOR REAL ESTATE</div>
      </section>
      <section className="auth-form-side"><div className="auth-form-wrap">
        <div className="auth-mobile-brand brand"><span className="brand-mark">C</span><span>clovent</span></div>
        <div className="auth-form-heading"><span className="auth-kicker">{mode === 'login' ? 'WELCOME BACK' : 'GET STARTED'}</span><h2>{mode === 'login' ? 'Sign in to Clovent' : 'Create your workspace'}</h2><p>{mode === 'login' ? 'Pick up where your business left off.' : 'Your private real estate command center starts here.'}</p></div>
        <form className="auth-form" onSubmit={submit}>
          {mode === 'signup' ? <>
            <div className="form-two"><label>First name<input autoComplete="given-name" value={form.first_name} onChange={update('first_name')} required placeholder="Alex" /></label><label>Last name<input autoComplete="family-name" value={form.last_name} onChange={update('last_name')} required placeholder="Sanchez" /></label></div>
            <label>Workspace name<input autoComplete="organization" value={form.org_name} onChange={update('org_name')} required minLength={2} placeholder="Sanchez Real Estate" /></label>
          </> : <label>Workspace slug<input autoComplete="organization" value={form.slug} onChange={update('slug')} required placeholder="your-workspace" /><small>Use the workspace slug created when your account was set up.</small></label>}
          <label>Email address<input type="email" autoComplete="email" value={form.email} onChange={update('email')} required placeholder="you@example.com" /></label>
          <label>Password<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'signup' ? 8 : undefined} value={form.password} onChange={update('password')} required placeholder={mode === 'signup' ? 'At least 8 characters' : 'Enter your password'} /></label>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <button className="auth-submit" disabled={loading}>{loading ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}<span>→</span></button>
        </form>
        <div className="auth-switch">{mode === 'login' ? <>New to Clovent? <button onClick={() => { setMode('signup'); setError(''); }}>Create an account</button></> : <>Already have a workspace? <button onClick={() => { setMode('login'); setError(''); }}>Sign in</button></>}</div>
        <button className="auth-demo-link" onClick={onDemo}><span>✦</span> Explore the demo workspace</button>
        <div className="auth-security"><span>⌑</span> Your workspace is private and secure</div>
      </div></section>
    </div>
  </main>;
}
