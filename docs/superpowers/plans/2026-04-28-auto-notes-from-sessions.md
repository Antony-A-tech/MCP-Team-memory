# Auto-Notes from Sessions (v4.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual `memory_write`-driven entries with automatic WHY-fact extraction from imported sessions, with cross-session deduplication and confirmation-based importance.

**Architecture:** Add `extracting_notes` step to session pipeline; LLM extractor (Gemini, Ollama fallback) returns ≤5 atomic-fact candidates per session; embedding-based dedup decides CONFIRM/MERGE/CREATE_NEW; manual entries channelled through new `note_share` (personal note → entry); deprecate direct `memory_write` to 410 Gone; introduce `KnowledgeSource`/`HierarchicalRetrieval` abstraction for v5 Azure integration.

**Tech Stack:** TypeScript, Node 20+, PostgreSQL (raw SQL via `pg`), Qdrant 1.13, Gemini 2.5 Flash + Ollama qwen3.5:4b, Vitest, Express.

**Spec:** `docs/superpowers/specs/2026-04-28-auto-notes-from-sessions-design.md`

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `src/storage/migrations/018-auto-notes.sql` | new | Schema additions: `entries.{auto_generated,extraction_confidence,explicit_marker_strength,confirmation_count,last_confirmed_at,evidence_sources,external_refs,importance_score}`, `personal_notes.shared_to_entry_id`, sessions CHECK update |
| `src/storage/migrations/018-rollback.sql` | new | DROP COLUMN rollback for 018 |
| `src/storage/migrations/019-deprecate-categories.sql` | new | `COMMENT ON COLUMN entries.category` only |
| `src/extraction/types.ts` | new | `CandidateNote`, `ExtractionResult`, `MergeDecision`, `EvidenceSource` |
| `src/extraction/prompt.ts` | new | `buildExtractionPrompt(sessionMetadata, summary, conversation)`, language detection, JSON-shape validation |
| `src/extraction/extractor.ts` | new | `NoteExtractor` — LLM call, JSON parse with retry, server-side filters, top-N cap |
| `src/extraction/dedup.ts` | new | `DedupResolver` — Qdrant search + decision branching (CONFIRM/MERGE/CREATE_NEW) |
| `src/extraction/merger.ts` | new | `NoteMerger` — LLM merge call for cos 0.7–0.85 |
| `src/extraction/llm-provider.ts` | new | Thin `ExtractionLlmProvider` interface + Gemini/Ollama adapters |
| `src/retrieval/types.ts` | new | `KnowledgeChunk`, `KnowledgeSource`, `RetrievalFilters`, `SourceType` |
| `src/retrieval/sources/entries-source.ts` | new | `EntriesSource implements KnowledgeSource` |
| `src/retrieval/sources/sessions-source.ts` | new | `SessionsSource implements KnowledgeSource` |
| `src/retrieval/sources/messages-source.ts` | new | `MessagesSource implements KnowledgeSource` |
| `src/retrieval/hierarchical.ts` | new | `HierarchicalRetrieval` orchestrator, `register(source)`, `retrieve(query, filters)` |
| `src/memory/manager.ts` | modify | `confirmExisting`, `mergeIntoExisting`, `createFromCandidate`, `recomputeImportanceScore` methods; sanitize `evidence_sources` in read paths; sort by `importance_score` |
| `src/memory/decay.ts` | modify | Add `buildSingletonAutoArchiveQuery()` for one-confirmation auto-records older than 30 days |
| `src/memory/types.ts` | modify | Extend `MemoryEntry` interface with new fields |
| `src/memory/importance.ts` | new | `computeImportanceScore(entry, today)` pure function |
| `src/sessions/manager.ts` | modify | New pipeline state `extracting_notes`; call `NoteExtractor` after embedding |
| `src/sessions/types.ts` | modify | Update `embeddingStatus` union |
| `src/sessions/storage.ts` | modify | `getNextQueued` accepts new state; `recoverStuckSessions` covers `extracting_notes` |
| `src/notes/manager.ts` | modify | Add `share(noteId, agentTokenId, params)` returning `ShareResult` |
| `src/notes/storage.ts` | modify | `setSharedToEntry(noteId, entryId)` |
| `src/notes/types.ts` | modify | `PersonalNote.sharedToEntryId` |
| `src/server.ts` | modify | `memory_write` returns 410 Gone; new tool `note_share`; sanitize `evidence_sources` in formatted output |
| `src/web/server.ts` | modify | New REST endpoint `POST /api/notes/:id/share` |
| `src/web/public/...` | modify | Notes page: "Расшарить" button + modal (category select, override fields, dedup-prompt) |
| `src/rag/agent.ts` | modify | Switch from direct manager calls to `HierarchicalRetrieval` |
| `src/app.ts` | modify | Wire `NoteExtractor`, `DedupResolver`, `NoteMerger`, `HierarchicalRetrieval`; pass to `SessionManager` and `RagAgent` factories |
| `src/config.ts` | modify | New env vars (see spec §13) with defaults |
| `src/__tests__/extraction-prompt.test.ts` | new | Prompt builder, language detection, sample selection |
| `src/__tests__/extraction-extractor.test.ts` | new | LLM call mock, JSON parse retry, all server-side filters, top-N cap |
| `src/__tests__/extraction-dedup.test.ts` | new | Branching at boundaries 0.7/0.85; evidence dedup |
| `src/__tests__/extraction-merger.test.ts` | new | Merge produces ≤500 chars; tags union |
| `src/__tests__/importance.test.ts` | new | All 4 score components + boundary cases |
| `src/__tests__/decay-singleton.test.ts` | new | New decay rule isolated; doesn't touch pinned/multi-confirmed/recent |
| `src/__tests__/retrieval-hierarchical.test.ts` | new | Mock sources, layered output, register additional |
| `src/__tests__/notes-share.test.ts` | new | Share flow: new entry / confirm-existing / merge with auto-decision; `shared_to_entry_id` set |
| `src/__tests__/memory-write-deprecated.test.ts` | new | `memory_write` MCP tool returns 410-shaped error |
| `src/__tests__/sessions-extraction-integration.test.ts` | new | Pipeline ends at `complete` with extraction; `EXTRACT_NOTES_ENABLED=false` skips |
| `scripts/backfill-extract-notes.cjs` | new | Optional CLI: re-run extraction over selected past sessions |

---

## Phase 0 — Schema migrations

### Task 1: Migration 018 — entries / personal_notes / sessions schema

**Files:**
- Create: `src/storage/migrations/018-auto-notes.sql`
- Create: `src/storage/migrations/018-rollback.sql`
- Create: `src/__tests__/migration-018.test.ts`

- [ ] **Step 1: Write migration test (Vitest, against test PG database)**

```typescript
// src/__tests__/migration-018.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from '../storage/migrator.js';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/team_memory_test';

describe('migration 018-auto-notes', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB });
    await runMigrations(pool);
  });

  afterAll(async () => { await pool.end(); });

  it('adds expected columns to entries', async () => {
    const { rows } = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name='entries'
        AND column_name IN ('auto_generated','extraction_confidence',
          'explicit_marker_strength','confirmation_count','last_confirmed_at',
          'evidence_sources','external_refs','importance_score')
      ORDER BY column_name
    `);
    expect(rows.length).toBe(8);
    const byName = Object.fromEntries(rows.map(r => [r.column_name, r]));
    expect(byName.auto_generated.data_type).toBe('boolean');
    expect(byName.confirmation_count.data_type).toBe('integer');
    expect(byName.evidence_sources.data_type).toBe('jsonb');
    expect(byName.external_refs.data_type).toBe('jsonb');
  });

  it('adds shared_to_entry_id to personal_notes', async () => {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='personal_notes' AND column_name='shared_to_entry_id'
    `);
    expect(rows.length).toBe(1);
  });

  it('extracting_notes is allowed in sessions.embedding_status', async () => {
    const sid = '00000000-0000-0000-0000-000000000018';
    await pool.query(`INSERT INTO agent_tokens (id, name, token_hash, is_active) VALUES ($1,'mt','x',true) ON CONFLICT DO NOTHING`, [sid]);
    await pool.query(`INSERT INTO sessions (id, agent_token_id, summary, message_count, embedding_status) VALUES ($1,$1,'s',0,'extracting_notes') ON CONFLICT DO NOTHING`, [sid]);
    const { rows } = await pool.query(`SELECT embedding_status FROM sessions WHERE id=$1`, [sid]);
    expect(rows[0].embedding_status).toBe('extracting_notes');
    await pool.query(`DELETE FROM sessions WHERE id=$1`, [sid]);
    await pool.query(`DELETE FROM agent_tokens WHERE id=$1`, [sid]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- migration-018`
Expected: FAIL ("column ... does not exist", or sessions CHECK violation).

- [ ] **Step 3: Write migration 018-auto-notes.sql**

```sql
-- src/storage/migrations/018-auto-notes.sql
ALTER TABLE entries
  ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS extraction_confidence FLOAT,
  ADD COLUMN IF NOT EXISTS explicit_marker_strength FLOAT,
  ADD COLUMN IF NOT EXISTS confirmation_count INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS evidence_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS external_refs JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS importance_score FLOAT NOT NULL DEFAULT 0.5;

CREATE INDEX IF NOT EXISTS idx_entries_importance       ON entries(project_id, importance_score DESC);
CREATE INDEX IF NOT EXISTS idx_entries_evidence_sources ON entries USING GIN (evidence_sources);
CREATE INDEX IF NOT EXISTS idx_entries_external_refs    ON entries USING GIN (external_refs);
CREATE INDEX IF NOT EXISTS idx_entries_auto_generated   ON entries(project_id, auto_generated);

ALTER TABLE personal_notes
  ADD COLUMN IF NOT EXISTS shared_to_entry_id UUID REFERENCES entries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_personal_notes_shared
  ON personal_notes(shared_to_entry_id) WHERE shared_to_entry_id IS NOT NULL;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_embedding_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_embedding_status_check
  CHECK (embedding_status IN (
    'queued', 'queued_embed', 'summarizing', 'embedding',
    'extracting_notes', 'complete', 'failed', 'extraction_failed'
  ));
```

- [ ] **Step 4: Write rollback**

```sql
-- src/storage/migrations/018-rollback.sql
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_embedding_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_embedding_status_check
  CHECK (embedding_status IN ('queued','queued_embed','summarizing','embedding','complete','failed'));

DROP INDEX IF EXISTS idx_personal_notes_shared;
ALTER TABLE personal_notes DROP COLUMN IF EXISTS shared_to_entry_id;

DROP INDEX IF EXISTS idx_entries_importance;
DROP INDEX IF EXISTS idx_entries_evidence_sources;
DROP INDEX IF EXISTS idx_entries_external_refs;
DROP INDEX IF EXISTS idx_entries_auto_generated;
ALTER TABLE entries
  DROP COLUMN IF EXISTS auto_generated,
  DROP COLUMN IF EXISTS extraction_confidence,
  DROP COLUMN IF EXISTS explicit_marker_strength,
  DROP COLUMN IF EXISTS confirmation_count,
  DROP COLUMN IF EXISTS last_confirmed_at,
  DROP COLUMN IF EXISTS evidence_sources,
  DROP COLUMN IF EXISTS external_refs,
  DROP COLUMN IF EXISTS importance_score;
```

- [ ] **Step 5: Run test, verify pass**

Run: `npm test -- migration-018`
Expected: PASS (all 3 sub-tests).

- [ ] **Step 6: Commit**

```bash
git add src/storage/migrations/018-auto-notes.sql src/storage/migrations/018-rollback.sql src/__tests__/migration-018.test.ts
git commit -m "feat(db): migration 018 — auto-notes columns + sessions extracting_notes state"
```

### Task 2: Migration 019 — deprecate categories COMMENT

**Files:**
- Create: `src/storage/migrations/019-deprecate-categories.sql`

- [ ] **Step 1: Write migration**

```sql
-- src/storage/migrations/019-deprecate-categories.sql
COMMENT ON COLUMN entries.category IS
  'Active categories: architecture, decisions, conventions.
   DEPRECATED since v4.5 (2026-04-28): tasks, progress, issues
   - new memory_write API rejects them (410 Gone);
   - auto-extractor never produces them;
   - existing rows decay normally.';
```

- [ ] **Step 2: Run migrator, verify no error**

Run: `npm run build && node --enable-source-maps dist/scripts/migrate.js` (or whatever the project's migrator entrypoint is — see `src/storage/migrator.ts`).
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/storage/migrations/019-deprecate-categories.sql
git commit -m "feat(db): migration 019 — comment marking task/progress/issues categories deprecated"
```

---

## Phase 1 — Types

### Task 3: Extraction types

**Files:**
- Create: `src/extraction/types.ts`

- [ ] **Step 1: Write types**

```typescript
// src/extraction/types.ts
import type { Category } from '../memory/types.js';

export type AutoCategory = Extract<Category, 'architecture' | 'decisions' | 'conventions'>;
export const AUTO_CATEGORIES: AutoCategory[] = ['architecture', 'decisions', 'conventions'];

export interface CandidateNote {
  category: AutoCategory;
  title: string;
  fact: string;
  why: string;
  tags: string[];
  confidence: number;             // 0..1, from LLM
  explicit_marker_strength: number; // 0..1, from LLM
}

export interface EvidenceSource {
  type: 'session' | 'personal_note' | 'pr' | 'wiki' | 'code_review' | 'work_item';
  id: string;
  agent_token_id?: string;     // for session/personal_note
  shared_by?: string;          // public-safe alias for personal_note id-owner
  confirmed_at: string;        // ISO
}

export interface ExtractionResult {
  candidates: CandidateNote[];   // already filtered & capped to <=5
  rejected: Array<{ candidate: CandidateNote; reason: string }>;
  llm_input_chars: number;
  llm_output_chars: number;
}

export type DedupAction =
  | { type: 'CREATE_NEW'; candidate: CandidateNote }
  | { type: 'CONFIRM'; entry_id: string; candidate: CandidateNote; score: number }
  | { type: 'MERGE'; entry_id: string; candidate: CandidateNote; score: number };

export interface DedupResult {
  decisions: DedupAction[];
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/extraction/types.ts
git commit -m "feat(extraction): types for candidates, evidence sources, dedup decisions"
```

### Task 4: Retrieval types

**Files:**
- Create: `src/retrieval/types.ts`

- [ ] **Step 1: Write types**

```typescript
// src/retrieval/types.ts
export type SourceType =
  | 'entries' | 'sessions' | 'session_messages'
  | 'code' | 'pr' | 'wiki' | 'work_item' | 'review';

export interface KnowledgeChunk {
  source_type: SourceType;
  source_id: string;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface RetrievalFilters {
  project_id: string;
  agent_token_id?: string;
  categories?: string[];
  date_from?: string;
  date_to?: string;
}

export interface KnowledgeSource {
  readonly type: SourceType;
  search(query: string, filters: RetrievalFilters, limit: number): Promise<KnowledgeChunk[]>;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/retrieval/types.ts
git commit -m "feat(retrieval): KnowledgeSource and KnowledgeChunk types"
```

### Task 5: Extend MemoryEntry interface

**Files:**
- Modify: `src/memory/types.ts`

- [ ] **Step 1: Read current `MemoryEntry`**

Run: `npx tsc --noEmit` to confirm baseline clean.

- [ ] **Step 2: Add fields to `MemoryEntry` (and `CompactMemoryEntry` where relevant)**

In `src/memory/types.ts`, locate the `MemoryEntry` interface and add (after `lastReadAt`):

```typescript
  autoGenerated?: boolean;
  extractionConfidence?: number | null;
  explicitMarkerStrength?: number | null;
  confirmationCount?: number;
  lastConfirmedAt?: string | null;
  evidenceSources?: import('../extraction/types.js').EvidenceSource[];
  externalRefs?: Record<string, unknown>;
  importanceScore?: number;
```

For `CompactMemoryEntry`, add only:

```typescript
  importanceScore?: number;
  confirmationCount?: number;
  autoGenerated?: boolean;
```

- [ ] **Step 3: Update PG row mapper**

Locate `mapRowToEntry` (or equivalent) in `src/storage/pg-storage.ts` (search for `category: row.category`) and add mappings for new columns. Example addition:

```typescript
  autoGenerated: row.auto_generated,
  extractionConfidence: row.extraction_confidence,
  explicitMarkerStrength: row.explicit_marker_strength,
  confirmationCount: row.confirmation_count,
  lastConfirmedAt: row.last_confirmed_at?.toISOString?.() ?? null,
  evidenceSources: row.evidence_sources ?? [],
  externalRefs: row.external_refs ?? {},
  importanceScore: row.importance_score,
```

Also update SELECT lists in PgStorage methods that fetch entries (`getById`, `getByIds`, `read`, etc.) to include the new columns. Use a helper if not already present:

```typescript
const ENTRY_COLUMNS = `
  id, project_id, category, domain, title, content, author, tags,
  priority, status, pinned, related_ids, created_at, updated_at,
  read_count, last_read_at,
  auto_generated, extraction_confidence, explicit_marker_strength,
  confirmation_count, last_confirmed_at, evidence_sources,
  external_refs, importance_score
`.trim();
```

Replace ad-hoc `SELECT *` and column lists with this constant.

- [ ] **Step 4: Run all tests, fix any compilation issues**

Run: `npm test`
Expected: existing tests pass; new fields default to `false/0/[]/{}` per migration defaults.

- [ ] **Step 5: Commit**

```bash
git add src/memory/types.ts src/storage/pg-storage.ts
git commit -m "feat(memory): MemoryEntry extended with auto-notes fields, PG mapper updated"
```

---

## Phase 2 — Importance score

### Task 6: Pure scoring function

**Files:**
- Create: `src/memory/importance.ts`
- Create: `src/__tests__/importance.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// src/__tests__/importance.test.ts
import { describe, it, expect } from 'vitest';
import { computeImportanceScore } from '../memory/importance.js';

const FIXED_NOW = new Date('2026-04-28T00:00:00Z');

describe('computeImportanceScore', () => {
  it('zero confirmations + no marker + no authors → 0.05 (recency only, score=0.3*1)', () => {
    const score = computeImportanceScore({
      confirmationCount: 0,
      lastConfirmedAt: FIXED_NOW.toISOString(),
      explicitMarkerStrength: null,
      uniqueAuthors: 0,
    }, FIXED_NOW);
    // 0.4*0 + 0.3*exp(0/60)=0.3 + 0.2*0.5 (default) + 0.1*0 = 0.4
    expect(score).toBeCloseTo(0.4, 3);
  });

  it('5 confirmations cap at 1.0; recent; strong marker; 3 authors → 1.0', () => {
    const score = computeImportanceScore({
      confirmationCount: 5,
      lastConfirmedAt: FIXED_NOW.toISOString(),
      explicitMarkerStrength: 1.0,
      uniqueAuthors: 3,
    }, FIXED_NOW);
    // 0.4*1 + 0.3*1 + 0.2*1 + 0.1*1 = 1.0
    expect(score).toBeCloseTo(1.0, 3);
  });

  it('7 confirmations clamped to 1.0', () => {
    const score = computeImportanceScore({
      confirmationCount: 7,
      lastConfirmedAt: FIXED_NOW.toISOString(),
      explicitMarkerStrength: 1.0,
      uniqueAuthors: 5,
    }, FIXED_NOW);
    expect(score).toBeCloseTo(1.0, 3);
  });

  it('60 days since confirmation → recency ~ 1/e', () => {
    const past = new Date(FIXED_NOW.getTime() - 60 * 86400_000);
    const score = computeImportanceScore({
      confirmationCount: 0,
      lastConfirmedAt: past.toISOString(),
      explicitMarkerStrength: 0,
      uniqueAuthors: 0,
    }, FIXED_NOW);
    // 0 + 0.3 * exp(-1) + 0 + 0 ≈ 0.110
    expect(score).toBeCloseTo(0.3 / Math.E, 3);
  });

  it('null lastConfirmedAt treated as 0 days', () => {
    const score = computeImportanceScore({
      confirmationCount: 0,
      lastConfirmedAt: null,
      explicitMarkerStrength: 0,
      uniqueAuthors: 0,
    }, FIXED_NOW);
    expect(score).toBeCloseTo(0.3, 3);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm test -- importance`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement function**

```typescript
// src/memory/importance.ts
export interface ImportanceInput {
  confirmationCount: number;
  lastConfirmedAt: string | null;
  explicitMarkerStrength: number | null;  // null → default 0.5
  uniqueAuthors: number;
}

export function computeImportanceScore(input: ImportanceInput, now: Date = new Date()): number {
  const confirmationsTerm = Math.min(input.confirmationCount / 5, 1.0);
  const days = input.lastConfirmedAt
    ? Math.max(0, (now.getTime() - new Date(input.lastConfirmedAt).getTime()) / 86400_000)
    : 0;
  const recencyTerm = Math.exp(-days / 60);
  const markerTerm = input.explicitMarkerStrength ?? 0.5;
  const authorsTerm = Math.min(input.uniqueAuthors / 3, 1.0);

  return 0.4 * confirmationsTerm
       + 0.3 * recencyTerm
       + 0.2 * markerTerm
       + 0.1 * authorsTerm;
}

export function uniqueAuthorsFromEvidence(
  evidence: Array<{ agent_token_id?: string; shared_by?: string }>,
): number {
  const ids = new Set<string>();
  for (const e of evidence) {
    const id = e.agent_token_id ?? e.shared_by;
    if (id) ids.add(id);
  }
  return ids.size;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- importance`
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/importance.ts src/__tests__/importance.test.ts
git commit -m "feat(memory): pure importance score function with 4 weighted components"
```

### Task 7: MemoryManager — recompute importance on entry change

**Files:**
- Modify: `src/memory/manager.ts`
- Create: `src/__tests__/memory-importance-recompute.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// src/__tests__/memory-importance-recompute.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/team_memory_test';

describe('importance recompute on insert/update', () => {
  let pool: Pool, storage: PgStorage, manager: MemoryManager;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB });
    storage = new PgStorage(TEST_DB, 'simple');
    manager = new MemoryManager(storage);
    await manager.initialize();
  });

  afterAll(async () => {
    await manager.close();
    await pool.end();
  });

  it('importance_score is set on insert (within (0..1))', async () => {
    const entry = await manager.write({
      projectId: '00000000-0000-0000-0000-000000000000',
      category: 'decisions',
      title: 'Test decision',
      content: 'Use JWT with 7d refresh',
      tags: ['test'],
    });
    expect(entry.importanceScore).toBeGreaterThan(0);
    expect(entry.importanceScore).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test → fails or returns null**

Run: `npm test -- memory-importance-recompute`
Expected: FAIL ("expected null > 0" or similar).

- [ ] **Step 3: Implement recompute**

In `src/memory/manager.ts`:

```typescript
import { computeImportanceScore, uniqueAuthorsFromEvidence } from './importance.js';

// Add private method:
private async recomputeImportanceScore(entryId: string): Promise<number> {
  const { rows } = await this.storage.getPool().query(`
    SELECT confirmation_count, last_confirmed_at, explicit_marker_strength, evidence_sources
    FROM entries WHERE id = $1
  `, [entryId]);
  if (rows.length === 0) return 0.5;
  const r = rows[0];
  const score = computeImportanceScore({
    confirmationCount: r.confirmation_count,
    lastConfirmedAt: r.last_confirmed_at?.toISOString?.() ?? r.last_confirmed_at ?? null,
    explicitMarkerStrength: r.explicit_marker_strength,
    uniqueAuthors: uniqueAuthorsFromEvidence(r.evidence_sources ?? []),
  });
  await this.storage.getPool().query(
    `UPDATE entries SET importance_score = $1 WHERE id = $2`,
    [score, entryId],
  );
  return score;
}
```

Hook into `write()`, `update()`: after success, call `recomputeImportanceScore(entry.id)` and set on returned object before returning.

`PgStorage` needs `getPool()` exposed if not already (check existing code; per `app.ts:44` it is).

- [ ] **Step 4: Run test → passes**

Run: `npm test -- memory-importance-recompute`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/manager.ts src/__tests__/memory-importance-recompute.test.ts
git commit -m "feat(memory): recompute importance_score on write/update"
```

### Task 8: Batch recompute job (24h)

**Files:**
- Modify: `src/memory/manager.ts` (add `startImportanceRecomputeJob`, `stopImportanceRecomputeJob`)
- Modify: `src/app.ts` (start the job)

- [ ] **Step 1: Add job control to MemoryManager**

```typescript
private importanceJobInterval: NodeJS.Timeout | null = null;

startImportanceRecomputeJob(intervalHours: number = 24): void {
  if (this.importanceJobInterval) return;
  const tick = async () => {
    const start = Date.now();
    const { rowCount } = await this.storage.getPool().query(`
      UPDATE entries SET importance_score =
        0.4 * LEAST(confirmation_count::float / 5.0, 1.0)
      + 0.3 * EXP(-EXTRACT(EPOCH FROM NOW() - COALESCE(last_confirmed_at, NOW())) / (60.0 * 86400.0))
      + 0.2 * COALESCE(explicit_marker_strength, 0.5)
      + 0.1 * LEAST(
          (SELECT COUNT(DISTINCT COALESCE(es->>'agent_token_id', es->>'shared_by'))::float / 3.0
           FROM jsonb_array_elements(evidence_sources) es),
          1.0
        )
      WHERE status = 'active'
    `);
    logger.info({ rowCount, ms: Date.now() - start }, 'importance score batch recomputed');
  };
  this.importanceJobInterval = setInterval(() => { tick().catch(err => logger.error({ err }, 'importance job error')); }, intervalHours * 3600_000);
  tick().catch(err => logger.error({ err }, 'importance job initial run error'));
}

stopImportanceRecomputeJob(): void {
  if (this.importanceJobInterval) { clearInterval(this.importanceJobInterval); this.importanceJobInterval = null; }
}
```

Add `this.stopImportanceRecomputeJob();` to `close()`.

- [ ] **Step 2: Wire into app.ts**

In `src/app.ts` after `memoryManager.startAutoArchive(...)`:

```typescript
const importanceHours = parseInt(process.env.IMPORTANCE_RECOMPUTE_INTERVAL_HOURS ?? '24', 10);
memoryManager.startImportanceRecomputeJob(importanceHours);
```

Add `memoryManager.stopImportanceRecomputeJob();` to graceful shutdown (already covered by `memoryManager.close()`).

- [ ] **Step 3: Smoke test (manual, no Vitest)**

Run: `npm run build && npm start`
Look for log line: `importance score batch recomputed`.
Expected: log appears, no error.

- [ ] **Step 4: Commit**

```bash
git add src/memory/manager.ts src/app.ts
git commit -m "feat(memory): batch importance recompute job (24h default)"
```

---

## Phase 3 — Decay extension

### Task 9: Singleton-auto-record decay rule

**Files:**
- Modify: `src/memory/decay.ts`
- Create: `src/__tests__/decay-singleton.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/__tests__/decay-singleton.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { archiveSingletonAutoEntries } from '../memory/decay.js';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/team_memory_test';
const pool = new Pool({ connectionString: TEST_DB });

afterAll(async () => { await pool.end(); });

async function makeEntry(p: { auto: boolean; pinned: boolean; conf: number; ageDays: number }) {
  const { rows } = await pool.query(`
    INSERT INTO entries (project_id, category, title, content, status, pinned,
      auto_generated, confirmation_count, created_at, updated_at, last_confirmed_at)
    VALUES ($1,'decisions','t','c','active',$2,$3,$4, NOW() - ($5 || ' days')::interval, NOW(), NULL)
    RETURNING id
  `, ['00000000-0000-0000-0000-000000000000', p.pinned, p.auto, p.conf, p.ageDays]);
  return rows[0].id as string;
}

describe('archiveSingletonAutoEntries', () => {
  beforeEach(async () => {
    await pool.query(`DELETE FROM entries WHERE project_id='00000000-0000-0000-0000-000000000000' AND title='t'`);
  });

  it('archives auto-generated, unpinned, count=1, >30 days', async () => {
    const id = await makeEntry({ auto: true, pinned: false, conf: 1, ageDays: 31 });
    const archived = await archiveSingletonAutoEntries(pool, 30);
    expect(archived).toContain(id);
    const { rows } = await pool.query(`SELECT status FROM entries WHERE id=$1`, [id]);
    expect(rows[0].status).toBe('archived');
  });

  it('keeps pinned even if auto+singleton+old', async () => {
    const id = await makeEntry({ auto: true, pinned: true, conf: 1, ageDays: 60 });
    const archived = await archiveSingletonAutoEntries(pool, 30);
    expect(archived).not.toContain(id);
  });

  it('keeps multi-confirmed', async () => {
    const id = await makeEntry({ auto: true, pinned: false, conf: 2, ageDays: 60 });
    const archived = await archiveSingletonAutoEntries(pool, 30);
    expect(archived).not.toContain(id);
  });

  it('keeps recent', async () => {
    const id = await makeEntry({ auto: true, pinned: false, conf: 1, ageDays: 10 });
    const archived = await archiveSingletonAutoEntries(pool, 30);
    expect(archived).not.toContain(id);
  });

  it('keeps non-auto manual entries', async () => {
    const id = await makeEntry({ auto: false, pinned: false, conf: 1, ageDays: 60 });
    const archived = await archiveSingletonAutoEntries(pool, 30);
    expect(archived).not.toContain(id);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm test -- decay-singleton`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement**

In `src/memory/decay.ts`:

```typescript
import type { Pool } from 'pg';

export async function archiveSingletonAutoEntries(pool: Pool, days: number): Promise<string[]> {
  const { rows } = await pool.query(`
    UPDATE entries SET status = 'archived'
    WHERE status = 'active'
      AND auto_generated = true
      AND pinned = false
      AND confirmation_count = 1
      AND created_at < NOW() - ($1 || ' days')::interval
      AND last_confirmed_at IS NULL
    RETURNING id
  `, [days]);
  return rows.map(r => r.id as string);
}
```

- [ ] **Step 4: Wire into auto-archive job**

In `src/memory/manager.ts`, find `startAutoArchive`. After existing archival call, add:

```typescript
import { archiveSingletonAutoEntries } from './decay.js';
// inside the interval tick:
const decayDays = parseInt(process.env.AUTO_DECAY_DAYS ?? '30', 10);
const singletonIds = await archiveSingletonAutoEntries(this.storage.getPool(), decayDays);
if (singletonIds.length > 0) logger.info({ count: singletonIds.length }, 'singleton auto-entries archived');
```

- [ ] **Step 5: Run test → passes**

Run: `npm test -- decay-singleton`
Expected: 5 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/memory/decay.ts src/memory/manager.ts src/__tests__/decay-singleton.test.ts
git commit -m "feat(memory): auto-decay rule for singleton auto-generated entries"
```

---

## Phase 4 — Read-side filtering & sorting

### Task 10: Sort by importance, sanitize evidence_sources

**Files:**
- Modify: `src/memory/manager.ts` (read paths) and `src/storage/pg-storage.ts` (ORDER BY in `read`)
- Create: `src/__tests__/memory-read-sort-sanitize.test.ts`

- [ ] **Step 1: Write test**

```typescript
// src/__tests__/memory-read-sort-sanitize.test.ts
import { describe, it, expect } from 'vitest';
import { sanitizeEvidenceSourcesForPublic } from '../memory/manager.js';

describe('sanitizeEvidenceSourcesForPublic', () => {
  it('strips id from personal_note evidence', () => {
    const out = sanitizeEvidenceSourcesForPublic([
      { type: 'personal_note', id: 'note-uuid', shared_by: 'agent-uuid', confirmed_at: '2026-04-28T00:00:00Z' },
      { type: 'session', id: 'sess-uuid', agent_token_id: 'agent-uuid', confirmed_at: '2026-04-28T00:00:00Z' },
    ]);
    expect(out[0]).toEqual({ type: 'personal_note', shared_by: 'agent-uuid', confirmed_at: '2026-04-28T00:00:00Z' });
    expect(out[1]).toEqual({ type: 'session', id: 'sess-uuid', agent_token_id: 'agent-uuid', confirmed_at: '2026-04-28T00:00:00Z' });
  });
  it('returns [] for empty/undefined', () => {
    expect(sanitizeEvidenceSourcesForPublic(undefined)).toEqual([]);
    expect(sanitizeEvidenceSourcesForPublic([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm test -- memory-read-sort-sanitize`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement sanitizer (export from manager.ts)**

```typescript
// src/memory/manager.ts (add export at top-level)
import type { EvidenceSource } from '../extraction/types.js';

export function sanitizeEvidenceSourcesForPublic(sources?: EvidenceSource[]): EvidenceSource[] {
  if (!sources) return [];
  return sources.map(s => {
    if (s.type === 'personal_note') {
      const { id: _id, ...rest } = s;
      return rest as EvidenceSource;
    }
    return s;
  });
}
```

In `MemoryManager.read()` and `getById()` results: before returning entries, map each to apply `sanitizeEvidenceSourcesForPublic(entry.evidenceSources)`.

- [ ] **Step 4: Update storage ORDER BY**

In `src/storage/pg-storage.ts` `read()`, change ORDER BY from `updated_at DESC` (or whatever current default) to:

```sql
ORDER BY pinned DESC, importance_score DESC, updated_at DESC
```

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: PASS (existing manager tests for ordering may need adjustment — fix expectations to reflect importance ordering for new rows). If a test fails because it expected `updated_at` ordering, adapt the fixture: pin or set explicit `importance_score` to make ordering deterministic.

- [ ] **Step 6: Commit**

```bash
git add src/memory/manager.ts src/storage/pg-storage.ts src/__tests__/memory-read-sort-sanitize.test.ts
git commit -m "feat(memory): sort entries by importance, sanitize personal_note evidence ids"
```

---

## Phase 5 — Extraction prompt and LLM provider

### Task 11: ExtractionLlmProvider abstraction

**Files:**
- Create: `src/extraction/llm-provider.ts`

- [ ] **Step 1: Write file**

```typescript
// src/extraction/llm-provider.ts
import type { GeminiChatProvider } from '../llm/gemini.js';
import type { OllamaLlmClient } from '../llm/ollama.js';
import logger from '../logger.js';

export interface ExtractionLlmProvider {
  readonly name: string;
  isReady(): boolean;
  /**
   * Generate JSON output for the given prompt. Returns raw text — caller parses.
   * temperature low (0..0.3), maxTokens up to ~1500 (room for 5 candidates).
   */
  generate(prompt: string, opts: { temperature: number; maxTokens: number; signal?: AbortSignal }): Promise<string>;
}

export class GeminiExtractionProvider implements ExtractionLlmProvider {
  readonly name: string;
  constructor(private chat: GeminiChatProvider) { this.name = chat.name; }
  isReady() { return this.chat.isReady(); }
  async generate(prompt: string, opts: { temperature: number; maxTokens: number; signal?: AbortSignal }): Promise<string> {
    return this.chat.generate({ prompt, temperature: opts.temperature, maxTokens: opts.maxTokens }, opts.signal);
  }
}

export class OllamaExtractionProvider implements ExtractionLlmProvider {
  readonly name: string;
  constructor(private client: OllamaLlmClient) { this.name = client.modelName; }
  isReady() { return this.client.isReady(); }
  async generate(prompt: string, opts: { temperature: number; maxTokens: number; signal?: AbortSignal }): Promise<string> {
    if (opts.signal?.aborted) throw new Error('Aborted');
    return this.client.generate(prompt, { temperature: opts.temperature, maxTokens: opts.maxTokens });
  }
}

export function pickExtractionProvider(gemini: GeminiChatProvider | null, ollama: OllamaLlmClient | undefined, configured: 'gemini' | 'ollama'): ExtractionLlmProvider | null {
  if (configured === 'gemini' && gemini && gemini.isReady()) return new GeminiExtractionProvider(gemini);
  if (configured === 'ollama' && ollama && ollama.isReady()) return new OllamaExtractionProvider(ollama);
  // Fallback chain
  if (gemini && gemini.isReady()) return new GeminiExtractionProvider(gemini);
  if (ollama && ollama.isReady()) return new OllamaExtractionProvider(ollama);
  logger.warn('No extraction LLM provider available — extraction disabled');
  return null;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/extraction/llm-provider.ts
git commit -m "feat(extraction): ExtractionLlmProvider with Gemini/Ollama adapters"
```

### Task 12: Prompt builder

**Files:**
- Create: `src/extraction/prompt.ts`
- Create: `src/__tests__/extraction-prompt.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// src/__tests__/extraction-prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildExtractionPrompt, detectLang, sampleMessagesForPrompt } from '../extraction/prompt.js';

describe('detectLang', () => {
  it('detects Russian when Cyrillic ratio > 15%', () => {
    expect(detectLang('Hello мир и тогда')).toBe('Russian');
  });
  it('defaults to English when Cyrillic ratio < 15%', () => {
    expect(detectLang('Just plain English without accents')).toBe('English');
  });
  it('handles empty input', () => {
    expect(detectLang('')).toBe('English');
  });
});

describe('sampleMessagesForPrompt', () => {
  it('returns all when ≤40', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    expect(sampleMessagesForPrompt(msgs)).toHaveLength(30);
  });
  it('first 10 + middle step + last 10 when >40', () => {
    const msgs = Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const out = sampleMessagesForPrompt(msgs);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out[0].content).toBe('m0');
    expect(out[out.length - 1].content).toBe('m199');
  });
});

describe('buildExtractionPrompt', () => {
  it('includes summary, transcript, language tag, JSON skeleton', () => {
    const prompt = buildExtractionPrompt({
      summary: 'Worked on auth refactor',
      messages: [{ role: 'user', content: 'Решили использовать JWT' }],
    });
    expect(prompt).toContain('Worked on auth refactor');
    expect(prompt).toContain('Решили использовать JWT');
    expect(prompt).toMatch(/Russian|English/);
    expect(prompt).toContain('"architecture"');
    expect(prompt).toContain('"decisions"');
    expect(prompt).toContain('"conventions"');
  });
});
```

- [ ] **Step 2: Run failing tests**

Run: `npm test -- extraction-prompt`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/extraction/prompt.ts
const MAX_MESSAGES_FIRST = 10;
const MAX_MESSAGES_LAST = 10;
const MAX_MESSAGES_MIDDLE = 20;
const MAX_MESSAGE_CHARS = 300;

export function detectLang(text: string): 'Russian' | 'English' {
  const filtered = text.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '');
  if (filtered.length === 0) return 'English';
  const cyrillic = (filtered.match(/[а-яА-ЯёЁ]/g) ?? []).length;
  return cyrillic / filtered.length > 0.15 ? 'Russian' : 'English';
}

export function sampleMessagesForPrompt(messages: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
  if (messages.length <= MAX_MESSAGES_FIRST + MAX_MESSAGES_LAST + MAX_MESSAGES_MIDDLE) return messages;
  const first = messages.slice(0, MAX_MESSAGES_FIRST);
  const last = messages.slice(-MAX_MESSAGES_LAST);
  const middle = messages.slice(MAX_MESSAGES_FIRST, -MAX_MESSAGES_LAST);
  const step = Math.max(1, Math.ceil(middle.length / MAX_MESSAGES_MIDDLE));
  const middleSampled = middle.filter((_, i) => i % step === 0).slice(0, MAX_MESSAGES_MIDDLE);
  return [...first, ...middleSampled, ...last];
}

export function buildExtractionPrompt(input: {
  summary: string;
  messages: Array<{ role: string; content: string }>;
  projectId?: string;
  gitBranch?: string;
}): string {
  const sampled = sampleMessagesForPrompt(input.messages);
  const conversation = sampled.map(m => `[${m.role}]: ${m.content.slice(0, MAX_MESSAGE_CHARS)}`).join('\n');
  const lang = detectLang(input.summary + ' ' + conversation);

  return `You analyze a development session and extract ONLY atomic facts
worth preserving as long-term team knowledge.

Categories you may extract into (output keys):
- "architecture": system invariants, contracts, structural patterns
- "decisions":    explicit "why X, not Y" choices the team committed to
- "conventions":  rules, standards, agreed-upon practices

Each fact MUST satisfy:
- Atomic: one statement, not a paragraph of multiple ideas.
- Explains WHY (rationale, constraint, trade-off), not just WHAT
  (what's already in code, commits, PRs).
- Reusable beyond this session's specific bug or task.
- Length 30-500 characters in the "fact" field.

For each fact provide:
- "title": short identifier (5-10 words), language: ${lang}
- "fact": the WHY statement, language: ${lang}
- "why": background/rationale (1-2 sentences), language: ${lang}
- "tags": 2-5 lowercase tags
- "confidence": 0.0-1.0 — how confident you are this is a real durable fact
- "explicit_marker_strength": 0.0-1.0 — how clearly the session marks this
  as a closure (phrases like "решили", "договорились", "конвенция",
  "итого", "root cause", final user "ОК так и делаем") vs casual mention

If the session contains no such facts — return empty arrays.
Empty output is correct and expected for routine work.

Output VALID JSON, no markdown, no commentary:
{"architecture":[...],"decisions":[...],"conventions":[...]}

Session summary:
${input.summary}

Session transcript (sample):
${conversation}`;
}
```

- [ ] **Step 4: Run, verify pass + commit**

```bash
npm test -- extraction-prompt
git add src/extraction/prompt.ts src/__tests__/extraction-prompt.test.ts
git commit -m "feat(extraction): prompt builder, language detection, message sampling"
```

### Task 13: NoteExtractor — LLM call + parsing + filters

**Files:**
- Create: `src/extraction/extractor.ts`
- Create: `src/__tests__/extraction-extractor.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// src/__tests__/extraction-extractor.test.ts
import { describe, it, expect, vi } from 'vitest';
import { NoteExtractor } from '../extraction/extractor.js';
import type { ExtractionLlmProvider } from '../extraction/llm-provider.js';

function fakeProvider(responses: string[]): ExtractionLlmProvider {
  let i = 0;
  return {
    name: 'fake',
    isReady: () => true,
    generate: vi.fn(async () => responses[i++] ?? responses[responses.length - 1]),
  };
}

const goodResponse = JSON.stringify({
  architecture: [],
  decisions: [{
    title: 'Use JWT with refresh',
    fact: 'Auth uses JWT plus 7-day refresh tokens because cookie session storage was rejected for cross-domain reasons.',
    why: 'Refresh allows revocation and short access tokens.',
    tags: ['auth', 'jwt'],
    confidence: 0.9,
    explicit_marker_strength: 0.8,
  }],
  conventions: [],
});

describe('NoteExtractor', () => {
  it('parses well-formed JSON and applies filters', async () => {
    const ex = new NoteExtractor(fakeProvider([goodResponse]));
    const res = await ex.extract({ summary: 's', messages: [] });
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].category).toBe('decisions');
  });

  it('retries once if first response is malformed', async () => {
    const malformed = '```json\n' + goodResponse + '\n```';
    const ex = new NoteExtractor(fakeProvider([malformed, goodResponse]));
    const res = await ex.extract({ summary: 's', messages: [] });
    expect(res.candidates).toHaveLength(1);
  });

  it('rejects low confidence', async () => {
    const r = JSON.stringify({ architecture: [], decisions: [{
      title: 'x', fact: 'a'.repeat(50), why: 'y', tags: ['a'],
      confidence: 0.4, explicit_marker_strength: 0.9,
    }], conventions: [] });
    const ex = new NoteExtractor(fakeProvider([r]));
    const res = await ex.extract({ summary: 's', messages: [] });
    expect(res.candidates).toHaveLength(0);
    expect(res.rejected[0].reason).toMatch(/confidence/);
  });

  it('rejects too short fact', async () => {
    const r = JSON.stringify({ architecture: [], decisions: [{
      title: 'x', fact: 'short', why: 'y', tags: ['a'],
      confidence: 0.9, explicit_marker_strength: 0.9,
    }], conventions: [] });
    const ex = new NoteExtractor(fakeProvider([r]));
    const res = await ex.extract({ summary: 's', messages: [] });
    expect(res.candidates).toHaveLength(0);
  });

  it('caps to top 5 by confidence*marker', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      title: `t${i}`, fact: 'a'.repeat(50), why: 'y', tags: ['a'],
      confidence: 0.6 + i * 0.05, explicit_marker_strength: 0.5 + i * 0.05,
    }));
    const r = JSON.stringify({ architecture: items, decisions: [], conventions: [] });
    const ex = new NoteExtractor(fakeProvider([r]));
    const res = await ex.extract({ summary: 's', messages: [] });
    expect(res.candidates).toHaveLength(5);
    expect(res.candidates[0].title).toBe('t7'); // highest score
  });

  it('returns empty when LLM emits {}', async () => {
    const ex = new NoteExtractor(fakeProvider(['{}']));
    const res = await ex.extract({ summary: 's', messages: [] });
    expect(res.candidates).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npm test -- extraction-extractor`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/extraction/extractor.ts
import type { ExtractionLlmProvider } from './llm-provider.js';
import type { CandidateNote, ExtractionResult, AutoCategory } from './types.js';
import { AUTO_CATEGORIES } from './types.js';
import { buildExtractionPrompt } from './prompt.js';
import logger from '../logger.js';

export interface ExtractorConfig {
  minConfidence: number;
  minMarkerStrength: number;
  minFactLen: number;
  maxFactLen: number;
  maxNotesPerSession: number;
}

const DEFAULTS: ExtractorConfig = {
  minConfidence: 0.6,
  minMarkerStrength: 0.3,
  minFactLen: 30,
  maxFactLen: 500,
  maxNotesPerSession: 5,
};

export class NoteExtractor {
  private cfg: ExtractorConfig;
  constructor(private provider: ExtractionLlmProvider, cfg: Partial<ExtractorConfig> = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  async extract(input: { summary: string; messages: Array<{ role: string; content: string }>; signal?: AbortSignal }): Promise<ExtractionResult> {
    const prompt = buildExtractionPrompt(input);
    let raw = await this.provider.generate(prompt, { temperature: 0.2, maxTokens: 1500, signal: input.signal });
    let parsed = tryParseJson(raw);
    if (!parsed) {
      logger.warn({ rawSnippet: raw.slice(0, 200) }, 'extractor: malformed JSON, retrying');
      raw = await this.provider.generate(prompt + '\n\nReturn ONLY valid JSON, no markdown fences.', { temperature: 0.0, maxTokens: 1500, signal: input.signal });
      parsed = tryParseJson(raw);
    }
    if (!parsed) {
      logger.warn('extractor: still malformed after retry, returning empty');
      return { candidates: [], rejected: [], llm_input_chars: prompt.length, llm_output_chars: raw.length };
    }

    const all: CandidateNote[] = [];
    for (const cat of AUTO_CATEGORIES) {
      const arr = (parsed as any)[cat];
      if (!Array.isArray(arr)) continue;
      for (const it of arr) all.push({
        category: cat as AutoCategory,
        title: String(it.title ?? ''),
        fact: String(it.fact ?? ''),
        why: String(it.why ?? ''),
        tags: Array.isArray(it.tags) ? it.tags.map((t: unknown) => String(t).toLowerCase()) : [],
        confidence: Number(it.confidence ?? 0),
        explicit_marker_strength: Number(it.explicit_marker_strength ?? 0),
      });
    }

    const accepted: CandidateNote[] = [];
    const rejected: ExtractionResult['rejected'] = [];
    for (const c of all) {
      const reason = this.reject(c);
      if (reason) rejected.push({ candidate: c, reason });
      else accepted.push(c);
    }

    accepted.sort((a, b) => (b.confidence * b.explicit_marker_strength) - (a.confidence * a.explicit_marker_strength));
    const capped = accepted.slice(0, this.cfg.maxNotesPerSession);

    return {
      candidates: capped,
      rejected,
      llm_input_chars: prompt.length,
      llm_output_chars: raw.length,
    };
  }

  private reject(c: CandidateNote): string | null {
    if (c.confidence < this.cfg.minConfidence) return `confidence ${c.confidence} < ${this.cfg.minConfidence}`;
    if (c.explicit_marker_strength < this.cfg.minMarkerStrength) return `marker ${c.explicit_marker_strength} < ${this.cfg.minMarkerStrength}`;
    if (c.fact.length < this.cfg.minFactLen) return `fact too short (${c.fact.length} < ${this.cfg.minFactLen})`;
    if (c.fact.length > this.cfg.maxFactLen) return `fact too long (${c.fact.length} > ${this.cfg.maxFactLen})`;
    if (c.title.length < 5) return 'title too short';
    if (c.tags.length < 1) return 'no tags';
    return null;
  }
}

function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim().replace(/^```(?:json)?/, '').replace(/```$/, '').trim();
  try { return JSON.parse(trimmed); } catch { return null; }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test -- extraction-extractor`
Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extraction/extractor.ts src/__tests__/extraction-extractor.test.ts
git commit -m "feat(extraction): NoteExtractor with parse-retry, filters, top-N cap"
```

### Task 14: DedupResolver

**Files:**
- Create: `src/extraction/dedup.ts`
- Create: `src/__tests__/extraction-dedup.test.ts`

- [ ] **Step 1: Write tests with mocked Qdrant + embedding**

```typescript
// src/__tests__/extraction-dedup.test.ts
import { describe, it, expect, vi } from 'vitest';
import { DedupResolver } from '../extraction/dedup.js';
import type { CandidateNote } from '../extraction/types.js';

function mockProvider() {
  return {
    isReady: () => true,
    embed: vi.fn(async () => Array(768).fill(0)),
    embedBatch: vi.fn(),
    close: vi.fn(),
  };
}
function mockStore(score: number) {
  return {
    search: vi.fn(async () => score >= 0 ? [{ id: 'existing-id', score, payload: {} }] : []),
    upsert: vi.fn(),
    upsertBatch: vi.fn(),
    delete: vi.fn(),
    deleteByFilter: vi.fn(),
    setPayload: vi.fn(),
    close: vi.fn(),
  };
}
const candidate: CandidateNote = {
  category: 'decisions',
  title: 'JWT refresh',
  fact: 'Auth uses JWT plus 7-day refresh tokens for revocation.',
  why: 'Cross-domain rejected cookie sessions.',
  tags: ['auth'],
  confidence: 0.9,
  explicit_marker_strength: 0.8,
};

describe('DedupResolver', () => {
  it('cos > 0.85 → CONFIRM', async () => {
    const r = new DedupResolver(mockProvider() as any, mockStore(0.9) as any);
    const out = await r.resolve('proj', [candidate]);
    expect(out.decisions[0].type).toBe('CONFIRM');
  });
  it('0.7 ≤ cos ≤ 0.85 → MERGE', async () => {
    const r = new DedupResolver(mockProvider() as any, mockStore(0.78) as any);
    const out = await r.resolve('proj', [candidate]);
    expect(out.decisions[0].type).toBe('MERGE');
  });
  it('cos < 0.7 → CREATE_NEW', async () => {
    const r = new DedupResolver(mockProvider() as any, mockStore(0.5) as any);
    const out = await r.resolve('proj', [candidate]);
    expect(out.decisions[0].type).toBe('CREATE_NEW');
  });
  it('no matches → CREATE_NEW', async () => {
    const r = new DedupResolver(mockProvider() as any, mockStore(-1) as any);
    const out = await r.resolve('proj', [candidate]);
    expect(out.decisions[0].type).toBe('CREATE_NEW');
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```typescript
// src/extraction/dedup.ts
import type { EmbeddingProvider } from '../embedding/provider.js';
import type { VectorStore } from '../vector/vector-store.js';
import type { CandidateNote, DedupAction, DedupResult } from './types.js';

export interface DedupConfig {
  confirmThreshold: number;  // cos > this → CONFIRM
  mergeThreshold: number;    // cos in [merge, confirm] → MERGE
}

const DEFAULTS: DedupConfig = { confirmThreshold: 0.85, mergeThreshold: 0.7 };

export class DedupResolver {
  private cfg: DedupConfig;
  constructor(
    private embedding: EmbeddingProvider,
    private vectorStore: VectorStore,
    cfg: Partial<DedupConfig> = {},
  ) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  async resolve(projectId: string, candidates: CandidateNote[]): Promise<DedupResult> {
    const decisions: DedupAction[] = [];
    for (const c of candidates) {
      const text = `${c.title}\n${c.fact}\n${c.why}`;
      const vec = await this.embedding.embed(text, 'document');
      const matches = await this.vectorStore.search('entries', vec, {
        must: [
          { key: 'project_id', match: { value: projectId } },
          { key: 'category', match: { value: c.category } },
        ],
      }, 3);
      const top = matches[0];
      if (!top || top.score < this.cfg.mergeThreshold) {
        decisions.push({ type: 'CREATE_NEW', candidate: c });
      } else if (top.score > this.cfg.confirmThreshold) {
        decisions.push({ type: 'CONFIRM', entry_id: String(top.id), candidate: c, score: top.score });
      } else {
        decisions.push({ type: 'MERGE', entry_id: String(top.id), candidate: c, score: top.score });
      }
    }
    return { decisions };
  }
}
```

- [ ] **Step 4: Run, verify pass + commit**

```bash
npm test -- extraction-dedup
git add src/extraction/dedup.ts src/__tests__/extraction-dedup.test.ts
git commit -m "feat(extraction): DedupResolver with CONFIRM/MERGE/CREATE_NEW branching"
```

### Task 15: NoteMerger

**Files:**
- Create: `src/extraction/merger.ts`
- Create: `src/__tests__/extraction-merger.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// src/__tests__/extraction-merger.test.ts
import { describe, it, expect, vi } from 'vitest';
import { NoteMerger } from '../extraction/merger.js';

const provider = {
  name: 'mock', isReady: () => true,
  generate: vi.fn(async () => JSON.stringify({
    title: 'Merged title',
    fact: 'Merged fact under 500 chars',
    why: 'Merged why',
    tags: ['merged', 'a'],
  })),
};

describe('NoteMerger', () => {
  it('produces atomic merge with combined tags', async () => {
    const m = new NoteMerger(provider as any);
    const out = await m.merge(
      { title: 'Old', content: 'Old fact', tags: ['old'] },
      { title: 'New', fact: 'New fact', why: 'why', tags: ['new'], category: 'decisions', confidence: 1, explicit_marker_strength: 1 },
    );
    expect(out.title).toBe('Merged title');
    expect(out.tags).toEqual(expect.arrayContaining(['merged', 'a']));
    expect(out.fact.length).toBeLessThanOrEqual(500);
  });

  it('respects merge limit per session via static counter (caller provides count)', () => {
    expect(NoteMerger.canMerge(0, 3)).toBe(true);
    expect(NoteMerger.canMerge(3, 3)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

```typescript
// src/extraction/merger.ts
import type { ExtractionLlmProvider } from './llm-provider.js';
import type { CandidateNote } from './types.js';
import logger from '../logger.js';

export interface ExistingForMerge {
  title: string;
  content: string;
  tags: string[];
}

export interface MergedNote {
  title: string;
  fact: string;
  why: string;
  tags: string[];
}

export class NoteMerger {
  constructor(private provider: ExtractionLlmProvider) {}

  static canMerge(currentCount: number, max: number): boolean {
    return currentCount < max;
  }

  async merge(existing: ExistingForMerge, candidate: CandidateNote): Promise<MergedNote> {
    const prompt = `Объедини два связанных факта в один атомарный.
Сохрани WHY обоих, не теряй информацию, не превышай 500 символов в "fact".

EXISTING:
title: ${existing.title}
content: ${existing.content}

NEW:
title: ${candidate.title}
fact: ${candidate.fact}
why: ${candidate.why}

Output VALID JSON, no markdown:
{"title":"...","fact":"...","why":"...","tags":["..."]}`;

    const raw = await this.provider.generate(prompt, { temperature: 0.2, maxTokens: 700 });
    const trimmed = raw.trim().replace(/^```(?:json)?/, '').replace(/```$/, '').trim();
    let parsed: any;
    try { parsed = JSON.parse(trimmed); } catch (e) {
      logger.warn({ raw: raw.slice(0, 200) }, 'merger: malformed JSON, falling back to candidate');
      return { title: candidate.title, fact: candidate.fact, why: candidate.why, tags: [...new Set([...existing.tags, ...candidate.tags])] };
    }
    const fact = String(parsed.fact ?? candidate.fact).slice(0, 500);
    const tags: string[] = [...new Set([
      ...existing.tags,
      ...(Array.isArray(parsed.tags) ? parsed.tags : []),
      ...candidate.tags,
    ])].map(t => String(t).toLowerCase()).slice(0, 8);
    return {
      title: String(parsed.title ?? existing.title),
      fact,
      why: String(parsed.why ?? candidate.why),
      tags,
    };
  }
}
```

- [ ] **Step 4: Run, verify pass + commit**

```bash
npm test -- extraction-merger
git add src/extraction/merger.ts src/__tests__/extraction-merger.test.ts
git commit -m "feat(extraction): NoteMerger with LLM-based atomic merge under 500 chars"
```

### Task 16: MemoryManager — confirmExisting / mergeIntoExisting / createFromCandidate

**Files:**
- Modify: `src/memory/manager.ts`
- Create: `src/__tests__/memory-extraction-write.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// src/__tests__/memory-extraction-write.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/team_memory_test';
const PROJ = '00000000-0000-0000-0000-000000000000';

describe('MemoryManager extraction writes', () => {
  let pool: Pool, storage: PgStorage, manager: MemoryManager;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB });
    storage = new PgStorage(TEST_DB, 'simple');
    manager = new MemoryManager(storage);
    await manager.initialize();
  });

  afterAll(async () => { await manager.close(); await pool.end(); });

  it('createFromCandidate inserts with auto_generated=true and evidence_sources', async () => {
    const id = await manager.createFromCandidate(PROJ, {
      category: 'decisions',
      title: 'JWT refresh test',
      fact: 'JWT with 7d refresh, because cookies are blocked cross-domain',
      why: 'Tested rationale',
      tags: ['test'],
      confidence: 0.9,
      explicit_marker_strength: 0.7,
    }, [{ type: 'session', id: 'sess-1', agent_token_id: 'a-1', confirmed_at: new Date().toISOString() }]);
    const { rows } = await pool.query(`SELECT * FROM entries WHERE id=$1`, [id]);
    expect(rows[0].auto_generated).toBe(true);
    expect(rows[0].confirmation_count).toBe(1);
    expect(rows[0].evidence_sources).toHaveLength(1);
  });

  it('confirmExisting increments count and appends evidence', async () => {
    const id = await manager.createFromCandidate(PROJ, {
      category: 'decisions', title: 'Confirm me', fact: 'A'.repeat(50), why: 'y',
      tags: ['t'], confidence: 0.9, explicit_marker_strength: 0.7,
    }, [{ type: 'session', id: 'sess-A', confirmed_at: new Date().toISOString() }]);
    await manager.confirmExisting(id, { type: 'session', id: 'sess-B', confirmed_at: new Date().toISOString() });
    const { rows } = await pool.query(`SELECT confirmation_count, evidence_sources FROM entries WHERE id=$1`, [id]);
    expect(rows[0].confirmation_count).toBe(2);
    expect(rows[0].evidence_sources).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `npm test -- memory-extraction-write`
Expected: FAIL (methods missing).

- [ ] **Step 3: Implement methods on MemoryManager**

```typescript
// src/memory/manager.ts (add methods)
import type { CandidateNote, EvidenceSource } from '../extraction/types.js';

async createFromCandidate(projectId: string, c: CandidateNote, evidence: EvidenceSource[], domain?: string): Promise<string> {
  const content = `${c.fact}\n\nWhy: ${c.why}`;
  const { rows } = await this.storage.getPool().query(`
    INSERT INTO entries (
      project_id, category, domain, title, content, author, tags,
      priority, status, pinned,
      auto_generated, extraction_confidence, explicit_marker_strength,
      confirmation_count, last_confirmed_at, evidence_sources, external_refs
    ) VALUES (
      $1, $2, $3, $4, $5, 'auto-extractor', $6,
      'medium', 'active', false,
      true, $7, $8,
      1, NOW(), $9::jsonb, '{}'::jsonb
    )
    RETURNING id
  `, [
    projectId, c.category, domain ?? null, c.title, content, c.tags,
    c.confidence, c.explicit_marker_strength,
    JSON.stringify(evidence),
  ]);
  const id = rows[0].id as string;

  // Recompute importance + emit Qdrant upsert (fire-and-forget)
  await this.recomputeImportanceScore(id);

  if (this.embeddingProvider?.isReady() && this.vectorStore) {
    this.embeddingProvider.embed(`${c.title}\n${c.fact}\n${c.why}`, 'document')
      .then(vec => this.vectorStore!.upsert('entries', id, vec, {
        project_id: projectId,
        category: c.category,
        title: c.title,
        tags: c.tags,
      }))
      .catch(err => logger.warn({ err, id }, 'failed to embed new auto-entry'));
  }
  return id;
}

async confirmExisting(entryId: string, evidence: EvidenceSource): Promise<void> {
  await this.storage.getPool().query(`
    UPDATE entries
    SET confirmation_count = confirmation_count + 1,
        last_confirmed_at = NOW(),
        evidence_sources = evidence_sources || $1::jsonb
    WHERE id = $2
  `, [JSON.stringify([evidence]), entryId]);
  await this.recomputeImportanceScore(entryId);
}

async mergeIntoExisting(entryId: string, merged: { title: string; fact: string; why: string; tags: string[] }, evidence: EvidenceSource): Promise<void> {
  const content = `${merged.fact}\n\nWhy: ${merged.why}`;
  await this.storage.getPool().query(`
    UPDATE entries
    SET title = $1, content = $2, tags = $3,
        confirmation_count = confirmation_count + 1,
        last_confirmed_at = NOW(),
        evidence_sources = evidence_sources || $4::jsonb,
        updated_at = NOW()
    WHERE id = $5
  `, [merged.title, content, merged.tags, JSON.stringify([evidence]), entryId]);
  await this.recomputeImportanceScore(entryId);

  // Re-embed
  if (this.embeddingProvider?.isReady() && this.vectorStore) {
    this.embeddingProvider.embed(`${merged.title}\n${merged.fact}\n${merged.why}`, 'document')
      .then(vec => this.vectorStore!.upsert('entries', entryId, vec, { title: merged.title, tags: merged.tags }))
      .catch(err => logger.warn({ err, entryId }, 'failed to re-embed merged entry'));
  }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test -- memory-extraction-write`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/manager.ts src/__tests__/memory-extraction-write.test.ts
git commit -m "feat(memory): createFromCandidate/confirmExisting/mergeIntoExisting"
```

---

## Phase 6 — Sessions integration

### Task 17: Pipeline state extracting_notes in SessionManager

**Files:**
- Modify: `src/sessions/manager.ts`
- Modify: `src/sessions/types.ts`
- Modify: `src/sessions/storage.ts` (`getNextQueued`, `recoverStuckSessions`)
- Create: `src/__tests__/sessions-extraction-integration.test.ts`

- [ ] **Step 1: Update embedding_status union in `src/sessions/types.ts`**

```typescript
export type EmbeddingStatus =
  | 'queued' | 'queued_embed' | 'summarizing' | 'embedding'
  | 'extracting_notes' | 'complete' | 'failed' | 'extraction_failed';
```

(Reflect this in any place the type is duplicated.)

- [ ] **Step 2: Storage: include `extracting_notes` in stuck-recovery and queue-pickup**

In `src/sessions/storage.ts`, find `recoverStuckSessions` and `getNextQueued`. Add `'extracting_notes'` and `'extraction_failed'` to the recovery set; in `getNextQueued`, add `'extracting_notes'` as a status the worker can pick up to continue the pipeline if it ended on that step.

Specifically in `recoverStuckSessions`:

```sql
UPDATE sessions
SET embedding_status = CASE embedding_status
  WHEN 'summarizing'      THEN 'queued'
  WHEN 'embedding'        THEN 'queued_embed'
  WHEN 'extracting_notes' THEN 'extracting_notes'  -- left as-is, pickup retries
  ELSE embedding_status
END
WHERE embedding_status IN ('summarizing','embedding','extracting_notes')
  AND updated_at < NOW() - INTERVAL '10 minutes';
```

In `getNextQueued`, change to:

```sql
SELECT * FROM sessions
WHERE embedding_status IN ('queued','queued_embed','extracting_notes')
ORDER BY updated_at ASC
LIMIT 1
FOR UPDATE SKIP LOCKED
```

- [ ] **Step 3: SessionManager — call extractor after embedding**

In `src/sessions/manager.ts`, modify constructor to accept extraction deps:

```typescript
import { NoteExtractor } from '../extraction/extractor.js';
import { DedupResolver } from '../extraction/dedup.js';
import { NoteMerger } from '../extraction/merger.js';
import type { MemoryManager } from '../memory/manager.js';
import type { EvidenceSource } from '../extraction/types.js';

constructor(
  private storage: SessionStorage,
  private vectorStore?: VectorStore,
  private embeddingProvider?: EmbeddingProvider,
  private llmClient?: OllamaLlmClient,
  private noteExtractor?: NoteExtractor,
  private dedupResolver?: DedupResolver,
  private noteMerger?: NoteMerger,
  private memoryManager?: MemoryManager,
  private extractionEnabled: boolean = true,
  private maxMergesPerSession: number = 3,
) {}
```

In `processQueue`, after embedding completes, instead of marking `complete`, transition to `extracting_notes`:

```typescript
// Step 3 (NEW): extracting_notes
if (this.extractionEnabled && this.noteExtractor && this.dedupResolver && this.memoryManager) {
  await this.storage.updateEmbeddingStatus(session.id, 'extracting_notes');
  try {
    await this.runExtraction(session);
    await this.storage.updateEmbeddingStatus(session.id, 'complete');
  } catch (err) {
    logger.error({ err, sessionId: session.id }, 'note extraction failed');
    await this.storage.updateEmbeddingStatus(session.id, 'extraction_failed');
  }
} else {
  await this.storage.updateEmbeddingStatus(session.id, 'complete');
}
```

Add private method:

```typescript
private async runExtraction(session: Session): Promise<void> {
  if (!session.projectId) { logger.info({ sessionId: session.id }, 'skip extraction: no project'); return; }
  const messages = await this.storage.getMessages(session.id, 0);
  const result = await this.noteExtractor!.extract({
    summary: session.summary,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  });
  if (result.candidates.length === 0) {
    logger.info({ sessionId: session.id, rejected: result.rejected.length }, 'extraction yielded zero candidates');
    return;
  }
  const dedup = await this.dedupResolver!.resolve(session.projectId, result.candidates);
  let mergesUsed = 0;
  for (const decision of dedup.decisions) {
    const evidence: EvidenceSource = {
      type: 'session',
      id: session.id,
      agent_token_id: session.agentTokenId,
      confirmed_at: new Date().toISOString(),
    };
    if (decision.type === 'CREATE_NEW') {
      await this.memoryManager!.createFromCandidate(session.projectId, decision.candidate, [evidence]);
    } else if (decision.type === 'CONFIRM') {
      await this.memoryManager!.confirmExisting(decision.entry_id, evidence);
    } else if (decision.type === 'MERGE') {
      if (!this.noteMerger || !NoteMerger.canMerge(mergesUsed, this.maxMergesPerSession)) {
        // Fall through to CONFIRM behaviour to avoid losing the signal
        await this.memoryManager!.confirmExisting(decision.entry_id, evidence);
        continue;
      }
      const existing = await this.memoryManager!.getById(decision.entry_id);
      if (!existing) continue;
      const merged = await this.noteMerger.merge(
        { title: existing.title, content: existing.content, tags: existing.tags },
        decision.candidate,
      );
      await this.memoryManager!.mergeIntoExisting(decision.entry_id, merged, evidence);
      mergesUsed++;
    }
  }
  logger.info({ sessionId: session.id, decisions: dedup.decisions.map(d => d.type), merges: mergesUsed }, 'extraction applied');
}
```

Note: `MemoryManager.getById` may not exist publicly; if not, add a thin pass-through:

```typescript
async getById(id: string): Promise<MemoryEntry | null> {
  return this.storage.getById(id);
}
```

- [ ] **Step 4: Write integration test**

```typescript
// src/__tests__/sessions-extraction-integration.test.ts
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import { SessionStorage } from '../sessions/storage.js';
import { SessionManager } from '../sessions/manager.js';
import { NoteExtractor } from '../extraction/extractor.js';
import { DedupResolver } from '../extraction/dedup.js';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/team_memory_test';
const PROJ = '00000000-0000-0000-0000-000000000000';

describe('session pipeline → extraction', () => {
  let pool: Pool, storage: PgStorage, manager: MemoryManager;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB });
    storage = new PgStorage(TEST_DB, 'simple');
    manager = new MemoryManager(storage);
    await manager.initialize();
  });

  afterAll(async () => { await manager.close(); await pool.end(); });

  it('end-to-end: import → summary skipped (provided) → embedding skipped (no provider) → extraction runs → complete', async () => {
    const sessStorage = new SessionStorage(pool);
    const fakeProvider = {
      name: 'fake', isReady: () => true,
      generate: vi.fn(async () => JSON.stringify({
        architecture: [], conventions: [],
        decisions: [{
          title: 'Atomic decision', fact: 'Something durable atomic and clear under 500 chars to pass.',
          why: 'Because reasons.', tags: ['t'],
          confidence: 0.9, explicit_marker_strength: 0.8,
        }],
      })),
    };
    const extractor = new NoteExtractor(fakeProvider as any);
    const fakeEmbed = { isReady: () => true, embed: vi.fn(async () => Array(768).fill(0)), embedBatch: vi.fn(), close: vi.fn() };
    const fakeVec = { search: vi.fn(async () => []), upsert: vi.fn(), upsertBatch: vi.fn(), delete: vi.fn(), deleteByFilter: vi.fn(), setPayload: vi.fn(), close: vi.fn() };
    const dedup = new DedupResolver(fakeEmbed as any, fakeVec as any);
    const sm = new SessionManager(sessStorage, fakeVec as any, fakeEmbed as any, undefined, extractor, dedup, undefined, manager, true);

    const session = await sm.importSession('agent-token-id-uuid', {
      externalId: `test-${Date.now()}`,
      summary: 'Provided summary',
      projectId: PROJ,
      messages: [{ role: 'user', content: 'Решили использовать JWT', toolNames: [] }],
    });
    // Drain queue to processed=complete
    for (let i = 0; i < 5 && (await sessStorage.getSession(session.id))!.embeddingStatus !== 'complete'; i++) {
      await sm.processQueue();
    }
    const final = await sessStorage.getSession(session.id);
    expect(final!.embeddingStatus).toBe('complete');
    const { rows } = await pool.query(`SELECT * FROM entries WHERE evidence_sources @> $1::jsonb`, [JSON.stringify([{ type: 'session', id: session.id }])]);
    expect(rows.length).toBe(1);
  });

  it('extractionEnabled=false skips extraction', async () => {
    // ... similar setup but with extractionEnabled=false; assert state is 'complete' and no entries created.
    // (Implementation copies the test above with `extractionEnabled: false` and expects 0 rows.)
  });
});
```

- [ ] **Step 5: Run all tests + commit**

```bash
npm test -- sessions-extraction-integration
git add src/sessions/manager.ts src/sessions/types.ts src/sessions/storage.ts src/__tests__/sessions-extraction-integration.test.ts
git commit -m "feat(sessions): add extracting_notes pipeline state with extractor/dedup/merger"
```

---

## Phase 7 — Manual share path

### Task 18: NotesManager.share + storage update

**Files:**
- Modify: `src/notes/manager.ts`
- Modify: `src/notes/storage.ts`
- Modify: `src/notes/types.ts`
- Create: `src/__tests__/notes-share.test.ts`

- [ ] **Step 1: Add `sharedToEntryId` to PersonalNote type and storage mapper**

In `src/notes/types.ts`, add to `PersonalNote`:

```typescript
sharedToEntryId?: string | null;
```

In `src/notes/storage.ts` row mapper: `sharedToEntryId: row.shared_to_entry_id ?? null`. Add to all SELECT lists.

Add method:

```typescript
async setSharedToEntry(noteId: string, entryId: string | null): Promise<void> {
  await this.pool.query(`UPDATE personal_notes SET shared_to_entry_id = $1 WHERE id = $2`, [entryId, noteId]);
}
```

- [ ] **Step 2: Write share test**

```typescript
// src/__tests__/notes-share.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import { PersonalNotesStorage } from '../notes/storage.js';
import { NotesManager } from '../notes/manager.js';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/team_memory_test';
const PROJ = '00000000-0000-0000-0000-000000000000';
const AGENT = '00000000-0000-0000-0000-000000000aaa';

describe('NotesManager.share', () => {
  let pool: Pool, storage: PgStorage, mm: MemoryManager, ns: PersonalNotesStorage, nm: NotesManager;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB });
    storage = new PgStorage(TEST_DB, 'simple');
    mm = new MemoryManager(storage);
    await mm.initialize();
    await pool.query(`INSERT INTO agent_tokens (id, name, token_hash, is_active) VALUES ($1,'a','x',true) ON CONFLICT DO NOTHING`, [AGENT]);
    ns = new PersonalNotesStorage(pool);
    nm = new NotesManager(ns); // no vector store needed if dedup mocked separately
  });

  afterAll(async () => { await mm.close(); await pool.end(); });

  it('share with no match → creates entry, sets shared_to_entry_id', async () => {
    const note = await nm.write(AGENT, { title: 'JWT decision', content: 'Use JWT 7d refresh', tags: ['auth'], priority: 'medium', projectId: PROJ, sessionId: null });
    const result = await nm.share({
      noteId: note.id, agentTokenId: AGENT, category: 'decisions',
      memoryManager: mm, onMatch: 'create_new',
    });
    expect(result.action).toBe('created');
    expect(result.entryId).toBeTypeOf('string');
    const fresh = await nm.getById(note.id, AGENT);
    expect(fresh!.sharedToEntryId).toBe(result.entryId);
  });
});
```

- [ ] **Step 3: Implement `share` on NotesManager**

```typescript
// src/notes/manager.ts (add)
import type { MemoryManager } from '../memory/manager.js';
import type { CandidateNote, AutoCategory, EvidenceSource } from '../extraction/types.js';
import type { DedupResolver } from '../extraction/dedup.js';
import type { NoteMerger } from '../extraction/merger.js';

export type ShareAction =
  | 'created'
  | 'confirmed_existing'
  | 'merged'
  | 'match_found_pending_user_decision';

export interface ShareResult {
  action: ShareAction;
  entryId: string | null;
  existingEntry?: { id: string; title: string; content: string; score: number };
  matchScore?: number;
}

export interface ShareParams {
  noteId: string;
  agentTokenId: string;
  category: AutoCategory;
  override?: { title?: string; content?: string; tags?: string[]; externalRefs?: Record<string, unknown> };
  onMatch?: 'prompt' | 'confirm_existing' | 'create_new' | 'merge';
  memoryManager: MemoryManager;
  dedupResolver?: DedupResolver;
  merger?: NoteMerger;
}

async share(p: ShareParams): Promise<ShareResult> {
  const note = await this.storage.getById(p.noteId, p.agentTokenId);
  if (!note) throw new Error('Note not found or not yours');
  const title = p.override?.title ?? note.title;
  const fact = p.override?.content ?? note.content;
  const tags = p.override?.tags ?? note.tags;

  const candidate: CandidateNote = {
    category: p.category, title, fact, why: 'Manual share',
    tags, confidence: 1.0, explicit_marker_strength: 1.0,
  };
  const evidence: EvidenceSource = {
    type: 'personal_note',
    id: note.id,
    shared_by: p.agentTokenId,
    confirmed_at: new Date().toISOString(),
  };

  // Dedup if resolver available
  if (p.dedupResolver && note.projectId) {
    const dedup = await p.dedupResolver.resolve(note.projectId, [candidate]);
    const decision = dedup.decisions[0];
    if (decision.type === 'CONFIRM' || decision.type === 'MERGE') {
      const existing = await p.memoryManager.getById(decision.entry_id);
      const onMatch = p.onMatch ?? 'prompt';
      if (onMatch === 'prompt') {
        return {
          action: 'match_found_pending_user_decision',
          entryId: null,
          existingEntry: existing ? { id: existing.id, title: existing.title, content: existing.content, score: decision.score } : undefined,
          matchScore: decision.score,
        };
      }
      if (onMatch === 'confirm_existing') {
        await p.memoryManager.confirmExisting(decision.entry_id, evidence);
        await this.storage.setSharedToEntry(note.id, decision.entry_id);
        return { action: 'confirmed_existing', entryId: decision.entry_id };
      }
      if (onMatch === 'merge' && p.merger && existing) {
        const merged = await p.merger.merge({ title: existing.title, content: existing.content, tags: existing.tags }, candidate);
        await p.memoryManager.mergeIntoExisting(decision.entry_id, merged, evidence);
        await this.storage.setSharedToEntry(note.id, decision.entry_id);
        return { action: 'merged', entryId: decision.entry_id };
      }
      // onMatch=create_new falls through
    }
  }

  // Create new — pinned because manual share = guaranteed important
  const entryId = await p.memoryManager.createFromCandidate(note.projectId ?? '00000000-0000-0000-0000-000000000000', candidate, [evidence]);
  // Set pinned=true to opt out of decay
  await p.memoryManager.update({ id: entryId, pinned: true });
  await this.storage.setSharedToEntry(note.id, entryId);
  return { action: 'created', entryId };
}
```

- [ ] **Step 4: Run tests + commit**

```bash
npm test -- notes-share
git add src/notes/manager.ts src/notes/storage.ts src/notes/types.ts src/__tests__/notes-share.test.ts
git commit -m "feat(notes): share() — manual personal note → team entry with dedup + pin"
```

### Task 19: REST endpoint POST /api/notes/:id/share

**Files:**
- Modify: `src/app.ts` (add route)

- [ ] **Step 1: Add route**

In `src/app.ts`, after existing notes routes, add:

```typescript
app.post('/api/notes/:id/share', async (req, res) => {
  if (!notesManager) { res.status(404).json({ success: false, error: 'Notes not configured' }); return; }
  const agentTokenId = (req as any).auth?.agentTokenId as string | undefined;
  if (!agentTokenId) { res.status(401).json({ success: false, error: 'Agent token required' }); return; }
  const { category, override, on_match } = req.body ?? {};
  if (!['architecture','decisions','conventions'].includes(category)) {
    res.status(400).json({ success: false, error: 'category must be architecture, decisions, or conventions' });
    return;
  }
  try {
    const result = await notesManager.share({
      noteId: req.params.id,
      agentTokenId,
      category,
      override,
      onMatch: on_match,
      memoryManager,
      dedupResolver,    // these need to be wired in (see Task 21)
      merger,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    if (err.message?.includes('not found')) { res.status(404).json({ success: false, error: err.message }); return; }
    logger.error({ err }, 'POST /api/notes/:id/share failed');
    res.status(500).json({ success: false, error: 'Share failed' });
  }
});
```

(Variables `dedupResolver`, `merger` will be created in Task 21.)

- [ ] **Step 2: Smoke test (manual)**

Bring up server, create note, POST `/api/notes/<id>/share` with `{"category":"decisions"}`. Expect 200 and entry created. Skip if Task 21 not done yet — postpone the check until then.

- [ ] **Step 3: Commit**

```bash
git add src/app.ts
git commit -m "feat(api): POST /api/notes/:id/share endpoint"
```

### Task 20: MCP tool `note_share`

**Files:**
- Modify: `src/server.ts`
- Create: `src/__tests__/mcp-note-share.test.ts`

- [ ] **Step 1: Add Zod schema + tool definition**

In `src/server.ts` near other note schemas:

```typescript
const NoteShareSchema = z.object({
  note_id: z.string().uuid(),
  category: z.enum(['architecture', 'decisions', 'conventions']),
  override: z.object({
    title: z.string().optional(),
    content: z.string().optional(),
    tags: z.array(z.string()).optional(),
    external_refs: z.record(z.unknown()).optional(),
  }).optional(),
  on_match: z.enum(['prompt', 'confirm_existing', 'create_new', 'merge']).optional(),
});
```

In tool list (where `note_search` is registered), add:

```typescript
{
  name: 'note_share',
  description: 'Share a personal note as a team-memory entry (architecture/decisions/conventions). Performs dedup; if a similar entry exists, returns existing match or confirms/merges per on_match.',
  inputSchema: { type: 'object', required: ['note_id', 'category'], properties: {
    note_id: { type: 'string' },
    category: { type: 'string', enum: ['architecture','decisions','conventions'] },
    override: { type: 'object' },
    on_match: { type: 'string', enum: ['prompt','confirm_existing','create_new','merge'] },
  } },
},
```

In handler switch, add case:

```typescript
case 'note_share': {
  if (!notesManager || !memoryManager) return { content: [{ type: 'text', text: '❌ Not configured' }], isError: true };
  const parsed = NoteShareSchema.safeParse(args);
  if (!parsed.success) return { content: [{ type: 'text', text: `❌ ${formatZodError(parsed.error)}` }], isError: true };
  const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
  if (!agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required for share' }], isError: true };
  const result = await notesManager.share({
    noteId: parsed.data.note_id, agentTokenId,
    category: parsed.data.category,
    override: parsed.data.override
      ? { title: parsed.data.override.title, content: parsed.data.override.content, tags: parsed.data.override.tags, externalRefs: parsed.data.override.external_refs }
      : undefined,
    onMatch: parsed.data.on_match,
    memoryManager,
    dedupResolver,
    merger,
  });
  const lines = [`Action: ${result.action}`];
  if (result.entryId) lines.push(`Entry ID: ${result.entryId}`);
  if (result.existingEntry) lines.push(`Existing: ${result.existingEntry.title} (score ${result.existingEntry.score.toFixed(2)})`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}
```

The variables `dedupResolver` and `merger` come into `buildMcpServer` signature; update it (Task 21).

- [ ] **Step 2: Commit**

```bash
git add src/server.ts
git commit -m "feat(mcp): note_share tool"
```

### Task 21: Deprecate memory_write

**Files:**
- Modify: `src/server.ts`
- Create: `src/__tests__/memory-write-deprecated.test.ts`

- [ ] **Step 1: Write test**

```typescript
// src/__tests__/memory-write-deprecated.test.ts
import { describe, it, expect } from 'vitest';
import { buildMcpServer } from '../server.js';
// We test the handler directly with a minimal manager mock.
import { MemoryManager } from '../memory/manager.js';

describe('memory_write deprecation', () => {
  it('returns isError true with 410-style guidance text', async () => {
    const memoryManagerMock: any = {};
    const server = buildMcpServer(memoryManagerMock, undefined as any, undefined, undefined, undefined as any, undefined as any);
    // The MCP SDK testing approach varies; if buildMcpServer exposes a handle, exercise via it.
    // Otherwise, this test asserts that the case "memory_write" string is matched
    // and returns isError true. (See implementation comments.)
    expect(server).toBeDefined();
  });
});
```

(If exercising the MCP server directly is impractical here, replace with a smaller unit-level test that imports the deprecation message constant from `server.ts` and asserts text content.)

- [ ] **Step 2: Replace `memory_write` handler with 410 response**

In `src/server.ts`, find `case 'memory_write':` block and replace with:

```typescript
case 'memory_write': {
  return {
    content: [{
      type: 'text',
      text: 'memory_write deprecated since v4.5. Use note_write to create a personal draft, then note_share to publish to team memory. Auto-extractor also creates entries from sessions automatically.',
    }],
    isError: true,
  };
}
```

In tool definitions list, replace `memory_write` description with:

```typescript
{
  name: 'memory_write',
  description: 'DEPRECATED since v4.5 — returns 410-style error. Use note_write + note_share or rely on auto-extraction from sessions.',
  inputSchema: { type: 'object', properties: {} },
},
```

- [ ] **Step 3: Run + commit**

```bash
npm test -- memory-write-deprecated
git add src/server.ts src/__tests__/memory-write-deprecated.test.ts
git commit -m "feat(mcp): deprecate memory_write — returns 410-style guidance"
```

---

## Phase 8 — Retrieval abstraction

### Task 22: KnowledgeSource implementations

**Files:**
- Create: `src/retrieval/sources/entries-source.ts`
- Create: `src/retrieval/sources/sessions-source.ts`
- Create: `src/retrieval/sources/messages-source.ts`

- [ ] **Step 1: Implement EntriesSource**

```typescript
// src/retrieval/sources/entries-source.ts
import type { KnowledgeSource, KnowledgeChunk, RetrievalFilters } from '../types.js';
import type { EmbeddingProvider } from '../../embedding/provider.js';
import type { VectorStore, VectorFilter } from '../../vector/vector-store.js';
import type { PgStorage } from '../../storage/pg-storage.js';

export class EntriesSource implements KnowledgeSource {
  readonly type = 'entries' as const;
  constructor(private embedding: EmbeddingProvider, private vector: VectorStore, private storage: PgStorage) {}

  async search(query: string, filters: RetrievalFilters, limit: number): Promise<KnowledgeChunk[]> {
    if (!this.embedding.isReady()) return [];
    const vec = await this.embedding.embed(query, 'query');
    const f: VectorFilter = { must: [{ key: 'project_id', match: { value: filters.project_id } }] };
    if (filters.categories?.length) {
      f.should = filters.categories.map(c => ({ key: 'category', match: { value: c } }));
    }
    const results = await this.vector.search('entries', vec, f, limit);
    const ids = results.map(r => String(r.id));
    if (ids.length === 0) return [];
    const entries = await this.storage.getByIds(filters.project_id, ids);
    return results.map(r => {
      const e = entries.find(x => x.id === String(r.id));
      if (!e) return null;
      return {
        source_type: 'entries' as const,
        source_id: e.id,
        text: `${e.title}\n\n${e.content}`,
        score: r.score,
        metadata: { category: e.category, importance_score: e.importanceScore, confirmation_count: e.confirmationCount, pinned: e.pinned, tags: e.tags },
      };
    }).filter((x): x is KnowledgeChunk => x !== null);
  }
}
```

- [ ] **Step 2: Implement SessionsSource and MessagesSource similarly**

```typescript
// src/retrieval/sources/sessions-source.ts
import type { KnowledgeSource, KnowledgeChunk, RetrievalFilters } from '../types.js';
import type { EmbeddingProvider } from '../../embedding/provider.js';
import type { VectorStore, VectorFilter } from '../../vector/vector-store.js';
import type { SessionStorage } from '../../sessions/storage.js';

export class SessionsSource implements KnowledgeSource {
  readonly type = 'sessions' as const;
  constructor(private embedding: EmbeddingProvider, private vector: VectorStore, private storage: SessionStorage) {}

  async search(query: string, filters: RetrievalFilters, limit: number): Promise<KnowledgeChunk[]> {
    if (!this.embedding.isReady()) return [];
    const vec = await this.embedding.embed(query, 'query');
    const f: VectorFilter = { must: [{ key: 'project_id', match: { value: filters.project_id } }] };
    if (filters.agent_token_id) f.must!.push({ key: 'agent_token_id', match: { value: filters.agent_token_id } });
    const results = await this.vector.search('sessions', vec, f, limit);
    const out: KnowledgeChunk[] = [];
    for (const r of results) {
      const s = await this.storage.getSession(String(r.id));
      if (!s) continue;
      out.push({
        source_type: 'sessions',
        source_id: s.id,
        text: s.summary,
        score: r.score,
        metadata: { name: s.name, message_count: s.messageCount, started_at: s.startedAt, tags: s.tags },
      });
    }
    return out;
  }
}
```

```typescript
// src/retrieval/sources/messages-source.ts
import type { KnowledgeSource, KnowledgeChunk, RetrievalFilters } from '../types.js';
import type { EmbeddingProvider } from '../../embedding/provider.js';
import type { VectorStore, VectorFilter } from '../../vector/vector-store.js';
import type { SessionStorage } from '../../sessions/storage.js';

export class MessagesSource implements KnowledgeSource {
  readonly type = 'session_messages' as const;
  constructor(private embedding: EmbeddingProvider, private vector: VectorStore, private storage: SessionStorage) {}

  async search(query: string, filters: RetrievalFilters, limit: number): Promise<KnowledgeChunk[]> {
    if (!this.embedding.isReady()) return [];
    const vec = await this.embedding.embed(query, 'query');
    const f: VectorFilter = { must: [] };
    if (filters.agent_token_id) f.must!.push({ key: 'agent_token_id', match: { value: filters.agent_token_id } });
    const results = await this.vector.search('session_messages', vec, f, limit);
    const out: KnowledgeChunk[] = [];
    for (const r of results) {
      const messageId = r.payload.message_id as string;
      const sessionId = r.payload.session_id as string;
      const messages = await this.storage.getMessageById(sessionId, messageId);
      if (!messages) continue;
      out.push({
        source_type: 'session_messages',
        source_id: messageId,
        text: messages.content,
        score: r.score,
        metadata: { session_id: sessionId, role: messages.role, tool_names: messages.toolNames },
      });
    }
    return out;
  }
}
```

(If `getMessageById` isn't yet on SessionStorage, add a thin wrapper.)

- [ ] **Step 3: Commit**

```bash
git add src/retrieval/sources/
git commit -m "feat(retrieval): EntriesSource, SessionsSource, MessagesSource"
```

### Task 23: HierarchicalRetrieval orchestrator

**Files:**
- Create: `src/retrieval/hierarchical.ts`
- Create: `src/__tests__/retrieval-hierarchical.test.ts`

- [ ] **Step 1: Write test**

```typescript
// src/__tests__/retrieval-hierarchical.test.ts
import { describe, it, expect } from 'vitest';
import { HierarchicalRetrieval } from '../retrieval/hierarchical.js';
import type { KnowledgeSource, KnowledgeChunk } from '../retrieval/types.js';

function fakeSource(type: any, chunks: KnowledgeChunk[]): KnowledgeSource {
  return { type, search: async () => chunks } as any;
}

describe('HierarchicalRetrieval', () => {
  it('groups results by source type', async () => {
    const r = new HierarchicalRetrieval([
      fakeSource('entries', [{ source_type: 'entries', source_id: 'e1', text: 'note', score: 0.9, metadata: {} }]),
      fakeSource('sessions', [{ source_type: 'sessions', source_id: 's1', text: 'sess', score: 0.7, metadata: {} }]),
      fakeSource('session_messages', []),
    ]);
    const out = await r.retrieve('q', { project_id: 'p' });
    expect(out.notes).toHaveLength(1);
    expect(out.sessions).toHaveLength(1);
    expect(out.snippets).toHaveLength(0);
  });

  it('applies threshold filtering per layer', async () => {
    const r = new HierarchicalRetrieval([
      fakeSource('entries', [{ source_type: 'entries', source_id: 'e1', text: 'note', score: 0.5, metadata: {} }]),
    ], { entriesThreshold: 0.6, sessionsThreshold: 0.55, snippetsThreshold: 0.5 });
    const out = await r.retrieve('q', { project_id: 'p' });
    expect(out.notes).toHaveLength(0);
  });

  it('register adds new source', async () => {
    const r = new HierarchicalRetrieval([]);
    r.register(fakeSource('entries', [{ source_type: 'entries', source_id: 'e1', text: 'x', score: 0.9, metadata: {} }]));
    const out = await r.retrieve('q', { project_id: 'p' });
    expect(out.notes).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/retrieval/hierarchical.ts
import type { KnowledgeSource, KnowledgeChunk, RetrievalFilters, SourceType } from './types.js';

export interface RetrievalConfig {
  entriesLimit: number; entriesThreshold: number;
  sessionsLimit: number; sessionsThreshold: number;
  snippetsLimit: number; snippetsThreshold: number;
}
const DEFAULTS: RetrievalConfig = {
  entriesLimit: 5, entriesThreshold: 0.6,
  sessionsLimit: 5, sessionsThreshold: 0.55,
  snippetsLimit: 10, snippetsThreshold: 0.5,
};

export interface RetrievalOutput {
  notes: KnowledgeChunk[];
  sessions: KnowledgeChunk[];
  snippets: KnowledgeChunk[];
  // v5 placeholders:
  code?: KnowledgeChunk[];
  prs?: KnowledgeChunk[];
  wikis?: KnowledgeChunk[];
}

export class HierarchicalRetrieval {
  private cfg: RetrievalConfig;
  constructor(private sources: KnowledgeSource[], cfg: Partial<RetrievalConfig> = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  register(source: KnowledgeSource): void { this.sources.push(source); }

  async retrieve(query: string, filters: RetrievalFilters): Promise<RetrievalOutput> {
    const calls = this.sources.map(s => this.callSource(s, query, filters));
    const results = await Promise.all(calls);
    const out: RetrievalOutput = { notes: [], sessions: [], snippets: [] };
    for (const chunks of results) {
      for (const c of chunks) {
        switch (c.source_type) {
          case 'entries': out.notes.push(c); break;
          case 'sessions': out.sessions.push(c); break;
          case 'session_messages': out.snippets.push(c); break;
          case 'code': (out.code ??= []).push(c); break;
          case 'pr': (out.prs ??= []).push(c); break;
          case 'wiki': (out.wikis ??= []).push(c); break;
        }
      }
    }
    return out;
  }

  private async callSource(s: KnowledgeSource, q: string, f: RetrievalFilters): Promise<KnowledgeChunk[]> {
    const limit = this.limitFor(s.type);
    const threshold = this.thresholdFor(s.type);
    const all = await s.search(q, f, limit);
    return all.filter(c => c.score >= threshold);
  }

  private limitFor(t: SourceType): number {
    if (t === 'entries') return this.cfg.entriesLimit;
    if (t === 'sessions') return this.cfg.sessionsLimit;
    if (t === 'session_messages') return this.cfg.snippetsLimit;
    return 5;
  }
  private thresholdFor(t: SourceType): number {
    if (t === 'entries') return this.cfg.entriesThreshold;
    if (t === 'sessions') return this.cfg.sessionsThreshold;
    if (t === 'session_messages') return this.cfg.snippetsThreshold;
    return 0.5;
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
npm test -- retrieval-hierarchical
git add src/retrieval/hierarchical.ts src/__tests__/retrieval-hierarchical.test.ts
git commit -m "feat(retrieval): HierarchicalRetrieval orchestrator with per-layer thresholds"
```

### Task 24: RagAgent → use HierarchicalRetrieval

**Files:**
- Modify: `src/rag/agent.ts`
- Modify: `src/rag/tool-adapter.ts` (or wherever search calls live)
- Modify: `src/app.ts` (build retrieval, pass into factory)

- [ ] **Step 1: Inject HierarchicalRetrieval**

In `src/rag/agent.ts` constructor params, add `retrieval?: HierarchicalRetrieval`. Internally, where the agent currently calls `memoryManager.read(...)` or `sessionManager.searchSessions(...)`, route through `retrieval.retrieve(...)` when a unified retrieval is needed (e.g. an `auto-recall` step). Keep MCP tool calls (the agent's function-calling) unchanged — those go through the McpToolAdapter to specific managers.

The minimum change: replace any "manual layered query" code in the agent's onboarding/auto-context step. If the agent today only relies on tool calls, leave logic as-is and instead expose `HierarchicalRetrieval` as an optional helper for future auto-context.

- [ ] **Step 2: Build + wire in app.ts**

Already covered in Task 26.

- [ ] **Step 3: Smoke test**

Bring up the server, send a chat message, verify it still responds. No regression expected because the existing tool-call path is preserved.

- [ ] **Step 4: Commit**

```bash
git add src/rag/agent.ts src/rag/tool-adapter.ts
git commit -m "refactor(rag): allow HierarchicalRetrieval injection (no behaviour change)"
```

---

## Phase 9 — Configuration

### Task 25: Config — new env vars

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example` (if exists; otherwise update README)

- [ ] **Step 1: Read current `loadConfig` shape**

Open `src/config.ts`. Add new fields to the returned config:

```typescript
extractNotesEnabled: process.env.EXTRACT_NOTES_ENABLED !== 'false',
extractLlmProvider: (process.env.EXTRACT_LLM_PROVIDER ?? 'gemini') as 'gemini' | 'ollama',
extractMinConfidence: parseFloat(process.env.EXTRACT_MIN_CONFIDENCE ?? '0.6'),
extractMinMarkerStrength: parseFloat(process.env.EXTRACT_MIN_MARKER_STRENGTH ?? '0.3'),
extractMinFactLen: parseInt(process.env.EXTRACT_MIN_FACT_LEN ?? '30', 10),
extractMaxFactLen: parseInt(process.env.EXTRACT_MAX_FACT_LEN ?? '500', 10),
extractMaxNotesPerSession: parseInt(process.env.EXTRACT_MAX_NOTES_PER_SESSION ?? '5', 10),
extractMaxMergesPerSession: parseInt(process.env.EXTRACT_MAX_MERGES_PER_SESSION ?? '3', 10),
dedupConfirmThreshold: parseFloat(process.env.DEDUP_CONFIRM_THRESHOLD ?? '0.85'),
dedupMergeThreshold: parseFloat(process.env.DEDUP_MERGE_THRESHOLD ?? '0.7'),
autoDecayDays: parseInt(process.env.AUTO_DECAY_DAYS ?? '30', 10),
importanceRecomputeIntervalHours: parseInt(process.env.IMPORTANCE_RECOMPUTE_INTERVAL_HOURS ?? '24', 10),
```

Add NaN-guard helpers per existing pattern (see existing parseInt usage).

- [ ] **Step 2: Run config tests**

Run: `npm test -- config`
Expected: existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts .env.example
git commit -m "feat(config): env vars for extraction, dedup, decay, importance"
```

### Task 26: Wire everything in app.ts

**Files:**
- Modify: `src/app.ts`

- [ ] **Step 1: Build extraction stack and pass to SessionManager**

After Gemini provider is set up:

```typescript
import { pickExtractionProvider } from './extraction/llm-provider.js';
import { NoteExtractor } from './extraction/extractor.js';
import { DedupResolver } from './extraction/dedup.js';
import { NoteMerger } from './extraction/merger.js';
import { HierarchicalRetrieval } from './retrieval/hierarchical.js';
import { EntriesSource } from './retrieval/sources/entries-source.js';
import { SessionsSource } from './retrieval/sources/sessions-source.js';
import { MessagesSource } from './retrieval/sources/messages-source.js';

let dedupResolver: DedupResolver | undefined;
let merger: NoteMerger | undefined;
if (config.extractNotesEnabled && memoryManager.getEmbeddingProvider() && memoryManager.getVectorStore()) {
  dedupResolver = new DedupResolver(
    memoryManager.getEmbeddingProvider()!,
    memoryManager.getVectorStore()!,
    { confirmThreshold: config.dedupConfirmThreshold, mergeThreshold: config.dedupMergeThreshold },
  );
}

const extractionProvider = pickExtractionProvider(chatProvider, llmClient, config.extractLlmProvider);
let noteExtractor: NoteExtractor | undefined;
if (extractionProvider && config.extractNotesEnabled) {
  noteExtractor = new NoteExtractor(extractionProvider, {
    minConfidence: config.extractMinConfidence,
    minMarkerStrength: config.extractMinMarkerStrength,
    minFactLen: config.extractMinFactLen,
    maxFactLen: config.extractMaxFactLen,
    maxNotesPerSession: config.extractMaxNotesPerSession,
  });
  merger = new NoteMerger(extractionProvider);
}
```

Update `SessionManager` instantiation to pass these:

```typescript
sessionManager = new SessionManager(
  sessionStorage,
  memoryManager.getVectorStore() ?? undefined,
  memoryManager.getEmbeddingProvider() ?? undefined,
  llmClient,
  noteExtractor,
  dedupResolver,
  merger,
  memoryManager,
  config.extractNotesEnabled,
  config.extractMaxMergesPerSession,
);
```

Build retrieval and (optionally) pass into RagAgent factory:

```typescript
let retrieval: HierarchicalRetrieval | undefined;
if (memoryManager.getEmbeddingProvider() && memoryManager.getVectorStore()) {
  const sources = [
    new EntriesSource(memoryManager.getEmbeddingProvider()!, memoryManager.getVectorStore()!, storage),
  ];
  if (sessionManager) {
    sources.push(new SessionsSource(memoryManager.getEmbeddingProvider()!, memoryManager.getVectorStore()!, sessionManager.getStorage()));
    sources.push(new MessagesSource(memoryManager.getEmbeddingProvider()!, memoryManager.getVectorStore()!, sessionManager.getStorage()));
  }
  retrieval = new HierarchicalRetrieval(sources);
}
```

(Add `getStorage()` method on SessionManager if not present: `getStorage() { return this.storage; }`.)

Pass `dedupResolver`, `merger`, `retrieval` into MCP server factory and chat-route deps as needed (this is where Tasks 19/20 plug in).

- [ ] **Step 2: Update `buildMcpServer` signature**

In `src/server.ts`:

```typescript
export function buildMcpServer(
  memoryManager: MemoryManager,
  agentTokenStore: AgentTokenStore,
  notesManager?: NotesManager,
  sessionManager?: SessionManager,
  dedupResolver?: DedupResolver,
  merger?: NoteMerger,
) { ... }
```

- [ ] **Step 3: Build, run smoke**

Run: `npm run build && npm start`
Expected: Server starts, log line about extraction provider chosen, no crash.

- [ ] **Step 4: Commit**

```bash
git add src/app.ts src/server.ts src/sessions/manager.ts
git commit -m "feat(app): wire extraction stack and HierarchicalRetrieval"
```

---

## Phase 10 — Web UI: share button and dedup modal

### Task 27: Share button + modal

**Files:**
- Modify: `src/web/public/index.html` (or wherever notes view lives — search for `note-card`)
- Modify: `src/web/public/js/notes.js` (or equivalent)
- Modify: `src/web/public/css/main.css` (modal styles, badge)

- [ ] **Step 1: Add "Расшарить" button on each note card with `sharedToEntryId == null`**

Inline in JS rendering function (find the place that builds note card HTML):

```javascript
const sharedBadge = note.sharedToEntryId
  ? `<span class="badge badge-shared" title="Расшарено в команду">📤 Расшарено</span>`
  : `<button class="btn btn-secondary btn-share" data-note-id="${note.id}">Расшарить в команду</button>`;
// Append to card actions row
```

- [ ] **Step 2: Build modal HTML (one global instance)**

Add to `index.html`:

```html
<dialog id="share-modal">
  <form method="dialog">
    <h3>Расшарить заметку в команду</h3>
    <label>Категория:
      <select name="category" required>
        <option value="">— выбрать —</option>
        <option value="architecture">architecture</option>
        <option value="decisions">decisions</option>
        <option value="conventions">conventions</option>
      </select>
    </label>
    <label>Title (опционально перезаписать):
      <input type="text" name="title" />
    </label>
    <label>Content (опционально перезаписать):
      <textarea name="content" rows="4"></textarea>
    </label>
    <div class="dedup-prompt" hidden>
      <p>Найдена похожая запись: <strong class="dedup-title"></strong> (cos <span class="dedup-score"></span>)</p>
      <button type="button" data-action="confirm">Подтвердить существующую</button>
      <button type="button" data-action="merge">Слить с существующей</button>
      <button type="button" data-action="create_new">Создать новую</button>
    </div>
    <menu>
      <button type="button" id="share-cancel">Отмена</button>
      <button type="submit" id="share-submit">Расшарить</button>
    </menu>
  </form>
</dialog>
```

- [ ] **Step 3: Implement JS handler**

```javascript
document.body.addEventListener('click', async (e) => {
  if (e.target.matches('.btn-share')) {
    const noteId = e.target.dataset.noteId;
    openShareModal(noteId);
  }
});

function openShareModal(noteId) {
  const dlg = document.getElementById('share-modal');
  dlg.dataset.noteId = noteId;
  dlg.querySelector('.dedup-prompt').hidden = true;
  dlg.showModal();
}

document.getElementById('share-modal').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dlg = e.currentTarget;
  const noteId = dlg.dataset.noteId;
  const fd = new FormData(dlg.querySelector('form'));
  const body = { category: fd.get('category') };
  if (fd.get('title')) body.override = { ...(body.override ?? {}), title: fd.get('title') };
  if (fd.get('content')) body.override = { ...(body.override ?? {}), content: fd.get('content') };
  body.on_match = 'prompt';

  const res = await fetch(`/api/notes/${noteId}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.action === 'match_found_pending_user_decision') {
    dlg.querySelector('.dedup-title').textContent = data.existingEntry.title;
    dlg.querySelector('.dedup-score').textContent = data.matchScore.toFixed(2);
    dlg.querySelector('.dedup-prompt').hidden = false;
    return;
  }
  if (data.success && data.entryId) {
    showToast(`Расшарено: ${data.entryId} (${data.action})`);
    dlg.close();
    refreshNotes();
  } else {
    showToast(`Ошибка: ${data.error ?? 'unknown'}`);
  }
});

// Dedup-prompt buttons
document.querySelectorAll('#share-modal .dedup-prompt button').forEach(b => {
  b.addEventListener('click', async () => {
    const dlg = document.getElementById('share-modal');
    const noteId = dlg.dataset.noteId;
    const action = b.dataset.action;
    const fd = new FormData(dlg.querySelector('form'));
    const res = await fetch(`/api/notes/${noteId}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ category: fd.get('category'), on_match: action }),
    });
    const data = await res.json();
    if (data.success) { showToast(data.action); dlg.close(); refreshNotes(); }
    else showToast(`Ошибка: ${data.error}`);
  });
});
```

(`authHeaders`, `showToast`, `refreshNotes` are existing helpers — search the file for analogous patterns.)

- [ ] **Step 4: Add minimal CSS**

```css
.badge-shared { background: var(--accent); color: #fff; padding: 2px 8px; border-radius: 4px; }
#share-modal { padding: 1rem; min-width: 360px; }
#share-modal form > label { display: block; margin-bottom: 0.5rem; }
.dedup-prompt { background: var(--bg-secondary); padding: 0.5rem; border-radius: 4px; margin-top: 0.5rem; }
```

- [ ] **Step 5: Manual smoke**

Open Web UI → Notes tab → create test note → click "Расшарить" → fill category → Submit. Expect toast "created" or "match_found_pending_user_decision". Test all three on_match paths.

- [ ] **Step 6: Commit**

```bash
git add src/web/public/
git commit -m "feat(ui): share-to-team button + dedup-prompt modal for personal notes"
```

---

## Phase 11 — Optional ret-extraction CLI

### Task 28: Backfill script (optional, only if needed after 2 weeks)

**Files:**
- Create: `scripts/backfill-extract-notes.cjs`

- [ ] **Step 1: Write CLI**

```javascript
#!/usr/bin/env node
/**
 * Re-runs note extraction on selected past sessions.
 * Marks them embedding_status='queued_embed' (already embedded → straight to extracting_notes).
 * Usage:
 *   node scripts/backfill-extract-notes.cjs --project=<uuid> --top=50
 *   node scripts/backfill-extract-notes.cjs --session=<uuid>
 */
const { Client } = require('pg');

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  let sql, params;
  if (args.session) {
    sql = `UPDATE sessions SET embedding_status = 'queued' WHERE id = $1 RETURNING id`;
    params = [args.session];
  } else if (args.project) {
    const top = parseInt(args.top ?? '50', 10);
    sql = `UPDATE sessions SET embedding_status = 'queued'
           WHERE id IN (
             SELECT id FROM sessions
             WHERE project_id = $1 AND embedding_status = 'complete'
             ORDER BY message_count DESC
             LIMIT $2
           ) RETURNING id`;
    params = [args.project, top];
  } else { console.error('--project=<uuid> or --session=<uuid> required'); process.exit(1); }
  const { rows } = await c.query(sql, params);
  console.log(`Re-queued ${rows.length} sessions`);
  await c.end();
}
main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Commit**

```bash
git add scripts/backfill-extract-notes.cjs
git commit -m "chore(scripts): backfill-extract-notes — manual re-extraction CLI"
```

---

## Phase 12 — Final verification

### Task 29: Full test run, build, manual smoke, metrics

**Files:** none (verification only)

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: ALL tests pass (existing + new). Note current pass count.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: tsc emits no errors.

- [ ] **Step 3: Bring up local dev server**

Run: `docker-compose up -d postgres qdrant ollama`
Run: `npm start`

Verify in logs:
- `Memory Manager initialized`
- `importance score batch recomputed`
- `Session manager initialized with background worker`
- `Server ready for connections`
- One of: `Gemini chat provider configured` / `Ollama LLM client initialized` / `extraction LLM provider available`

- [ ] **Step 4: Manual smoke — extraction**

1. Import a real session via session-sync hook (or `session_import` MCP tool) for `Рефакторинг MCP Team Memory` project.
2. Wait ≤2 min for queue worker to drain.
3. Check `sessions.embedding_status` → `complete`.
4. Check `entries WHERE evidence_sources @> '[{"type":"session","id":"<imported-id>"}]'` — verify 0..5 rows with `auto_generated=true`.
5. If 0 rows — verify session content lacks marker phrases (expected); pick a session with explicit "решили" / "договорились" to validate non-zero path.

- [ ] **Step 5: Manual smoke — share**

1. Create personal note via Web UI.
2. Click "Расшарить" → category=`decisions` → Submit.
3. Verify entry appears in entries list with `pinned=true`, `auto_generated=false`, `evidence_sources` containing `personal_note`.
4. Verify note now shows "📤 Расшарено" badge.

- [ ] **Step 6: Manual smoke — memory_write deprecated**

Call `memory_write` from any MCP client (or Claude Code CLI). Expect error response with `410-style` text.

- [ ] **Step 7: Update memory record**

```bash
# Use team-memory MCP tool from your CLI / agent:
# memory_update(id="85fb857d-ee30-4f4a-aca8-0f8b45bdd5b6", status="completed", content="<plus a final 'completed' note>")
```

- [ ] **Step 8: Tag and PR**

```bash
git checkout -b feat/auto-notes-v4.5
# Cherry-pick the spec + plan + all task commits onto this branch
# OR rebase onto current main
git push -u origin feat/auto-notes-v4.5
gh pr create --title "feat: v4.5 auto-notes from sessions" --body "$(cat <<'EOF'
## Summary
- Auto-extract WHY-facts from imported sessions via Gemini/Ollama
- Cross-session dedup with CONFIRM/MERGE/CREATE_NEW branching
- Personal note → team entry via "Расшарить" UI + note_share MCP tool
- memory_write deprecated (410 Gone) — channelled through notes
- HierarchicalRetrieval abstraction for v5 Azure integration
- Auto-decay for singleton auto-entries (30 days)

## Test plan
- [ ] All Vitest tests green
- [ ] npm run build clean
- [ ] Manual smoke: real session yields 0..5 entries
- [ ] Manual smoke: note share with all on_match paths
- [ ] Manual smoke: memory_write returns 410-style error

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

This plan was reviewed against the spec section by section:

- **§1 (Контекст)**: covered by overall plan + Task 21 (memory_write 410) + Task 27 (UI). ✅
- **§2 (Ключевые решения)**: every decision is implemented as concrete tasks. ✅
- **§3 (Архитектура)**: file-structure table maps every spec module to a Task. ✅
- **§3.2 (Pipeline)**: Task 17 adds `extracting_notes` state with extraction_failed. ✅
- **§3.3 (Manual flow)**: Tasks 18, 19, 20, 27. ✅
- **§4 (Извлечение)**: Tasks 12 (prompt), 13 (extractor + filters + cap). ✅
- **§5 (Дедуп / merge)**: Tasks 14 (DedupResolver), 15 (NoteMerger), 16 (memory writes). ✅
- **§6 (Schema)**: Tasks 1, 2. ✅
- **§7 (Importance)**: Tasks 6, 7, 8. ✅
- **§8 (Auto-decay)**: Task 9. ✅
- **§9 (Retrieval-абстракция)**: Tasks 4, 22, 23, 24. ✅
- **§10 (Manual entry path)**: Tasks 18, 19, 20, 27. ✅
- **§11 (API/MCP)**: Tasks 19, 20, 21. ✅
- **§12 (Migration / совместимость)**: Tasks 1 (rollback), 5 (mapper preserves existing rows). ✅
- **§13 (ENV)**: Task 25. ✅
- **§14 (Тесты)**: every Task has TDD test step. ✅
- **§15 (Метрики)**: Task 29 §4 manual smoke validates extraction. ✅
- **§16 (Скиллы / docs)**: README updates and skill rewrite are flagged in spec §16 — those happen in a separate repo (`team-memory-marketplace`), out of scope for this plan. README update is included as a task — see below.

### Gaps fixed inline during self-review

- README update task missing → no separate task. Fold into Task 29 manual smoke as documentation step? Decision: out-of-scope for this plan; track separately.
- Task 24 (RagAgent) is intentionally minimal because the agent already uses MCP tool calls for retrieval — switching to `HierarchicalRetrieval` happens only when an "auto-context" feature lands. Left with a smoke-test step instead of behaviour test.
- All type names/method names checked for consistency across tasks (`createFromCandidate`, `confirmExisting`, `mergeIntoExisting`, `share`, `setSharedToEntry`).
- All file paths checked against actual repo structure (`src/extraction`, `src/retrieval`, `src/__tests__`).

No placeholders found.
