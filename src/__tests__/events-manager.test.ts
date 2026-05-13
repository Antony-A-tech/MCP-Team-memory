import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { Migrator } from '../storage/migrator.js';
import { EventsStorage } from '../events/storage.js';
import { EventsManager } from '../events/manager.js';
import path from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';
const PID = '00000000-0000-0000-0000-00000000ffff';

describe('EventsManager', () => {
  let pool: pg.Pool;
  let manager: EventsManager;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB });
    await new Migrator(pool, path.resolve('src/storage/migrations')).run();
    await pool.query(`DELETE FROM project_events WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'events-manager-test')`, [PID]);
    manager = new EventsManager(new EventsStorage(pool));
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM project_events WHERE project_id = $1`, [PID]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM project_events WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.end();
  });

  it('add returns event with id and refs', async () => {
    const ev = await manager.add({
      projectId: PID,
      eventType: 'release',
      occurredAt: new Date(),
      title: 'v1.0.0',
      refs: { version_tag: 'v1.0.0' },
    });
    expect(ev.id).toBeDefined();
    expect(ev.refs.version_tag).toBe('v1.0.0');
  });

  it('listRecent returns last N events', async () => {
    for (let i = 0; i < 12; i++) {
      await manager.add({
        projectId: PID,
        eventType: 'deploy',
        occurredAt: new Date(Date.now() - i * 86400000),
        title: `deploy ${i}`,
      });
    }
    const recent = await manager.listRecent(PID, 10);
    expect(recent).toHaveLength(10);
    expect(recent[0].title).toBe('deploy 0');
  });

  it('rejects empty title', async () => {
    await expect(manager.add({
      projectId: PID,
      eventType: 'merge',
      occurredAt: new Date(),
      title: '',
    })).rejects.toThrow(/title/);
  });

  it('rejects whitespace-only title', async () => {
    await expect(manager.add({
      projectId: PID,
      eventType: 'merge',
      occurredAt: new Date(),
      title: '   ',
    })).rejects.toThrow(/title/);
  });

  it('delete returns true for existing event', async () => {
    const ev = await manager.add({ projectId: PID, eventType: 'merge', occurredAt: new Date(), title: 'x' });
    const ok = await manager.delete(ev.id);
    expect(ok).toBe(true);
  });
});
