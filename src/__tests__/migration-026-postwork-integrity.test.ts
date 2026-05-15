// src/__tests__/migration-026-postwork-integrity.test.ts
//
// Tests for migration 026 — Phase 1.A of
// docs/superpowers/plans/2026-05-15-v5-postwork-audit-fixes.md.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { Migrator } from '../storage/migrator.js';
import path from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';
const PID = '00000000-0000-0000-0000-000000026001';
const TOKEN_ID = '00000000-0000-0000-0000-000000026099';

describe('Migration 026: postwork integrity', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB });
    await new Migrator(pool, path.resolve('src/storage/migrations')).run();
    // Clean any leftovers from previous runs.
    await pool.query(`DELETE FROM sessions WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM personal_notes WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.query(`DELETE FROM agent_tokens WHERE id = $1`, [TOKEN_ID]);
    await pool.query(
      `INSERT INTO agent_tokens (id, token, agent_name, role, is_active)
       VALUES ($1, 'tm_test_026_token', 'test-026', 'developer', true)
       ON CONFLICT (id) DO NOTHING`,
      [TOKEN_ID],
    );
  });

  beforeEach(async () => {
    // Recreate the project for each test so cascades from previous tests are
    // gone.
    await pool.query(`DELETE FROM sessions WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM personal_notes WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'mig-026')`, [PID]);
  });

  afterAll(async () => {
    // Sessions whose project_id was SET NULL by an earlier test still
    // reference the agent_token, so delete by token here too.
    await pool.query(`DELETE FROM sessions WHERE agent_token_id = $1`, [TOKEN_ID]);
    await pool.query(`DELETE FROM personal_notes WHERE agent_token_id = $1`, [TOKEN_ID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.query(`DELETE FROM agent_tokens WHERE id = $1`, [TOKEN_ID]);
    await pool.end();
  });

  it('FK personal_notes.project_id is ON DELETE CASCADE', async () => {
    const { rows } = await pool.query(
      `SELECT confdeltype FROM pg_constraint
       WHERE conname = 'personal_notes_project_id_fkey'`,
    );
    expect(rows[0]?.confdeltype).toBe('c'); // CASCADE
  });

  it('FK sessions.project_id is ON DELETE SET NULL', async () => {
    const { rows } = await pool.query(
      `SELECT confdeltype FROM pg_constraint
       WHERE conname = 'sessions_project_id_fkey'`,
    );
    expect(rows[0]?.confdeltype).toBe('n'); // SET NULL
  });

  it('deleting a project cascades-deletes its personal_notes', async () => {
    await pool.query(
      `INSERT INTO personal_notes (agent_token_id, project_id, title, content)
       VALUES ($1, $2, 'note A', 'c'), ($1, $2, 'note B', 'c')`,
      [TOKEN_ID, PID],
    );
    const before = await pool.query(
      `SELECT COUNT(*)::int as c FROM personal_notes WHERE project_id = $1`,
      [PID],
    );
    expect(before.rows[0].c).toBe(2);

    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);

    const after = await pool.query(
      `SELECT COUNT(*)::int as c FROM personal_notes WHERE project_id = $1`,
      [PID],
    );
    expect(after.rows[0].c).toBe(0);
  });

  it('deleting a project sets sessions.project_id to NULL, preserves the row', async () => {
    const insertResult = await pool.query(
      `INSERT INTO sessions (project_id, agent_token_id, name, summary, started_at, message_count)
       VALUES ($1, $2, 'sess', 'session-026 summary', NOW(), 0) RETURNING id`,
      [PID, TOKEN_ID],
    );
    const sessId = insertResult.rows[0].id;

    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);

    const after = await pool.query(
      `SELECT project_id, name FROM sessions WHERE id = $1`,
      [sessId],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].project_id).toBeNull();
    expect(after.rows[0].name).toBe('sess');
  });

  it('column comments are populated by the migration', async () => {
    const { rows } = await pool.query(
      `SELECT pg_catalog.col_description(c.oid, a.attnum) AS comment
       FROM pg_class c
       JOIN pg_attribute a ON a.attrelid = c.oid
       WHERE c.relname = 'entries' AND a.attname = 'status'`,
    );
    expect(rows[0]?.comment).toMatch(/Entry lifecycle/i);
  });
});
