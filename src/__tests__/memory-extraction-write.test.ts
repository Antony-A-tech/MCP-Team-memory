// src/__tests__/memory-extraction-write.test.ts
//
// Integration tests for MemoryManager auto-extraction write methods:
//   - createFromCandidate
//   - confirmExisting
//   - mergeIntoExisting
//
// Requires a real PostgreSQL instance.
// Set TEST_DATABASE_URL to override the default connection string.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import { DEFAULT_PROJECT_ID } from '../memory/types.js';
import type { CandidateNote, EvidenceSource } from '../extraction/types.js';

const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  'postgres://memory:memory@localhost:5432/team_memory_test';

const TITLE_PREFIX = 'extraction-write-test';

const candidate = (suffix = ''): CandidateNote => ({
  category: 'decisions',
  title: `${TITLE_PREFIX}${suffix}`,
  fact: 'Auth uses JWT plus 7-day refresh tokens because cookie session storage was rejected for cross-domain reasons.',
  why: 'Refresh allows revocation and short access tokens.',
  tags: ['auth', 'jwt'],
  confidence: 0.9,
  explicit_marker_strength: 0.7,
});

const sessionEvidence = (id: string): EvidenceSource => ({
  type: 'session',
  id,
  agent_token_id: '11111111-1111-1111-1111-111111111111',
  confirmed_at: new Date().toISOString(),
});

describe('MemoryManager auto-extraction writes', () => {
  let pool: Pool;
  let storage: PgStorage;
  let manager: MemoryManager;

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

  beforeEach(async () => {
    await pool.query(
      `DELETE FROM entries WHERE project_id=$1 AND title LIKE $2`,
      [DEFAULT_PROJECT_ID, TITLE_PREFIX + '%'],
    );
  });

  it('createFromCandidate inserts with auto_generated=true and evidence_sources', async () => {
    const id = await manager.createFromCandidate(
      DEFAULT_PROJECT_ID,
      candidate('-create'),
      [sessionEvidence('sess-create-1')],
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const { rows } = await pool.query(`SELECT * FROM entries WHERE id=$1`, [id]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.auto_generated).toBe(true);
    expect(row.confirmation_count).toBe(1);
    expect(row.last_confirmed_at).toBeTruthy();
    expect(row.evidence_sources).toHaveLength(1);
    expect(row.evidence_sources[0].id).toBe('sess-create-1');
    expect(row.author).toBe('auto-extractor');
    expect(row.category).toBe('decisions');
    expect(row.tags).toEqual(['auth', 'jwt']);
    expect(row.content).toContain(candidate().fact);
    expect(row.content).toContain('Why:');
    expect(row.importance_score).toBeGreaterThan(0);
  });

  it('confirmExisting increments count and appends evidence', async () => {
    const id = await manager.createFromCandidate(
      DEFAULT_PROJECT_ID,
      candidate('-confirm'),
      [sessionEvidence('sess-A')],
    );
    await manager.confirmExisting(id, sessionEvidence('sess-B'));

    const { rows } = await pool.query(
      `SELECT confirmation_count, evidence_sources FROM entries WHERE id=$1`,
      [id],
    );
    expect(rows[0].confirmation_count).toBe(2);
    expect(rows[0].evidence_sources).toHaveLength(2);
    const ids = rows[0].evidence_sources.map((e: { id: string }) => e.id);
    expect(ids).toContain('sess-A');
    expect(ids).toContain('sess-B');
  });

  it('mergeIntoExisting rewrites title/content/tags and increments count', async () => {
    const id = await manager.createFromCandidate(
      DEFAULT_PROJECT_ID,
      candidate('-merge'),
      [sessionEvidence('sess-orig')],
    );
    await manager.mergeIntoExisting(
      id,
      {
        title: `${TITLE_PREFIX}-merge-rewritten`,
        fact: 'Merged fact text.',
        why: 'Merged rationale.',
        tags: ['auth', 'merged'],
      },
      sessionEvidence('sess-merge'),
    );

    const { rows } = await pool.query(
      `SELECT title, content, tags, confirmation_count, evidence_sources FROM entries WHERE id=$1`,
      [id],
    );
    expect(rows[0].title).toBe(`${TITLE_PREFIX}-merge-rewritten`);
    expect(rows[0].content).toContain('Merged fact text.');
    expect(rows[0].content).toContain('Why: Merged rationale.');
    expect(rows[0].tags).toEqual(['auth', 'merged']);
    expect(rows[0].confirmation_count).toBe(2);
    expect(rows[0].evidence_sources).toHaveLength(2);
  });
});
