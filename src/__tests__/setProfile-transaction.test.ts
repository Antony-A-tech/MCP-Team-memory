// src/__tests__/setProfile-transaction.test.ts
//
// Regression test: setProfile must be atomic — concurrent callers must NOT
// trip the partial UNIQUE idx_entries_one_active_profile (raising 23505).
//
// Phase 1.B of docs/superpowers/plans/2026-05-15-v5-postwork-audit-fixes.md.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';

const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  'postgres://memory:memory@localhost:5432/team_memory_test';

const PID = '00000000-0000-0000-0000-000000027001';

describe('setProfile — atomic archive-then-write', () => {
  let pool: Pool;
  let storage: PgStorage;
  let manager: MemoryManager;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB });
    storage = new PgStorage(TEST_DB, 'simple');
    manager = new MemoryManager(storage);
    await manager.initialize();
    await pool.query(
      `INSERT INTO projects (id, name) VALUES ($1, 'setProfile-test')
       ON CONFLICT (id) DO NOTHING`,
      [PID],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await manager.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PID]);
  });

  it('inserts a single active profile on a fresh project', async () => {
    const entry = await manager.setProfile(PID, '# Hello\n\nProfile content.', ['onboard']);
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.category).toBe('profile');
    expect(entry.status).toBe('active');
    expect(entry.pinned).toBe(true);

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int as active FROM entries
       WHERE project_id = $1 AND category = 'profile' AND status = 'active'`,
      [PID],
    );
    expect(rows[0].active).toBe(1);
  });

  it('archives the previous profile and creates a new active one on sequential calls', async () => {
    const first = await manager.setProfile(PID, 'v1');
    const second = await manager.setProfile(PID, 'v2');
    expect(first.id).not.toBe(second.id);

    const { rows } = await pool.query(
      `SELECT id, status, content FROM entries
       WHERE project_id = $1 AND category = 'profile' ORDER BY created_at`,
      [PID],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].status).toBe('archived');
    expect(rows[1].id).toBe(second.id);
    expect(rows[1].status).toBe('active');
    expect(rows[1].content).toBe('v2');
  });

  it('survives 10 concurrent setProfile calls without 23505 leaking to caller', async () => {
    const calls = Array.from({ length: 10 }, (_, i) => manager.setProfile(PID, `concurrent-v${i}`));
    const results = await Promise.allSettled(calls);

    // None of the rejected promises should be the partial-unique violation —
    // that's the bug we're fixing. (Other rejections, e.g. transient DB
    // hiccups, would still need investigation but are not expected here.)
    for (const r of results) {
      if (r.status === 'rejected') {
        const msg = String((r.reason as Error)?.message ?? r.reason);
        expect(msg).not.toMatch(/idx_entries_one_active_profile|23505|duplicate key/i);
      }
    }

    // Most importantly: there must be exactly one active profile at the end.
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int as active FROM entries
       WHERE project_id = $1 AND category = 'profile' AND status = 'active'`,
      [PID],
    );
    expect(rows[0].active).toBe(1);
  });

  it('rejects content exceeding MAX_PROFILE_BYTES and leaves DB untouched', async () => {
    const huge = 'x'.repeat(70_000); // > 64 KB
    await expect(manager.setProfile(PID, huge)).rejects.toThrow(/exceeds/);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int as c FROM entries WHERE project_id = $1 AND category = 'profile'`,
      [PID],
    );
    expect(rows[0].c).toBe(0);
  });
});
