import { EmbeddingPipeline } from '../embeddings/pipeline';
import { EmbeddingStore } from '../embeddings/store';
import { queryMany } from '../../db/client';
import type { UUID } from '../../shared/types';
import { queueEmbeddingJob } from '../../workers/queue';

export class AIMemorySystem {
  private pipeline = new EmbeddingPipeline();
  private store = new EmbeddingStore();

  // Store a memory for a contact or deal
  async remember(params: {
    tenant_id: UUID;
    entity_type: 'contact' | 'deal' | 'activity' | 'message' | 'note';
    entity_id: UUID;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await queueEmbeddingJob({
      tenant_id: params.tenant_id,
      entity_type: params.entity_type,
      entity_id: params.entity_id,
      content: params.content,
    });
  }

  // Build a rich text representation for a contact's memory
  async buildContactMemory(tenantId: UUID, contactId: UUID): Promise<string> {
    const [activities, messages, deals] = await Promise.all([
      queryMany<{ type: string; body: string; occurred_at: Date }>(
        `SELECT type, body, occurred_at FROM activities
         WHERE tenant_id = $1 AND contact_id = $2 AND body IS NOT NULL
         ORDER BY occurred_at DESC LIMIT 20`,
        [tenantId, contactId],
      ),
      queryMany<{ channel: string; direction: string; body: string; sent_at: Date }>(
        `SELECT channel, direction, body, sent_at FROM messages
         WHERE tenant_id = $1 AND contact_id = $2
         ORDER BY sent_at DESC LIMIT 20`,
        [tenantId, contactId],
      ),
      queryMany<{ name: string; stage: string; type: string }>(
        'SELECT name, stage, type FROM deals WHERE tenant_id = $1 AND contact_id = $2',
        [tenantId, contactId],
      ),
    ]);

    const parts: string[] = [];

    if (deals.length > 0) {
      parts.push(`Deals: ${deals.map(d => `${d.name} (${d.stage})`).join(', ')}`);
    }

    if (activities.length > 0) {
      const activitySummary = activities
        .filter(a => a.body)
        .map(a => `[${a.type}] ${String(a.body ?? '').slice(0, 100)}`)
        .join('. ');
      parts.push(`Activities: ${activitySummary}`);
    }

    if (messages.length > 0) {
      const msgSummary = messages
        .map(m => `[${m.direction} ${m.channel}] ${String(m.body ?? '').slice(0, 100)}`)
        .join('. ');
      parts.push(`Messages: ${msgSummary}`);
    }

    return parts.join('\n\n');
  }

  // Semantic search across all memory
  async query(params: {
    tenant_id: UUID;
    question: string;
    entity_types?: string[];
    contact_id?: UUID;
    limit?: number;
  }): Promise<Array<{
    entity_type: string;
    entity_id: UUID;
    content: string;
    similarity: number;
    metadata: Record<string, unknown>;
  }>> {
    const queryEmbedding = await this.pipeline.embed(params.question);

    const results = await this.store.findSimilar(params.tenant_id, queryEmbedding, {
      entity_types: params.entity_types,
      limit: params.limit ?? 10,
      threshold: 0.4,
    });

    return results;
  }

  // Answer questions about a specific entity
  async answerAboutContact(
    tenantId: UUID,
    contactId: UUID,
    question: string,
  ): Promise<{ answer: string; sources: string[] }> {
    const results = await this.query({
      tenant_id: tenantId,
      question,
      entity_types: ['activity', 'message', 'note'],
      limit: 5,
    });

    // Filter to this contact's data
    const relevant = results.filter(r => r.entity_id === contactId || r.metadata?.contact_id === contactId);

    if (relevant.length === 0) {
      return {
        answer: 'No relevant information found in this contact\'s history.',
        sources: [],
      };
    }

    // Build context from retrieved memories
    const context = relevant.map(r => r.content).join('\n---\n');
    const sources = relevant.map(r => `${r.entity_type}:${r.entity_id}`);

    // Simple extractive answer (in production, pass to LLM)
    const answer = `Based on ${relevant.length} records:\n${context.slice(0, 500)}`;

    return { answer, sources };
  }
}
