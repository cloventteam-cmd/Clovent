import type { Contact } from '../../shared/types';
import { generateFollowUpMessage } from '../../ai/prompts/templates';

interface GenerateParams {
  template: string;
  contact: Contact;
  channel: 'email' | 'sms';
  context?: Record<string, unknown>;
}

export class MessageGenerator {
  generate(params: GenerateParams): string {
    const { template, contact, channel, context = {} } = params;

    // Merge variables
    const vars: Record<string, string> = {
      '{{first_name}}': contact.first_name ?? '',
      '{{last_name}}': contact.last_name ?? '',
      '{{full_name}}': `${contact.first_name} ${contact.last_name}`.trim(),
      '{{city}}': (contact as any).city ?? '',
      '{{state}}': (contact as any).state ?? '',
      ...Object.fromEntries(
        Object.entries(context).map(([k, v]) => [`{{${k}}}`, String(v ?? '')]),
      ),
    };

    let output = template;
    for (const [token, value] of Object.entries(vars)) {
      output = output.replaceAll(token, value);
    }

    // Apply channel-specific length limits
    if (channel === 'sms' && output.length > 160) {
      output = output.slice(0, 157) + '...';
    }

    // If no template or empty after substitution, generate a default
    if (!output.trim()) {
      output = generateFollowUpMessage(contact, 90, 'dormant');
    }

    return output;
  }
}
