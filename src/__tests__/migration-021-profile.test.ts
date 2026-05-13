import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { Migrator } from '../storage/migrator.js';
import path from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';
const PID = '00000000-0000-0000-0000-000000000099';

describe('Migration 021: profile category', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB });
    const migrator = new Migrator(pool, path.resolve('src/storage/migrations'));
    await migrator.run();
    // Ensure clean project row for the test PID
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'mig-021-test')`, [PID]);
  });

  beforeEach(async () => {
    // Clean entries to avoid cross-test pollution
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PID]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.end();
  });

  it('accepts category = profile', async () => {
    const { rows } = await pool.query(
      `INSERT INTO entries (project_id, category, title, content)
       VALUES ($1, 'profile', 'P1', 'content')
       RETURNING category`,
      [PID],
    );
    expect(rows[0].category).toBe('profile');
  });

  it('enforces only one active profile per project', async () => {
    await pool.query(
      `INSERT INTO entries (project_id, category, title, content, status)
       VALUES ($1, 'profile', 'P-first', 'c', 'active')`,
      [PID],
    );
    await expect(
      pool.query(
        `INSERT INTO entries (project_id, category, title, content, status)
         VALUES ($1, 'profile', 'P-second', 'c', 'active')`,
        [PID],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('allows archiving an old profile and creating a new active one', async () => {
    const { rows: firstRows } = await pool.query(
      `INSERT INTO entries (project_id, category, title, content, status)
       VALUES ($1, 'profile', 'P-v1', 'c', 'active')
       RETURNING id`,
      [PID],
    );
    await pool.query(
      `UPDATE entries SET status='archived' WHERE id = $1`,
      [firstRows[0].id],
    );
    const { rows } = await pool.query(
      `INSERT INTO entries (project_id, category, title, content, status)
       VALUES ($1, 'profile', 'P-v2', 'c', 'active')
       RETURNING id`,
      [PID],
    );
    expect(rows[0].id).toBeTruthy();
  });
});
