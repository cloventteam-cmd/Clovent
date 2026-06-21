import { createWorker, type EmbeddingJobData } from './queue';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { EmbeddingPipeline } from '../ai/embeddings/pipeline';
import { EmbeddingStore } from '../ai/embeddings/store';

const pipeline = new EmbeddingPipeline();
const store = new EmbeddingStore();

export function startEmbeddingWorker(): void {
  createWorker<EmbeddingJobData>(
    config.queues.embedding,
    async (job) => {
      const { tenant_id, entity_type, entity_id, content } = job.data;

      if (!content || content.trim().length === 0) return;

      // Generate embedding vector
      const embedding = await pipeline.embed(content);

      // Store in pgvector
      await store.upsert({
        tenant_id,
        entity_type,
        entity_id,
        content,
        embedding,
        chunk_index: 0,
        model: pipeline.modelName,
        metadata: {},
      });

      logger.debug({ entity_type, entity_id }, 'Embedding stored');
    },
    8,
  );

  logger.info('Embedding worker started');
}
