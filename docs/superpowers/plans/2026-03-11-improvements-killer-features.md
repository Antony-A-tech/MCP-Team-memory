# Team Memory MCP — Improvements & Killer Features Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform team-memory-mcp from a functional memory store into a production-grade, intelligent knowledge management system for AI agent teams.

**Architecture:** Incremental feature additions organized in 4 phases. Each phase is independently deployable. Phase 1 focuses on production-readiness (logging, health, graceful shutdown). Phase 2 adds semantic intelligence (vector search, auto-tagging). Phase 3 enables enterprise workflows (RBAC, webhooks). Phase 4 introduces knowledge management features (snapshots, cross-project sharing, summarization).

**Tech Stack:** TypeScript, Node.js 20+, PostgreSQL 16 + pgvector, Vitest, Zod, pino (logging), OpenAI/Anthropic API (embeddings)

---

## Phase 1: Production Readiness

### Task 1: Structured Logging with pino

**Files:**
- Create: `src/logger.ts`
- Modify: `src/app.ts` — replace console.error
- Modify: `src/server.ts` — replace console.error (MCP server startup log)
- Modify: `src/memory/manager.ts` — replace console.error
- Modify: `src/sync/websocket.ts` — replace console.error
- Modify: `src/storage/pg-storage.ts` — replace console.error
- Modify: `src/storage/migration.ts` — replace console.error
- Modify: `src/web/server.ts` — replace console.error

**Why:** All current logging uses `console.error` making it impossible to distinguish INFO from ERROR in production. pino provides JSON-structured, leveled, high-performance logging.

- [ ] **Step 1: Install pino**

Run: `cd d:/MCP/team-memory-mcp && npm install pino`

- [ ] **Step 2: Create logger module**

Create `src/logger.ts`:

```typescript
import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';

// CRITICAL: In stdio mode, ANY stdout output corrupts MCP JSON-RPC protocol.
// Stdio mode MUST always log to stderr (fd 2), regardless of NODE_ENV.
const isStdio = process.env.MEMORY_TRANSPORT === 'stdio';

const transport = isStdio
  ? { target: 'pino/file', options: { destination: 2 } }  // always stderr for MCP stdio
  : process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
    : undefined;  // default pino JSON to stdout in production HTTP mode

export const logger = pino({ level, transport });

export default logger;
```

- [ ] **Step 3: Replace console.error across all files**

Pattern: `console.error('message', data)` → `logger.info({ data }, 'message')` for info, `logger.error({ err }, 'message')` for errors.

Example in `src/app.ts`:
```typescript
import logger from './logger.js';
// ...
logger.info({ port: config.port }, 'Server running');
logger.warn('CORS origin set to * — all origins allowed');
```

- [ ] **Step 4: Install pino-pretty as devDependency**

Run: `npm install -D pino-pretty`

- [ ] **Step 5: Run build and tests**

Run: `npm run build && npx vitest run`

- [ ] **Step 6: Commit**

```bash
git add src/logger.ts src/app.ts src/server.ts src/memory/manager.ts src/sync/websocket.ts src/storage/pg-storage.ts src/storage/migration.ts src/web/server.ts package.json package-lock.json
git commit -m "feat: add structured logging with pino, replace console.error"
```

---

### Task 2: Health Check Endpoint

**Files:**
- Create: `src/health.ts`
- Modify: `src/app.ts`

**Why:** Required for Docker/Kubernetes orchestration and monitoring.

- [ ] **Step 1: Create health module**

Create `src/health.ts`:

```typescript
import type { Request, Response } from 'express';
import type pg from 'pg';

export function createHealthHandler(pool: pg.Pool) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      const start = Date.now();
      await pool.query('SELECT 1');
      const dbLatencyMs = Date.now() - start;

      res.json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        checks: {
          database: { status: 'up', latencyMs: dbLatencyMs },
          memory: {
            heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
          },
        },
      });
    } catch (err) {
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        checks: {
          database: { status: 'down', error: (err as Error).message },
        },
      });
    }
  };
}
```

- [ ] **Step 2: Mount in app.ts**

```typescript
import { createHealthHandler } from './health.js';
// After storage initialization:
app.get('/health', createHealthHandler(storage.getPool()));
```

- [ ] **Step 3: Update docker-compose healthcheck**

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:3846/health"]
  interval: 30s
  timeout: 10s
  retries: 3
```

- [ ] **Step 4: Commit**

```bash
git add src/health.ts src/app.ts docker-compose.yml
git commit -m "feat: add /health endpoint with database and memory checks"
```

---

### Task 3: Graceful Shutdown Improvements

**Files:**
- Modify: `src/app.ts` (shutdown handler, approx lines 109-119 — line numbers shift after Task 1)

**Depends on:** Task 1 (uses `logger` import). Must be implemented after Task 1.

**Why:** Current shutdown calls `process.exit(0)` immediately. In-flight requests get dropped, audit logs may not flush.

- [ ] **Step 1: Improve shutdown handler**

Replace the shutdown logic in `src/app.ts`:

```typescript
  let isShuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, 'Graceful shutdown initiated');

    // 1. Stop accepting new connections
    server.close();

    // 2. Close WebSocket connections gracefully
    wsServer.stop();

    // 3. Stop auto-archive timer
    memoryManager.stopAutoArchive();

    // 4. Wait for in-flight requests (max 10s)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 5. Close database pool
    await memoryManager.close();

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
```

- [ ] **Step 2: Commit**

```bash
git add src/app.ts
git commit -m "feat: improve graceful shutdown with ordered cleanup"
```

---

### Task 4: Database Migrations System

**Files:**
- Create: `src/storage/migrations/` directory
- Create: `src/storage/migrations/001-initial-schema.sql`
- Create: `src/storage/migrator.ts`
- Modify: `src/storage/pg-storage.ts`

**Why:** Current approach runs full schema.sql on every start. No way to safely add columns/indexes to existing databases.

**Note:** The existing `src/storage/migration.ts` handles JSON→PostgreSQL data migration (v1→v2). This new `migrator.ts` handles SQL schema migrations. Different purposes — both coexist. The existing `schema_meta` table tracks schema version as string `'2.1.0'`. The new migrator uses a separate `schema_migrations` table with integer version tracking.

- [ ] **Step 1: Create migrator with bootstrap for existing databases**

Create `src/storage/migrator.ts`. The `run()` method must detect existing databases (that have `schema_meta` but no `schema_migrations` table) and bootstrap them by marking migration 001 as already applied:

```typescript
import type pg from 'pg';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import logger from '../logger.js';

export class Migrator {
  constructor(private pool: pg.Pool, private migrationsDir: string) {}

  async run(): Promise<void> {
    // Ensure migrations table
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Bootstrap: if schema_meta exists (v2 DB) but schema_migrations is empty,
    // mark migration 001 as already applied to avoid re-running initial schema
    await this.bootstrapExistingDb();

    const applied = await this.getAppliedVersions();
    const migrations = this.getPendingMigrations(applied);

    for (const migration of migrations) {
      logger.info({ version: migration.version, name: migration.name }, 'Applying migration');
      const sql = readFileSync(migration.path, 'utf-8');
      await this.pool.query('BEGIN');
      try {
        await this.pool.query(sql);
        await this.pool.query(
          'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
          [migration.version, migration.name]
        );
        await this.pool.query('COMMIT');
      } catch (err) {
        await this.pool.query('ROLLBACK');
        throw err;
      }
    }

    if (migrations.length > 0) {
      logger.info({ count: migrations.length }, 'Migrations applied');
    }
  }

  private async getAppliedVersions(): Promise<Set<number>> {
    const { rows } = await this.pool.query('SELECT version FROM schema_migrations ORDER BY version');
    return new Set(rows.map(r => r.version));
  }

  private getPendingMigrations(applied: Set<number>) {
    const files = readdirSync(this.migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    return files
      .map(f => {
        const match = f.match(/^(\d+)-(.+)\.sql$/);
        if (!match) return null;
        return { version: parseInt(match[1]), name: match[2], path: path.join(this.migrationsDir, f) };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null && !applied.has(m.version));
  }

  /** If this is an existing v2 DB (has schema_meta), mark initial migration as done */
  private async bootstrapExistingDb(): Promise<void> {
    const { rows: metaRows } = await this.pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_meta'`
    );
    if (metaRows.length === 0) return; // Fresh DB — no bootstrap needed

    const { rows: migRows } = await this.pool.query(
      `SELECT 1 FROM schema_migrations WHERE version = 1`
    );
    if (migRows.length > 0) return; // Already bootstrapped

    logger.info('Bootstrapping: existing v2 DB detected, marking migration 001 as applied');
    await this.pool.query(
      `INSERT INTO schema_migrations (version, name) VALUES (1, 'initial-schema')`
    );
  }
}
```

- [ ] **Step 2: Move schema.sql to migrations/001-initial-schema.sql**

- [ ] **Step 3: Update pg-storage.ts to use Migrator instead of directly running schema.sql**

- [ ] **Step 4: Update package.json build script to copy migrations directory**

Add to `package.json` scripts:
```json
"copy-migrations": "cpy \"src/storage/migrations/**/*.sql\" dist/storage/migrations/ --parents"
```
And update `build` script to include `npm run copy-migrations`.

- [ ] **Step 5: Test migration runs cleanly on fresh and existing databases**

- [ ] **Step 6: Commit**

```bash
git add src/storage/migrator.ts src/storage/migrations/ src/storage/pg-storage.ts package.json
git commit -m "feat: add database migration system with bootstrap for existing DBs"
```

---

### Task 5: Cursor-Based Pagination

**Files:**
- Modify: `src/storage/pg-storage.ts` — getAll method
- Modify: `src/memory/types.ts` — ReadParams, PaginatedResult
- Modify: `src/memory/validation.ts` — add cursor param
- Modify: `src/server.ts` — memory_read handler
- Modify: `src/web/server.ts` — GET /api/memory

**Why:** Current offset-based approach is inefficient for large datasets. Cursor-based pagination is consistent under concurrent writes.

- [ ] **Step 1: Add PaginatedResult type to types.ts**

```typescript
export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}
```

- [ ] **Step 2: Add composite cursor to ReadParams and validation**

Use composite cursor `(updated_at, id)` to handle entries with identical timestamps:

```typescript
// types.ts
export interface ReadParams {
  // ...existing fields (preserve tags, etc.)
  cursor?: string;  // Composite cursor: "ISO_DATE|UUID" of last item
}
```

```typescript
// validation.ts — add to ReadParamsSchema
cursor: z.string().optional(),  // validated at runtime as "ISO|UUID"
```

- [ ] **Step 3: Implement cursor in pg-storage.ts getAll**

Add condition: `AND (updated_at, id) < ($cursor_ts, $cursor_id)` when cursor is provided. The composite cursor ensures correct pagination even when multiple entries share the same `updatedAt`. Use `ORDER BY updated_at DESC, id DESC`.

**Backward compatibility:** When no `cursor` param is provided, return the current `MemoryEntry[]` format. When `cursor` is provided, return `PaginatedResult<MemoryEntry>`. Document this as a non-breaking addition — existing clients continue to work without cursor.

- [ ] **Step 4: Update MCP tool and REST API handlers**

- [ ] **Step 5: Test with existing tests**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat: add cursor-based pagination for memory_read"
```

---

## Phase 2: Semantic Intelligence

### Task 6: Vector Search with pgvector

**Files:**
- Create: `src/storage/migrations/002-pgvector.sql`
- Create: `src/embeddings/provider.ts`
- Create: `src/embeddings/index.ts`
- Modify: `src/storage/pg-storage.ts` — add semantic search
- Modify: `src/memory/manager.ts` — embed on write/update
- Modify: `src/server.ts` — add semantic_search option to memory_read
- Modify: `src/config.ts` — embedding provider config

**Why:** Current full-text search matches keywords only. Semantic search finds related concepts even when wording differs — critical for AI agents querying knowledge.

- [ ] **Step 1: Create migration for pgvector**

Create `src/storage/migrations/002-pgvector.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE entries ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Use HNSW index instead of IVFFlat:
-- IVFFlat requires training data and fails on empty/small tables.
-- HNSW works incrementally and handles growing datasets without retraining.
CREATE INDEX IF NOT EXISTS idx_entries_embedding
  ON entries USING hnsw (embedding vector_cosine_ops);
```

- [ ] **Step 2: Create embedding provider abstraction**

Create `src/embeddings/provider.ts`:

```typescript
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}
```

Create `src/embeddings/index.ts` with OpenAI implementation using `text-embedding-3-small` (1536 dimensions) and a no-op fallback.

- [ ] **Step 3: Add config for embedding provider**

```typescript
// config.ts additions
embeddingProvider: 'openai' | 'none';
embeddingApiKey: string | undefined;
embeddingModel: string;
```

Env vars: `EMBEDDING_PROVIDER`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`

- [ ] **Step 4: Embed on write and update in manager.ts**

After creating/updating an entry, compute embedding of `${title} ${content}` and store:

```typescript
if (this.embeddingProvider) {
  const vector = await this.embeddingProvider.embed(`${entry.title}\n${entry.content}`);
  await this.storage.updateEmbedding(entry.id, vector);
}
```

- [ ] **Step 5: Add updateEmbedding and semanticSearch to pg-storage.ts**

Add `updateEmbedding` method (called from manager.ts Step 4):

```typescript
async updateEmbedding(id: string, embedding: number[]): Promise<void> {
  await this.pool.query(
    'UPDATE entries SET embedding = $2::vector WHERE id = $1',
    [id, JSON.stringify(embedding)]
  );
}
```

Add `semanticSearch` method:

```typescript
async semanticSearch(projectId: string, embedding: number[], limit = 20): Promise<MemoryEntry[]> {
  const { rows } = await this.pool.query(
    `SELECT *, embedding <=> $2::vector AS distance
     FROM entries
     WHERE project_id = $1 AND embedding IS NOT NULL AND status = 'active'
     ORDER BY embedding <=> $2::vector
     LIMIT $3`,
    [projectId, JSON.stringify(embedding), limit]
  );
  return rows.map(rowToEntry);
}
```

- [ ] **Step 6: Add semantic search mode to memory_read MCP tool**

Add `search_mode: 'keyword' | 'semantic' | 'hybrid'` parameter. Hybrid combines both results.

- [ ] **Step 7: Write tests with mock embedding provider**

- [ ] **Step 8: Commit**

```bash
git commit -m "feat: add semantic vector search with pgvector"
```

---

### Task 7: Auto-Tagging & Auto-Categorization

**Files:**
- Create: `src/intelligence/auto-tagger.ts`
- Modify: `src/memory/manager.ts` — call auto-tagger on write
- Modify: `src/config.ts` — enable/disable auto-tagging

**Why:** Manual tagging is inconsistent and burdensome. LLM-powered auto-tagging ensures consistent taxonomy.

- [ ] **Step 1: Create auto-tagger module**

```typescript
// src/intelligence/auto-tagger.ts
export interface AutoTagResult {
  suggestedTags: string[];
  suggestedDomain: string | null;
  suggestedRelatedIds: string[];
}

export class AutoTagger {
  constructor(
    private apiKey: string,
    private existingTags: () => Promise<string[]>,
    private searchSimilar: (text: string) => Promise<{ id: string; title: string }[]>
  ) {}

  async analyze(title: string, content: string, category: string): Promise<AutoTagResult> {
    // Use Claude API to analyze content and suggest:
    // 1. Tags from existing tag vocabulary + new ones
    // 2. Domain classification
    // 3. Related entries based on semantic similarity
  }
}
```

- [ ] **Step 2: Integrate into manager.write()**

When auto-tagging is enabled:
```typescript
if (this.autoTagger && !params.tags?.length) {
  const suggestions = await this.autoTagger.analyze(params.title, params.content, params.category);
  entry.tags = suggestions.suggestedTags;
  entry.domain = entry.domain || suggestions.suggestedDomain;
  entry.relatedIds = [...entry.relatedIds, ...suggestions.suggestedRelatedIds];
}
```

- [ ] **Step 3: Add config options**

```
AUTO_TAG_ENABLED=true
AUTO_TAG_API_KEY=sk-...
AUTO_TAG_MODEL=claude-haiku-4-5-20251001
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: add LLM-powered auto-tagging and categorization"
```

---

### Task 8: Knowledge Graph Visualization

**Files:**
- Create: `src/web/public/graph.html`
- Create: `src/web/public/js/graph.js`
- Modify: `src/web/server.ts` — add graph data API endpoint

**Why:** `relatedIds` field exists but is invisible. A visual graph helps teams understand knowledge connections.

- [ ] **Step 1: Add API endpoint for graph data**

```typescript
app.get('/api/graph', async (req, res) => {
  const entries = await memoryManager.read({ status: 'active', limit: 500 });
  const nodes = entries.map(e => ({
    id: e.id, label: e.title, category: e.category, domain: e.domain
  }));
  const edges = entries.flatMap(e =>
    e.relatedIds.map(rid => ({ source: e.id, target: rid }))
  );
  res.json({ nodes, edges });
});
```

- [ ] **Step 2: Create graph visualization page**

Use D3.js force-directed graph in `graph.html`. Nodes colored by category, sized by priority. Edges show relationships.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: add knowledge graph visualization page"
```

---

## Phase 3: Enterprise Features

### Task 9: Role-Based Access Control (RBAC)

**Files:**
- Create: `src/storage/migrations/003-rbac.sql`
- Create: `src/auth/rbac.ts`
- Modify: `src/middleware/auth.ts` — add role extraction
- Modify: `src/server.ts` — add permission checks

**Why:** Enterprise teams need read-only roles for junior agents and restricted access per project.

- [ ] **Step 1: Design role model**

```sql
-- 003-rbac.sql
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'editor',  -- viewer, editor, admin
  -- NOTE: UUID[] has no FK enforcement. For strict integrity, use a join table
  -- api_key_projects(api_key_id, project_id REFERENCES projects(id)).
  -- Array approach chosen for simplicity; trade-off accepted for v1 RBAC.
  project_ids UUID[] DEFAULT '{}',      -- empty = all projects
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
```

Roles:
- `viewer`: memory_read, memory_sync, memory_export, memory_history, memory_audit
- `editor`: all viewer + memory_write, memory_update, memory_delete, memory_pin
- `admin`: all editor + memory_projects (create/update/delete), manage API keys

- [ ] **Step 2: Create RBAC middleware**

```typescript
// src/auth/rbac.ts
export type Role = 'viewer' | 'editor' | 'admin';

const PERMISSIONS: Record<string, Role> = {
  memory_read: 'viewer',
  memory_sync: 'viewer',
  memory_export: 'viewer',
  memory_history: 'viewer',
  memory_audit: 'viewer',
  memory_write: 'editor',
  memory_update: 'editor',
  memory_delete: 'editor',
  memory_pin: 'editor',
  memory_unarchive: 'editor',
  memory_projects: 'admin',
};

export function hasPermission(role: Role, tool: string): boolean {
  const required = PERMISSIONS[tool] || 'admin';
  const hierarchy: Role[] = ['viewer', 'editor', 'admin'];
  return hierarchy.indexOf(role) >= hierarchy.indexOf(required);
}
```

- [ ] **Step 3: Integrate into MCP tool handler and REST API**

- [ ] **Step 4: Add API key management endpoints**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: add role-based access control (RBAC)"
```

---

### Task 10: Webhooks & Notifications

**Files:**
- Create: `src/storage/migrations/004-webhooks.sql`
- Create: `src/webhooks/manager.ts`
- Create: `src/webhooks/delivery.ts`
- Modify: `src/memory/manager.ts` — fire webhooks on events
- Modify: `src/server.ts` — add webhook MCP tools

**Why:** Teams need notifications when critical knowledge changes. Integration with Slack/Teams/Discord.

- [ ] **Step 1: Design webhook storage**

```sql
-- 004-webhooks.sql
CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  url TEXT NOT NULL,
  events TEXT[] NOT NULL DEFAULT '{memory:created,memory:updated,memory:deleted}',
  secret TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id BIGSERIAL PRIMARY KEY,  -- BIGSERIAL for consistency with audit_log table
  webhook_id UUID REFERENCES webhooks(id),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status_code INT,
  response_body TEXT,
  delivered_at TIMESTAMPTZ DEFAULT NOW()
);
```

- [ ] **Step 2: Create webhook delivery system**

```typescript
// src/webhooks/delivery.ts
export class WebhookDelivery {
  async deliver(webhook: Webhook, event: WSEvent): Promise<void> {
    const signature = this.sign(JSON.stringify(event), webhook.secret);
    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Event-Type': event.type,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    });
    // Log delivery result
  }
}
```

- [ ] **Step 3: Add MCP tools for webhook management**

- `memory_webhook_create` — register webhook
- `memory_webhook_list` — list webhooks
- `memory_webhook_delete` — remove webhook

- [ ] **Step 4: Fire webhooks from MemoryManager events**

Subscribe to manager events, match against webhook filters, deliver async.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: add webhook system for event notifications"
```

---

## Phase 4: Knowledge Management

### Task 11: Memory Snapshots & Branching

**Files:**
- Create: `src/storage/migrations/005-snapshots.sql`
- Create: `src/snapshots/manager.ts`
- Modify: `src/server.ts` — add snapshot MCP tools

**Why:** Before major refactoring or experiments, teams need to "save state" and optionally branch knowledge.

- [ ] **Step 1: Design snapshot storage**

```sql
CREATE TABLE IF NOT EXISTS memory_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id),
  name TEXT NOT NULL,
  description TEXT,
  entry_count INT NOT NULL,
  snapshot_data JSONB NOT NULL,  -- full entries dump
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

- [ ] **Step 2: Implement SnapshotManager**

Methods:
- `createSnapshot(projectId, name, description)` — dump all active entries to JSON
- `listSnapshots(projectId)` — list available snapshots
- `restoreSnapshot(snapshotId)` — restore entries from snapshot (archive current, restore saved)
- `diffSnapshot(snapshotId)` — compare current state with snapshot

- [ ] **Step 3: Add MCP tools**

- `memory_snapshot_create` — create snapshot
- `memory_snapshot_list` — list snapshots
- `memory_snapshot_restore` — restore from snapshot
- `memory_snapshot_diff` — compare with current state

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: add memory snapshots and restore functionality"
```

---

### Task 12: Smart Summarization & Deduplication

**Files:**
- Create: `src/intelligence/summarizer.ts`
- Modify: `src/server.ts` — add memory_summarize tool
- Modify: `src/memory/manager.ts` — periodic summarization

**Why:** Over time, memory accumulates redundant entries. Smart summarization consolidates duplicates and generates executive summaries.

- [ ] **Step 1: Create summarizer module**

```typescript
// src/intelligence/summarizer.ts
export class Summarizer {
  /**
   * Find groups of semantically similar entries.
   * Uses embedding cosine similarity.
   */
  async findDuplicates(projectId: string, threshold = 0.92): Promise<EntryGroup[]>;

  /**
   * Merge a group of entries into one consolidated entry.
   * Uses LLM to combine content intelligently.
   */
  async mergeEntries(entries: MemoryEntry[]): Promise<MemoryEntry>;

  /**
   * Generate executive summary of project knowledge.
   */
  async generateProjectSummary(projectId: string): Promise<string>;
}
```

- [ ] **Step 2: Add MCP tools**

- `memory_summarize` — generate project summary
- `memory_deduplicate` — find and merge duplicate entries (with confirmation)

- [ ] **Step 3: Add periodic summarization option**

Config: `MEMORY_AUTO_SUMMARIZE_INTERVAL=weekly`

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: add smart summarization and deduplication"
```

---

### Task 13: Cross-Project Knowledge Sharing

**Files:**
- Create: `src/storage/migrations/006-shared-knowledge.sql`
- Modify: `src/storage/pg-storage.ts` — cross-project queries
- Modify: `src/server.ts` — add cross-project search tool

**Why:** Common patterns and lessons learned should be reusable across projects.

- [ ] **Step 1: Design shared knowledge model**

```sql
-- Shared entries are entries explicitly marked as "shareable"
ALTER TABLE entries ADD COLUMN IF NOT EXISTS shared BOOLEAN DEFAULT false;

-- Cross-project references
CREATE TABLE IF NOT EXISTS cross_project_refs (
  id SERIAL PRIMARY KEY,
  source_project_id UUID REFERENCES projects(id),
  source_entry_id UUID REFERENCES entries(id),
  target_project_id UUID REFERENCES projects(id),
  target_entry_id UUID REFERENCES entries(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

- [ ] **Step 2: Add cross-project search**

```typescript
async searchAcrossProjects(query: string, limit = 20): Promise<MemoryEntry[]> {
  // Search only shared entries across all projects
  const { rows } = await this.pool.query(
    `SELECT * FROM entries
     WHERE shared = true AND status = 'active'
       AND (search_vector @@ plainto_tsquery('simple', $1) OR title ILIKE $2)
     ORDER BY updated_at DESC LIMIT $3`,
    [query, `%${escapeIlike(query)}%`, limit]
  );
  return rows.map(rowToEntry);
}
```

- [ ] **Step 3: Add MCP tools**

- `memory_share` — mark entry as shared across projects
- `memory_search_global` — search all shared entries

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: add cross-project knowledge sharing"
```

---

### Task 14: CLI Tool

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/cli/commands.ts`
- Modify: `package.json` — add bin entry

**Why:** Quick terminal access: `tm search "auth"`, `tm write "decided to use JWT"`.

- [ ] **Step 1: Design CLI interface**

```
tm read [--category=tasks] [--search="auth"] [--limit=10]
tm write --category=decisions --title="Use JWT" --content="Decided to use JWT for auth"
tm search "authentication" [--semantic]
tm projects list
tm stats
tm export --format=markdown > memory.md
```

- [ ] **Step 2: Implement using Commander.js**

```bash
npm install commander
```

CLI communicates with the HTTP API:

```typescript
// src/cli/index.ts
import { Command } from 'commander';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));

const program = new Command()
  .name('tm')
  .description('Team Memory CLI')
  .version(version);

program.command('read')
  .option('-c, --category <cat>', 'Filter by category')
  .option('-s, --search <query>', 'Search entries')
  .option('-l, --limit <n>', 'Limit results', '10')
  .action(async (opts) => {
    const res = await fetch(`${API_URL}/api/memory?${new URLSearchParams(opts)}`);
    const data = await res.json();
    // Pretty-print entries
  });
```

- [ ] **Step 3: Add bin entry to package.json**

```json
"bin": {
  "tm": "dist/cli/index.js"
}
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: add CLI tool for quick terminal access"
```

---

## Implementation Priority & Roadmap

| Phase | Task | Priority | Estimated Effort | Dependencies |
|-------|------|----------|-----------------|--------------|
| 1 | Structured Logging | HIGH | 2h | None |
| 1 | Health Check | HIGH | 1h | None |
| 1 | Graceful Shutdown | HIGH | 30min | None |
| 1 | DB Migrations | HIGH | 3h | None |
| 1 | Cursor Pagination | MEDIUM | 2h | None |
| 2 | Vector Search | HIGH | 4h | DB Migrations |
| 2 | Auto-Tagging | MEDIUM | 3h | Vector Search |
| 2 | Knowledge Graph UI | LOW | 3h | None |
| 3 | RBAC | MEDIUM | 4h | DB Migrations |
| 3 | Webhooks | MEDIUM | 4h | DB Migrations |
| 4 | Snapshots | MEDIUM | 3h | DB Migrations |
| 4 | Summarization | LOW | 4h | Vector Search |
| 4 | Cross-Project | LOW | 3h | Vector Search |
| 4 | CLI Tool | LOW | 2h | None (uses existing REST API) |

**Recommended execution order:**
1. Phase 1 (all tasks) — foundational, no external dependencies
2. Task 6 (Vector Search) — unlocks Phase 2 and Phase 4
3. Task 9 (RBAC) — needed before going multi-user
4. Task 10 (Webhooks) — high demand feature
5. Remaining tasks in priority order
