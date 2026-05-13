import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { Migrator } from '../storage/migrator.js';
import path from 'path';
import fs from 'fs';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';
const PID = '00000000-0000-0000-0000-000000010001';

describe('Migration 022: knowledge unification', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB });
    // Run all migrations
    await new Migrator(pool, path.resolve('src/storage/migrations')).run();
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'mig-022-test')`, [PID]);
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PID]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.end();
  });

  /**
   * The migration runs at startup via Migrator; this test seeds an
   * 'architecture' row AFTER migration ran, then re-applies 022 SQL
   * manually to verify the transformation is correct and idempotent.
   */
  async function runMigration022(): Promise<void> {
    const sql = fs.readFileSync(
      path.resolve('src/storage/migrations/022-knowledge-category.sql'),
      'utf-8',
    );
    await pool.query(sql);
  }

  it('migrates architecture entries to knowledge with kind tag preserved', async () => {
    await pool.query(
      `INSERT INTO entries (project_id, category, title, content, tags)
       VALUES ($1, 'architecture', 'Test arch', 'c', ARRAY['existing-tag'])`,
      [PID],
    );
    await runMigration022();
    const { rows } = await pool.query(
      `SELECT category, tags FROM entries WHERE project_id=$1 AND title='Test arch'`,
      [PID],
    );
    expect(rows[0].category).toBe('knowledge');
    expect(rows[0].tags).toContain('architecture');
    expect(rows[0].tags).toContain('existing-tag');
  });

  it('migrates decisions and conventions similarly', async () => {
    await pool.query(
      `INSERT INTO entries (project_id, category, title, content)
       VALUES ($1, 'decisions', 'D', 'c'), ($1, 'conventions', 'C', 'c')`,
      [PID],
    );
    await runMigration022();
    const { rows } = await pool.query(
      `SELECT title, category, tags FROM entries WHERE project_id=$1 ORDER BY title`,
      [PID],
    );
    expect(rows[0].category).toBe('knowledge');
    expect(rows[0].tags).toContain('conventions');
    expect(rows[1].category).toBe('knowledge');
    expect(rows[1].tags).toContain('decisions');
  });

  it('is idempotent — re-running keeps category=knowledge with single tag', async () => {
    await pool.query(
      `INSERT INTO entries (project_id, category, title, content)
       VALUES ($1, 'architecture', 'I1', 'c')`,
      [PID],
    );
    await runMigration022();
    await runMigration022();
    const { rows } = await pool.query(
      `SELECT category, tags FROM entries WHERE project_id=$1 AND title='I1'`,
      [PID],
    );
    expect(rows[0].category).toBe('knowledge');
    const archCount = rows[0].tags.filter((t: string) => t === 'architecture').length;
    expect(archCount).toBe(1);
  });

  it('leaves tasks/progress/issues categories untouched', async () => {
    await pool.query(
      `INSERT INTO entries (project_id, category, title, content)
       VALUES ($1, 'tasks', 'T', 'c'), ($1, 'progress', 'P', 'c'), ($1, 'issues', 'I', 'c')`,
      [PID],
    );
    await runMigration022();
    const { rows } = await pool.query(
      `SELECT category FROM entries WHERE project_id=$1 ORDER BY title`,
      [PID],
    );
    expect(rows.map((r) => r.category).sort()).toEqual(['issues', 'progress', 'tasks']);
  });

  it("accepts category = 'knowledge' on direct INSERT after migration", async () => {
    await runMigration022();
    const { rows } = await pool.query(
      `INSERT INTO entries (project_id, category, title, content)
       VALUES ($1, 'knowledge', 'direct', 'c')
       RETURNING category`,
      [PID],
    );
    expect(rows[0].category).toBe('knowledge');
  });
});
