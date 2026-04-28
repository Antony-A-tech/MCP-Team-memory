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
    if (results.length === 0) return [];

    // Fetch each session once and verify it belongs to the requested project.
    // session_messages payloads don't carry project_id, so without this check
    // a query against project A would return messages from agent's sessions
    // in project B (cross-project content leak).
    const sessionIds = Array.from(
      new Set(results.map(r => r.payload.session_id).filter((s): s is string => !!s)),
    );
    const sessionMap = new Map<string, string | null>();
    await Promise.all(
      sessionIds.map(async sid => {
        const s = await this.storage.getSession(sid);
        sessionMap.set(sid, s ? s.projectId : null);
      }),
    );

    const messages = await Promise.all(
      results.map(async r => {
        const messageId = r.payload.message_id as string;
        const sessionId = r.payload.session_id as string;
        if (!messageId || !sessionId) return null;
        if (sessionMap.get(sessionId) !== filters.project_id) return null;
        const message = await this.storage.getMessageById(messageId);
        if (!message) return null;
        return { r, sessionId, message };
      }),
    );

    return messages
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .map(({ r, sessionId, message }) => ({
        source_type: 'session_messages' as const,
        source_id: message.id,
        text: message.content,
        score: r.score,
        metadata: {
          session_id: sessionId,
          role: message.role,
          tool_names: message.toolNames,
          message_index: message.messageIndex,
        },
      }));
  }
}
