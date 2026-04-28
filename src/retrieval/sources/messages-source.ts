// src/retrieval/sources/messages-source.ts
//
// KnowledgeSource that retrieves individual session messages. Fine-grained
// context for "what did the user say verbatim about X?". Filtered by
// agent_token_id only — message-level data is private to the agent that
// imported the session, never project-wide.

import type {
  KnowledgeSource,
  KnowledgeChunk,
  RetrievalFilters,
} from '../types.js';
import type { EmbeddingProvider } from '../../embedding/provider.js';
import type { VectorStore, VectorFilter } from '../../vector/vector-store.js';
import type { SessionStorage } from '../../sessions/storage.js';

export class MessagesSource implements KnowledgeSource {
  readonly type = 'session_messages' as const;

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
    // Without an agent token we cannot scope the search to "your messages".
    // Refuse rather than return foreign agents' private session content.
    if (!filters.agent_token_id) return [];

    const vec = await this.embedding.embed(query, 'query');
    const f: VectorFilter = {
      must: [{ key: 'agent_token_id', match: { value: filters.agent_token_id } }],
    };

    const results = await this.vector.search('session_messages', vec, f, limit);
    const out: KnowledgeChunk[] = [];
    for (const r of results) {
      const messageId = r.payload.message_id as string;
      const sessionId = r.payload.session_id as string;
      if (!messageId || !sessionId) continue;
      const message = await this.storage.getMessageById(messageId);
      if (!message) continue;
      out.push({
        source_type: 'session_messages',
        source_id: messageId,
        text: message.content,
        score: r.score,
        metadata: {
          session_id: sessionId,
          role: message.role,
          tool_names: message.toolNames,
          message_index: message.messageIndex,
        },
      });
    }
    return out;
  }
}
