import type { EmbeddingProvider, EmbedTaskType } from './provider.js';
import logger from '../logger.js';

/**
 * Ollama embedding provider using nomic-embed-text-v2-moe model.
 * 768 dimensions, 100+ languages (excellent Russian/English).
 * Effective context window observed via /api/ps is 512 tokens — see
 * MAX_EMBED_CHARS below for how inputs are bounded.
 * Requires Ollama running locally: curl -fsSL https://ollama.com/install.sh | sh
 * Model pulled automatically on first use.
 */
const DEFAULT_MODEL = 'nomic-embed-text-v2-moe';

// nomic-embed-text-v2-moe advertises 8192 tokens, but the live model
// reports context_length: 512 via /api/ps, and Ollama rejects entire
// batches (HTTP 400) when any single input exceeds that window — its
// `truncate: true` flag only applies to single-input requests.
// Mixed text (code + Cyrillic) tokenizes at ~2-3 tokens/char, so 2000
// chars gives ~1500 token headroom while leaving useful context.
const MAX_EMBED_CHARS = 2000;
const EMBED_BATCH_SIZE = 50;        // max texts per single Ollama API call
const EMBED_TIMEOUT_MS = 5 * 60_000; // 5 min per sub-batch (Ollama is slow on CPU)

function truncateForEmbed(text: string): string {
  return text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  dimensions = 768;  // default, auto-detected from test embed during initialize()
  readonly modelName: string;
  readonly providerType = 'ollama' as const;
  private ready = false;
  private baseUrl: string;

  constructor(baseUrl: string = 'http://localhost:11434', model?: string) {
    this.baseUrl = baseUrl;
    this.modelName = model || DEFAULT_MODEL;
  }

  isReady(): boolean { return this.ready; }

  async initialize(): Promise<void> {
    try {
      const healthRes = await fetch(`${this.baseUrl}/api/tags`);
      if (!healthRes.ok) throw new Error(`Ollama not reachable: ${healthRes.status}`);
      const tags = await healthRes.json() as { models?: { name: string }[] };
      const hasModel = tags.models?.some(m => m.name.startsWith(this.modelName));
      if (!hasModel) {
        logger.info(`Pulling ${this.modelName} model...`);
        const pullRes = await fetch(`${this.baseUrl}/api/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.modelName, stream: false }),
        });
        if (!pullRes.ok) throw new Error(`Failed to pull model: ${await pullRes.text()}`);
        logger.info(`Model ${this.modelName} pulled successfully`);
      }
      // Test embed call (direct fetch, not through this.embed which guards on ready)
      const testRes = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.modelName, truncate: true, input: 'search_query: test' }),
      });
      if (!testRes.ok) throw new Error(`Test embed failed: ${testRes.status}`);
      const testData = await testRes.json() as { embeddings: number[][] };
      // Auto-detect dimensions from the model's actual output
      this.dimensions = testData.embeddings[0].length;
      this.ready = true;
      logger.info({ model: this.modelName, dimensions: this.dimensions, baseUrl: this.baseUrl },
        'Ollama embedding provider initialized');
    } catch (err) {
      logger.warn({ err }, 'Failed to initialize Ollama embedding provider. Vector search disabled.');
      this.ready = false;
    }
  }

  async embed(text: string, taskType: EmbedTaskType = 'document'): Promise<number[]> {
    if (!this.ready) throw new Error('Embedding provider not initialized');
    const prefix = taskType === 'query' ? 'search_query: ' : 'search_document: ';
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.modelName, truncate: true, input: prefix + truncateForEmbed(text) }),
    });
    if (!res.ok) throw new Error(`Ollama embed error ${res.status}: ${await res.text()}`);
    const data = await res.json() as { embeddings: number[][] };
    return data.embeddings[0];
  }

  async embedBatch(texts: string[], taskType: EmbedTaskType = 'document'): Promise<number[][]> {
    if (!this.ready) throw new Error('Embedding provider not initialized');
    if (texts.length === 0) return [];
    const prefix = taskType === 'query' ? 'search_query: ' : 'search_document: ';
    const allEmbeddings: number[][] = [];
    const totalBatches = Math.ceil(texts.length / EMBED_BATCH_SIZE);

    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
      if (totalBatches > 1) {
        const batchNum = Math.floor(i / EMBED_BATCH_SIZE) + 1;
        logger.info({ batch: batchNum, totalBatches, batchSize: batch.length, totalTexts: texts.length },
          'Embedding sub-batch');
      }

      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.modelName, truncate: true, input: batch.map(t => prefix + truncateForEmbed(t)) }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });

      // Ollama rejects the entire batch (HTTP 400) when any single input
      // exceeds the embedding context window. Fall back to single-text
      // embedding where `truncate: true` does work, substituting a
      // zero-vector for inputs that still fail so one bad text cannot
      // take down the whole session.
      if (res.status === 400) {
        const errorBody = await res.text();
        const batchNum = Math.floor(i / EMBED_BATCH_SIZE) + 1;
        logger.warn({ batchNum, batchSize: batch.length, error: errorBody },
          'Batch embedding rejected, falling back to single-text mode');
        const fallback = await this.embedBatchSingleFallback(batch, prefix);
        allEmbeddings.push(...fallback);
        continue;
      }

      if (!res.ok) throw new Error(`Ollama embed error ${res.status}: ${await res.text()}`);
      const data = await res.json() as { embeddings: number[][] };
      allEmbeddings.push(...data.embeddings);
    }

    return allEmbeddings;
  }

  private async embedBatchSingleFallback(batch: string[], prefix: string): Promise<number[][]> {
    const results: number[][] = [];
    for (let idx = 0; idx < batch.length; idx++) {
      const text = batch[idx];
      try {
        const singleRes = await fetch(`${this.baseUrl}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.modelName, truncate: true, input: prefix + truncateForEmbed(text) }),
          signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        });
        if (singleRes.ok) {
          const singleData = await singleRes.json() as { embeddings: number[][] };
          results.push(singleData.embeddings[0]);
        } else {
          const errorBody = await singleRes.text();
          // textPreview deliberately omitted — imported session content can contain
          // tokens/secrets pasted during development. Index + length are enough to
          // correlate against the source batch.
          logger.warn({ status: singleRes.status, idx, textLength: text.length, error: errorBody },
            'Single text embedding failed, using zero vector');
          results.push(new Array(this.dimensions).fill(0));
        }
      } catch (err) {
        // Timeouts/aborts are a different failure class than "input too long after
        // truncate" — don't silently mask them as zero-vectors; let the caller fail
        // the whole batch the same way any other non-400 error would.
        const name = (err as { name?: string } | undefined)?.name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw err;
        }
        logger.warn({ err, idx, textLength: text.length },
          'Single text embedding threw, using zero vector');
        results.push(new Array(this.dimensions).fill(0));
      }
    }
    return results;
  }

  async close(): Promise<void> { this.ready = false; }
}
