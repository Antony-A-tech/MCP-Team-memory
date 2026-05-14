import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PgStorage } from '../storage/pg-storage.js';
import { PersonalNotesStorage } from '../notes/storage.js';
import { NotesManager } from '../notes/manager.js';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';

/**
 * v5 invariant — personal_notes.project_id is NOT NULL (migration 025).
 * These tests pin two parts of the contract:
 *   1. The DB rejects INSERTs without project_id.
 *   2. NotesManager.write happily forwards a valid project_id (proves the
 *      column accepts non-null values).
 *
 * The MCP-handler layer (server.ts note_write) rejects callers without
 * project_id BEFORE reaching the manager via requireProjectId(). That
 * boundary is validated in the wider integration coverage / smoke runs.
 */
describe('personal_notes project_id invariant (migration 025)', () => {
  let storage: PgStorage;
  let pool: pg.Pool;
  let notes: NotesManager;
  const TEST_TOKEN_ID = '00000000-0000-0000-0000-000000000a25';
  const TEST_PROJECT_ID = '00000000-0000-0000-0000-000000000000';

  beforeAll(async () => {
    storage = new PgStorage(TEST_DB);
    await storage.initialize();
    pool = new pg.Pool({ connectionString: TEST_DB });
    notes = new NotesManager(new PersonalNotesStorage(pool));
    // Seed an agent token row so FK on personal_notes.agent_token_id is satisfied.
    await pool.query(
      `INSERT INTO agent_tokens (id, token, agent_name, role)
       VALUES ($1, $2, 'mig-025-test', 'developer')
       ON CONFLICT (id) DO NOTHING`,
      [TEST_TOKEN_ID, 'tok-mig-025-' + Date.now()],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM personal_notes WHERE agent_token_id = $1`, [TEST_TOKEN_ID]);
    await pool.query(`DELETE FROM agent_tokens WHERE id = $1`, [TEST_TOKEN_ID]);
    await pool.end();
    await storage.close();
  });

  it('DB rejects direct INSERT without project_id (NOT NULL)', async () => {
    await expect(
      pool.query(
        `INSERT INTO personal_notes (agent_token_id, title, content)
         VALUES ($1, 'orphan', 'body')`,
        [TEST_TOKEN_ID],
      ),
    ).rejects.toThrow(/null value in column .*project_id|violates not-null/i);
  });

  it('NotesManager.write succeeds with a project_id', async () => {
    const note = await notes.write(TEST_TOKEN_ID, {
      title: 'with project',
      content: 'body',
      tags: [],
      priority: 'medium',
      projectId: TEST_PROJECT_ID,
      sessionId: null,
    });
    expect(note.id).toBeTruthy();
    expect(note.projectId).toBe(TEST_PROJECT_ID);
  });
});
