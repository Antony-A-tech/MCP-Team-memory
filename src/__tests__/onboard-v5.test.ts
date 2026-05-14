import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import { EventsStorage } from '../events/storage.js';
import { EventsManager } from '../events/manager.js';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';
const PID = '00000000-0000-0000-0000-000000020010';

describe('Onboarding v5 format', () => {
  let pool: pg.Pool;
  let storage: PgStorage;
  let manager: MemoryManager;
  let eventsManager: EventsManager;

  beforeAll(async () => {
    storage = new PgStorage(TEST_DB);
    await storage.initialize();
    manager = new MemoryManager(storage);
    pool = new pg.Pool({ connectionString: TEST_DB });
    eventsManager = new EventsManager(new EventsStorage(pool));
    manager.setEventsManager(eventsManager);
    await pool.query(`DELETE FROM project_events WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.query(`INSERT INTO projects (id, name, description) VALUES ($1, 'onboard-v5-test', 'Test')`, [PID]);
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM project_events WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PID]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM project_events WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.end();
    await storage.close();
  });

  it('shows profile placeholder when not set', async () => {
    const out = await manager.generateOnboarding(PID);
    expect(out).toContain('🗺️ Profile');
    expect(out).toContain('не задан');
    expect(out).toContain('memory_profile_set');
  });

  it('shows full profile content when set', async () => {
    await manager.setProfile(PID, '# Mission\nv5 onboarding test', []);
    const out = await manager.generateOnboarding(PID);
    expect(out).toContain('# Mission');
    expect(out).toContain('v5 onboarding test');
  });

  it('shows recent events section after profile, ordered DESC', async () => {
    await manager.setProfile(PID, '# Mission', []);
    await eventsManager.add({ projectId: PID, eventType: 'release', occurredAt: new Date('2026-05-12'), title: 'v5.0.0' });
    await eventsManager.add({ projectId: PID, eventType: 'merge', occurredAt: new Date('2026-05-13'), title: 'feat/x to main' });
    const out = await manager.generateOnboarding(PID);
    expect(out).toContain('📈 Recent activity');
    expect(out).toContain('v5.0.0');
    expect(out).toContain('feat/x to main');
    expect(out.indexOf('🗺️ Profile')).toBeLessThan(out.indexOf('📈 Recent activity'));
    // newer event listed first
    expect(out.indexOf('feat/x to main')).toBeLessThan(out.indexOf('v5.0.0'));
  });

  it('groups knowledge by kind tag', async () => {
    await pool.query(
      `INSERT INTO entries (project_id, category, title, content, tags)
       VALUES ($1, 'knowledge', 'Arch X', 'arch content', ARRAY['architecture'])`,
      [PID],
    );
    await pool.query(
      `INSERT INTO entries (project_id, category, title, content, tags)
       VALUES ($1, 'knowledge', 'Dec Y', 'decision content', ARRAY['decision'])`,
      [PID],
    );
    await pool.query(
      `INSERT INTO entries (project_id, category, title, content, tags)
       VALUES ($1, 'knowledge', 'Conv Z', 'convention content', ARRAY['convention'])`,
      [PID],
    );
    const out = await manager.generateOnboarding(PID);
    expect(out).toContain('📚 Knowledge');
    expect(out).toContain('🏗️ Architecture');
    expect(out).toContain('Arch X');
    expect(out).toContain('✅ Decisions');
    expect(out).toContain('Dec Y');
    expect(out).toContain('📏 Conventions');
    expect(out).toContain('Conv Z');
  });

  it('does NOT show deprecated tasks/issues/progress sections', async () => {
    await pool.query(
      `INSERT INTO entries (project_id, category, title, content)
       VALUES ($1, 'tasks', 'Old task', 'c'), ($1, 'issues', 'Old issue', 'c'), ($1, 'progress', 'Old progress', 'c')`,
      [PID],
    );
    const out = await manager.generateOnboarding(PID);
    expect(out).not.toContain('📋 Активные задачи');
    expect(out).not.toContain('🐛 Известные проблемы');
    expect(out).not.toContain('📈 Последний прогресс');
  });

  it('falls back to legacy architecture/decisions/conventions categories when knowledge is empty', async () => {
    await pool.query(
      `INSERT INTO entries (project_id, category, title, content)
       VALUES ($1, 'architecture', 'Legacy arch', 'legacy arch content')`,
      [PID],
    );
    const out = await manager.generateOnboarding(PID);
    expect(out).toContain('🏗️ Architecture');
    expect(out).toContain('Legacy arch');
  });

  it('groups migrated knowledge with PLURAL kind tags (decisions/conventions) into proper sections (C1 regression)', async () => {
    // Reproduces what migration 022 actually writes:
    //   decisions → category=knowledge, tags=['decisions']
    //   conventions → category=knowledge, tags=['conventions']
    await pool.query(
      `INSERT INTO entries (project_id, category, title, content, tags)
       VALUES ($1, 'knowledge', 'Migrated decision', 'decision content', ARRAY['decisions'])`,
      [PID],
    );
    await pool.query(
      `INSERT INTO entries (project_id, category, title, content, tags)
       VALUES ($1, 'knowledge', 'Migrated convention', 'convention content', ARRAY['conventions'])`,
      [PID],
    );
    const out = await manager.generateOnboarding(PID);
    // Both must show up in their proper section, NOT in "Other"
    expect(out).toContain('✅ Decisions');
    expect(out).toContain('Migrated decision');
    expect(out).toContain('📏 Conventions');
    expect(out).toContain('Migrated convention');
    // Sanity: ensure they did NOT leak into Other
    const otherIdx = out.indexOf('### Other');
    if (otherIdx >= 0) {
      const afterOther = out.slice(otherIdx);
      expect(afterOther).not.toContain('Migrated decision');
      expect(afterOther).not.toContain('Migrated convention');
    }
  });

  it('stats line mentions Knowledge, Profile, Events counters', async () => {
    await manager.setProfile(PID, '# Mission', []);
    await eventsManager.add({ projectId: PID, eventType: 'merge', occurredAt: new Date(), title: 'm' });
    const out = await manager.generateOnboarding(PID);
    expect(out).toMatch(/Knowledge: \d+, Profile: 1, Events: 1/);
  });
});
