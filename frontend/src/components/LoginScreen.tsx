import React, { useState, useEffect } from 'react';
import { api, setToken } from '../lib/api';

interface Props { onLogin: (user: Record<string, unknown>, org: Record<string, unknown>) => void }

export function LoginScreen({ onLogin }: Props) {
  const [form, setForm] = useState({ slug: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  // Blinking cursor effect
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 530);
    return () => clearInterval(t);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await api.login(form.slug, form.email, form.password);
      setToken(res.data.access_token);
      const me = await api.me();
      onLogin(me.data.user, me.data.organization);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const cursor = tick % 2 === 0 ? '█' : ' ';

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--bg)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '24px',
    }}>
      {/* ASCII logo */}
      <pre style={{
        color: 'var(--green)', fontSize: '11px', lineHeight: '1.3',
        letterSpacing: '0.05em', marginBottom: '32px', textAlign: 'center',
        fontFamily: 'var(--font)',
      }}>
{`  ██████╗██╗      ██████╗ ██╗   ██╗███████╗███╗   ██╗████████╗
 ██╔════╝██║     ██╔═══██╗██║   ██║██╔════╝████╗  ██║╚══██╔══╝
 ██║     ██║     ██║   ██║██║   ██║█████╗  ██╔██╗ ██║   ██║
 ██║     ██║     ██║   ██║╚██╗ ██╔╝██╔══╝  ██║╚██╗██║   ██║
 ╚██████╗███████╗╚██████╔╝ ╚████╔╝ ███████╗██║ ╚████║   ██║
  ╚═════╝╚══════╝ ╚═════╝   ╚═══╝  ╚══════╝╚═╝  ╚═══╝   ╚═╝`}
      </pre>

      <div style={{ color: 'var(--text-3)', fontSize: 'var(--sz-xs)', letterSpacing: '0.2em', marginBottom: '40px' }}>
        AI REAL ESTATE OPERATING SYSTEM — v1.0
      </div>

      {/* Login form */}
      <form onSubmit={submit} style={{
        width: '360px',
        background: 'var(--bg-panel)',
        border: '1px solid var(--border-hi)',
        padding: '24px',
      }}>
        <div style={{
          color: 'var(--green)', fontSize: 'var(--sz-xs)',
          letterSpacing: '0.15em', marginBottom: '20px',
          display: 'flex', alignItems: 'center', gap: '6px',
        }}>
          <span className="live-dot">●</span> TERMINAL LOGIN {cursor}
        </div>

        {(['slug', 'email', 'password'] as const).map(field => (
          <div key={field} style={{ marginBottom: '14px' }}>
            <label style={{
              display: 'block', color: 'var(--text-3)',
              fontSize: '8px', letterSpacing: '0.12em', marginBottom: '4px',
            }}>
              {field === 'slug' ? 'ORGANIZATION SLUG' : field.toUpperCase()}
            </label>
            <input
              type={field === 'password' ? 'password' : 'text'}
              value={form[field]}
              onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
              required
              placeholder={field === 'slug' ? 'my-org' : field === 'email' ? 'user@org.com' : '••••••••'}
              style={{
                width: '100%', display: 'block',
                background: 'var(--bg)', border: '1px solid var(--border-hi)',
                color: 'var(--text-1)', fontSize: 'var(--sz-md)',
                padding: '7px 8px',
              }}
              onFocus={e => (e.target.style.borderColor = 'var(--green)')}
              onBlur={e => (e.target.style.borderColor = 'var(--border-hi)')}
            />
          </div>
        ))}

        {error && (
          <div style={{ color: 'var(--red)', fontSize: 'var(--sz-xs)', marginBottom: '12px' }}>
            ⚠ {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            width: '100%',
            background: loading ? 'var(--bg)' : 'var(--green-dim)',
            border: `1px solid ${loading ? 'var(--border-hi)' : 'var(--green)'}`,
            color: loading ? 'var(--text-3)' : 'var(--green)',
            padding: '9px', cursor: loading ? 'default' : 'pointer',
            fontSize: 'var(--sz-sm)', fontWeight: 700,
            letterSpacing: '0.15em',
          }}
        >
          {loading ? 'AUTHENTICATING...' : `→ CONNECT TO SYSTEM ${cursor}`}
        </button>
      </form>

      <div style={{ marginTop: '24px', color: 'var(--text-4)', fontSize: '8px', letterSpacing: '0.1em' }}>
        REAL-TIME INTELLIGENCE · SSE STREAM · TENANT ISOLATED
      </div>
    </div>
  );
}
