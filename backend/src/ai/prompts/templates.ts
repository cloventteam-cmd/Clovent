import type { Contact, Deal, DailyBriefing } from '../../shared/types';

// ─── Prompt Template Engine ───────────────────────────────────────────────────
// All prompts work with or without an external LLM.
// When AI_PROVIDER=local, these are used to generate rule-based text.
// When AI_PROVIDER=openai/anthropic, these are passed to the API.

export const PromptTemplates = {
  contactFollowUp: (contact: Contact, context: string): string => `
You are a real estate agent's AI assistant. Write a brief, warm follow-up message.

Contact: ${contact.first_name} ${contact.last_name}
Context from history: ${context}
Contact type: ${contact.type}

Requirements:
- 2-3 sentences max
- Personal and specific to their situation
- No pressure, value-first
- End with an open-ended question
`.trim(),

  sellerOutreach: (contact: Contact, daysSince: number): string => `
Write a reconnection message for a past contact who may be ready to sell.

Contact: ${contact.first_name}
Days since last contact: ${daysSince}
Last known interest: ${contact.type}

Keep it brief, mention market conditions generally, offer value.
`.trim(),

  dealRiskSummary: (deal: Deal, risks: string[]): string => `
Summarize the key risks for this real estate transaction in 2-3 sentences.

Deal: ${deal.name}
Stage: ${deal.stage}
Price: $${((deal.price ?? 0) / 100).toLocaleString()}
Risks identified: ${risks.join(', ')}

Focus on what the agent should prioritize.
`.trim(),

  dailyBriefing: (data: {
    hotLeads: string[];
    dealsAtRisk: string[];
    pipelineValue: number;
    tasksOverdue: number;
  }): string => `
Generate a concise daily briefing for a real estate agent.

Hot leads today: ${data.hotLeads.join(', ') || 'None'}
Deals at risk: ${data.dealsAtRisk.join(', ') || 'None'}
Pipeline value: $${(data.pipelineValue / 100).toLocaleString()}
Overdue tasks: ${data.tasksOverdue}

Provide: top 3 priorities for the day, one key insight, and a motivational close.
`.trim(),

  smsTemplate: (contact: Contact, purpose: string): string =>
    `Hi ${contact.first_name}! ${purpose} Let me know if you have any questions. - [Agent Name]`,

  emailSubjectLine: (purpose: string, contact: Contact): string =>
    `Quick update for you, ${contact.first_name}`,
};

// ─── Rule-based text generator (no LLM required) ─────────────────────────────
export function generateFollowUpMessage(
  contact: Contact,
  daysSince: number,
  reason: string,
): string {
  const greeting = `Hi ${contact.first_name},`;

  const bodyMap: Record<string, string> = {
    dormant: `It's been a while since we last connected — just wanted to check in and see how things are going. The market has been moving and I have some insights that might be relevant to you.`,
    hot_lead: `I noticed you've been active recently and wanted to reach out personally to see how I can help with your real estate goals.`,
    deal_update: `I wanted to give you a quick update on where things stand and answer any questions you might have.`,
    seller_opportunity: `Based on recent market trends in your area, I think now could be a great time to explore your options. Would love to chat briefly about what's happening.`,
    referral: `I hope all is well! I'm always grateful for the referrals you've sent my way. Is there anything I can do for you or anyone in your network?`,
    anniversary: `Happy home anniversary! It's been ${Math.round(daysSince / 365)} year(s) since your closing — time flies. How are you enjoying the home?`,
  };

  const body = bodyMap[reason] ?? bodyMap.dormant;
  const close = `Would you be open to a quick call this week?`;

  return `${greeting}\n\n${body}\n\n${close}`;
}
