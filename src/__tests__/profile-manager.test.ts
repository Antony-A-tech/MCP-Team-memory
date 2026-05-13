import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';
const PROJECT_ID = '00000000-0000-0000-0000-00000000aaaa';

describe('MemoryManager.getProfile/setProfile', () => {
  let pool: pg.Pool;
  let storage: PgStorage;
  let manager: MemoryManager;

  beforeAll(async () => {
    storage = new PgStorage(TEST_DB);
    await storage.initialize();
    manager = new MemoryManager(storage);
    pool = new pg.Pool({ connectionString: TEST_DB });
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PROJECT_ID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PROJECT_ID]);
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'profile-test')`, [PROJECT_ID]);
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PROJECT_ID]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PROJECT_ID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PROJECT_ID]);
    await pool.end();
    await storage.close();
  });

  it('getProfile returns null when no profile exists', async () => {
    const profile = await manager.getProfile(PROJECT_ID);
    expect(profile).toBeNull();
  });

  it('setProfile creates a new entry with category=profile, pinned=true', async () => {
    const entry = await manager.setProfile(PROJECT_ID, '# Mission\nTest project', ['mvp'], 'token-xyz');
    expect(entry.category).toBe('profile');
    expect(entry.pinned).toBe(true);
    expect(entry.status).toBe('active');
    expect(entry.priority).toBe('high');
    expect(entry.tags).toContain('mvp');
    expect(entry.author).toBe('token-xyz');
  });

  it('getProfile returns the active profile entry', async () => {
    await manager.setProfile(PROJECT_ID, '# First', []);
    const profile = await manager.getProfile(PROJECT_ID);
    expect(profile?.content).toBe('# First');
  });

  it('setProfile archives the previous active profile and creates a new one', async () => {
    const first = await manager.setProfile(PROJECT_ID, '# v1', []);
    const second = await manager.setProfile(PROJECT_ID, '# v2', []);
    const refreshedFirst = await manager.getById(first.id);
    expect(refreshedFirst?.status).toBe('archived');
    expect(second.status).toBe('active');
    const active = await manager.getProfile(PROJECT_ID);
    expect(active?.id).toBe(second.id);
  });
});
