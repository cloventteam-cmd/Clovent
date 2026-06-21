import { normalizePhone, normalizeEmail } from '../shared/utils';

export class Normalizer {
  normalize(raw: Record<string, unknown>): Record<string, unknown> & {
    first_name: string;
    last_name: string;
    email?: string;
    phone?: string;
    external_id?: string;
  } {
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(raw)) {
      if (value === null || value === undefined || value === '') continue;
      out[key] = typeof value === 'string' ? value.trim() : value;
    }

    // Normalize name
    if (out.name && !out.first_name) {
      const parts = String(out.name).trim().split(/\s+/);
      out.first_name = parts[0] ?? '';
      out.last_name = parts.slice(1).join(' ') ?? '';
    }
    out.first_name = String(out.first_name ?? '').trim();
    out.last_name = String(out.last_name ?? '').trim();

    // Normalize email
    if (out.email) {
      out.email = normalizeEmail(String(out.email)) ?? undefined;
      if (!out.email) delete out.email;
    }

    // Normalize phone
    if (out.phone) {
      out.phone = normalizePhone(String(out.phone)) ?? undefined;
      if (!out.phone) delete out.phone;
    }
    if (out.phone_alt) {
      out.phone_alt = normalizePhone(String(out.phone_alt)) ?? undefined;
      if (!out.phone_alt) delete out.phone_alt;
    }

    // Normalize contact type
    if (out.type) {
      const typeMap: Record<string, string> = {
        buyer: 'lead',
        seller: 'lead',
        renter: 'lead',
        investor: 'investor',
        client: 'client',
        'past client': 'past_client',
        vendor: 'vendor',
        referral: 'referral_partner',
      };
      out.type = typeMap[String(out.type).toLowerCase()] ?? 'lead';
    }

    // Parse tags from comma-separated string
    if (typeof out.tags === 'string') {
      out.tags = out.tags.split(',').map((t: string) => t.trim()).filter(Boolean);
    }

    return out as any;
  }
}
