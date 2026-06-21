import { query, queryMany } from '../../db/client';
import type { UUID } from '../../shared/types';

interface EmbeddingRecord {
  tenant_id: UUID;
  entity_type: string;
  entity_id: UUID;
  chunk_index: number;
  content: string;
  embedding: number[];
  model: string;
  metadata: Record<string, unknown>;
}

interface SimilarityResult {
  entity_type: string;
  entity_id: UUID;
  content: string;
  similarity: number;
  metadata: Record<string, unknown>;
}

export class EmbeddingStore {
  async upsert(record: EmbeddingRecord): Promise<void> {
    const vectorLiteral = `[${record.embedding.join(',')}]`;

    await query(
      `INSERT INTO embeddings (
        tenant_id, entity_type, entity_id, chunk_index,
        content, embedding, model, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8)
      ON CONFLICT (id) DO NOTHING`,
      [
        record.tenant_id, record.entity_type, record.entity_id,
        record.chunk_index, record.content,
        vectorLiteral, record.model, JSON.stringify(record.metadata),
      ],
    );
  }

  async upsertByEntity(record: EmbeddingRecord): Promise<void> {
    const vectorLiteral = `[${record.embedding.join(',')}]`;

    await query(
      `INSERT INTO embeddings (
        tenant_id, entity_type, entity_id, chunk_index,
        content, embedding, model, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8)
      ON CONFLICT ON CONSTRAINT embeddings_entity_chunk
      DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding, updated_at = NOW()`,
      [
        record.tenant_id, record.entity_type, record.entity_id,
        record.chunk_index, record.content,
        vectorLiteral, record.model, JSON.stringify(record.metadata),
      ],
    );
  }

  async findSimilar(
    tenantId: UUID,
    queryEmbedding: number[],
    options: {
      entity_types?: string[];
      limit?: number;
      threshold?: number;
    } = {},
  ): Promise<SimilarityResult[]> {
    const { entity_types, limit = 10, threshold = 0.5 } = options;
    const vectorLiteral = `[${queryEmbedding.join(',')}]`;

    let entityFilter = '';
    const params: unknown[] = [tenantId, vectorLiteral, limit, threshold];
    let idx = 5;

    if (entity_types && entity_types.length > 0) {
      entityFilter = `AND entity_type = ANY($${idx++}::text[])`;
      params.push(entity_types);
    }

    return queryMany<SimilarityResult>(
      `SELECT entity_type, entity_id, content, metadata,
              1 - (embedding <=> $2::vector) AS similarity
       FROM embeddings
       WHERE tenant_id = $1 ${entityFilter}
         AND 1 - (embedding <=> $2::vector) >= $4
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      params,
    );
  }

  async deleteByEntity(tenantId: UUID, entityType: string, entityId: UUID): Promise<void> {
    await query(
      'DELETE FROM embeddings WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3',
      [tenantId, entityType, entityId],
    );
  }
}
