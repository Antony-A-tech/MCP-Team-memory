# Qdrant + Personal Notes + Session Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace pgvector with Qdrant, add private per-agent notes, and enable Claude Code session import with semantic search.

**Architecture:** Three-phase incremental migration. Phase 1 introduces a VectorStore abstraction backed by Qdrant, migrates existing embeddings, and switches to nomic-embed-text-v2-moe. Phase 2 adds personal_notes table with token-based access isolation. Phase 3 adds sessions/session_messages tables with adaptive chunking and full vectorization.

**Tech Stack:** TypeScript, PostgreSQL, Qdrant, @qdrant/js-client-rest, Ollama (nomic-embed-text-v2-moe), Vitest

**Spec:** `docs/superpowers/specs/2026-03-31-qdrant-personal-notes-sessions-design.md`

---

## File Structure

### Phase 0: Auth Fix (prerequisite for Phases 2-3)

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/middleware/auth.ts:58-63` | Add `agentTokenId` (UUID) to auth object |
| Modify | `src/types/express.d.ts` | Extend Request type with `agentTokenId` |
| Create | `src/__tests__/auth-token-id.test.ts` | Verify agentTokenId propagation |

### Phase 1: Qdrant Integration

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/vector/vector-store.ts` | VectorStore interface definition |
| Create | `src/vector/qdrant-store.ts` | Qdrant implementation of VectorStore |
| Create | `src/__tests__/qdrant-store.test.ts` | Unit tests for QdrantVectorStore |
| Modify | `src/config.ts` | Add QDRANT_URL, QDRANT_API_KEY, VECTOR_STORE env vars |
| Modify | `src/memory/manager.ts` | Wire VectorStore, update hybrid search flow |
| Create | `src/__tests__/manager-qdrant.test.ts` | Manager tests with VectorStore mock |
| Modify | `src/embedding/ollama.ts` | Support configurable model name via env var |
| Create | `src/vector/migrate-pgvector.ts` | Data migration script: pgvector → Qdrant |
| Create | `src/storage/migrations/011-drop-pgvector.sql` | Drop embedding column and HNSW index |
| Modify | `docker-compose.yml` | Add Qdrant service |
| Modify | `package.json` | Add @qdrant/js-client-rest dependency |

### Phase 2: Personal Notes

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/storage/migrations/012-personal-notes.sql` | personal_notes table |
| Create | `src/notes/types.ts` | PersonalNote, NoteFilters types |
| Create | `src/notes/validation.ts` | Zod schemas for note tools |
| Create | `src/notes/storage.ts` | PersonalNotesStorage (PG CRUD + FTS) |
| Create | `src/__tests__/notes-storage.test.ts` | Storage unit tests |
| Create | `src/notes/manager.ts` | NotesManager (storage + embedding + events) |
| Create | `src/__tests__/notes-manager.test.ts` | Manager unit tests |
| Modify | `src/server.ts` | Register 5 note_* MCP tools |
| Create | `src/__tests__/notes-tools.test.ts` | Tool handler tests (auth isolation) |

### Phase 3: Session Import

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/storage/migrations/013-sessions.sql` | sessions + session_messages tables + FK |
| Create | `src/sessions/types.ts` | Session, SessionMessage, SessionChunk types |
| Create | `src/sessions/validation.ts` | Zod schemas for session tools |
| Create | `src/sessions/chunking.ts` | Adaptive chunking algorithm |
| Create | `src/__tests__/chunking.test.ts` | Chunking unit tests |
| Create | `src/sessions/storage.ts` | SessionStorage (PG CRUD + FTS) |
| Create | `src/__tests__/sessions-storage.test.ts` | Storage unit tests |
| Create | `src/sessions/manager.ts` | SessionManager (storage + embedding + chunking) |
| Create | `src/__tests__/sessions-manager.test.ts` | Manager unit tests |
| Modify | `src/server.ts` | Register 6 session_* MCP tools |
| Create | `src/__tests__/sessions-tools.test.ts` | Tool handler tests (auth isolation) |

---

## Phase 0: Auth Fix

### Task 0: Propagate agent token UUID through auth middleware

**Files:**
- Modify: `src/middleware/auth.ts:58-63`
- Modify: `src/types/express.d.ts`
- Create: `src/__tests__/auth-token-id.test.ts`

**Context:** The current auth middleware sets `clientId: agentInfo.agentName` (a string like `"claude-agent-1"`). But `personal_notes.agent_token_id` and `sessions.agent_token_id` reference `agent_tokens.id` (a UUID). We need to propagate the UUID so downstream tool handlers can use it for DB queries.

- [ ] **Step 1: Write failing test**

Write `src/__tests__/auth-token-id.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createAuthMiddleware } from '../middleware/auth.js';
import type { Request, Response, NextFunction } from 'express';

function createMockAgentTokenStore() {
  return {
    resolve: vi.fn().mockReturnValue({
      id: '550e8400-e29b-41d4-a716-446655440000',
      agentName: 'test-agent',
      role: 'developer',
      isActive: true,
    }),
    trackLastUsed: vi.fn(),
  };
}

describe('Auth middleware — agentTokenId propagation', () => {
  it('sets agentTokenId (UUID) in auth object for agent tokens', () => {
    const store = createMockAgentTokenStore();
    const middleware = createAuthMiddleware('master-token', store as any);

    const req = {
      path: '/mcp',
      headers: {
        authorization: 'Bearer tm_agent_token_123',
        'x-project-id': 'proj-1',
      },
    } as unknown as Request;
    const res = {} as Response;
    const next: NextFunction = vi.fn();

    middleware(req, res, next);

    const auth = (req as any).auth;
    expect(auth.clientId).toBe('test-agent');
    expect(auth.agentTokenId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(next).toHaveBeenCalled();
  });

  it('does NOT set agentTokenId for master token', () => {
    const store = createMockAgentTokenStore();
    store.resolve.mockReturnValue(null); // not an agent token
    const middleware = createAuthMiddleware('master-secret', store as any);

    const req = {
      path: '/mcp',
      headers: { authorization: 'Bearer master-secret' },
    } as unknown as Request;
    const res = {} as Response;
    const next: NextFunction = vi.fn();

    middleware(req, res, next);

    const auth = (req as any).auth;
    expect(auth.clientId).toBe('master');
    expect(auth.agentTokenId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run src/__tests__/auth-token-id.test.ts
```

Expected: FAIL — `auth.agentTokenId` is `undefined` for agent tokens

- [ ] **Step 3: Update auth middleware**

In `src/middleware/auth.ts`, line 63, change the auth object for agent tokens:

```typescript
// Before:
(req as any).auth = { clientId: agentInfo.agentName, scopes: [agentInfo.role], projectId };

// After:
(req as any).auth = {
  clientId: agentInfo.agentName,
  agentTokenId: agentInfo.id,  // UUID from agent_tokens table
  scopes: [agentInfo.role],
  projectId,
};
```

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run src/__tests__/auth-token-id.test.ts
```

Expected: All 2 tests PASS

- [ ] **Step 5: Run all existing tests to verify no regression**

```bash
npx vitest run
```

Expected: All tests PASS (existing code only reads `clientId` and `scopes`, ignoring new field)

- [ ] **Step 6: Commit**

```bash
git add src/middleware/auth.ts src/__tests__/auth-token-id.test.ts
git commit -m "feat: propagate agent token UUID (agentTokenId) in auth middleware"
```

---

## Phase 1: Qdrant Integration

### Task 1: Add Qdrant dependency and config

**Files:**
- Modify: `package.json`
- Modify: `src/config.ts:5-56`

- [ ] **Step 1: Install Qdrant client**

```bash
cd d:/MCP/team-memory-mcp && npm install @qdrant/js-client-rest
```

- [ ] **Step 2: Add Qdrant config to AppConfig**

In `src/config.ts`, add to the `AppConfig` interface (after line 24):

```typescript
  // Qdrant / Vector Store
  vectorStore: 'qdrant' | 'pgvector';
  qdrantUrl: string;
  qdrantApiKey: string | undefined;
  ollamaEmbeddingModel: string;
```

In `loadConfig()` return object (after `ollamaUrl` line ~56):

```typescript
    vectorStore: (process.env.VECTOR_STORE as 'qdrant' | 'pgvector') || 'qdrant',
    qdrantUrl: process.env.QDRANT_URL || 'http://localhost:6333',
    qdrantApiKey: process.env.QDRANT_API_KEY || undefined,
    ollamaEmbeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text',
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json src/config.ts
git commit -m "feat: add Qdrant client dependency and config vars"
```

---

### Task 2: VectorStore interface

**Files:**
- Create: `src/vector/vector-store.ts`

- [ ] **Step 1: Create the interface**

```bash
mkdir -p src/vector
```

Write `src/vector/vector-store.ts`:

```typescript
/**
 * Abstract vector store interface.
 * Decouples embedding storage from the specific backend (Qdrant, pgvector, etc.)
 */

export interface VectorStoreSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface CollectionOptions {
  distance?: 'Cosine' | 'Euclid' | 'Dot';
  quantization?: 'scalar' | 'binary' | null;
  onDisk?: boolean;
}

export type VectorMatch =
  | { value: string | number | boolean }   // exact match (also matches if keyword[] contains value)
  | { any: (string | number)[] };          // match if payload array contains ANY of these values

export interface VectorFilterCondition {
  key: string;
  match: VectorMatch;
}

export interface VectorFilter {
  must?: VectorFilterCondition[];
  must_not?: VectorFilterCondition[];
  should?: VectorFilterCondition[];
}

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface VectorStore {
  /** Create collection if it doesn't exist */
  ensureCollection(name: string, dimensions: number, options?: CollectionOptions): Promise<void>;

  /** Upsert a single vector with payload */
  upsert(collection: string, id: string, vector: number[], payload: Record<string, unknown>): Promise<void>;

  /** Upsert multiple vectors in a batch */
  upsertBatch(collection: string, points: VectorPoint[]): Promise<void>;

  /** Search for nearest vectors with optional payload filtering */
  search(collection: string, vector: number[], filter?: VectorFilter, limit?: number): Promise<VectorStoreSearchResult[]>;

  /** Delete vectors by IDs */
  delete(collection: string, ids: string[]): Promise<void>;

  /** Delete vectors matching a filter */
  deleteByFilter(collection: string, filter: VectorFilter): Promise<void>;

  /** Create payload index for fast filtered search */
  createPayloadIndex(collection: string, field: string, schema: 'keyword' | 'integer' | 'bool'): Promise<void>;

  /** Check if collection exists */
  collectionExists(name: string): Promise<boolean>;

  /** Close connections */
  close(): Promise<void>;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/vector/vector-store.ts
git commit -m "feat: add VectorStore interface"
```

---

### Task 3: QdrantVectorStore implementation

**Files:**
- Create: `src/vector/qdrant-store.ts`
- Create: `src/__tests__/qdrant-store.test.ts`

- [ ] **Step 1: Write failing tests**

Write `src/__tests__/qdrant-store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QdrantVectorStore } from '../vector/qdrant-store.js';

// Mock @qdrant/js-client-rest
vi.mock('@qdrant/js-client-rest', () => {
  const mockClient = {
    collectionExists: vi.fn(),
    createCollection: vi.fn(),
    upsert: vi.fn(),
    search: vi.fn(),
    delete: vi.fn(),
    createPayloadIndex: vi.fn(),
  };
  return {
    QdrantClient: vi.fn(() => mockClient),
    __mockClient: mockClient,
  };
});

import { QdrantClient } from '@qdrant/js-client-rest';

function getMockClient() {
  return (QdrantClient as any).__mockClient ?? new (QdrantClient as any)();
}

describe('QdrantVectorStore', () => {
  let store: QdrantVectorStore;
  let mockClient: ReturnType<typeof getMockClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = getMockClient();
    store = new QdrantVectorStore('http://localhost:6333');
  });

  describe('ensureCollection', () => {
    it('creates collection when it does not exist', async () => {
      mockClient.collectionExists.mockResolvedValue({ exists: false });
      mockClient.createCollection.mockResolvedValue(true);
      mockClient.createPayloadIndex.mockResolvedValue(true);

      await store.ensureCollection('test', 768, { distance: 'Cosine' });

      expect(mockClient.createCollection).toHaveBeenCalledWith('test', {
        vectors: { size: 768, distance: 'Cosine' },
      });
    });

    it('skips creation when collection exists', async () => {
      mockClient.collectionExists.mockResolvedValue({ exists: true });

      await store.ensureCollection('test', 768);

      expect(mockClient.createCollection).not.toHaveBeenCalled();
    });

    it('applies scalar quantization when requested', async () => {
      mockClient.collectionExists.mockResolvedValue({ exists: false });
      mockClient.createCollection.mockResolvedValue(true);
      mockClient.createPayloadIndex.mockResolvedValue(true);

      await store.ensureCollection('test', 768, { quantization: 'scalar' });

      expect(mockClient.createCollection).toHaveBeenCalledWith('test', expect.objectContaining({
        vectors: { size: 768, distance: 'Cosine' },
        quantization_config: { scalar: { type: 'int8', always_ram: true } },
      }));
    });
  });

  describe('upsert', () => {
    it('upserts a single point', async () => {
      mockClient.upsert.mockResolvedValue(true);
      const vector = Array(768).fill(0.1);

      await store.upsert('test', 'id-1', vector, { key: 'value' });

      expect(mockClient.upsert).toHaveBeenCalledWith('test', {
        wait: true,
        points: [{ id: 'id-1', vector, payload: { key: 'value' } }],
      });
    });
  });

  describe('upsertBatch', () => {
    it('upserts multiple points', async () => {
      mockClient.upsert.mockResolvedValue(true);
      const points = [
        { id: 'a', vector: [0.1], payload: {} },
        { id: 'b', vector: [0.2], payload: {} },
      ];

      await store.upsertBatch('test', points);

      expect(mockClient.upsert).toHaveBeenCalledWith('test', {
        wait: true,
        points: [
          { id: 'a', vector: [0.1], payload: {} },
          { id: 'b', vector: [0.2], payload: {} },
        ],
      });
    });
  });

  describe('search', () => {
    it('returns scored results with payload', async () => {
      mockClient.search.mockResolvedValue([
        { id: 'id-1', score: 0.95, payload: { entry_id: 'abc' } },
        { id: 'id-2', score: 0.80, payload: { entry_id: 'def' } },
      ]);

      const results = await store.search('test', [0.1], undefined, 5);

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ id: 'id-1', score: 0.95, payload: { entry_id: 'abc' } });
    });

    it('passes filter to Qdrant', async () => {
      mockClient.search.mockResolvedValue([]);
      const filter = { must: [{ key: 'project_id', match: { value: 'proj-1' } }] };

      await store.search('test', [0.1], filter, 10);

      expect(mockClient.search).toHaveBeenCalledWith('test', {
        vector: [0.1],
        filter,
        limit: 10,
      });
    });
  });

  describe('delete', () => {
    it('deletes by IDs', async () => {
      mockClient.delete.mockResolvedValue(true);

      await store.delete('test', ['id-1', 'id-2']);

      expect(mockClient.delete).toHaveBeenCalledWith('test', {
        wait: true,
        points: ['id-1', 'id-2'],
      });
    });
  });

  describe('deleteByFilter', () => {
    it('deletes by filter', async () => {
      mockClient.delete.mockResolvedValue(true);
      const filter = { must: [{ key: 'session_id', match: { value: 'sess-1' } }] };

      await store.deleteByFilter('test', filter);

      expect(mockClient.delete).toHaveBeenCalledWith('test', {
        wait: true,
        filter,
      });
    });
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run src/__tests__/qdrant-store.test.ts
```

Expected: FAIL — `Cannot find module '../vector/qdrant-store.js'`

- [ ] **Step 3: Implement QdrantVectorStore**

Write `src/vector/qdrant-store.ts`:

```typescript
import { QdrantClient } from '@qdrant/js-client-rest';
import type {
  VectorStore,
  VectorStoreSearchResult,
  VectorFilter,
  VectorPoint,
  CollectionOptions,
} from './vector-store.js';
import { logger } from '../logger.js';

export class QdrantVectorStore implements VectorStore {
  private client: QdrantClient;

  constructor(url: string, apiKey?: string) {
    this.client = new QdrantClient({ url, apiKey });
  }

  async ensureCollection(name: string, dimensions: number, options?: CollectionOptions): Promise<void> {
    const { exists } = await this.client.collectionExists(name);
    if (exists) return;

    const config: Record<string, unknown> = {
      vectors: {
        size: dimensions,
        distance: options?.distance ?? 'Cosine',
      },
    };

    if (options?.quantization === 'scalar') {
      config.quantization_config = { scalar: { type: 'int8', always_ram: true } };
    } else if (options?.quantization === 'binary') {
      config.quantization_config = { binary: { always_ram: true } };
    }

    if (options?.onDisk) {
      (config.vectors as Record<string, unknown>).on_disk = true;
    }

    await this.client.createCollection(name, config);
    logger.info({ collection: name, dimensions }, 'Created Qdrant collection');
  }

  async createPayloadIndex(collection: string, field: string, schema: 'keyword' | 'integer' | 'bool'): Promise<void> {
    await this.client.createPayloadIndex(collection, {
      field_name: field,
      field_schema: schema,
    });
  }

  async upsert(collection: string, id: string, vector: number[], payload: Record<string, unknown>): Promise<void> {
    await this.client.upsert(collection, {
      wait: true,
      points: [{ id, vector, payload }],
    });
  }

  async upsertBatch(collection: string, points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;

    // Qdrant supports batches up to ~1000 points per call
    const BATCH_SIZE = 500;
    for (let i = 0; i < points.length; i += BATCH_SIZE) {
      const batch = points.slice(i, i + BATCH_SIZE);
      await this.client.upsert(collection, {
        wait: true,
        points: batch.map(p => ({ id: p.id, vector: p.vector, payload: p.payload })),
      });
    }
  }

  async search(
    collection: string,
    vector: number[],
    filter?: VectorFilter,
    limit: number = 10,
  ): Promise<VectorStoreSearchResult[]> {
    const results = await this.client.search(collection, {
      vector,
      filter,
      limit,
    });

    return results.map(r => ({
      id: String(r.id),
      score: r.score,
      payload: (r.payload ?? {}) as Record<string, unknown>,
    }));
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client.delete(collection, {
      wait: true,
      points: ids,
    });
  }

  async deleteByFilter(collection: string, filter: VectorFilter): Promise<void> {
    await this.client.delete(collection, {
      wait: true,
      filter,
    });
  }

  async collectionExists(name: string): Promise<boolean> {
    const { exists } = await this.client.collectionExists(name);
    return exists;
  }

  async close(): Promise<void> {
    // QdrantClient doesn't require explicit close
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run src/__tests__/qdrant-store.test.ts
```

Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/vector/qdrant-store.ts src/__tests__/qdrant-store.test.ts
git commit -m "feat: implement QdrantVectorStore with tests"
```

---

### Task 4: Update Ollama provider for configurable model

**Files:**
- Modify: `src/embedding/ollama.ts:10-13, 17-19, 23-57`
- Create: `src/__tests__/ollama-config.test.ts`

- [ ] **Step 1: Write failing test**

Write `src/__tests__/ollama-config.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { OllamaEmbeddingProvider } from '../embedding/ollama.js';

// We only test that config is accepted — not actual API calls
describe('OllamaEmbeddingProvider config', () => {
  it('uses default model name when not specified', () => {
    const provider = new OllamaEmbeddingProvider('http://localhost:11434');
    expect(provider.modelName).toBe('nomic-embed-text');
  });

  it('accepts custom model name', () => {
    const provider = new OllamaEmbeddingProvider('http://localhost:11434', 'nomic-embed-text-v2-moe');
    expect(provider.modelName).toBe('nomic-embed-text-v2-moe');
  });

  it('reports providerType as ollama', () => {
    const provider = new OllamaEmbeddingProvider('http://localhost:11434');
    expect(provider.providerType).toBe('ollama');
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run src/__tests__/ollama-config.test.ts
```

Expected: FAIL — constructor doesn't accept second argument (or modelName is wrong)

- [ ] **Step 3: Update OllamaEmbeddingProvider**

In `src/embedding/ollama.ts`, change the hardcoded model name to a constructor parameter:

Replace the model constants (lines ~10-13):
```typescript
const DEFAULT_MODEL = 'nomic-embed-text';
const DEFAULT_DIMENSIONS = 768;
```

Update constructor (lines ~17-19):
```typescript
constructor(baseUrl: string = 'http://localhost:11434', model?: string) {
  this.baseUrl = baseUrl;
  this._modelName = model || DEFAULT_MODEL;
}
```

Update the `modelName` getter to return `this._modelName` instead of the hardcoded constant.

Update `initialize()` to use `this._modelName` in the Ollama API calls (pulling model, checking tags, etc.) instead of the hardcoded `'nomic-embed-text'`.

Update `embed()` and `embedBatch()` to use `this._modelName` in the model field of API requests.

Add `private _modelName: string;` field.

- [ ] **Step 4: Run test — verify it passes**

```bash
npx vitest run src/__tests__/ollama-config.test.ts
```

Expected: All 3 tests PASS

- [ ] **Step 5: Run all existing tests to verify no regression**

```bash
npx vitest run
```

Expected: All tests PASS (existing embedding tests still work with default model)

- [ ] **Step 6: Commit**

```bash
git add src/embedding/ollama.ts src/__tests__/ollama-config.test.ts
git commit -m "feat: support configurable Ollama embedding model via constructor param"
```

---

### Task 5: Wire VectorStore into MemoryManager

**Files:**
- Modify: `src/memory/manager.ts:36-40, 133-173, 175-215, 217-270, 331-347`
- Create: `src/__tests__/manager-qdrant.test.ts`

- [ ] **Step 1: Write failing tests**

Write `src/__tests__/manager-qdrant.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryManager } from '../memory/manager.js';
import type { VectorStore } from '../vector/vector-store.js';

function createMockStorage() {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockImplementation(async (entry: any) => entry),
    update: vi.fn().mockImplementation(async (_id: string, updates: any) => ({
      id: 'test-id',
      projectId: '00000000-0000-0000-0000-000000000000',
      category: 'tasks',
      domain: null,
      title: 'Test',
      content: 'Content',
      author: 'agent',
      tags: [],
      priority: 'medium',
      status: 'active',
      pinned: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      relatedIds: [],
      ...updates,
    })),
    delete: vi.fn().mockResolvedValue(true),
    archive: vi.fn().mockResolvedValue({ status: 'archived' }),
    getById: vi.fn().mockResolvedValue(null),
    getChangesSince: vi.fn().mockResolvedValue([]),
    getLastUpdated: vi.fn().mockResolvedValue('2026-01-01T00:00:00.000Z'),
    getStats: vi.fn().mockResolvedValue({ total: 0, byCategory: {}, byPriority: {}, byStatus: {} }),
    archiveOldEntries: vi.fn().mockResolvedValue(0),
    count: vi.fn().mockResolvedValue(0),
    getProject: vi.fn().mockResolvedValue(null),
    createProject: vi.fn().mockResolvedValue({ id: 'proj-1', name: 'Test' }),
    listProjects: vi.fn().mockResolvedValue([]),
    updateProject: vi.fn().mockResolvedValue(undefined),
    deleteProject: vi.fn().mockResolvedValue(true),
    getByIds: vi.fn().mockResolvedValue([]),
    hybridSearch: vi.fn().mockResolvedValue([]),
    saveEmbedding: vi.fn().mockResolvedValue(undefined),
    setEmbeddingDimensions: vi.fn().mockResolvedValue(undefined),
    trackReads: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockVectorStore(): VectorStore {
  return {
    ensureCollection: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    upsertBatch: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteByFilter: vi.fn().mockResolvedValue(undefined),
    createPayloadIndex: vi.fn().mockResolvedValue(undefined),
    collectionExists: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockEmbeddingProvider() {
  return {
    embed: vi.fn().mockResolvedValue(Array(768).fill(0.1)),
    embedBatch: vi.fn().mockResolvedValue([Array(768).fill(0.1)]),
    isReady: vi.fn().mockReturnValue(true),
    dimensions: 768,
    modelName: 'test-model',
    providerType: 'ollama' as const,
  };
}

describe('MemoryManager with VectorStore', () => {
  let manager: MemoryManager;
  let storage: ReturnType<typeof createMockStorage>;
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let embedding: ReturnType<typeof createMockEmbeddingProvider>;

  beforeEach(async () => {
    storage = createMockStorage();
    vectorStore = createMockVectorStore();
    embedding = createMockEmbeddingProvider();
    manager = new MemoryManager(storage as any);
    manager.setVectorStore(vectorStore);
    await manager.setEmbeddingProvider(embedding as any);
  });

  it('upserts to Qdrant on write', async () => {
    storage.add.mockImplementation(async (entry: any) => ({ ...entry, id: 'new-id' }));

    await manager.write({
      category: 'tasks',
      title: 'Test task',
      content: 'Test content',
    });

    // Wait for async embedding
    await new Promise(r => setTimeout(r, 50));

    expect(vectorStore.upsert).toHaveBeenCalledWith(
      'entries',
      'new-id',
      expect.any(Array),
      expect.objectContaining({ entry_id: 'new-id' }),
    );
  });

  it('searches Qdrant when vector store is set', async () => {
    vectorStore.search.mockResolvedValue([
      { id: 'vec-1', score: 0.9, payload: { entry_id: 'entry-1' } },
    ]);
    storage.getByIds.mockResolvedValue([{
      id: 'entry-1',
      projectId: '00000000-0000-0000-0000-000000000000',
      title: 'Found',
      content: 'Content',
      category: 'tasks',
      domain: null,
      status: 'active',
      priority: 'medium',
      tags: [],
      pinned: false,
      author: 'agent',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      relatedIds: [],
    }]);

    const results = await manager.read({
      search: 'test query',
      mode: 'full',
    });

    expect(embedding.embed).toHaveBeenCalledWith('test query', 'query');
    expect(vectorStore.search).toHaveBeenCalledWith(
      'entries',
      expect.any(Array),
      expect.objectContaining({
        must: expect.arrayContaining([
          expect.objectContaining({ key: 'project_id' }),
        ]),
      }),
      expect.any(Number),
    );
  });

  it('deletes from Qdrant on delete', async () => {
    storage.getById.mockResolvedValue({ id: 'del-id', status: 'active' });
    storage.delete.mockResolvedValue(true);

    await manager.delete({ id: 'del-id', archive: false });

    expect(vectorStore.delete).toHaveBeenCalledWith('entries', ['del-id']);
  });

  it('falls back to FTS when Qdrant search fails', async () => {
    vectorStore.search.mockRejectedValue(new Error('Qdrant unavailable'));
    storage.search.mockResolvedValue([]);

    const results = await manager.read({ search: 'test query' });

    expect(storage.search).toHaveBeenCalled();
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run src/__tests__/manager-qdrant.test.ts
```

Expected: FAIL — `manager.setVectorStore is not a function`

- [ ] **Step 3: Modify MemoryManager**

In `src/memory/manager.ts`:

**Add import** at top:
```typescript
import type { VectorStore, VectorFilter } from '../vector/vector-store.js';
```

**Add field** after existing fields (~line 34):
```typescript
private vectorStore?: VectorStore;
```

**Add setter** (new method):
```typescript
setVectorStore(store: VectorStore): void {
  this.vectorStore = store;
}
```

**Update write() flow** (~line 208-212) — replace pgvector saveEmbedding with Qdrant upsert:

Replace the fire-and-forget embedding block:
```typescript
// Old: storage.saveEmbedding(created.id, embedding)
// New: upsert to Qdrant
if (this.embeddingProvider?.isReady()) {
  this.embeddingProvider.embed(created.title + '\n' + created.content, 'document')
    .then(vector => {
      if (this.vectorStore) {
        return this.vectorStore.upsert('entries', created.id, vector, {
          entry_id: created.id,
          project_id: created.projectId,
          category: created.category,
          domain: created.domain ?? '',
          status: created.status,
          tags: created.tags,
          author: created.author,
        });
      }
      // Fallback: save to PG if no vector store (migration period)
      return this.storage.saveEmbedding(created.id, vector);
    })
    .catch(err => logger.error({ err, entryId: created.id }, 'Failed to generate/store embedding'));
}
```

**Update read() flow** (~line 145-165) — use Qdrant for vector search:

When `search` is provided and embedding + vectorStore are ready:
```typescript
if (params.search && this.embeddingProvider?.isReady() && this.vectorStore) {
  try {
    const queryVector = await this.embeddingProvider.embed(params.search, 'query');
    const filter: VectorFilter = {
      must: [{ key: 'project_id', match: { value: projectId } }],
    };
    if (params.category && params.category !== 'all') {
      filter.must!.push({ key: 'category', match: { value: params.category } });
    }
    if (params.status) {
      filter.must!.push({ key: 'status', match: { value: params.status } });
    }
    const vectorResults = await this.vectorStore.search('entries', queryVector, filter, params.limit);
    const ftsResults = await this.storage.search(projectId, params.search, { ...filterOpts, compact: false });

    // Merge: FTS results + vector results by ID, weighted scoring
    return this.mergeSearchResults(ftsResults, vectorResults, params);
  } catch (err) {
    logger.warn({ err }, 'Vector search failed, falling back to FTS');
    return this.storage.search(projectId, params.search, filterOpts);
  }
}
```

Add `mergeSearchResults()` private method that:
1. Gets full entries by IDs from vector results via `storage.getByIds()`
2. Builds a score map: FTS results get position-based score (1.0 → 0.0), vector results use Qdrant score
3. Deduplicates by ID
4. Sorts by weighted score: `0.4 * ftsScore + 0.6 * vectorScore`
5. Returns merged list, trimmed to limit

**Update delete() flow** — add Qdrant cleanup:
```typescript
// After storage.delete() succeeds:
if (this.vectorStore) {
  this.vectorStore.delete('entries', [id]).catch(err =>
    logger.warn({ err, entryId: id }, 'Failed to delete vector'));
}
```

**Update update() flow** — re-embed on content change to Qdrant:
```typescript
// Replace storage.saveEmbedding with vectorStore.upsert
if (this.vectorStore) {
  this.vectorStore.upsert('entries', id, vector, {
    entry_id: id,
    project_id: updated.projectId,
    category: updated.category,
    domain: updated.domain ?? '',
    status: updated.status,
    tags: updated.tags,
    author: updated.author,
  });
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run src/__tests__/manager-qdrant.test.ts
```

Expected: All 4 tests PASS

- [ ] **Step 5: Run all tests**

```bash
npx vitest run
```

Expected: All tests PASS (existing manager.test.ts still works because vectorStore is optional)

- [ ] **Step 6: Commit**

```bash
git add src/memory/manager.ts src/__tests__/manager-qdrant.test.ts
git commit -m "feat: wire VectorStore into MemoryManager for hybrid search"
```

---

### Task 6: Wire Qdrant into app startup

**Files:**
- Modify: `src/index.ts` (or `src/app.ts` — wherever embedding provider is initialized)

- [ ] **Step 1: Add Qdrant initialization to startup**

In the file where `OllamaEmbeddingProvider` is created (likely `src/index.ts` or `src/app.ts`), after the embedding provider setup:

```typescript
import { QdrantVectorStore } from './vector/qdrant-store.js';

// After embedding provider is created:
if (config.vectorStore === 'qdrant') {
  const vectorStore = new QdrantVectorStore(config.qdrantUrl, config.qdrantApiKey);
  await vectorStore.ensureCollection('entries', embeddingProvider.dimensions);
  await vectorStore.createPayloadIndex('entries', 'project_id', 'keyword');
  await vectorStore.createPayloadIndex('entries', 'category', 'keyword');
  await vectorStore.createPayloadIndex('entries', 'status', 'keyword');
  await vectorStore.createPayloadIndex('entries', 'author', 'keyword');
  memoryManager.setVectorStore(vectorStore);
  logger.info({ url: config.qdrantUrl }, 'Qdrant vector store connected');
}

// When creating OllamaEmbeddingProvider, pass the model name:
const ollamaProvider = new OllamaEmbeddingProvider(config.ollamaUrl, config.ollamaEmbeddingModel);
```

- [ ] **Step 2: Add Qdrant to docker-compose.yml**

Add after the existing postgres service in `docker-compose.yml`:

```yaml
  qdrant:
    image: qdrant/qdrant:v1.13.2
    ports:
      - "127.0.0.1:6333:6333"
      - "127.0.0.1:6334:6334"
    volumes:
      - qdrant_data:/qdrant/storage
    environment:
      QDRANT__SERVICE__GRPC_PORT: 6334
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO", "/dev/null", "http://localhost:6333/healthz"]
      interval: 10s
      timeout: 5s
      retries: 3
```

Add `qdrant_data:` to the `volumes:` section.

Add `QDRANT_URL`, `VECTOR_STORE`, `OLLAMA_EMBEDDING_MODEL` env vars to the app service.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts src/app.ts docker-compose.yml
git commit -m "feat: wire Qdrant into app startup and docker-compose"
```

---

### Task 7: Data migration script (pgvector → Qdrant)

**Files:**
- Create: `src/vector/migrate-pgvector.ts`

**Context:** Before dropping the embedding column, we must migrate all existing vectors to Qdrant. Without this step, all embeddings are permanently lost.

- [ ] **Step 1: Write migration script**

Write `src/vector/migrate-pgvector.ts`:

```typescript
import { Pool } from 'pg';
import type { VectorStore } from './vector-store.js';
import { logger } from '../logger.js';

/**
 * Migrate all existing embeddings from pgvector (entries.embedding) to Qdrant.
 * Run this BEFORE migration 011 (which drops the embedding column).
 */
export async function migratePgvectorToQdrant(
  pool: Pool,
  vectorStore: VectorStore,
  dimensions: number,
): Promise<{ migrated: number; skipped: number }> {
  await vectorStore.ensureCollection('entries', dimensions);

  // Read all entries that have embeddings
  const { rows } = await pool.query(`
    SELECT id, project_id, category, domain, status, tags, author, embedding::text
    FROM entries
    WHERE embedding IS NOT NULL
  `);

  let migrated = 0;
  let skipped = 0;
  const BATCH_SIZE = 100;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const points = batch.map(row => {
      // Parse pgvector text representation: "[0.1,0.2,...]"
      // pgvector text format is already valid JSON: [0.1,0.2,...]
      const vector = JSON.parse(row.embedding);
      if (!Array.isArray(vector) || vector.length !== dimensions) {
        skipped++;
        return null;
      }
      migrated++;
      return {
        id: row.id,
        vector,
        payload: {
          entry_id: row.id,
          project_id: row.project_id,
          category: row.category,
          domain: row.domain ?? '',
          status: row.status,
          tags: row.tags || [],
          author: row.author,
        },
      };
    }).filter((p): p is NonNullable<typeof p> => p !== null);

    if (points.length > 0) {
      await vectorStore.upsertBatch('entries', points);
    }

    logger.info({ progress: Math.min(i + BATCH_SIZE, rows.length), total: rows.length }, 'Migration progress');
  }

  logger.info({ migrated, skipped, total: rows.length }, 'pgvector → Qdrant migration complete');
  return { migrated, skipped };
}
```

- [ ] **Step 2: Add migration invocation to startup**

In `src/index.ts` or `src/app.ts`, after Qdrant is connected but before normal operation, check if migration is needed:

```typescript
// One-time migration: pgvector → Qdrant
// Check if entries still have embedding column (migration 011 not yet applied)
const { rows: [{ exists: hasEmbeddingCol }] } = await pool.query(`
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'entries' AND column_name = 'embedding'
  )
`);

if (hasEmbeddingCol && config.vectorStore === 'qdrant') {
  const { migratePgvectorToQdrant } = await import('./vector/migrate-pgvector.js');
  await migratePgvectorToQdrant(pool, vectorStore, embeddingProvider.dimensions);
  logger.info('pgvector → Qdrant migration complete. You can now apply migration 011 to drop the embedding column.');
}
```

- [ ] **Step 3: Commit**

```bash
git add src/vector/migrate-pgvector.ts
git commit -m "feat: data migration script pgvector → Qdrant"
```

---

### Task 7b: PG migration to drop pgvector

**Files:**
- Create: `src/storage/migrations/011-drop-pgvector.sql`

- [ ] **Step 1: Write migration**

Write `src/storage/migrations/011-drop-pgvector.sql`:

```sql
-- Migration 011: Drop pgvector embedding column
-- Run AFTER Qdrant migration has been validated
-- Embeddings are now stored in Qdrant

-- Drop HNSW index on embedding column
DROP INDEX IF EXISTS idx_entries_embedding;

-- Drop the embedding column from entries table
ALTER TABLE entries DROP COLUMN IF EXISTS embedding;

-- Update schema version
UPDATE schema_meta SET value = '2.3.0' WHERE key = 'version';
```

- [ ] **Step 2: Commit**

```bash
git add src/storage/migrations/011-drop-pgvector.sql
git commit -m "feat: migration 011 to drop pgvector embedding column"
```

---

## Phase 2: Personal Notes

### Task 8: PG migration for personal_notes table

**Files:**
- Create: `src/storage/migrations/012-personal-notes.sql`

- [ ] **Step 1: Write migration**

Write `src/storage/migrations/012-personal-notes.sql`:

```sql
-- Migration 012: Personal notes with token-based access isolation

CREATE TABLE IF NOT EXISTS personal_notes (
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

CREATE INDEX IF NOT EXISTS idx_personal_notes_agent ON personal_notes(agent_token_id);
CREATE INDEX IF NOT EXISTS idx_personal_notes_project ON personal_notes(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_personal_notes_session ON personal_notes(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_personal_notes_status ON personal_notes(agent_token_id, status);
CREATE INDEX IF NOT EXISTS idx_personal_notes_search ON personal_notes USING GIN(search_vector);

-- FTS trigger (reuses existing update_search_vector function)
DROP TRIGGER IF EXISTS update_personal_notes_search_vector ON personal_notes;
CREATE TRIGGER update_personal_notes_search_vector
  BEFORE INSERT OR UPDATE OF title, content, tags ON personal_notes
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();

-- Timestamp trigger
DROP TRIGGER IF EXISTS update_personal_notes_timestamp ON personal_notes;
CREATE TRIGGER update_personal_notes_timestamp
  BEFORE UPDATE ON personal_notes
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Update schema version
UPDATE schema_meta SET value = '2.4.0' WHERE key = 'version';
```

- [ ] **Step 2: Commit**

```bash
git add src/storage/migrations/012-personal-notes.sql
git commit -m "feat: migration 012 for personal_notes table"
```

---

### Task 9: Personal Notes types and validation

**Files:**
- Create: `src/notes/types.ts`
- Create: `src/notes/validation.ts`

- [ ] **Step 1: Create types**

```bash
mkdir -p src/notes
```

Write `src/notes/types.ts`:

```typescript
export interface PersonalNote {
  id: string;
  agentTokenId: string;
  projectId: string | null;
  sessionId: string | null;
  title: string;
  content: string;
  tags: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface CompactPersonalNote {
  id: string;
  agentTokenId: string;
  projectId: string | null;
  sessionId: string | null;
  title: string;
  tags: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'active' | 'archived';
  updatedAt: string;
}

export interface NoteFilters {
  projectId?: string;
  sessionId?: string;
  search?: string;
  tags?: string[];
  status?: 'active' | 'archived';
  mode?: 'compact' | 'full';
  limit?: number;
  offset?: number;
}
```

- [ ] **Step 2: Create validation schemas**

Write `src/notes/validation.ts`:

```typescript
import { z } from 'zod';

const UuidSchema = z.string().uuid('Invalid UUID format');
const PriorityEnum = z.enum(['low', 'medium', 'high', 'critical']);
const StatusEnum = z.enum(['active', 'archived']);

export const NoteWriteSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(50000),
  tags: z.array(z.string().max(50)).max(20).default([]),
  priority: PriorityEnum.default('medium'),
  project_id: UuidSchema.optional(),
  session_id: UuidSchema.optional(),
});

export const NoteReadSchema = z.object({
  search: z.string().max(500).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  project_id: UuidSchema.optional(),
  session_id: UuidSchema.optional(),
  status: StatusEnum.optional(),
  mode: z.enum(['compact', 'full']).default('compact'),
  limit: z.number().int().min(1).default(50).transform(v => Math.min(v, 500)),
  offset: z.number().int().min(0).default(0),
});

export const NoteUpdateSchema = z.object({
  id: UuidSchema,
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(50000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  priority: PriorityEnum.optional(),
  status: StatusEnum.optional(),
  project_id: UuidSchema.nullable().optional(),
  session_id: UuidSchema.nullable().optional(),
});

export const NoteDeleteSchema = z.object({
  id: UuidSchema,
  archive: z.boolean().default(true),
});

export const NoteSearchSchema = z.object({
  query: z.string().min(1).max(500),
  project_id: UuidSchema.optional(),
  session_id: UuidSchema.optional(),
  limit: z.number().int().min(1).default(10).transform(v => Math.min(v, 50)),
});
```

- [ ] **Step 3: Commit**

```bash
git add src/notes/types.ts src/notes/validation.ts
git commit -m "feat: personal notes types and Zod validation schemas"
```

---

### Task 10: PersonalNotesStorage

**Files:**
- Create: `src/notes/storage.ts`
- Create: `src/__tests__/notes-storage.test.ts`

- [ ] **Step 1: Write failing tests**

Write `src/__tests__/notes-storage.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PersonalNotesStorage } from '../notes/storage.js';

function createMockPool() {
  const mockResult = { rows: [], rowCount: 0 };
  return {
    query: vi.fn().mockResolvedValue(mockResult),
  };
}

describe('PersonalNotesStorage', () => {
  let storage: PersonalNotesStorage;
  let pool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    pool = createMockPool();
    storage = new PersonalNotesStorage(pool as any);
  });

  describe('create', () => {
    it('inserts note with agent_token_id', async () => {
      const note = {
        agentTokenId: 'token-1',
        title: 'My note',
        content: 'Content here',
        tags: ['test'],
        priority: 'medium' as const,
        projectId: null,
        sessionId: null,
      };

      pool.query.mockResolvedValue({
        rows: [{ id: 'note-1', agent_token_id: 'token-1', title: 'My note', content: 'Content here',
                 tags: ['test'], priority: 'medium', status: 'active', project_id: null,
                 session_id: null, created_at: '2026-01-01', updated_at: '2026-01-01' }],
        rowCount: 1,
      });

      const result = await storage.create(note);

      expect(pool.query).toHaveBeenCalled();
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('INSERT INTO personal_notes');
      expect(sql).toContain('agent_token_id');
      expect(result.id).toBe('note-1');
    });
  });

  describe('getAll', () => {
    it('always filters by agent_token_id', async () => {
      pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await storage.getAll('token-1', {});

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('agent_token_id = $1');
      expect(pool.query.mock.calls[0][1]![0]).toBe('token-1');
    });

    it('allows master token to see all notes (null agentTokenId)', async () => {
      pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await storage.getAll(null, {});

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).not.toContain('agent_token_id = $1');
    });

    it('filters by project_id when provided', async () => {
      pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      await storage.getAll('token-1', { projectId: 'proj-1' });

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('project_id');
    });
  });

  describe('update', () => {
    it('verifies ownership before updating', async () => {
      // First query: check ownership
      pool.query
        .mockResolvedValueOnce({ rows: [{ agent_token_id: 'token-1' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'note-1', agent_token_id: 'token-1' }], rowCount: 1 });

      await storage.update('note-1', 'token-1', { title: 'Updated' });

      // First call should check ownership
      const ownershipSql = pool.query.mock.calls[0][0] as string;
      expect(ownershipSql).toContain('SELECT');
      expect(ownershipSql).toContain('agent_token_id');
    });

    it('throws on ownership mismatch', async () => {
      pool.query.mockResolvedValue({ rows: [{ agent_token_id: 'other-token' }], rowCount: 1 });

      await expect(
        storage.update('note-1', 'token-1', { title: 'Hack' }),
      ).rejects.toThrow(/access denied|forbidden/i);
    });
  });

  describe('delete', () => {
    it('verifies ownership before deleting', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ agent_token_id: 'token-1' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await storage.delete('note-1', 'token-1', false);

      expect(pool.query).toHaveBeenCalledTimes(2);
    });
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run src/__tests__/notes-storage.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement PersonalNotesStorage**

Write `src/notes/storage.ts`:

```typescript
import type { Pool } from 'pg';
import type { PersonalNote, CompactPersonalNote, NoteFilters } from './types.js';
import { logger } from '../logger.js';

export class PersonalNotesStorage {
  constructor(private pool: Pool) {}

  async create(note: {
    agentTokenId: string;
    title: string;
    content: string;
    tags: string[];
    priority: string;
    projectId: string | null;
    sessionId: string | null;
  }): Promise<PersonalNote> {
    const { rows } = await this.pool.query(
      `INSERT INTO personal_notes (agent_token_id, title, content, tags, priority, project_id, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [note.agentTokenId, note.title, note.content, note.tags, note.priority, note.projectId, note.sessionId],
    );
    return this.rowToNote(rows[0]);
  }

  async getAll(agentTokenId: string | null, filters: NoteFilters): Promise<(PersonalNote | CompactPersonalNote)[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (agentTokenId !== null) {
      conditions.push(`agent_token_id = $${idx++}`);
      params.push(agentTokenId);
    }
    if (filters.projectId) {
      conditions.push(`project_id = $${idx++}`);
      params.push(filters.projectId);
    }
    if (filters.sessionId) {
      conditions.push(`session_id = $${idx++}`);
      params.push(filters.sessionId);
    }
    if (filters.status) {
      conditions.push(`status = $${idx++}`);
      params.push(filters.status);
    }
    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`tags && $${idx++}`);
      params.push(filters.tags);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const columns = filters.mode === 'full'
      ? '*'
      : 'id, agent_token_id, project_id, session_id, title, tags, priority, status, updated_at';

    const { rows } = await this.pool.query(
      `SELECT ${columns} FROM personal_notes ${where} ORDER BY updated_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );

    return rows.map(r => filters.mode === 'full' ? this.rowToNote(r) : this.rowToCompact(r));
  }

  async search(agentTokenId: string | null, query: string, filters: NoteFilters): Promise<PersonalNote[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (agentTokenId !== null) {
      conditions.push(`agent_token_id = $${idx++}`);
      params.push(agentTokenId);
    }

    conditions.push(`(search_vector @@ plainto_tsquery($${idx}) OR title ILIKE $${idx + 1} OR content ILIKE $${idx + 1})`);
    params.push(query, `%${query}%`);
    idx += 2;

    if (filters.projectId) {
      conditions.push(`project_id = $${idx++}`);
      params.push(filters.projectId);
    }

    const where = conditions.join(' AND ');
    const limit = filters.limit ?? 50;

    const { rows } = await this.pool.query(
      `SELECT * FROM personal_notes WHERE ${where} ORDER BY updated_at DESC LIMIT $${idx++}`,
      [...params, limit],
    );

    return rows.map(r => this.rowToNote(r));
  }

  async getById(id: string): Promise<PersonalNote | null> {
    const { rows } = await this.pool.query('SELECT * FROM personal_notes WHERE id = $1', [id]);
    return rows.length > 0 ? this.rowToNote(rows[0]) : null;
  }

  async update(
    id: string,
    agentTokenId: string | null,
    updates: Partial<{ title: string; content: string; tags: string[]; priority: string; status: string; projectId: string | null; sessionId: string | null }>,
  ): Promise<PersonalNote> {
    // Verify ownership (skip for master token)
    if (agentTokenId !== null) {
      const { rows } = await this.pool.query('SELECT agent_token_id FROM personal_notes WHERE id = $1', [id]);
      if (rows.length === 0) throw new Error('Note not found');
      if (rows[0].agent_token_id !== agentTokenId) throw new Error('Access denied: not your note');
    }

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (updates.title !== undefined) { setClauses.push(`title = $${idx++}`); params.push(updates.title); }
    if (updates.content !== undefined) { setClauses.push(`content = $${idx++}`); params.push(updates.content); }
    if (updates.tags !== undefined) { setClauses.push(`tags = $${idx++}`); params.push(updates.tags); }
    if (updates.priority !== undefined) { setClauses.push(`priority = $${idx++}`); params.push(updates.priority); }
    if (updates.status !== undefined) { setClauses.push(`status = $${idx++}`); params.push(updates.status); }
    if (updates.projectId !== undefined) { setClauses.push(`project_id = $${idx++}`); params.push(updates.projectId); }
    if (updates.sessionId !== undefined) { setClauses.push(`session_id = $${idx++}`); params.push(updates.sessionId); }

    if (setClauses.length === 0) {
      return (await this.getById(id))!;
    }

    params.push(id);
    const { rows } = await this.pool.query(
      `UPDATE personal_notes SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    );

    return this.rowToNote(rows[0]);
  }

  async delete(id: string, agentTokenId: string | null, archive: boolean): Promise<boolean> {
    // Verify ownership
    if (agentTokenId !== null) {
      const { rows } = await this.pool.query('SELECT agent_token_id FROM personal_notes WHERE id = $1', [id]);
      if (rows.length === 0) return false;
      if (rows[0].agent_token_id !== agentTokenId) throw new Error('Access denied: not your note');
    }

    if (archive) {
      await this.pool.query("UPDATE personal_notes SET status = 'archived' WHERE id = $1", [id]);
    } else {
      await this.pool.query('DELETE FROM personal_notes WHERE id = $1', [id]);
    }
    return true;
  }

  private rowToNote(row: any): PersonalNote {
    return {
      id: row.id,
      agentTokenId: row.agent_token_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      title: row.title,
      content: row.content,
      tags: row.tags || [],
      priority: row.priority,
      status: row.status,
      createdAt: row.created_at?.toISOString?.() ?? row.created_at,
      updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
    };
  }

  private rowToCompact(row: any): CompactPersonalNote {
    return {
      id: row.id,
      agentTokenId: row.agent_token_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      title: row.title,
      tags: row.tags || [],
      priority: row.priority,
      status: row.status,
      updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
    };
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run src/__tests__/notes-storage.test.ts
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/notes/storage.ts src/__tests__/notes-storage.test.ts
git commit -m "feat: PersonalNotesStorage with token-based access isolation"
```

---

### Task 11: NotesManager (orchestration layer)

**Files:**
- Create: `src/notes/manager.ts`
- Create: `src/__tests__/notes-manager.test.ts`

- [ ] **Step 1: Write failing tests**

Write `src/__tests__/notes-manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotesManager } from '../notes/manager.js';

function createMockNotesStorage() {
  return {
    create: vi.fn().mockResolvedValue({ id: 'note-1', title: 'Test', agentTokenId: 'tok-1' }),
    getAll: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
    getById: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue({ id: 'note-1', title: 'Updated' }),
    delete: vi.fn().mockResolvedValue(true),
  };
}

function createMockVectorStore() {
  return {
    ensureCollection: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    upsertBatch: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteByFilter: vi.fn().mockResolvedValue(undefined),
    createPayloadIndex: vi.fn().mockResolvedValue(undefined),
    collectionExists: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockEmbedding() {
  return {
    embed: vi.fn().mockResolvedValue(Array(768).fill(0.1)),
    embedBatch: vi.fn().mockResolvedValue([Array(768).fill(0.1)]),
    isReady: vi.fn().mockReturnValue(true),
    dimensions: 768,
    modelName: 'test',
    providerType: 'ollama' as const,
  };
}

describe('NotesManager', () => {
  let manager: NotesManager;
  let storage: ReturnType<typeof createMockNotesStorage>;
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let embedding: ReturnType<typeof createMockEmbedding>;

  beforeEach(() => {
    storage = createMockNotesStorage();
    vectorStore = createMockVectorStore();
    embedding = createMockEmbedding();
    manager = new NotesManager(storage as any, vectorStore as any, embedding as any);
  });

  it('creates note and upserts embedding to Qdrant', async () => {
    storage.create.mockResolvedValue({
      id: 'note-1',
      agentTokenId: 'tok-1',
      title: 'Test',
      content: 'Content',
      tags: [],
      priority: 'medium',
      status: 'active',
      projectId: null,
      sessionId: null,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });

    const note = await manager.write('tok-1', {
      title: 'Test',
      content: 'Content',
      tags: [],
      priority: 'medium',
      projectId: null,
      sessionId: null,
    });

    expect(storage.create).toHaveBeenCalled();
    // Wait for async embedding
    await new Promise(r => setTimeout(r, 50));
    expect(vectorStore.upsert).toHaveBeenCalledWith(
      'personal_notes',
      'note-1',
      expect.any(Array),
      expect.objectContaining({ agent_token_id: 'tok-1' }),
    );
  });

  it('semantic search filters by agent_token_id', async () => {
    vectorStore.search.mockResolvedValue([
      { id: 'note-1', score: 0.9, payload: { note_id: 'note-1' } },
    ]);
    storage.getById.mockResolvedValue({
      id: 'note-1', title: 'Found', content: 'X', agentTokenId: 'tok-1',
    });

    await manager.semanticSearch('tok-1', 'test query');

    expect(vectorStore.search).toHaveBeenCalledWith(
      'personal_notes',
      expect.any(Array),
      expect.objectContaining({
        must: expect.arrayContaining([
          { key: 'agent_token_id', match: { value: 'tok-1' } },
        ]),
      }),
      expect.any(Number),
    );
  });

  it('deletes note and removes vector from Qdrant', async () => {
    await manager.delete('note-1', 'tok-1', false);

    expect(storage.delete).toHaveBeenCalledWith('note-1', 'tok-1', false);
    expect(vectorStore.delete).toHaveBeenCalledWith('personal_notes', ['note-1']);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run src/__tests__/notes-manager.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement NotesManager**

Write `src/notes/manager.ts`:

```typescript
import type { PersonalNotesStorage } from './storage.js';
import type { PersonalNote, CompactPersonalNote, NoteFilters } from './types.js';
import type { VectorStore, VectorFilter } from '../vector/vector-store.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import { logger } from '../logger.js';

export class NotesManager {
  constructor(
    private storage: PersonalNotesStorage,
    private vectorStore?: VectorStore,
    private embeddingProvider?: EmbeddingProvider,
  ) {}

  async write(agentTokenId: string, data: {
    title: string;
    content: string;
    tags: string[];
    priority: string;
    projectId: string | null;
    sessionId: string | null;
  }): Promise<PersonalNote> {
    const note = await this.storage.create({ agentTokenId, ...data });

    // Fire-and-forget: embed and store vector
    if (this.embeddingProvider?.isReady() && this.vectorStore) {
      this.embeddingProvider.embed(note.title + '\n' + note.content, 'document')
        .then(vector => this.vectorStore!.upsert('personal_notes', note.id, vector, {
          note_id: note.id,
          agent_token_id: agentTokenId,
          project_id: note.projectId ?? '',
          session_id: note.sessionId ?? '',
          tags: note.tags,
          status: note.status,
        }))
        .catch(err => logger.error({ err, noteId: note.id }, 'Failed to embed note'));
    }

    return note;
  }

  async read(agentTokenId: string | null, filters: NoteFilters): Promise<(PersonalNote | CompactPersonalNote)[]> {
    if (filters.search) {
      return this.storage.search(agentTokenId, filters.search, filters);
    }
    return this.storage.getAll(agentTokenId, filters);
  }

  async update(noteId: string, agentTokenId: string | null, updates: Record<string, unknown>): Promise<PersonalNote> {
    const note = await this.storage.update(noteId, agentTokenId, updates as any);

    // Re-embed if content changed
    if ((updates.title || updates.content) && this.embeddingProvider?.isReady() && this.vectorStore) {
      this.embeddingProvider.embed(note.title + '\n' + note.content, 'document')
        .then(vector => this.vectorStore!.upsert('personal_notes', note.id, vector, {
          note_id: note.id,
          agent_token_id: note.agentTokenId,
          project_id: note.projectId ?? '',
          session_id: note.sessionId ?? '',
          tags: note.tags,
          status: note.status,
        }))
        .catch(err => logger.error({ err, noteId: note.id }, 'Failed to re-embed note'));
    }

    return note;
  }

  async delete(noteId: string, agentTokenId: string | null, archive: boolean): Promise<boolean> {
    const result = await this.storage.delete(noteId, agentTokenId, archive);

    if (!archive && this.vectorStore) {
      this.vectorStore.delete('personal_notes', [noteId])
        .catch(err => logger.warn({ err, noteId }, 'Failed to delete note vector'));
    }

    return result;
  }

  async semanticSearch(agentTokenId: string, query: string, options?: {
    projectId?: string;
    sessionId?: string;
    limit?: number;
  }): Promise<Array<PersonalNote & { score: number }>> {
    if (!this.embeddingProvider?.isReady() || !this.vectorStore) {
      return [];
    }

    const queryVector = await this.embeddingProvider.embed(query, 'query');
    const filter: VectorFilter = {
      must: [{ key: 'agent_token_id', match: { value: agentTokenId } }],
    };
    if (options?.projectId) {
      filter.must!.push({ key: 'project_id', match: { value: options.projectId } });
    }
    if (options?.sessionId) {
      filter.must!.push({ key: 'session_id', match: { value: options.sessionId } });
    }

    const results = await this.vectorStore.search('personal_notes', queryVector, filter, options?.limit ?? 10);

    const notes = await Promise.all(
      results.map(async r => {
        const note = await this.storage.getById(r.payload.note_id as string);
        return note ? { ...note, score: r.score } : null;
      }),
    );

    return notes.filter((n): n is PersonalNote & { score: number } => n !== null);
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run src/__tests__/notes-manager.test.ts
```

Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/notes/manager.ts src/__tests__/notes-manager.test.ts
git commit -m "feat: NotesManager with Qdrant integration and token isolation"
```

---

### Task 12: Register note_* MCP tools in server.ts

**Files:**
- Modify: `src/server.ts:46-54, 307-450+`
- Create: `src/__tests__/notes-tools.test.ts`

- [ ] **Step 1: Write failing test for auth isolation**

Write `src/__tests__/notes-tools.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { NoteWriteSchema, NoteReadSchema, NoteSearchSchema, NoteUpdateSchema, NoteDeleteSchema } from '../notes/validation.js';

describe('Note tool validation schemas', () => {
  describe('NoteWriteSchema', () => {
    it('accepts valid input', () => {
      const result = NoteWriteSchema.safeParse({
        title: 'My note',
        content: 'Some content',
        tags: ['test'],
      });
      expect(result.success).toBe(true);
    });

    it('rejects empty title', () => {
      const result = NoteWriteSchema.safeParse({ title: '', content: 'x' });
      expect(result.success).toBe(false);
    });

    it('defaults priority to medium', () => {
      const result = NoteWriteSchema.parse({ title: 'X', content: 'Y' });
      expect(result.priority).toBe('medium');
    });
  });

  describe('NoteReadSchema', () => {
    it('defaults mode to compact', () => {
      const result = NoteReadSchema.parse({});
      expect(result.mode).toBe('compact');
    });

    it('caps limit at 500', () => {
      const result = NoteReadSchema.parse({ limit: 9999 });
      expect(result.limit).toBe(500);
    });
  });

  describe('NoteSearchSchema', () => {
    it('requires query', () => {
      const result = NoteSearchSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests — verify they pass** (validation already implemented)

```bash
npx vitest run src/__tests__/notes-tools.test.ts
```

Expected: All tests PASS

- [ ] **Step 3: Add note tools to server.ts**

In `src/server.ts`, add to the `buildMcpServer` function signature:
```typescript
export function buildMcpServer(
  memoryManager: MemoryManager,
  agentTokenStore?: AgentTokenStore,
  notesManager?: NotesManager,  // NEW
): Server
```

Add 5 tool definitions to the tools list:
- `note_write` — uses NoteWriteSchema
- `note_read` — uses NoteReadSchema
- `note_update` — uses NoteUpdateSchema
- `note_delete` — uses NoteDeleteSchema
- `note_search` — uses NoteSearchSchema

Add tool handlers in the switch statement. Key pattern for each handler:

```typescript
case 'note_write': {
  if (!notesManager) return { content: [{ type: 'text', text: 'Notes not configured' }], isError: true };
  const parsed = NoteWriteSchema.safeParse(args);
  if (!parsed.success) return { content: [{ type: 'text', text: formatZodError(parsed.error) }], isError: true };

  // Extract agent token UUID from auth (added in Task 0) — critical for isolation
  // Master token (clientId === 'master') passes null → can see all notes (admin)
  // Agent token passes UUID → sees only own notes
  const isMaster = (extra as any)?.authInfo?.clientId === 'master';
  const agentTokenId: string | null = isMaster
    ? null
    : ((extra as any)?.authInfo?.agentTokenId as string | undefined) ?? null;
  if (!isMaster && !agentTokenId) return { content: [{ type: 'text', text: 'Agent token required for personal notes' }], isError: true };

  const note = await notesManager.write(agentTokenId, {
    title: parsed.data.title,
    content: parsed.data.content,
    tags: parsed.data.tags,
    priority: parsed.data.priority,
    projectId: parsed.data.project_id ?? null,
    sessionId: parsed.data.session_id ?? null,
  });

  return { content: [{ type: 'text', text: `Note created: ${note.id}\nTitle: ${note.title}` }] };
}
```

Each remaining handler follows the same pattern: parse with Zod → extract `agentTokenId` from `(extra as any)?.authInfo?.agentTokenId` → reject if missing → delegate to `notesManager`. Specific details:

- `note_read`: parse NoteReadSchema → `notesManager.read(agentTokenId, parsed.data)` → format as list
- `note_update`: parse NoteUpdateSchema → `notesManager.update(parsed.data.id, agentTokenId, parsed.data)` → format result
- `note_delete`: parse NoteDeleteSchema → `notesManager.delete(parsed.data.id, agentTokenId, parsed.data.archive)` → confirm
- `note_search`: parse NoteSearchSchema → `notesManager.semanticSearch(agentTokenId, parsed.data.query, parsed.data)` → format with scores

**Call site update:** Also update `src/app.ts:104`:
```typescript
// Before:
mountMcpTransport(app, () => buildMcpServer(memoryManager, agentTokenStore));
// After:
mountMcpTransport(app, () => buildMcpServer(memoryManager, agentTokenStore, notesManager));
```
And `src/server.ts:786` (StdioMcpServer constructor):
```typescript
this.server = buildMcpServer(memoryManager, undefined, undefined);
```

- [ ] **Step 4: Run all tests**

```bash
npx vitest run
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/__tests__/notes-tools.test.ts
git commit -m "feat: register 5 note_* MCP tools with token-based auth"
```

---

## Phase 3: Session Import

### Task 13: PG migration for sessions tables

**Files:**
- Create: `src/storage/migrations/013-sessions.sql`

- [ ] **Step 1: Write migration**

Write `src/storage/migrations/013-sessions.sql`:

```sql
-- Migration 013: Sessions + session messages + FK for personal_notes

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_token_id UUID NOT NULL REFERENCES agent_tokens(id),
  project_id UUID REFERENCES projects(id),

  external_id TEXT,
  name TEXT,
  summary TEXT NOT NULL,
  working_directory TEXT,
  git_branch TEXT,

  message_count INT DEFAULT 0,
  embedding_status TEXT DEFAULT 'pending'
    CHECK (embedding_status IN ('pending', 'processing', 'complete', 'failed')),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ DEFAULT NOW(),

  tags TEXT[] DEFAULT '{}',
  search_vector TSVECTOR,

  UNIQUE(agent_token_id, external_id)
);

CREATE TABLE IF NOT EXISTS session_messages (
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
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_token_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_external ON sessions(agent_token_id, external_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(agent_token_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_search ON sessions USING GIN(search_vector);

-- Message indexes
CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_session_messages_search ON session_messages USING GIN(search_vector);

-- IMPORTANT: Cannot reuse update_search_vector() because:
--   - sessions has `name`/`summary` instead of `title`/`content`
--   - session_messages has only `content`, no `title` or `tags`
-- Dedicated FTS functions for each table:

CREATE OR REPLACE FUNCTION update_sessions_search_vector()
RETURNS TRIGGER AS $$
DECLARE
    lang TEXT;
BEGIN
    lang := COALESCE(current_setting('app.fts_language', true), 'simple');
    NEW.search_vector :=
        setweight(to_tsvector(lang::regconfig, coalesce(NEW.name, '')), 'A') ||
        setweight(to_tsvector(lang::regconfig, coalesce(NEW.summary, '')), 'B') ||
        setweight(to_tsvector(lang::regconfig, coalesce(array_to_string(NEW.tags, ' '), '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_session_messages_search_vector()
RETURNS TRIGGER AS $$
DECLARE
    lang TEXT;
BEGIN
    lang := COALESCE(current_setting('app.fts_language', true), 'simple');
    NEW.search_vector :=
        setweight(to_tsvector(lang::regconfig, coalesce(NEW.content, '')), 'A');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- FTS triggers using dedicated functions
DROP TRIGGER IF EXISTS trg_sessions_search ON sessions;
CREATE TRIGGER trg_sessions_search
  BEFORE INSERT OR UPDATE OF name, summary, tags ON sessions
  FOR EACH ROW EXECUTE FUNCTION update_sessions_search_vector();

DROP TRIGGER IF EXISTS trg_session_messages_search ON session_messages;
CREATE TRIGGER trg_session_messages_search
  BEFORE INSERT OR UPDATE OF content ON session_messages
  FOR EACH ROW EXECUTE FUNCTION update_session_messages_search_vector();

DROP TRIGGER IF EXISTS update_sessions_timestamp ON sessions;
CREATE TRIGGER update_sessions_timestamp
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Add FK from personal_notes.session_id now that sessions table exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_personal_notes_session'
  ) THEN
    ALTER TABLE personal_notes
      ADD CONSTRAINT fk_personal_notes_session
      FOREIGN KEY (session_id) REFERENCES sessions(id);
  END IF;
END$$;

-- Update schema version
UPDATE schema_meta SET value = '2.5.0' WHERE key = 'version';
```

- [ ] **Step 2: Commit**

```bash
git add src/storage/migrations/013-sessions.sql
git commit -m "feat: migration 013 for sessions and session_messages tables"
```

---

### Task 14: Session types, validation, and adaptive chunking

**Files:**
- Create: `src/sessions/types.ts`
- Create: `src/sessions/validation.ts`
- Create: `src/sessions/chunking.ts`
- Create: `src/__tests__/chunking.test.ts`

- [ ] **Step 1: Create types**

```bash
mkdir -p src/sessions
```

Write `src/sessions/types.ts`:

```typescript
export interface Session {
  id: string;
  agentTokenId: string;
  projectId: string | null;
  externalId: string | null;
  name: string | null;
  summary: string;
  workingDirectory: string | null;
  gitBranch: string | null;
  messageCount: number;
  embeddingStatus: 'pending' | 'processing' | 'complete' | 'failed';
  startedAt: string | null;
  endedAt: string | null;
  importedAt: string;
  tags: string[];
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  messageIndex: number;
  hasToolUse: boolean;
  toolNames: string[];
  timestamp: string | null;
}

export interface SessionChunk {
  text: string;
  messageId: string;
  chunkIndex: number;
  totalChunks: number;
}

export interface SessionFilters {
  projectId?: string;
  tags?: string[];
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  limit?: number;
  offset?: number;
}
```

- [ ] **Step 2: Create validation schemas**

Write `src/sessions/validation.ts`:

```typescript
import { z } from 'zod';

const UuidSchema = z.string().uuid('Invalid UUID format');

export const SessionImportSchema = z.object({
  external_id: z.string().max(200).optional(),
  name: z.string().max(500).optional(),
  summary: z.string().min(1).max(10000),
  project_id: UuidSchema.optional(),
  working_directory: z.string().max(1000).optional(),
  git_branch: z.string().max(200).optional(),
  tags: z.array(z.string().max(50)).max(20).default([]),
  started_at: z.string().datetime().optional(),
  ended_at: z.string().datetime().optional(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string().min(1).max(500000),
    timestamp: z.string().datetime().optional(),
    tool_names: z.array(z.string().max(100)).default([]),
  })).min(1).max(50000),
});

export const SessionListSchema = z.object({
  project_id: UuidSchema.optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  date_from: z.string().datetime().optional(),
  date_to: z.string().datetime().optional(),
  search: z.string().max(500).optional(),
  limit: z.number().int().min(1).default(20).transform(v => Math.min(v, 100)),
  offset: z.number().int().min(0).default(0),
});

export const SessionSearchSchema = z.object({
  query: z.string().min(1).max(500),
  project_id: UuidSchema.optional(),
  limit: z.number().int().min(1).default(10).transform(v => Math.min(v, 50)),
});

export const SessionReadSchema = z.object({
  session_id: UuidSchema,
  message_from: z.number().int().min(0).default(0),
  message_to: z.number().int().min(0).optional(),
});

export const SessionMessageSearchSchema = z.object({
  query: z.string().min(1).max(500),
  session_id: UuidSchema.optional(),
  limit: z.number().int().min(1).default(10).transform(v => Math.min(v, 50)),
});

export const SessionDeleteSchema = z.object({
  session_id: UuidSchema,
});
```

- [ ] **Step 3: Write failing chunking tests**

Write `src/__tests__/chunking.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { chunkMessage, estimateTokens } from '../sessions/chunking.js';

describe('estimateTokens', () => {
  it('estimates roughly 4 chars per token for English', () => {
    const tokens = estimateTokens('Hello world, this is a test.');
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(15);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('chunkMessage', () => {
  it('returns single chunk for short messages', () => {
    const chunks = chunkMessage('Short message', 'msg-1');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].totalChunks).toBe(1);
    expect(chunks[0].messageId).toBe('msg-1');
    expect(chunks[0].text).toBe('Short message');
  });

  it('splits long messages into multiple chunks', () => {
    // Create a ~3000 token message (approx 12000 chars)
    const longMessage = 'word '.repeat(3000);
    const chunks = chunkMessage(longMessage, 'msg-2');

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[chunks.length - 1].chunkIndex).toBe(chunks.length - 1);
    chunks.forEach(c => {
      expect(c.totalChunks).toBe(chunks.length);
      expect(c.messageId).toBe('msg-2');
    });
  });

  it('includes overlap between chunks', () => {
    const longMessage = 'word '.repeat(3000);
    const chunks = chunkMessage(longMessage, 'msg-3');

    // Second chunk should start before first chunk ends (overlap)
    if (chunks.length >= 2) {
      const firstEnd = chunks[0].text.length;
      const fullText = chunks.map(c => c.text).join('');
      // Due to overlap, joined text will be longer than original
      expect(fullText.length).toBeGreaterThan(longMessage.length);
    }
  });

  it('preserves all content across chunks', () => {
    const longMessage = 'The quick brown fox jumps over the lazy dog. '.repeat(200);
    const chunks = chunkMessage(longMessage, 'msg-4');

    // Every part of the original should appear in at least one chunk
    const words = ['quick', 'brown', 'fox', 'jumps', 'lazy', 'dog'];
    words.forEach(word => {
      const found = chunks.some(c => c.text.includes(word));
      expect(found).toBe(true);
    });
  });
});
```

- [ ] **Step 4: Run tests — verify they fail**

```bash
npx vitest run src/__tests__/chunking.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 5: Implement adaptive chunking**

Write `src/sessions/chunking.ts`:

```typescript
import type { SessionChunk } from './types.js';

const MAX_CHUNK_TOKENS = 2000;
const OVERLAP_TOKENS = 100;
const CHARS_PER_TOKEN = 4;  // rough estimate

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function charsForTokens(tokens: number): number {
  return tokens * CHARS_PER_TOKEN;
}

export function chunkMessage(content: string, messageId: string): SessionChunk[] {
  const tokens = estimateTokens(content);

  if (tokens <= MAX_CHUNK_TOKENS) {
    return [{
      text: content,
      messageId,
      chunkIndex: 0,
      totalChunks: 1,
    }];
  }

  const chunks: SessionChunk[] = [];
  const maxChars = charsForTokens(MAX_CHUNK_TOKENS);
  const stepChars = charsForTokens(MAX_CHUNK_TOKENS - OVERLAP_TOKENS);
  let offset = 0;

  while (offset < content.length) {
    const end = Math.min(offset + maxChars, content.length);
    chunks.push({
      text: content.slice(offset, end),
      messageId,
      chunkIndex: chunks.length,
      totalChunks: -1,  // set after
    });
    offset += stepChars;
    if (end === content.length) break;
  }

  chunks.forEach(c => c.totalChunks = chunks.length);
  return chunks;
}
```

- [ ] **Step 6: Run tests — verify they pass**

```bash
npx vitest run src/__tests__/chunking.test.ts
```

Expected: All 5 tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/sessions/types.ts src/sessions/validation.ts src/sessions/chunking.ts src/__tests__/chunking.test.ts
git commit -m "feat: session types, validation, and adaptive chunking"
```

---

### Task 15: SessionStorage

**Files:**
- Create: `src/sessions/storage.ts`
- Create: `src/__tests__/sessions-storage.test.ts`

- [ ] **Step 1: Write failing tests**

Write `src/__tests__/sessions-storage.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionStorage } from '../sessions/storage.js';

function createMockPool() {
  // createSession uses pool.connect() → client.query(), not pool.query() directly
  const mockClient = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: vi.fn().mockResolvedValue(mockClient),
    _mockClient: mockClient,  // expose for assertions
  };
}

describe('SessionStorage', () => {
  let storage: SessionStorage;
  let pool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    pool = createMockPool();
    storage = new SessionStorage(pool as any);
  });

  describe('createSession', () => {
    it('inserts session and messages in a transaction', async () => {
      const client = pool._mockClient;
      client.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // BEGIN
        .mockResolvedValueOnce({
          rows: [{
            id: 'sess-1', agent_token_id: 'tok-1', summary: 'Test', message_count: 2,
            embedding_status: 'pending', imported_at: '2026-01-01',
            external_id: null, name: null, project_id: null,
            working_directory: null, git_branch: null, tags: [],
            started_at: null, ended_at: null, search_vector: null,
          }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 2 })  // batch insert messages
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

      const result = await storage.createSession({
        agentTokenId: 'tok-1',
        summary: 'Test',
        messages: [
          { role: 'user', content: 'Hello', toolNames: [] },
          { role: 'assistant', content: 'Hi', toolNames: [] },
        ],
      });

      expect(result.id).toBe('sess-1');
      // Verify transaction: BEGIN, INSERT session, INSERT messages, COMMIT
      expect(client.query.mock.calls[0][0]).toBe('BEGIN');
      expect((client.query.mock.calls[1][0] as string)).toContain('INSERT INTO sessions');
      expect((client.query.mock.calls[2][0] as string)).toContain('INSERT INTO session_messages');
      expect(client.query.mock.calls[3][0]).toBe('COMMIT');
      expect(client.release).toHaveBeenCalled();
    });
  });

  describe('listSessions', () => {
    it('filters by agent_token_id', async () => {
      await storage.listSessions('tok-1', {});

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('agent_token_id = $1');
    });
  });

  describe('getMessages', () => {
    it('returns messages ordered by index', async () => {
      pool.query.mockResolvedValue({
        rows: [
          { id: 'm1', session_id: 's1', role: 'user', content: 'Q', message_index: 0 },
          { id: 'm2', session_id: 's1', role: 'assistant', content: 'A', message_index: 1 },
        ],
        rowCount: 2,
      });

      const messages = await storage.getMessages('s1', 0);

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('ORDER BY message_index');
    });
  });

  describe('deleteSession', () => {
    it('verifies ownership before deletion', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ agent_token_id: 'tok-1' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await storage.deleteSession('sess-1', 'tok-1');

      const ownershipSql = pool.query.mock.calls[0][0] as string;
      expect(ownershipSql).toContain('agent_token_id');
    });

    it('throws on ownership mismatch', async () => {
      pool.query.mockResolvedValue({ rows: [{ agent_token_id: 'other' }], rowCount: 1 });

      await expect(
        storage.deleteSession('sess-1', 'tok-1'),
      ).rejects.toThrow(/access denied|forbidden/i);
    });
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run src/__tests__/sessions-storage.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement SessionStorage**

Write `src/sessions/storage.ts`:

```typescript
import type { Pool } from 'pg';
import type { Session, SessionMessage, SessionFilters } from './types.js';
import { logger } from '../logger.js';

export class SessionStorage {
  constructor(private pool: Pool) {}

  async createSession(data: {
    agentTokenId: string;
    externalId?: string;
    name?: string;
    summary: string;
    projectId?: string;
    workingDirectory?: string;
    gitBranch?: string;
    tags?: string[];
    startedAt?: string;
    endedAt?: string;
    messages: Array<{
      role: string;
      content: string;
      timestamp?: string;
      toolNames: string[];
    }>;
  }): Promise<Session> {
    // Use transaction: session + messages must be atomic
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Insert session
      const { rows: [session] } = await client.query(
        `INSERT INTO sessions (agent_token_id, external_id, name, summary, project_id, working_directory, git_branch, tags, started_at, ended_at, message_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          data.agentTokenId, data.externalId ?? null, data.name ?? null, data.summary,
          data.projectId ?? null, data.workingDirectory ?? null, data.gitBranch ?? null,
          data.tags ?? [], data.startedAt ?? null, data.endedAt ?? null, data.messages.length,
        ],
      );

      // Batch insert messages
      if (data.messages.length > 0) {
        const values: string[] = [];
        const params: unknown[] = [];
        let idx = 1;

        data.messages.forEach((msg, i) => {
          const hasToolUse = msg.toolNames.length > 0;
          values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
          params.push(session.id, msg.role, msg.content, i, hasToolUse, msg.toolNames, msg.timestamp ?? null);
        });

        await client.query(
          `INSERT INTO session_messages (session_id, role, content, message_index, has_tool_use, tool_names, timestamp)
           VALUES ${values.join(', ')}`,
          params,
        );
      }

      await client.query('COMMIT');
      return this.rowToSession(session);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async findByExternalId(agentTokenId: string, externalId: string): Promise<Session | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM sessions WHERE agent_token_id = $1 AND external_id = $2',
      [agentTokenId, externalId],
    );
    return rows.length > 0 ? this.rowToSession(rows[0]) : null;
  }

  async listSessions(agentTokenId: string, filters: SessionFilters): Promise<Session[]> {
    const conditions = ['agent_token_id = $1'];
    const params: unknown[] = [agentTokenId];
    let idx = 2;

    if (filters.projectId) {
      conditions.push(`project_id = $${idx++}`);
      params.push(filters.projectId);
    }
    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`tags && $${idx++}`);
      params.push(filters.tags);
    }
    if (filters.dateFrom) {
      conditions.push(`started_at >= $${idx++}`);
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push(`started_at <= $${idx++}`);
      params.push(filters.dateTo);
    }
    if (filters.search) {
      conditions.push(`(search_vector @@ plainto_tsquery($${idx}) OR name ILIKE $${idx + 1} OR summary ILIKE $${idx + 1})`);
      params.push(filters.search, `%${filters.search}%`);
      idx += 2;
    }

    const limit = filters.limit ?? 20;
    const offset = filters.offset ?? 0;

    const { rows } = await this.pool.query(
      `SELECT * FROM sessions WHERE ${conditions.join(' AND ')} ORDER BY started_at DESC NULLS LAST LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );

    return rows.map(r => this.rowToSession(r));
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const { rows } = await this.pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    return rows.length > 0 ? this.rowToSession(rows[0]) : null;
  }

  async getMessages(sessionId: string, from: number = 0, to?: number): Promise<SessionMessage[]> {
    let sql = 'SELECT * FROM session_messages WHERE session_id = $1 AND message_index >= $2';
    const params: unknown[] = [sessionId, from];
    let idx = 3;

    if (to !== undefined) {
      sql += ` AND message_index <= $${idx++}`;
      params.push(to);
    }

    sql += ' ORDER BY message_index ASC';

    const { rows } = await this.pool.query(sql, params);
    return rows.map(r => this.rowToMessage(r));
  }

  async updateEmbeddingStatus(sessionId: string, status: string): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET embedding_status = $1 WHERE id = $2',
      [status, sessionId],
    );
  }

  async deleteSession(sessionId: string, agentTokenId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      'SELECT agent_token_id FROM sessions WHERE id = $1', [sessionId],
    );
    if (rows.length === 0) return false;
    if (rows[0].agent_token_id !== agentTokenId) throw new Error('Access denied: not your session');

    await this.pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    return true;
  }

  private rowToSession(row: any): Session {
    return {
      id: row.id,
      agentTokenId: row.agent_token_id,
      projectId: row.project_id,
      externalId: row.external_id,
      name: row.name,
      summary: row.summary,
      workingDirectory: row.working_directory,
      gitBranch: row.git_branch,
      messageCount: row.message_count,
      embeddingStatus: row.embedding_status,
      startedAt: row.started_at?.toISOString?.() ?? row.started_at,
      endedAt: row.ended_at?.toISOString?.() ?? row.ended_at,
      importedAt: row.imported_at?.toISOString?.() ?? row.imported_at,
      tags: row.tags || [],
    };
  }

  private rowToMessage(row: any): SessionMessage {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      messageIndex: row.message_index,
      hasToolUse: row.has_tool_use,
      toolNames: row.tool_names || [],
      timestamp: row.timestamp?.toISOString?.() ?? row.timestamp,
    };
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run src/__tests__/sessions-storage.test.ts
```

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sessions/storage.ts src/__tests__/sessions-storage.test.ts
git commit -m "feat: SessionStorage with batch message insert and ownership checks"
```

---

### Task 16: SessionManager (orchestration with embedding)

**Files:**
- Create: `src/sessions/manager.ts`
- Create: `src/__tests__/sessions-manager.test.ts`

- [ ] **Step 1: Write failing tests**

Write `src/__tests__/sessions-manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../sessions/manager.js';

function createMockSessionStorage() {
  return {
    createSession: vi.fn().mockResolvedValue({
      id: 'sess-1', agentTokenId: 'tok-1', summary: 'Test', messageCount: 2,
      embeddingStatus: 'pending', tags: [],
    }),
    findByExternalId: vi.fn().mockResolvedValue(null),
    listSessions: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue(null),
    getMessages: vi.fn().mockResolvedValue([]),
    updateEmbeddingStatus: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(true),
  };
}

function createMockVectorStore() {
  return {
    ensureCollection: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue(undefined),
    upsertBatch: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteByFilter: vi.fn().mockResolvedValue(undefined),
    createPayloadIndex: vi.fn().mockResolvedValue(undefined),
    collectionExists: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockEmbedding() {
  return {
    embed: vi.fn().mockResolvedValue(Array(768).fill(0.1)),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) =>
      texts.map(() => Array(768).fill(0.1)),
    ),
    isReady: vi.fn().mockReturnValue(true),
    dimensions: 768,
    modelName: 'test',
    providerType: 'ollama' as const,
  };
}

describe('SessionManager', () => {
  let manager: SessionManager;
  let storage: ReturnType<typeof createMockSessionStorage>;
  let vectorStore: ReturnType<typeof createMockVectorStore>;
  let embedding: ReturnType<typeof createMockEmbedding>;

  beforeEach(() => {
    storage = createMockSessionStorage();
    vectorStore = createMockVectorStore();
    embedding = createMockEmbedding();
    manager = new SessionManager(storage as any, vectorStore as any, embedding as any);
  });

  describe('import', () => {
    it('creates session and embeds summary + messages', async () => {
      const result = await manager.importSession('tok-1', {
        summary: 'Discussed auth',
        messages: [
          { role: 'user', content: 'How to add JWT?', toolNames: [] },
          { role: 'assistant', content: 'Use jsonwebtoken...', toolNames: [] },
        ],
      });

      expect(storage.createSession).toHaveBeenCalled();
      expect(result.id).toBe('sess-1');

      // Wait for async embedding
      await new Promise(r => setTimeout(r, 100));

      // Summary should be embedded to sessions collection
      expect(vectorStore.upsert).toHaveBeenCalledWith(
        'sessions', 'sess-1', expect.any(Array),
        expect.objectContaining({ agent_token_id: 'tok-1' }),
      );

      // Messages should be batch-embedded to session_messages collection
      expect(vectorStore.upsertBatch).toHaveBeenCalledWith(
        'session_messages',
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({ session_id: 'sess-1', agent_token_id: 'tok-1' }),
          }),
        ]),
      );
    });

    it('returns existing session on duplicate external_id', async () => {
      storage.findByExternalId.mockResolvedValue({
        id: 'existing-sess', summary: 'Old', messageCount: 5,
      });

      const result = await manager.importSession('tok-1', {
        externalId: 'ext-1',
        summary: 'New',
        messages: [{ role: 'user', content: 'x', toolNames: [] }],
      });

      expect(result.id).toBe('existing-sess');
      expect(storage.createSession).not.toHaveBeenCalled();
    });
  });

  describe('searchSessions', () => {
    it('searches by summary embedding with agent filter', async () => {
      vectorStore.search.mockResolvedValue([
        { id: 'sess-1', score: 0.9, payload: { session_id: 'sess-1' } },
      ]);
      storage.getSession.mockResolvedValue({
        id: 'sess-1', summary: 'Auth discussion', agentTokenId: 'tok-1',
      });

      const results = await manager.searchSessions('tok-1', 'authentication');

      expect(vectorStore.search).toHaveBeenCalledWith(
        'sessions', expect.any(Array),
        expect.objectContaining({
          must: expect.arrayContaining([
            { key: 'agent_token_id', match: { value: 'tok-1' } },
          ]),
        }),
        expect.any(Number),
      );
    });
  });

  describe('searchMessages', () => {
    it('searches within specific session', async () => {
      vectorStore.search.mockResolvedValue([
        { id: 'chunk-1', score: 0.85, payload: { message_id: 'msg-1', session_id: 'sess-1', chunk_index: 0 } },
      ]);

      await manager.searchMessages('tok-1', 'JWT token', { sessionId: 'sess-1' });

      expect(vectorStore.search).toHaveBeenCalledWith(
        'session_messages', expect.any(Array),
        expect.objectContaining({
          must: expect.arrayContaining([
            { key: 'agent_token_id', match: { value: 'tok-1' } },
            { key: 'session_id', match: { value: 'sess-1' } },
          ]),
        }),
        expect.any(Number),
      );
    });
  });

  describe('deleteSession', () => {
    it('deletes from PG and both Qdrant collections', async () => {
      await manager.deleteSession('sess-1', 'tok-1');

      expect(storage.deleteSession).toHaveBeenCalledWith('sess-1', 'tok-1');
      expect(vectorStore.delete).toHaveBeenCalledWith('sessions', ['sess-1']);
      expect(vectorStore.deleteByFilter).toHaveBeenCalledWith('session_messages', {
        must: [{ key: 'session_id', match: { value: 'sess-1' } }],
      });
    });
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run src/__tests__/sessions-manager.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement SessionManager**

Write `src/sessions/manager.ts`:

```typescript
import type { SessionStorage } from './storage.js';
import type { Session, SessionMessage, SessionFilters, SessionChunk } from './types.js';
import type { VectorStore, VectorFilter } from '../vector/vector-store.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import { chunkMessage } from './chunking.js';
import { logger } from '../logger.js';

export class SessionManager {
  constructor(
    private storage: SessionStorage,
    private vectorStore?: VectorStore,
    private embeddingProvider?: EmbeddingProvider,
  ) {}

  async importSession(agentTokenId: string, data: {
    externalId?: string;
    name?: string;
    summary: string;
    projectId?: string;
    workingDirectory?: string;
    gitBranch?: string;
    tags?: string[];
    startedAt?: string;
    endedAt?: string;
    messages: Array<{ role: string; content: string; timestamp?: string; toolNames: string[] }>;
  }): Promise<Session & { chunkCount?: number }> {
    // Check duplicate
    if (data.externalId) {
      const existing = await this.storage.findByExternalId(agentTokenId, data.externalId);
      if (existing) return existing;
    }

    const session = await this.storage.createSession({ agentTokenId, ...data });

    // Async: embed summary + messages
    if (this.embeddingProvider?.isReady() && this.vectorStore) {
      this.embedSessionAsync(session, agentTokenId, data.messages).catch(err =>
        logger.error({ err, sessionId: session.id }, 'Failed to embed session'),
      );
    }

    return session;
  }

  private async embedSessionAsync(
    session: Session,
    agentTokenId: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<void> {
    await this.storage.updateEmbeddingStatus(session.id, 'processing');

    try {
      // 1. Embed summary → sessions collection
      const summaryVector = await this.embeddingProvider!.embed(session.summary, 'document');
      await this.vectorStore!.upsert('sessions', session.id, summaryVector, {
        session_id: session.id,
        agent_token_id: agentTokenId,
        project_id: session.projectId ?? '',
        name: session.name ?? '',
        tags: session.tags,
        started_at: session.startedAt ? new Date(session.startedAt).getTime() : 0,
        message_count: session.messageCount,
      });

      // 2. Chunk and embed messages → session_messages collection
      // Get message IDs from DB (they were assigned during createSession)
      const dbMessages = await this.storage.getMessages(session.id, 0);
      const allChunks: SessionChunk[] = [];

      for (const msg of dbMessages) {
        const chunks = chunkMessage(msg.content, msg.id);
        allChunks.push(...chunks);
      }

      // Batch embed all chunks (with fallback to sequential if embedBatch not available)
      if (allChunks.length > 0) {
        const texts = allChunks.map(c => c.text);
        const vectors = this.embeddingProvider!.embedBatch
          ? await this.embeddingProvider!.embedBatch(texts, 'document')
          : await Promise.all(texts.map(t => this.embeddingProvider!.embed(t, 'document')));

        const points = allChunks.map((chunk, i) => {
          const msg = dbMessages.find(m => m.id === chunk.messageId)!;
          return {
            id: `${chunk.messageId}_${chunk.chunkIndex}`,
            vector: vectors[i],
            payload: {
              message_id: chunk.messageId,
              session_id: session.id,
              agent_token_id: agentTokenId,
              role: msg.role,
              message_index: msg.messageIndex,
              chunk_index: chunk.chunkIndex,
              total_chunks: chunk.totalChunks,
              has_tool_use: msg.hasToolUse,
              tool_names: msg.toolNames,
            },
          };
        });

        await this.vectorStore!.upsertBatch('session_messages', points);
      }

      await this.storage.updateEmbeddingStatus(session.id, 'complete');
      logger.info({ sessionId: session.id, chunks: allChunks.length }, 'Session embedding complete');
    } catch (err) {
      await this.storage.updateEmbeddingStatus(session.id, 'failed');
      throw err;
    }
  }

  async listSessions(agentTokenId: string, filters: SessionFilters): Promise<Session[]> {
    return this.storage.listSessions(agentTokenId, filters);
  }

  async readSession(sessionId: string, agentTokenId: string, from?: number, to?: number): Promise<{
    session: Session;
    messages: SessionMessage[];
  } | null> {
    const session = await this.storage.getSession(sessionId);
    if (!session) return null;
    if (session.agentTokenId !== agentTokenId) throw new Error('Access denied: not your session');

    const messages = await this.storage.getMessages(sessionId, from ?? 0, to);
    return { session, messages };
  }

  async searchSessions(agentTokenId: string, query: string, options?: {
    projectId?: string;
    limit?: number;
  }): Promise<Array<Session & { score: number }>> {
    if (!this.embeddingProvider?.isReady() || !this.vectorStore) return [];

    const queryVector = await this.embeddingProvider.embed(query, 'query');
    const filter: VectorFilter = {
      must: [{ key: 'agent_token_id', match: { value: agentTokenId } }],
    };
    if (options?.projectId) {
      filter.must!.push({ key: 'project_id', match: { value: options.projectId } });
    }

    const results = await this.vectorStore.search('sessions', queryVector, filter, options?.limit ?? 10);

    const sessions = await Promise.all(
      results.map(async r => {
        const session = await this.storage.getSession(r.payload.session_id as string);
        return session ? { ...session, score: r.score } : null;
      }),
    );

    return sessions.filter((s): s is Session & { score: number } => s !== null);
  }

  async searchMessages(agentTokenId: string, query: string, options?: {
    sessionId?: string;
    limit?: number;
  }): Promise<Array<{ messageId: string; sessionId: string; role: string; content: string; score: number; chunkIndex: number }>> {
    if (!this.embeddingProvider?.isReady() || !this.vectorStore) return [];

    const queryVector = await this.embeddingProvider.embed(query, 'query');
    const filter: VectorFilter = {
      must: [{ key: 'agent_token_id', match: { value: agentTokenId } }],
    };
    if (options?.sessionId) {
      filter.must!.push({ key: 'session_id', match: { value: options.sessionId } });
    }

    const results = await this.vectorStore.search('session_messages', queryVector, filter, options?.limit ?? 10);

    return results.map(r => ({
      messageId: r.payload.message_id as string,
      sessionId: r.payload.session_id as string,
      role: r.payload.role as string,
      content: '',  // caller fetches full content via session_read if needed
      score: r.score,
      chunkIndex: r.payload.chunk_index as number,
    }));
  }

  async deleteSession(sessionId: string, agentTokenId: string): Promise<boolean> {
    const result = await this.storage.deleteSession(sessionId, agentTokenId);

    if (this.vectorStore) {
      await this.vectorStore.delete('sessions', [sessionId]).catch(err =>
        logger.warn({ err, sessionId }, 'Failed to delete session vector'));
      await this.vectorStore.deleteByFilter('session_messages', {
        must: [{ key: 'session_id', match: { value: sessionId } }],
      }).catch(err =>
        logger.warn({ err, sessionId }, 'Failed to delete message vectors'));
    }

    return result;
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run src/__tests__/sessions-manager.test.ts
```

Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sessions/manager.ts src/__tests__/sessions-manager.test.ts
git commit -m "feat: SessionManager with import, chunking, and semantic search"
```

---

### Task 17: Register session_* MCP tools in server.ts

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add SessionManager to buildMcpServer signature**

```typescript
export function buildMcpServer(
  memoryManager: MemoryManager,
  agentTokenStore?: AgentTokenStore,
  notesManager?: NotesManager,
  sessionManager?: SessionManager,  // NEW
): Server
```

- [ ] **Step 2: Add 6 tool definitions**

Add to the tools list:
- `session_import` — SessionImportSchema
- `session_list` — SessionListSchema
- `session_search` — SessionSearchSchema
- `session_read` — SessionReadSchema
- `session_message_search` — SessionMessageSearchSchema
- `session_delete` — SessionDeleteSchema

- [ ] **Step 3: Add tool handlers**

Same pattern as note tools — extract `agentTokenId` from auth, validate with Zod, delegate to `sessionManager`:

```typescript
case 'session_import': {
  if (!sessionManager) return { content: [{ type: 'text', text: 'Sessions not configured' }], isError: true };
  const parsed = SessionImportSchema.safeParse(args);
  if (!parsed.success) return { content: [{ type: 'text', text: formatZodError(parsed.error) }], isError: true };

  // Sessions require agent token (master token cannot import sessions — they belong to agents)
  const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
  if (!agentTokenId) return { content: [{ type: 'text', text: 'Agent token required for session import' }], isError: true };

  const session = await sessionManager.importSession(agentTokenId, {
    externalId: parsed.data.external_id,
    name: parsed.data.name,
    summary: parsed.data.summary,
    projectId: parsed.data.project_id,
    workingDirectory: parsed.data.working_directory,
    gitBranch: parsed.data.git_branch,
    tags: parsed.data.tags,
    startedAt: parsed.data.started_at,
    endedAt: parsed.data.ended_at,
    messages: parsed.data.messages.map(m => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      toolNames: m.tool_names,
    })),
  });

  return { content: [{ type: 'text', text: `Session imported: ${session.id}\nMessages: ${session.messageCount}\nSummary: ${session.summary.slice(0, 200)}` }] };
}
```

Each remaining handler follows the same pattern: parse → extract agentTokenId → delegate to sessionManager:

- `session_list`: parse SessionListSchema → `sessionManager.listSessions(agentTokenId, parsed.data)` → format as list with name, summary, dates
- `session_search`: parse SessionSearchSchema → `sessionManager.searchSessions(agentTokenId, parsed.data.query, parsed.data)` → format with scores
- `session_read`: parse SessionReadSchema → `sessionManager.readSession(parsed.data.session_id, agentTokenId, parsed.data.message_from, parsed.data.message_to)` → format session + messages
- `session_message_search`: parse SessionMessageSearchSchema → `sessionManager.searchMessages(agentTokenId, parsed.data.query, parsed.data)` → format with scores and message context
- `session_delete`: parse SessionDeleteSchema → `sessionManager.deleteSession(parsed.data.session_id, agentTokenId)` → confirm deletion

**Call site update:** Update `src/app.ts:104`:
```typescript
mountMcpTransport(app, () => buildMcpServer(memoryManager, agentTokenStore, notesManager, sessionManager));
```

- [ ] **Step 4: Wire managers in startup (index.ts or app.ts)**

After vectorStore and embeddingProvider are created:

```typescript
import { PersonalNotesStorage } from './notes/storage.js';
import { NotesManager } from './notes/manager.js';
import { SessionStorage } from './sessions/storage.js';
import { SessionManager } from './sessions/manager.js';

// Create managers
const notesStorage = new PersonalNotesStorage(pool);
const notesManager = new NotesManager(notesStorage, vectorStore, embeddingProvider);

const sessionStorage = new SessionStorage(pool);
const sessionManager = new SessionManager(sessionStorage, vectorStore, embeddingProvider);

// Ensure Qdrant collections + payload indexes
if (vectorStore) {
  await vectorStore.ensureCollection('personal_notes', embeddingProvider.dimensions);
  await vectorStore.createPayloadIndex('personal_notes', 'agent_token_id', 'keyword');
  await vectorStore.createPayloadIndex('personal_notes', 'project_id', 'keyword');
  await vectorStore.createPayloadIndex('personal_notes', 'session_id', 'keyword');

  await vectorStore.ensureCollection('sessions', embeddingProvider.dimensions);
  await vectorStore.createPayloadIndex('sessions', 'agent_token_id', 'keyword');
  await vectorStore.createPayloadIndex('sessions', 'project_id', 'keyword');

  await vectorStore.ensureCollection('session_messages', embeddingProvider.dimensions, { quantization: 'scalar' });
  await vectorStore.createPayloadIndex('session_messages', 'agent_token_id', 'keyword');
  await vectorStore.createPayloadIndex('session_messages', 'session_id', 'keyword');
  await vectorStore.createPayloadIndex('session_messages', 'role', 'keyword');
}

// Pass to server builder
const server = buildMcpServer(memoryManager, agentTokenStore, notesManager, sessionManager);
```

- [ ] **Step 5: Run all tests**

```bash
npx vitest run
```

Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/index.ts src/app.ts
git commit -m "feat: register 6 session_* MCP tools and wire managers in startup"
```

---

### Task 18: Build and verify

- [ ] **Step 1: TypeScript build**

```bash
npm run build
```

Expected: No errors

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: All tests PASS

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: complete Phase 1-3 — Qdrant, Personal Notes, Session Import"
```
