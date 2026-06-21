import { config } from '../../shared/config';
import { logger } from '../../shared/logger';

// ─── Local TF-IDF embedding (no external API required) ────────────────────────
// When AI_PROVIDER=local, we use a deterministic TF-IDF-based vector.
// When AI_PROVIDER=openai, we call the OpenAI embeddings API.
// Dimension: 1536 to match pgvector index regardless of provider.

const EMBEDDING_DIM = 1536;

export class EmbeddingPipeline {
  readonly modelName: string;

  constructor() {
    this.modelName = config.ai.provider === 'openai' ? 'text-embedding-3-small' : 'local-tfidf-v1';
  }

  async embed(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      return new Array(EMBEDDING_DIM).fill(0);
    }

    if (config.ai.provider === 'openai' && config.ai.openaiKey) {
      return this.embedWithOpenAI(text);
    }

    return this.embedLocal(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (config.ai.provider === 'openai' && config.ai.openaiKey) {
      return this.embedBatchWithOpenAI(texts);
    }
    return Promise.all(texts.map(t => this.embedLocal(t)));
  }

  // Deterministic local embedding using character n-gram hashing
  // Produces consistent 1536-dim vectors without any external dependency
  private embedLocal(text: string): number[] {
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const vector = new Float32Array(EMBEDDING_DIM).fill(0);

    // Bag-of-words with positional encoding
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      // Hash token to index
      const h = this.murmurHash(token) % EMBEDDING_DIM;
      const posWeight = 1 / (1 + i * 0.1); // position decay
      vector[Math.abs(h)] += posWeight;

      // Bigrams
      if (i + 1 < tokens.length) {
        const bigram = `${token}_${tokens[i + 1]}`;
        const bh = this.murmurHash(bigram) % EMBEDDING_DIM;
        vector[Math.abs(bh)] += 0.5 * posWeight;
      }
    }

    // L2 normalize
    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
    return Array.from(vector).map(v => v / norm);
  }

  private murmurHash(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  private async embedWithOpenAI(text: string): Promise<number[]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.openaiKey}`,
      },
      body: JSON.stringify({ model: this.modelName, input: text }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'OpenAI embedding failed, falling back to local');
      return this.embedLocal(text);
    }

    const data = await response.json() as any;
    return data.data[0].embedding as number[];
  }

  private async embedBatchWithOpenAI(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.openaiKey}`,
      },
      body: JSON.stringify({ model: this.modelName, input: texts }),
    });

    if (!response.ok) {
      return Promise.all(texts.map(t => this.embedLocal(t)));
    }

    const data = await response.json() as any;
    return data.data.map((d: any) => d.embedding as number[]);
  }
}
