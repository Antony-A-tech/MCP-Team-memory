// src/__tests__/notes-share.test.ts
//
// Integration tests for NotesManager.share — the manual path that
// publishes a personal note as a team-memory entry, applying optional
// dedup and pinning the resulting entry.
//
// Requires a real PostgreSQL instance.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import { PersonalNotesStorage } from '../notes/storage.js';
import { NotesManager } from '../notes/manager.js';
import { DedupResolver } from '../extraction/dedup.js';
import { DEFAULT_PROJECT_ID } from '../memory/types.js';

const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  'postgres://memory:memory@localhost:5432/team_memory_test';

const AGENT = '00000000-0000-0000-0000-0000000000aa';
const TITLE_PREFIX = 'share-test';

function mockEmbed() {
  return {
    isReady: () => true,
    dimensions: 768,
    embed: vi.fn(async () => Array(768).fill(0)),
    embedBatch: vi.fn(async () => []),
    close: vi.fn(),
  };
}

function mockVectorStore(score: number) {
  return {
    search: vi.fn(async () =>
      score >= 0
        ? [{ id: 'EXISTING-ID-PLACEHOLDER', score, payload: {} as Record<string, unknown> }]
        : [],
    ),
    upsert: vi.fn(),
    upsertBatch: vi.fn(),
    delete: vi.fn(),
    deleteByFilter: vi.fn(),
    setPayload: vi.fn(),
    ensureCollection: vi.fn(),
    createPayloadIndex: vi.fn(),
    getPointCount: vi.fn(),
    collectionExists: vi.fn(),
    close: vi.fn(),
  };
}

describe('NotesManager.share', () => {
  let pool: Pool;
  let storage: PgStorage;
  let manager: MemoryManager;
  let notesStorage: PersonalNotesStorage;
  let notesManager: NotesManager;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB });
    storage = new PgStorage(TEST_DB, 'simple');
    manager = new MemoryManager(storage);
    await manager.initialize();
    await pool.query(
      `INSERT INTO agent_tokens (id, token, agent_name, is_active)
       VALUES ($1, $2, 'share-test-agent', true)
       ON CONFLICT (id) DO NOTHING`,
      [AGENT, `share-test-token-${Date.now()}`],
    );
    notesStorage = new PersonalNotesStorage(pool);
    notesManager = new NotesManager(notesStorage);
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM personal_notes WHERE agent_token_id = $1`,
      [AGENT],
    );
    await pool.query(
      `DELETE FROM entries WHERE project_id=$1 AND title LIKE $2`,
      [DEFAULT_PROJECT_ID, TITLE_PREFIX + '%'],
    );
    await manager.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      `DELETE FROM personal_notes WHERE agent_token_id = $1`,
      [AGENT],
    );
    await pool.query(
      `DELETE FROM entries WHERE project_id=$1 AND title LIKE $2`,
      [DEFAULT_PROJECT_ID, TITLE_PREFIX + '%'],
    );
  });

  it('share without dedup → creates pinned entry, sets shared_to_entry_id', async () => {
    const note = await notesManager.write(AGENT, {
      title: `${TITLE_PREFIX}-1`,
      content: 'Use JWT 7d refresh because cookies were rejected cross-domain.',
      tags: ['auth'],
      priority: 'medium',
      projectId: DEFAULT_PROJECT_ID,
      sessionId: null,
    });

    const result = await notesManager.share({
      noteId: note.id,
      agentTokenId: AGENT,
      category: 'decisions',
      memoryManager: manager,
    });

    expect(result.action).toBe('created');
    expect(result.entryId).toBeTypeOf('string');

    const fresh = await notesManager.getById(note.id, AGENT);
    expect(fresh!.sharedToEntryId).toBe(result.entryId);

    const { rows } = await pool.query(
      `SELECT pinned, auto_generated, evidence_sources, author FROM entries WHERE id=$1`,
      [result.entryId],
    );
    expect(rows[0].pinned).toBe(true);
    expect(rows[0].auto_generated).toBe(true);
    expect(rows[0].author).toBe('auto-extractor');
    expect(rows[0].evidence_sources).toHaveLength(1);
    expect(rows[0].evidence_sources[0].type).toBe('personal_note');
  });

  it('share with high-cosine dedup + onMatch=prompt returns existing entry without writing', async () => {
    // Seed an existing entry the dedup mock will "find".
    const existing = await manager.write({
      projectId: DEFAULT_PROJECT_ID,
      category: 'decisions',
      title: `${TITLE_PREFIX}-existing`,
      content: 'Existing fact about JWT',
      tags: ['auth'],
    });

    const note = await notesManager.write(AGENT, {
      title: `${TITLE_PREFIX}-prompt`,
      content: 'Same JWT decision',
      tags: ['auth'],
      priority: 'medium',
      projectId: DEFAULT_PROJECT_ID,
      sessionId: null,
    });

    const vec = mockVectorStore(0.92);
    // Mock returns a fixed ID; rewrite it to point at the seeded entry.
    vec.search = vi.fn(async () => [
      { id: existing.id, score: 0.92, payload: {} },
    ]);
    const dedup = new DedupResolver(mockEmbed() as never, vec as never);

    const result = await notesManager.share({
      noteId: note.id,
      agentTokenId: AGENT,
      category: 'decisions',
      memoryManager: manager,
      dedupResolver: dedup,
      onMatch: 'prompt',
    });

    expect(result.action).toBe('match_found_pending_user_decision');
    expect(result.entryId).toBeNull();
    expect(result.existingEntry?.id).toBe(existing.id);
    expect(result.matchScore).toBeCloseTo(0.92);

    // Note must not be marked as shared yet — user hasn't decided.
    const fresh = await notesManager.getById(note.id, AGENT);
    expect(fresh!.sharedToEntryId).toBeNull();
  });

  it('share with onMatch=confirm_existing increments count and links note', async () => {
    const existing = await manager.write({
      projectId: DEFAULT_PROJECT_ID,
      category: 'decisions',
      title: `${TITLE_PREFIX}-confirm`,
      content: 'Existing JWT fact',
      tags: ['auth'],
    });

    const note = await notesManager.write(AGENT, {
      title: `${TITLE_PREFIX}-cnote`,
      content: 'Same JWT decision again',
      tags: ['auth'],
      priority: 'medium',
      projectId: DEFAULT_PROJECT_ID,
      sessionId: null,
    });

    const vec = mockVectorStore(0.9);
    vec.search = vi.fn(async () => [
      { id: existing.id, score: 0.9, payload: {} },
    ]);
    const dedup = new DedupResolver(mockEmbed() as never, vec as never);

    const result = await notesManager.share({
      noteId: note.id,
      agentTokenId: AGENT,
      category: 'decisions',
      memoryManager: manager,
      dedupResolver: dedup,
      onMatch: 'confirm_existing',
    });

    expect(result.action).toBe('confirmed_existing');
    expect(result.entryId).toBe(existing.id);

    const fresh = await notesManager.getById(note.id, AGENT);
    expect(fresh!.sharedToEntryId).toBe(existing.id);

    const { rows } = await pool.query(
      `SELECT confirmation_count FROM entries WHERE id=$1`,
      [existing.id],
    );
    expect(rows[0].confirmation_count).toBe(2);
  });

  it('share rejects notes that don\'t belong to the agent', async () => {
    const note = await notesManager.write(AGENT, {
      title: `${TITLE_PREFIX}-other`,
      content: 'Some content',
      tags: [],
      priority: 'medium',
      projectId: DEFAULT_PROJECT_ID,
      sessionId: null,
    });

    await expect(
      notesManager.share({
        noteId: note.id,
        agentTokenId: '00000000-0000-0000-0000-0000000000bb',
        category: 'decisions',
        memoryManager: manager,
      }),
    ).rejects.toThrow(/not found or not yours/);
  });
});
