// src/__tests__/sessions-extraction-integration.test.ts
//
// End-to-end test of the v4.5 sessions → embedding → extracting_notes →
// complete pipeline. Embedding provider, vector store, and the extraction
// LLM are mocked so we can exercise the full state machine without a live
// cluster, but PostgreSQL is real (TEST_DATABASE_URL).
//
// Covers two scenarios:
//   1. extractionEnabled=true → entry is created with the session's id in
//      its evidence_sources, session lands in `complete`.
//   2. extractionEnabled=false → no entry is created, session still lands
//      in `complete`.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import { SessionStorage } from '../sessions/storage.js';
import { SessionManager } from '../sessions/manager.js';
import { NoteExtractor } from '../extraction/extractor.js';
import { DedupResolver } from '../extraction/dedup.js';
import { DEFAULT_PROJECT_ID } from '../memory/types.js';

const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  'postgres://memory:memory@localhost:5432/team_memory_test';

const AGENT = '00000000-0000-0000-0000-000000000bb1';

function mockEmbed() {
  return {
    isReady: () => true,
    dimensions: 768,
    embed: vi.fn(async () => Array(768).fill(0)),
    embedBatch: vi.fn(async () => []),
    close: vi.fn(),
  };
}

function mockVectorStore() {
  return {
    // No matches in dedup → all candidates routed to CREATE_NEW.
    search: vi.fn(async () => []),
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

function fakeExtractionLlm(response: string) {
  return {
    name: 'fake-extractor',
    isReady: () => true,
    generate: vi.fn(async () => response),
  };
}

const goodLlmResponse = JSON.stringify({
  architecture: [],
  decisions: [
    {
      title: 'Use JWT with 7d refresh',
      fact:
        'Auth uses JWT plus 7-day refresh tokens because cookie session storage was rejected for cross-domain reasons.',
      why: 'Refresh allows revocation and short access tokens.',
      tags: ['auth', 'jwt'],
      confidence: 0.9,
      explicit_marker_strength: 0.8,
    },
  ],
  conventions: [],
});

describe('sessions → extraction integration', () => {
  let pool: Pool;
  let storage: PgStorage;
  let memory: MemoryManager;
  let sessionStorage: SessionStorage;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB });
    storage = new PgStorage(TEST_DB, 'simple');
    memory = new MemoryManager(storage);
    await memory.initialize();
    await pool.query(
      `INSERT INTO agent_tokens (id, token, agent_name, is_active)
       VALUES ($1, $2, 'extraction-int-agent', true)
       ON CONFLICT (id) DO NOTHING`,
      [AGENT, `extr-int-${Date.now()}`],
    );
    sessionStorage = new SessionStorage(pool);
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM entries WHERE project_id=$1 AND author='auto-extractor'`,
      [DEFAULT_PROJECT_ID],
    );
    await pool.query(`DELETE FROM session_messages WHERE session_id IN (SELECT id FROM sessions WHERE agent_token_id = $1)`, [AGENT]);
    await pool.query(`DELETE FROM sessions WHERE agent_token_id = $1`, [AGENT]);
    await pool.query(`DELETE FROM agent_tokens WHERE id = $1`, [AGENT]);
    await memory.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      `DELETE FROM entries WHERE project_id=$1 AND author='auto-extractor'`,
      [DEFAULT_PROJECT_ID],
    );
    await pool.query(`DELETE FROM session_messages WHERE session_id IN (SELECT id FROM sessions WHERE agent_token_id = $1)`, [AGENT]);
    await pool.query(`DELETE FROM sessions WHERE agent_token_id = $1`, [AGENT]);
  });

  it('extractionEnabled=true → entry created, session lands in complete', async () => {
    const embed = mockEmbed();
    const vec = mockVectorStore();
    const extractor = new NoteExtractor(fakeExtractionLlm(goodLlmResponse) as never);
    const dedup = new DedupResolver(embed as never, vec as never);
    const sm = new SessionManager(
      sessionStorage,
      vec as never,
      embed as never,
      undefined, // llmClient — summary already provided
      extractor,
      dedup,
      undefined, // merger — not exercised in CREATE_NEW path
      memory,
      true, // extractionEnabled
      3,
    );

    const session = await sm.importSession(AGENT, {
      externalId: `int-${Date.now()}-on`,
      summary: 'Worked on auth refactor; decided JWT 7d refresh',
      projectId: DEFAULT_PROJECT_ID,
      messages: [
        { role: 'user', content: 'Решили использовать JWT', toolNames: [] },
      ],
    });

    // Drain the queue until the session reaches a terminal state.
    for (let i = 0; i < 10; i++) {
      const current = await sessionStorage.getSession(session.id);
      if (current?.embeddingStatus === 'complete' || current?.embeddingStatus === 'failed') {
        break;
      }
      await sm.processQueue();
    }

    const final = await sessionStorage.getSession(session.id);
    expect(final?.embeddingStatus).toBe('complete');

    // The extractor's only candidate landed as a new entry whose evidence
    // points back at our session.
    const { rows } = await pool.query(
      `SELECT id, title, auto_generated, evidence_sources
       FROM entries
       WHERE project_id=$1
         AND evidence_sources @> $2::jsonb`,
      [
        DEFAULT_PROJECT_ID,
        JSON.stringify([{ type: 'session', id: session.id }]),
      ],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].auto_generated).toBe(true);
    expect(rows[0].title).toBe('Use JWT with 7d refresh');
  });

  it('extractionEnabled=false → no entries, session still lands in complete', async () => {
    const embed = mockEmbed();
    const vec = mockVectorStore();
    const extractor = new NoteExtractor(fakeExtractionLlm(goodLlmResponse) as never);
    const dedup = new DedupResolver(embed as never, vec as never);
    const sm = new SessionManager(
      sessionStorage,
      vec as never,
      embed as never,
      undefined,
      extractor,
      dedup,
      undefined,
      memory,
      false, // extractionEnabled = OFF
      3,
    );

    const session = await sm.importSession(AGENT, {
      externalId: `int-${Date.now()}-off`,
      summary: 'Same summary, extraction disabled',
      projectId: DEFAULT_PROJECT_ID,
      messages: [
        { role: 'user', content: 'noop', toolNames: [] },
      ],
    });

    for (let i = 0; i < 10; i++) {
      const current = await sessionStorage.getSession(session.id);
      if (current?.embeddingStatus === 'complete' || current?.embeddingStatus === 'failed') {
        break;
      }
      await sm.processQueue();
    }

    const final = await sessionStorage.getSession(session.id);
    expect(final?.embeddingStatus).toBe('complete');

    const { rows } = await pool.query(
      `SELECT id FROM entries
       WHERE project_id=$1
         AND evidence_sources @> $2::jsonb`,
      [
        DEFAULT_PROJECT_ID,
        JSON.stringify([{ type: 'session', id: session.id }]),
      ],
    );
    expect(rows.length).toBe(0);
  });

  it('retry idempotency: a second pass over the same session creates no duplicates', async () => {
    const embed = mockEmbed();
    const vec = mockVectorStore();
    const extractor = new NoteExtractor(fakeExtractionLlm(goodLlmResponse) as never);
    const dedup = new DedupResolver(embed as never, vec as never);
    const sm = new SessionManager(
      sessionStorage,
      vec as never,
      embed as never,
      undefined,
      extractor,
      dedup,
      undefined,
      memory,
      true,
      3,
    );

    const session = await sm.importSession(AGENT, {
      externalId: `int-${Date.now()}-idem`,
      summary: 'Idempotency test',
      projectId: DEFAULT_PROJECT_ID,
      messages: [{ role: 'user', content: 'x', toolNames: [] }],
    });

    for (let i = 0; i < 10; i++) {
      const current = await sessionStorage.getSession(session.id);
      if (current?.embeddingStatus === 'complete') break;
      await sm.processQueue();
    }

    // Force-run extraction again. The hasExtractionEvidence guard should
    // skip everything; no duplicate entries should appear.
    await pool.query(
      `UPDATE sessions SET embedding_status='extracting_notes', updated_at=NOW() - INTERVAL '15 minutes' WHERE id=$1`,
      [session.id],
    );
    for (let i = 0; i < 5; i++) {
      const current = await sessionStorage.getSession(session.id);
      if (current?.embeddingStatus === 'complete') break;
      await sm.processQueue();
    }

    const { rows } = await pool.query(
      `SELECT COUNT(*) AS n FROM entries
       WHERE project_id=$1
         AND evidence_sources @> $2::jsonb`,
      [
        DEFAULT_PROJECT_ID,
        JSON.stringify([{ type: 'session', id: session.id }]),
      ],
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});
