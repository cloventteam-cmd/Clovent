import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { EmbeddingPipeline } from './embeddings/pipeline';
import { AIMemorySystem } from './memory/system';
import { ContactScorer } from './scoring/contact-scorer';
import { PromptTemplates, generateFollowUpMessage } from './prompts/templates';
import type { Contact, Deal } from '../shared/types';

// ─── Unified AI Abstraction Layer ─────────────────────────────────────────────
// All AI features go through this layer. No direct external API calls elsewhere.

export class AILayer {
  readonly embeddings = new EmbeddingPipeline();
  readonly memory = new AIMemorySystem();
  readonly scorer = new ContactScorer();

  async complete(prompt: string, maxTokens = 500): Promise<string> {
    if (config.ai.provider === 'anthropic' && config.ai.anthropicKey) {
      return this.completeWithAnthropic(prompt, maxTokens);
    }
    if (config.ai.provider === 'openai' && config.ai.openaiKey) {
      return this.completeWithOpenAI(prompt, maxTokens);
    }
    return this.completeLocal(prompt);
  }

  // Rule-based local completion (always works, no API key needed)
  private completeLocal(prompt: string): string {
    // Extract key signals from the prompt and produce structured text
    if (prompt.includes('follow-up') || prompt.includes('reconnect')) {
      return generateFollowUpMessage(
        { first_name: 'there', last_name: '' } as Contact,
        90,
        'dormant',
      );
    }
    if (prompt.includes('risk')) {
      return 'Key risks identified require immediate attention. Focus on communication and documentation.';
    }
    if (prompt.includes('briefing')) {
      return 'Focus on your hottest leads today. Review deals at risk and follow up promptly.';
    }
    return 'Action recommended based on current data analysis.';
  }

  private async completeWithAnthropic(prompt: string, maxTokens: number): Promise<string> {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.ai.anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) throw new Error(`Anthropic API error: ${response.status}`);
      const data = await response.json() as any;
      return data.content[0]?.text ?? '';
    } catch (err) {
      logger.warn({ err }, 'Anthropic completion failed, falling back to local');
      return this.completeLocal(prompt);
    }
  }

  private async completeWithOpenAI(prompt: string, maxTokens: number): Promise<string> {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.ai.openaiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: 'You are a real estate AI assistant. Be concise and actionable.' },
            { role: 'user', content: prompt },
          ],
        }),
      });

      if (!response.ok) throw new Error(`OpenAI API error: ${response.status}`);
      const data = await response.json() as any;
      return data.choices[0]?.message?.content ?? '';
    } catch (err) {
      logger.warn({ err }, 'OpenAI completion failed, falling back to local');
      return this.completeLocal(prompt);
    }
  }

  async generateContactMessage(
    contact: Contact,
    purpose: string,
    channel: 'email' | 'sms',
  ): Promise<string> {
    if (channel === 'sms') {
      return PromptTemplates.smsTemplate(contact, purpose);
    }

    const prompt = PromptTemplates.contactFollowUp(contact, purpose);
    return this.complete(prompt, 200);
  }

  async generateDealRiskSummary(deal: Deal, riskCategories: string[]): Promise<string> {
    const prompt = PromptTemplates.dealRiskSummary(deal, riskCategories);
    return this.complete(prompt, 300);
  }
}

// Singleton instance
export const ai = new AILayer();
