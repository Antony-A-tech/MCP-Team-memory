// src/__tests__/pg-storage-stats.test.ts
//
// Integration test for PgStorage.getStats() — Phase 1.F of
// docs/superpowers/plans/2026-05-15-v5-postwork-audit-fixes.md.
//
// Verifies the GROUPING SETS consolidation returns the same shape and values
// as the original 5-query implementation.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PgStorage } from '../storage/pg-storage.js';

const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  'postgres://memory:memory@localhost:5432/team_memory_test';

const PID = '00000000-0000-0000-0000-000000029001';

describe('PgStorage.getStats() — single-query GROUPING SETS', () => {
  let pool: Pool;
  let storage: PgStorage;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB });
    storage = new PgStorage(TEST_DB, 'simple');
    await pool.query(
      `INSERT INTO projects (id, name) VALUES ($1, 'stats-test')
       ON CONFLICT (id) DO NOTHING`,
      [PID],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PID]);
  });

  it('returns zero counts on empty project', async () => {
    const stats = await storage.getStats(PID);
    expect(stats.totalEntries).toBe(0);
    expect(stats.pinnedCount).toBe(0);
    expect(stats.last24h).toBe(0);
    expect(stats.last7d).toBe(0);
    expect(stats.byCategory).toEqual({});
    expect(stats.byDomain).toEqual({});
    expect(stats.byStatus).toEqual({});
    expect(stats.byPriority).toEqual({});
  });

  it('counts correctly across all dimensions on a populated project', async () => {
    // Seed: 3 knowledge (2 backend + 1 frontend), 2 conventions (1 active 1 archived), 1 profile pinned
    const seed = [
      { category: 'knowledge',  domain: 'backend',  status: 'active',   priority: 'high',   pinned: false },
      { category: 'knowledge',  domain: 'backend',  status: 'active',   priority: 'medium', pinned: false },
      { category: 'knowledge',  domain: 'frontend', status: 'active',   priority: 'medium', pinned: false },
      { category: 'conventions',domain: null,       status: 'active',   priority: 'low',    pinned: false },
      { category: 'conventions',domain: null,       status: 'archived', priority: 'low',    pinned: false },
      { category: 'profile',    domain: null,       status: 'active',   priority: 'high',   pinned: true  },
    ];

    for (const e of seed) {
      await pool.query(
        `INSERT INTO entries
           (project_id, category, domain, title, content, author, priority, status, pinned, tags, related_ids)
         VALUES ($1, $2, $3, $4, 'c', 'tester', $5, $6, $7, ARRAY[]::text[], ARRAY[]::uuid[])`,
        [PID, e.category, e.domain, `stats-test-${seed.indexOf(e)}`, e.priority, e.status, e.pinned],
      );
    }

    const stats = await storage.getStats(PID);

    expect(stats.totalEntries).toBe(6);
    expect(stats.pinnedCount).toBe(1);

    expect(stats.byCategory.knowledge).toBe(3);
    expect(stats.byCategory.conventions).toBe(2);
    expect(stats.byCategory.profile).toBe(1);

    expect(stats.byDomain.backend).toBe(2);
    expect(stats.byDomain.frontend).toBe(1);
    expect(stats.byDomain.unset).toBe(3);

    expect(stats.byStatus.active).toBe(5);
    expect(stats.byStatus.archived).toBe(1);

    expect(stats.byPriority.high).toBe(2);
    expect(stats.byPriority.medium).toBe(2);
    expect(stats.byPriority.low).toBe(2);

    // All entries were inserted just now → both windows include them all
    expect(stats.last24h).toBe(6);
    expect(stats.last7d).toBe(6);
  });
});
