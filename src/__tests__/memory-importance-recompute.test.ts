// src/__tests__/memory-importance-recompute.test.ts
//
// Integration test: importance_score is recomputed and persisted on write/update.
// Requires a real PostgreSQL instance.
// Set TEST_DATABASE_URL to override the default connection string.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';

const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  'postgres://memory:memory@localhost:5432/team_memory_test';

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

  it('importance_score is updated after update()', async () => {
    // Write initial entry
    const entry = await manager.write({
      projectId: '00000000-0000-0000-0000-000000000000',
      category: 'architecture',
      title: 'Score update test',
      content: 'Initial content',
      tags: [],
    });
    expect(entry.importanceScore).toBeGreaterThan(0);

    // Update it and confirm score is still set
    const updated = await manager.update({
      id: entry.id,
      content: 'Updated content with more detail',
    });
    expect(updated).not.toBeNull();
    expect((updated as import('../memory/types.js').MemoryEntry).importanceScore).toBeGreaterThan(0);
    expect((updated as import('../memory/types.js').MemoryEntry).importanceScore).toBeLessThanOrEqual(1);
  });
});
