import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { Migrator } from '../storage/migrator.js';
import path from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';
const PID = '00000000-0000-0000-0000-00000000dddd';

describe('Migration 023: project_events', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB });
    const migrator = new Migrator(pool, path.resolve('src/storage/migrations'));
    await migrator.run();
    await pool.query(`DELETE FROM project_events WHERE project_id = $1`, [PID]).catch(() => {});
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'events-test')`, [PID]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM project_events WHERE project_id = $1`, [PID]).catch(() => {});
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.end();
  });

  it('accepts all 5 event types', async () => {
    for (const t of ['merge', 'release', 'deploy', 'incident', 'milestone']) {
      await pool.query(
        `INSERT INTO project_events (project_id, event_type, occurred_at, title)
         VALUES ($1, $2, NOW(), $3)`,
        [PID, t, `t-${t}`],
      );
    }
    const { rows } = await pool.query(
      `SELECT event_type FROM project_events WHERE project_id=$1`,
      [PID],
    );
    expect(rows.length).toBe(5);
  });

  it('rejects unknown event_type', async () => {
    await expect(
      pool.query(
        `INSERT INTO project_events (project_id, event_type, occurred_at, title)
         VALUES ($1, 'unknown', NOW(), 't')`,
        [PID],
      ),
    ).rejects.toThrow(/check constraint|invalid input/i);
  });

  it('cascades on project delete', async () => {
    const TEMP_ID = '00000000-0000-0000-0000-00000000ddde';
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'cascade-test') ON CONFLICT DO NOTHING`, [TEMP_ID]);
    await pool.query(
      `INSERT INTO project_events (project_id, event_type, occurred_at, title) VALUES ($1, 'merge', NOW(), 't')`,
      [TEMP_ID],
    );
    await pool.query(`DELETE FROM projects WHERE id=$1`, [TEMP_ID]);
    const { rows } = await pool.query(
      `SELECT id FROM project_events WHERE project_id=$1`,
      [TEMP_ID],
    );
    expect(rows.length).toBe(0);
  });

  it('refs JSONB roundtrips correctly', async () => {
    await pool.query(
      `INSERT INTO project_events (project_id, event_type, occurred_at, title, refs)
       VALUES ($1, 'release', NOW(), 'v1', $2::jsonb)`,
      [PID, JSON.stringify({ pr_number: 42, version_tag: 'v1.0.0' })],
    );
    const { rows } = await pool.query(
      `SELECT refs FROM project_events WHERE project_id=$1 AND title='v1'`,
      [PID],
    );
    expect(rows[0].refs).toEqual({ pr_number: 42, version_tag: 'v1.0.0' });
  });
});
