// src/__tests__/migration-018.test.ts
//
// Integration test for migration 018-auto-notes.
// Requires a real PostgreSQL instance.
// Set TEST_DATABASE_URL to override the default connection string.
//
// Default matches the docker-compose dev credentials; pass
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/team_memory_test
// if your local setup differs.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import { Migrator } from '../storage/migrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  'postgres://memory:memory@localhost:5432/team_memory_test';

const MIGRATIONS_DIR = path.resolve(__dirname, '../storage/migrations');

describe('migration 018-auto-notes', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB });
    const migrator = new Migrator(pool, MIGRATIONS_DIR);
    await migrator.run();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('adds expected columns to entries', async () => {
    const { rows } = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name='entries'
        AND column_name IN ('auto_generated','extraction_confidence',
          'explicit_marker_strength','confirmation_count','last_confirmed_at',
          'evidence_sources','external_refs','importance_score')
      ORDER BY column_name
    `);
    expect(rows.length).toBe(8);
    const byName = Object.fromEntries(rows.map((r: Record<string, string>) => [r.column_name, r]));
    expect(byName.auto_generated.data_type).toBe('boolean');
    expect(byName.confirmation_count.data_type).toBe('integer');
    expect(byName.evidence_sources.data_type).toBe('jsonb');
    expect(byName.external_refs.data_type).toBe('jsonb');
  });

  it('adds shared_to_entry_id to personal_notes', async () => {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='personal_notes' AND column_name='shared_to_entry_id'
    `);
    expect(rows.length).toBe(1);
  });

  it('extracting_notes is allowed in sessions.embedding_status', async () => {
    const sid = '00000000-0000-0000-0000-000000000018';
    // Note: agent_tokens uses `token` and `agent_name`, not `name`/`token_hash`
    // (see migration 008-agent-tokens.sql for schema)
    await pool.query(
      `INSERT INTO agent_tokens (id, token, agent_name, is_active) VALUES ($1,'test-token-018','test-agent',true) ON CONFLICT DO NOTHING`,
      [sid],
    );
    await pool.query(
      `INSERT INTO sessions (id, agent_token_id, summary, message_count, embedding_status) VALUES ($1,$1,'s',0,'extracting_notes') ON CONFLICT DO NOTHING`,
      [sid],
    );
    const { rows } = await pool.query(
      `SELECT embedding_status FROM sessions WHERE id=$1`,
      [sid],
    );
    expect(rows[0].embedding_status).toBe('extracting_notes');
    await pool.query(`DELETE FROM sessions WHERE id=$1`, [sid]);
    await pool.query(`DELETE FROM agent_tokens WHERE id=$1`, [sid]);
  });

  it('column defaults apply on INSERT (confirmation_count, auto_generated, evidence_sources, external_refs, importance_score)', async () => {
    const projectId = '00000000-0000-0000-0000-000000000018';
    // Ensure default project exists (matches DEFAULT_PROJECT_ID convention used elsewhere)
    await pool.query(
      `INSERT INTO projects (id, name) VALUES ($1, 'migration-018-test') ON CONFLICT (id) DO NOTHING`,
      [projectId],
    );
    const inserted = await pool.query(
      `INSERT INTO entries (project_id, category, title, content)
       VALUES ($1, 'decisions', 'defaults probe', 'body')
       RETURNING id, auto_generated, confirmation_count, evidence_sources,
                 external_refs, importance_score, last_confirmed_at,
                 extraction_confidence, explicit_marker_strength`,
      [projectId],
    );
    const row = inserted.rows[0];
    expect(row.auto_generated).toBe(false);
    expect(row.confirmation_count).toBe(1);
    expect(row.evidence_sources).toEqual([]);
    expect(row.external_refs).toEqual({});
    expect(row.importance_score).toBeCloseTo(0.5, 5);
    expect(row.last_confirmed_at).toBeNull();
    expect(row.extraction_confidence).toBeNull();
    expect(row.explicit_marker_strength).toBeNull();
    // Cleanup
    await pool.query(`DELETE FROM entries WHERE id = $1`, [row.id]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });
});
