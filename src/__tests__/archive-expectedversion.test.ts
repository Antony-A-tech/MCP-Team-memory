// src/__tests__/archive-expectedversion.test.ts
//
// Tests for archive()/unarchive() optimistic-lock support — Phase 1.C of
// docs/superpowers/plans/2026-05-15-v5-postwork-audit-fixes.md.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import { VersionManager } from '../storage/versioning.js';

const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  'postgres://memory:memory@localhost:5432/team_memory_test';

const PID = '00000000-0000-0000-0000-000000028001';

describe('archive() — expectedVersion conflict handling', () => {
  let pool: Pool;
  let storage: PgStorage;
  let manager: MemoryManager;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB });
    storage = new PgStorage(TEST_DB, 'simple');
    const versionManager = new VersionManager(pool);
    manager = new MemoryManager(storage, undefined, versionManager);
    await manager.initialize();
    await pool.query(
      `INSERT INTO projects (id, name) VALUES ($1, 'archive-ev-test')
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

  it('archives entry when expectedVersion matches current (no prior versions → 0)', async () => {
    const created = await manager.write({
      projectId: PID,
      category: 'knowledge',
      title: 'Archive test',
      content: 'c',
      author: 'tester',
    });
    // Fresh entry has no entry_versions row → MAX(version) = 0 fallback
    const result = await storage.archive(created.id, 0);
    expect(result && 'conflict' in result).toBeFalsy();
    if (result && !('conflict' in result)) {
      expect(result.status).toBe('archived');
    }
  });

  it('returns ConflictError when expectedVersion is stale', async () => {
    const created = await manager.write({
      projectId: PID,
      category: 'knowledge',
      title: 'Archive race',
      content: 'c',
      author: 'tester',
    });
    // Bump the version via an update — simulates concurrent writer
    const updated = await manager.update({ id: created.id, content: 'c2', expected_version: 0 });
    expect(updated && !('conflict' in updated)).toBe(true);

    // Stale caller tries to archive at version 0; should conflict
    const result = await storage.archive(created.id, 0);
    expect(result).toBeDefined();
    expect(result && 'conflict' in result).toBe(true);
  });

  it('archive without expectedVersion succeeds regardless of version (last-write-wins)', async () => {
    const created = await manager.write({
      projectId: PID,
      category: 'knowledge',
      title: 'No-version archive',
      content: 'c',
      author: 'tester',
    });
    await manager.update({ id: created.id, content: 'updated', expected_version: 0 });

    const result = await storage.archive(created.id);
    expect(result && !('conflict' in result)).toBe(true);
  });

  it('MemoryManager.delete propagates ConflictError when expectedVersion stale', async () => {
    const created = await manager.write({
      projectId: PID,
      category: 'knowledge',
      title: 'Manager-level conflict',
      content: 'c',
      author: 'tester',
    });
    await manager.update({ id: created.id, content: 'c2', expected_version: 0 });

    const result = await manager.delete({ id: created.id, archive: true, expectedVersion: 0 });
    expect(typeof result).toBe('object');
    if (typeof result === 'object') {
      expect('conflict' in result).toBe(true);
    }
  });

  it('MemoryManager.delete without expectedVersion still returns boolean', async () => {
    const created = await manager.write({
      projectId: PID,
      category: 'knowledge',
      title: 'Manager-level no-version',
      content: 'c',
      author: 'tester',
    });
    const result = await manager.delete({ id: created.id, archive: true });
    expect(result).toBe(true);
  });
});
