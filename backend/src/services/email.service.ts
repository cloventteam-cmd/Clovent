/**
 * Email Service
 *
 * Sends transactional emails via Resend (primary) or logs to console (mock).
 * Every email is stored in the messages table regardless of provider.
 */
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { query } from '../db/client';

export interface EmailPayload {
  to: string;
  from?: string;
  subject: string;
  html: string;
  text?: string;
  tenant_id: string;
  contact_id?: string;
  metadata?: Record<string, unknown>;
}

export interface EmailResult {
  success: boolean;
  message_id?: string;
  error?: string;
  provider: string;
}

// ─── Resend provider ──────────────────────────────────────────────────────────
async function sendViaResend(payload: EmailPayload): Promise<EmailResult> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.email.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: payload.from ?? config.email.from,
      to: [payload.to],
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend error ${response.status}: ${body}`);
  }

  const data = await response.json() as { id: string };
  return { success: true, message_id: data.id, provider: 'resend' };
}

// ─── Mock provider (dev / no API key) ─────────────────────────────────────────
function sendViaMock(payload: EmailPayload): EmailResult {
  logger.info(
    {
      to: payload.to,
      subject: payload.subject,
      preview: payload.text?.slice(0, 80) ?? payload.html.replace(/<[^>]+>/g, '').slice(0, 80),
    },
    '[EMAIL MOCK] Would send email',
  );
  return { success: true, message_id: `mock-${Date.now()}`, provider: 'mock' };
}

// ─── Main send function ───────────────────────────────────────────────────────
export async function sendEmail(payload: EmailPayload): Promise<EmailResult> {
  let result: EmailResult;

  try {
    if (config.email.provider === 'resend' && config.email.apiKey) {
      result = await sendViaResend(payload);
    } else {
      result = sendViaMock(payload);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, to: payload.to, subject: payload.subject }, 'Email send failed');
    result = { success: false, error: message, provider: config.email.provider };
  }

  // Persist to messages table for audit trail
  await query(
    `INSERT INTO messages (
      tenant_id, contact_id, channel, direction, subject, body, html_body,
      status, external_id, metadata, sent_at
    ) VALUES ($1,$2,'email','outbound',$3,$4,$5,$6,$7,$8,NOW())`,
    [
      payload.tenant_id,
      payload.contact_id ?? null,
      payload.subject,
      payload.text ?? null,
      payload.html,
      result.success ? 'sent' : 'failed',
      result.message_id ?? null,
      JSON.stringify(payload.metadata ?? {}),
    ],
  ).catch((dbErr) => {
    logger.warn({ dbErr }, 'Failed to persist email to messages table');
  });

  return result;
}

// ─── Notification email templates ─────────────────────────────────────────────
export function buildNotificationEmail(params: {
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  tenant_name?: string;
}): { subject: string; html: string; text: string } {
  const { type, title, body, data, tenant_name = 'CLOVENT' } = params;

  const iconMap: Record<string, string> = {
    hot_lead: '🔥',
    deal_risk: '⚠️',
    opportunity: '💡',
    import_complete: '✅',
    daily_summary: '📋',
    task_due: '⏰',
  };
  const icon = iconMap[type] ?? '🔔';

  const dataLines = Object.entries(data)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `<tr><td style="color:#666;padding:4px 8px;">${k}:</td><td style="padding:4px 8px;font-weight:bold;">${v}</td></tr>`)
    .join('');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:20px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1)">
    <div style="background:#1a1a2e;padding:20px 24px">
      <span style="color:#fff;font-size:18px;font-weight:700">${tenant_name}</span>
    </div>
    <div style="padding:24px">
      <div style="font-size:28px;margin-bottom:8px">${icon}</div>
      <h2 style="margin:0 0 8px;color:#1a1a2e;font-size:20px">${title}</h2>
      <p style="margin:0 0 16px;color:#444;line-height:1.5">${body}</p>
      ${dataLines ? `<table style="border-collapse:collapse;width:100%;background:#f9f9f9;border-radius:6px">${dataLines}</table>` : ''}
    </div>
    <div style="background:#f9f9f9;padding:12px 24px;border-top:1px solid #eee">
      <p style="margin:0;color:#999;font-size:12px">CLOVENT AI Real Estate OS · <a href="#" style="color:#999">Unsubscribe</a></p>
    </div>
  </div>
</body>
</html>`.trim();

  const text = `${icon} ${title}\n\n${body}\n\n${Object.entries(data).filter(([,v]) => typeof v !== 'object').map(([k,v]) => `${k}: ${v}`).join('\n')}`;

  return { subject: `${icon} ${title}`, html, text };
}
