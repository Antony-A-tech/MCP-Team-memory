// src/retrieval/sources/sessions-source.ts
//
// KnowledgeSource that surfaces session-level summaries. Useful for
// "where did we discuss X?" — coarse-grained context retrieval.

import type {
  KnowledgeSource,
  KnowledgeChunk,
  RetrievalFilters,
} from '../types.js';
import type { EmbeddingProvider } from '../../embedding/provider.js';
import type { VectorStore, VectorFilter } from '../../vector/vector-store.js';
import type { SessionStorage } from '../../sessions/storage.js';

export class SessionsSource implements KnowledgeSource {
  readonly type = 'sessions' as const;

  constructor(
    private embedding: EmbeddingProvider,
    private vector: VectorStore,
    private storage: SessionStorage,
  ) {}

  async search(
    query: string,
    filters: RetrievalFilters,
    limit: number,
  ): Promise<KnowledgeChunk[]> {
    if (!this.embedding.isReady()) return [];
    const vec = await this.embedding.embed(query, 'query');

    const f: VectorFilter = {
      must: [{ key: 'project_id', match: { value: filters.project_id } }],
    };
    if (filters.agent_token_id) {
      f.must!.push({ key: 'agent_token_id', match: { value: filters.agent_token_id } });
    }

    const results = await this.vector.search('sessions', vec, f, limit);
    const hydrated = await Promise.all(
      results.map(async r => {
        const s = await this.storage.getSession(String(r.id));
        return s ? { r, s } : null;
      }),
    );
    return hydrated
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .map(({ r, s }) => ({
        source_type: 'sessions' as const,
        source_id: s.id,
        text: s.summary,
        score: r.score,
        metadata: {
          name: s.name,
          message_count: s.messageCount,
          started_at: s.startedAt,
          tags: s.tags,
        },
      }));
  }
}
