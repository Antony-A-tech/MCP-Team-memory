// src/__tests__/decay-singleton.test.ts
//
// Integration test for archiveSingletonAutoEntries.
// Requires a real PostgreSQL instance.
// Set TEST_DATABASE_URL to override the default connection string.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgStorage } from '../storage/pg-storage.js';
import { archiveSingletonAutoEntries } from '../memory/decay.js';
import { DEFAULT_PROJECT_ID } from '../memory/types.js';

const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  'postgres://memory:memory@localhost:5432/team_memory_test';

const TITLE = 'singleton-decay-test';

async function makeEntry(
  pool: Pool,
  p: { auto: boolean; pinned: boolean; conf: number; ageDays: number; lastConfirmed?: Date | null }
): Promise<string> {
  const { rows } = await pool.query(
    `
    INSERT INTO entries (
      project_id, category, title, content, status, pinned,
      auto_generated, confirmation_count, created_at, updated_at, last_confirmed_at
    )
    VALUES (
      $1, 'decisions', $2, 'c', 'active', $3,
      $4, $5,
      NOW() - ($6 || ' days')::interval,
      NOW(),
      $7
    )
    RETURNING id
    `,
    [
      DEFAULT_PROJECT_ID,
      TITLE,
      p.pinned,
      p.auto,
      p.conf,
      p.ageDays,
      p.lastConfirmed ?? null,
    ]
  );
  return rows[0].id as string;
}

describe('archiveSingletonAutoEntries', () => {
  let pool: Pool;
  let storage: PgStorage;

  beforeAll(async () => {
    // Ensure migrations + default project are in place.
    storage = new PgStorage(TEST_DB, 'simple');
    await storage.initialize();
    pool = new Pool({ connectionString: TEST_DB });
  });

  afterAll(async () => {
    await pool.end();
    await storage.close();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM entries WHERE project_id=$1 AND title=$2`, [
      DEFAULT_PROJECT_ID,
      TITLE,
    ]);
  });

  it('archives auto-generated, unpinned, count=1, >30 days, never confirmed', async () => {
    const id = await makeEntry(pool, { auto: true, pinned: false, conf: 1, ageDays: 31 });
    const archived = await archiveSingletonAutoEntries(pool, 30);
    expect(archived).toContain(id);
    const { rows } = await pool.query(`SELECT status FROM entries WHERE id=$1`, [id]);
    expect(rows[0].status).toBe('archived');
  });

  it('keeps pinned even if auto + singleton + old', async () => {
    const id = await makeEntry(pool, { auto: true, pinned: true, conf: 1, ageDays: 60 });
    const archived = await archiveSingletonAutoEntries(pool, 30);
    expect(archived).not.toContain(id);
  });

  it('keeps multi-confirmed entries (count > 1)', async () => {
    const id = await makeEntry(pool, { auto: true, pinned: false, conf: 2, ageDays: 60 });
    const archived = await archiveSingletonAutoEntries(pool, 30);
    expect(archived).not.toContain(id);
  });

  it('keeps recent entries (within decay window)', async () => {
    const id = await makeEntry(pool, { auto: true, pinned: false, conf: 1, ageDays: 10 });
    const archived = await archiveSingletonAutoEntries(pool, 30);
    expect(archived).not.toContain(id);
  });

  it('keeps non-auto manual entries', async () => {
    const id = await makeEntry(pool, { auto: false, pinned: false, conf: 1, ageDays: 60 });
    const archived = await archiveSingletonAutoEntries(pool, 30);
    expect(archived).not.toContain(id);
  });

  it('keeps entries that were re-confirmed at least once (last_confirmed_at IS NOT NULL)', async () => {
    const id = await makeEntry(pool, {
      auto: true,
      pinned: false,
      conf: 1,
      ageDays: 60,
      lastConfirmed: new Date(),
    });
    const archived = await archiveSingletonAutoEntries(pool, 30);
    expect(archived).not.toContain(id);
  });
});
