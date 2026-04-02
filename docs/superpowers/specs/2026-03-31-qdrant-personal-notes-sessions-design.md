# Team Memory MCP v3: Qdrant + Personal Notes + Session Import

**Date:** 2026-03-31
**Status:** Draft
**Approach:** Incremental, 3 phases

## Overview

Three interconnected features extending Team Memory MCP:

1. **Phase 1** — Replace pgvector with Qdrant as the vector store
2. **Phase 2** — Personal notes with token-based access isolation
3. **Phase 3** — Claude Code session import with semantic search

Each phase is independently deployable and testable.

---

## Embedding Model Recommendation

### Current: nomic-embed-text-v1.5

The current default model has limitations for this project:
- Primarily English-trained — poor cross-language matching (RU query → EN content)
- Short queries ("auth", "WebSocket") produce diffuse embeddings
- 768 fixed dimensions, no Matryoshka support

### Recommended: nomic-embed-text-v2-moe

| Property | v1.5 | multilingual-e5-large | **v2-moe (recommended)** |
|----------|------|----------------------|--------------------------|
| Dimensions | 768 | 1024 | 768 (Matryoshka: 768/512/256) |
| Model size | 274 MB | 2.2 GB | ~600 MB |
| Languages | EN only | 100+ (RU excellent) | **100+ (RU good)** |
| Max context | 8192 tokens | 512 tokens (!) | **8192 tokens** |
| Ollama support | Yes | No | **Yes** |
| Short query quality | Poor | Good | **Good** |
| Architecture | Dense | Dense | **MoE (475M total, 305M active)** |

**Why not multilingual-e5-large:** Despite excellent multilingual quality, its 512-token context limit
is a dealbreaker — ~4% of session messages exceed this and would be truncated.

**nomic-embed-text-v2-moe** combines the best of both: multilingual support from e5 + long context
from nomic + runs via Ollama. Installation: `ollama pull nomic-embed-text-v2-moe`.

The Ollama embedding provider in the current codebase already supports model switching via
`OLLAMA_EMBEDDING_MODEL` env var — no code changes needed for the model swap.

---

## Phase 1: Qdrant Integration

### Goal

Replace pgvector (in-PostgreSQL embeddings) with Qdrant — a dedicated vector database optimized for large-scale similarity search. This prepares the system for v3 where codebases, logs, and sessions will all be vectorized.

### Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────┐
│ MemoryManager│────▶│ VectorStore  │────▶│ Qdrant  │
│             │     │ (interface)  │     │ (Docker) │
└─────────────┘     └──────────────┘     └─────────┘
       │
       ▼
┌─────────────┐
│ PostgreSQL  │  ← data stays here
│ (no vector) │  ← embedding column removed after migration
└─────────────┘
```

### VectorStore Interface

```typescript
interface VectorStore {
  ensureCollection(name: string, dimensions: number, options?: CollectionOptions): Promise<void>;
  upsert(collection: string, id: string, vector: number[], payload: Record<string, unknown>): Promise<void>;
  upsertBatch(collection: string, points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>): Promise<void>;
  search(collection: string, vector: number[], filter?: QdrantFilter, limit?: number): Promise<SearchResult[]>;
  delete(collection: string, ids: string[]): Promise<void>;
  deleteByFilter(collection: string, filter: QdrantFilter): Promise<void>;
  collectionExists(name: string): Promise<boolean>;
  getCollectionInfo(name: string): Promise<CollectionInfo>;
}

interface SearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

interface CollectionOptions {
  distance?: 'Cosine' | 'Euclid' | 'Dot';
  quantization?: 'scalar' | 'binary' | null;
  onDisk?: boolean;
}
```

### Qdrant Collections (Phase 1)

**`entries`**
- Vector: 768-dim (matches current embedding provider output)
- Distance: Cosine
- Payload schema:
  - `entry_id` (keyword) — UUID, matches PG entries.id
  - `project_id` (keyword) — UUID
  - `category` (keyword) — architecture|tasks|decisions|issues|progress|conventions
  - `domain` (keyword) — optional
  - `status` (keyword) — active|completed|archived
  - `tags` (keyword[]) — array of tags
  - `author` (keyword) — agent name
- Payload indexes: `project_id`, `category`, `status`, `author`

### Hybrid Search (Updated)

Current: FTS (PostgreSQL) + vector (pgvector) in one query.
New: FTS (PostgreSQL) + vector (Qdrant) merged in application code.

```typescript
async hybridSearch(query: string, projectId: string, options: SearchOptions): Promise<SearchResult[]> {
  // 1. FTS search in PostgreSQL
  const ftsResults = await this.pgStorage.ftsSearch(query, projectId, options);

  // 2. Vector search in Qdrant
  const queryVector = await this.embeddingProvider.embed(query, 'query');
  const vectorResults = await this.vectorStore.search('entries', queryVector, {
    must: [{ key: 'project_id', match: { value: projectId } }],
    ...buildQdrantFilter(options)
  }, options.limit);

  // 3. Merge with weighted scoring
  return mergeResults(ftsResults, vectorResults, { ftsWeight: 0.4, vectorWeight: 0.6 });
}
```

### Migration Strategy

1. Deploy Qdrant container alongside PostgreSQL
2. Create `entries` collection in Qdrant
3. Run migration script: read all entries with embeddings from PG → batch upsert to Qdrant
4. Switch search to use Qdrant (feature flag: `VECTOR_STORE=qdrant|pgvector`)
5. After validation, run PG migration 011 to drop `embedding` column and HNSW index
6. Remove pgvector extension dependency

```sql
-- Migration: 011-drop-pgvector.sql
-- Run AFTER Qdrant migration is validated

DROP INDEX IF EXISTS idx_entries_embedding;
ALTER TABLE entries DROP COLUMN IF EXISTS embedding;
-- Note: pgvector extension kept if other tables use it, otherwise:
-- DROP EXTENSION IF EXISTS vector;
```

### Infrastructure

```yaml
# Addition to docker-compose.yml
qdrant:
  image: qdrant/qdrant:v1.13.2
  ports:
    - "6333:6333"    # REST API
    - "6334:6334"    # gRPC
  volumes:
    - qdrant_data:/qdrant/storage
  environment:
    QDRANT__SERVICE__GRPC_PORT: 6334
  restart: unless-stopped

volumes:
  qdrant_data:
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VECTOR_STORE` | `qdrant` | Vector store backend (`qdrant` or `pgvector` for fallback) |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant server URL |
| `QDRANT_API_KEY` | — | Optional API key (for Qdrant Cloud) |
| `QDRANT_GRPC_URL` | — | Optional gRPC URL (faster for batch ops) |

### Dependencies

- `@qdrant/js-client-rest` — Official Qdrant JS client

---

## Phase 2: Personal Notes

### Goal

Private per-agent notes with token-based access isolation. Notes can optionally link to projects and imported sessions.

### PostgreSQL Schema

```sql
-- Migration: 012-personal-notes.sql

CREATE TABLE personal_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_token_id UUID NOT NULL REFERENCES agent_tokens(id),
  project_id UUID REFERENCES projects(id),
  session_id UUID,  -- FK added in migration 013 after sessions table exists

  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  priority TEXT DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status TEXT DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),

  search_vector TSVECTOR,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_personal_notes_agent ON personal_notes(agent_token_id);
CREATE INDEX idx_personal_notes_project ON personal_notes(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_personal_notes_session ON personal_notes(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_personal_notes_status ON personal_notes(agent_token_id, status);
CREATE INDEX idx_personal_notes_search ON personal_notes USING GIN(search_vector);

-- FTS trigger (same pattern as entries)
CREATE TRIGGER update_personal_notes_search_vector
  BEFORE INSERT OR UPDATE OF title, content, tags ON personal_notes
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();

-- Timestamp trigger
CREATE TRIGGER update_personal_notes_timestamp
  BEFORE UPDATE ON personal_notes
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();
```

### Access Control

**Rule: a token can only read/write/update/delete its own notes.**

All storage methods for personal notes require `agent_token_id` as a mandatory parameter. This is extracted from the authenticated request in the MCP tool handler — not provided by the caller.

```typescript
// In tool handler (server.ts)
case 'note_read': {
  const agentTokenId = getAgentTokenId(request); // from auth middleware
  return storage.getPersonalNotes(agentTokenId, params);
}

// In storage — every query filters by agent_token_id
async getPersonalNotes(agentTokenId: string, filters: NoteFilters) {
  const query = `
    SELECT * FROM personal_notes
    WHERE agent_token_id = $1
    AND ($2::uuid IS NULL OR project_id = $2)
    AND ($3::text IS NULL OR status = $3)
    ORDER BY updated_at DESC
    LIMIT $4 OFFSET $5
  `;
  return this.pool.query(query, [agentTokenId, filters.projectId, ...]);
}
```

**Master token exception:** Master token (`MEMORY_API_TOKEN`) can read all notes for admin/debugging. The master token sets `agentTokenId = null`, and storage methods check for this:

```typescript
async getPersonalNotes(agentTokenId: string | null, filters) {
  if (agentTokenId === null) {
    // Master token — no agent filter, can see all
    return this.pool.query(`SELECT * FROM personal_notes WHERE ...`, [...]);
  }
  // Agent token — strict isolation
  return this.pool.query(`SELECT * FROM personal_notes WHERE agent_token_id = $1 ...`, [agentTokenId, ...]);
}
```

### Qdrant Collection

**`personal_notes`**
- Vector: 768-dim
- Distance: Cosine
- Payload:
  - `note_id` (keyword) — UUID
  - `agent_token_id` (keyword) — UUID, mandatory filter
  - `project_id` (keyword) — optional
  - `session_id` (keyword) — optional
  - `tags` (keyword[])
  - `status` (keyword)
- Payload indexes: `agent_token_id`, `project_id`, `session_id`

### MCP Tools

**`note_write`**
- Params: `{ title, content, tags?, priority?, project_id?, session_id? }`
- Auto-sets `agent_token_id` from auth
- Embeds content → upserts to Qdrant `personal_notes`
- Returns: `{ id, title, created_at }`

**`note_read`**
- Params: `{ search?, tags?, project_id?, session_id?, status?, mode?: 'compact'|'full', limit?, offset? }`
- Filters by caller's `agent_token_id`
- If `search` provided: hybrid search (FTS + Qdrant)
- Returns: list of notes (compact: no content, full: with content)

**`note_update`**
- Params: `{ id, title?, content?, tags?, priority?, status?, project_id?, session_id? }`
- Verifies ownership (agent_token_id match)
- Updates PG + re-embeds if content changed → updates Qdrant

**`note_delete`**
- Params: `{ id, archive?: true }`
- Verifies ownership
- Default: archives (status='archived'). `archive=false`: hard delete from PG + Qdrant

**`note_search`**
- Params: `{ query, project_id?, session_id?, limit? }`
- Semantic search via Qdrant with `agent_token_id` filter
- Returns: notes with similarity scores

---

## Phase 3: Session Import

### Goal

Import Claude Code chat histories into the database with full vectorization. Enable semantic search across sessions (find relevant session) and within sessions (find specific messages).

### Session Data Source

Claude Code stores sessions locally in `~/.claude/projects/<dir>/<sessionId>.jsonl`.
Each JSONL file contains events: `message` (user/assistant), `progress`, `tool_use`, `tool_result`, etc.
The agent reads session files and sends data through the MCP tool.
The server does NOT access the filesystem directly — all data comes through the MCP protocol.

### Volume Estimates (based on actual data analysis)

Analysis of the current user's Claude Code history:

| Metric | Value |
|--------|-------|
| Main sessions | 136 |
| Subagent sessions | 923 |
| Total message events (main) | ~41,200 |
| Total message events (subagents) | ~37,500 |
| Raw JSONL on disk | 1.2 GB |
| Pure text content (main sessions) | ~47 MB |

**Qdrant storage estimate (main sessions only, with adaptive chunking ~45K vectors):**

| Quantization | Vector data | Payload | Total |
|-------------|-------------|---------|-------|
| None (float32) | ~132 MB | ~9 MB | **~141 MB** |
| Scalar (uint8) | ~33 MB | ~9 MB | **~42 MB** |

With subagents included (~83K vectors): ~73 MB with quantization. Negligible for Qdrant.

### Adaptive Chunking Strategy

Not all messages fit in a single embedding. Message size distribution (from largest session, 4106 events):

| Size | % of messages | Strategy |
|------|--------------|----------|
| < 1 KB | 51% | Single chunk |
| 1-5 KB (~200-1000 tokens) | 37% | Single chunk |
| 5-20 KB (~1000-4000 tokens) | 8% | Single chunk (within model context) |
| 20-100 KB (~4000-20000 tokens) | 2.4% | **Split into chunks** |
| > 100 KB | 1.4% | **Split into chunks** |

**Algorithm:**

```typescript
const MAX_CHUNK_TOKENS = 2000;  // safe for nomic-v2-moe (8K context)
const OVERLAP_TOKENS = 100;     // context continuity between chunks

function chunkMessage(content: string): ChunkResult[] {
  const tokens = estimateTokens(content);

  if (tokens <= MAX_CHUNK_TOKENS) {
    // ~96% of messages — single chunk
    return [{ text: content, chunkIndex: 0, totalChunks: 1 }];
  }

  // ~4% of messages — split with overlap
  const chunks: ChunkResult[] = [];
  let offset = 0;
  while (offset < content.length) {
    const chunk = content.slice(offset, offset + charsForTokens(MAX_CHUNK_TOKENS));
    chunks.push({
      text: chunk,
      chunkIndex: chunks.length,
      totalChunks: -1  // set after loop
    });
    offset += charsForTokens(MAX_CHUNK_TOKENS - OVERLAP_TOKENS);
  }
  chunks.forEach(c => c.totalChunks = chunks.length);
  return chunks;
}
```

This adds ~10-15% more vectors (from splitting large messages), resulting in ~45K vectors
instead of 41K for main sessions. The overhead is minimal.

### PostgreSQL Schema

```sql
-- Migration: 013-sessions.sql

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_token_id UUID NOT NULL REFERENCES agent_tokens(id),
  project_id UUID REFERENCES projects(id),

  external_id TEXT,                    -- Claude Code session ID
  name TEXT,                           -- session name (from -n flag or /rename)
  summary TEXT NOT NULL,               -- agent-generated summary
  working_directory TEXT,              -- where session ran
  git_branch TEXT,                     -- git branch during session

  message_count INT DEFAULT 0,
  embedding_status TEXT DEFAULT 'pending'
    CHECK (embedding_status IN ('pending', 'processing', 'complete', 'failed')),
  started_at TIMESTAMPTZ,              -- first message timestamp
  ended_at TIMESTAMPTZ,                -- last message timestamp
  imported_at TIMESTAMPTZ DEFAULT NOW(),

  tags TEXT[] DEFAULT '{}',
  search_vector TSVECTOR,

  UNIQUE(agent_token_id, external_id)  -- prevent duplicate imports
);

CREATE TABLE session_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  message_index INT NOT NULL,

  has_tool_use BOOLEAN DEFAULT FALSE,
  tool_names TEXT[] DEFAULT '{}',

  timestamp TIMESTAMPTZ,
  search_vector TSVECTOR,

  UNIQUE(session_id, message_index)
);

-- Session indexes
CREATE INDEX idx_sessions_agent ON sessions(agent_token_id);
CREATE INDEX idx_sessions_project ON sessions(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_sessions_external ON sessions(agent_token_id, external_id);
CREATE INDEX idx_sessions_date ON sessions(agent_token_id, started_at DESC);
CREATE INDEX idx_sessions_search ON sessions USING GIN(search_vector);

-- Message indexes
CREATE INDEX idx_session_messages_session ON session_messages(session_id);
CREATE INDEX idx_session_messages_search ON session_messages USING GIN(search_vector);

-- FTS triggers
CREATE TRIGGER update_sessions_search_vector
  BEFORE INSERT OR UPDATE OF name, summary, tags ON sessions
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();

CREATE TRIGGER update_session_messages_search_vector
  BEFORE INSERT OR UPDATE OF content ON session_messages
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();

-- Timestamp trigger for sessions
CREATE TRIGGER update_sessions_timestamp
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Add FK from personal_notes.session_id now that sessions table exists
ALTER TABLE personal_notes
  ADD CONSTRAINT fk_personal_notes_session
  FOREIGN KEY (session_id) REFERENCES sessions(id);
```

### Access Control

Same as Personal Notes: `agent_token_id` mandatory filter on all queries. Master token can access all.

### Qdrant Collections

**`sessions`**
- Vector: 768-dim (from summary embedding)
- Distance: Cosine
- Payload:
  - `session_id` (keyword) — UUID
  - `agent_token_id` (keyword) — mandatory filter
  - `project_id` (keyword) — optional
  - `name` (text) — session name
  - `tags` (keyword[])
  - `started_at` (integer) — unix timestamp for range filtering
  - `message_count` (integer)
- Payload indexes: `agent_token_id`, `project_id`, `started_at`

**`session_messages`**
- Vector: 768-dim (from message chunk embedding)
- Distance: Cosine
- Payload:
  - `message_id` (keyword) — UUID, links back to PG session_messages
  - `session_id` (keyword) — for scoped search
  - `agent_token_id` (keyword) — mandatory filter
  - `role` (keyword) — user|assistant|system
  - `message_index` (integer) — ordering within session
  - `chunk_index` (integer) — chunk position within message (0 for single-chunk messages)
  - `total_chunks` (integer) — how many chunks this message was split into (1 for most)
  - `has_tool_use` (bool)
  - `tool_names` (keyword[])
- Payload indexes: `agent_token_id`, `session_id`, `role`
- Quantization: scalar (uint8) — recommended for this collection due to high volume

### MCP Tools

**`session_import`**
- Params:
  ```typescript
  {
    external_id?: string;           // Claude Code session ID
    name?: string;                  // session name
    summary: string;                // agent-generated summary (required)
    project_id?: string;            // optional project link
    working_directory?: string;
    git_branch?: string;
    tags?: string[];
    started_at?: string;            // ISO timestamp
    ended_at?: string;
    messages: Array<{
      role: 'user' | 'assistant' | 'system';
      content: string;
      timestamp?: string;
      tool_names?: string[];
    }>;
  }
  ```
- Behavior:
  1. Check duplicate: `(agent_token_id, external_id)` unique
  2. INSERT session into PG
  3. INSERT messages batch into PG
  4. Embed summary → upsert Qdrant `sessions`
  5. Embed each message → batch upsert Qdrant `session_messages`
  6. Update `session.message_count`
- Returns: `{ session_id, message_count, status: 'imported' }`
- Idempotent: re-import with same `external_id` returns existing session ID

**`session_list`**
- Params: `{ project_id?, tags?, date_from?, date_to?, search?, limit?, offset? }`
- Returns: list of sessions (id, name, summary, message_count, started_at, tags)
- Filtered by caller's `agent_token_id`

**`session_search`**
- Params: `{ query, project_id?, limit? }`
- Semantic search across session summaries via Qdrant
- Returns: sessions with similarity scores

**`session_read`**
- Params: `{ session_id, message_from?, message_to? }`
- Returns full session with messages (pagination via message_from/message_to indices)
- Ownership check: session.agent_token_id must match caller

**`session_message_search`**
- Params: `{ query, session_id?, limit? }`
- If `session_id` provided: search within that session
- If not: search across ALL caller's session messages
- Returns: messages with session context and similarity scores

**`session_delete`**
- Params: `{ session_id }`
- Cascades: deletes session + all messages from PG
- Deletes vectors from Qdrant `sessions` and `session_messages`
- Ownership check required

### Import Flow

```
User: "Import my last session"
  │
  ▼
Claude Code Agent:
  1. Reads ~/.claude/ → finds session data
  2. Generates summary from session content
  3. Calls session_import({ summary, messages, ... })
  │
  ▼
Server (session_import tool handler):
  1. Validate params (Zod)
  2. Check duplicate (agent_token_id + external_id)
  3. BEGIN transaction
  4. INSERT INTO sessions (...)
  5. INSERT INTO session_messages (...) -- batch
  6. COMMIT
  7. Async: embed summary → Qdrant sessions collection
  8. Async: for each message:
     a. Apply adaptive chunking (split if > 2000 tokens)
     b. Embed each chunk → batch upsert Qdrant session_messages
     c. Track chunk_index/total_chunks in payload
  9. Update session.embedding_status = 'complete'
  10. Return { session_id, message_count, chunk_count, status: "imported" }
```

### Search Flow

```
User: "Find where we discussed WebSocket reconnect"
  │
  ▼
Agent calls: session_search({ query: "WebSocket reconnect" })
  │
  ▼
Server:
  1. Embed query
  2. Qdrant search on `sessions` (filter: agent_token_id=caller)
  3. Return top-N sessions with summary and score
  │
  ▼
Agent: "Found 3 sessions. Searching inside the top one..."
Agent calls: session_message_search({
  query: "WebSocket reconnect",
  session_id: "found-session-id"
})
  │
  ▼
Server:
  1. Qdrant search on `session_messages` (filter: session_id + agent_token_id)
  2. Return matching messages with context (role, index, content snippet)
```

---

## Cross-Cutting Concerns

### Embedding Model

Recommended model: **nomic-embed-text-v2-moe** via Ollama (see Embedding Model Recommendation section).
All three phases use the same embedding provider interface. The model switch requires only an env var change:
`OLLAMA_EMBEDDING_MODEL=nomic-embed-text-v2-moe`.

### Embedding Pipeline

All three phases use the same embedding provider (Gemini/Local/Ollama). The `EmbeddingProvider` interface remains unchanged — only the storage backend switches from pgvector to Qdrant.

Embedding is async and non-blocking for import operations. The server returns success after PG writes, then processes embeddings in the background. A status field tracks embedding progress:

```typescript
// For sessions: track whether embeddings are ready
type EmbeddingStatus = 'pending' | 'processing' | 'complete' | 'failed';
```

### Error Handling

- Qdrant unavailable: fall back to FTS-only search, log warning
- Embedding provider unavailable: store data without vectors, backfill later
- Duplicate import: return existing session ID (idempotent)
- Token mismatch on read/update/delete: 403 Forbidden

### Testing Strategy

- Unit tests: VectorStore interface mock for Qdrant operations
- Integration tests: Qdrant testcontainer for real vector operations
- Access control tests: verify token isolation (agent A cannot read agent B's notes/sessions)
- Migration tests: verify pgvector → Qdrant data migration

### Performance Considerations

- Batch embedding for session messages (Gemini supports up to 100/call)
- Qdrant batch upsert for import operations
- PG batch INSERT for session messages
- Payload indexes in Qdrant for fast filtered search
- Quantization (scalar) for session_messages collection to save memory on large volumes

---

## Summary of New MCP Tools

| Phase | Tool | Description |
|-------|------|-------------|
| 2 | `note_write` | Create a personal note |
| 2 | `note_read` | List/filter personal notes |
| 2 | `note_update` | Update own note |
| 2 | `note_delete` | Archive/delete own note |
| 2 | `note_search` | Semantic search through personal notes |
| 3 | `session_import` | Import Claude Code session with messages |
| 3 | `session_list` | List imported sessions |
| 3 | `session_search` | Semantic search across session summaries |
| 3 | `session_read` | Read full session with messages |
| 3 | `session_message_search` | Semantic search within/across session messages |
| 3 | `session_delete` | Delete imported session |

## Summary of New Database Objects

| Phase | Object | Type | Description |
|-------|--------|------|-------------|
| 1 | `entries` | Qdrant collection | Migrated from pgvector |
| 2 | `personal_notes` | PG table | Private notes per agent |
| 2 | `personal_notes` | Qdrant collection | Note embeddings |
| 3 | `sessions` | PG table | Session metadata |
| 3 | `session_messages` | PG table | Session message chunks |
| 3 | `sessions` | Qdrant collection | Summary embeddings |
| 3 | `session_messages` | Qdrant collection | Message embeddings |

## Environment Variables (New)

| Variable | Default | Phase | Description |
|----------|---------|-------|-------------|
| `VECTOR_STORE` | `qdrant` | 1 | Vector backend: `qdrant` or `pgvector` |
| `QDRANT_URL` | `http://localhost:6333` | 1 | Qdrant REST API URL |
| `QDRANT_API_KEY` | — | 1 | Optional API key |
| `QDRANT_GRPC_URL` | — | 1 | Optional gRPC URL for batch ops |
