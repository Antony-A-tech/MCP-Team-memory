import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { AgentTokenStore } from '../auth/agent-tokens.js';
import { Migrator } from '../storage/migrator.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://memory:memory@localhost:5432/team_memory_test';

// Fixed UUIDs so we only wipe rows WE own. Other tests share the DB; a
// blanket `DELETE FROM projects` would cascade into their fixtures and
// break the full-suite run.
const PROJECT_A = '00000000-cafe-cafe-cafe-000000000001';
const PROJECT_B = '00000000-cafe-cafe-cafe-000000000002';
const PROJECT_C = '00000000-cafe-cafe-cafe-000000000003';
const RBAC_PROJECT_IDS = [PROJECT_A, PROJECT_B, PROJECT_C];
const AGENT_NAME_PREFIX = '__rbac-test-agent';

let pool: Pool;
let store: AgentTokenStore;

async function fresh(): Promise<{ tokenId: string; rawToken: string; projectIds: string[] }> {
  // Targeted wipe: only THIS suite's tokens (by name prefix) and projects
  // (by fixed UUID). CASCADE drops the matching token_project_access rows.
  await pool.query(`DELETE FROM agent_tokens WHERE agent_name LIKE $1`, [`${AGENT_NAME_PREFIX}%`]);
  await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [RBAC_PROJECT_IDS]);

  await pool.query(
    `INSERT INTO projects (id, name, description) VALUES
       ($1, $2, 'a'), ($3, $4, 'b'), ($5, $6, 'c')`,
    [
      PROJECT_A, `${AGENT_NAME_PREFIX}-Project-A`,
      PROJECT_B, `${AGENT_NAME_PREFIX}-Project-B`,
      PROJECT_C, `${AGENT_NAME_PREFIX}-Project-C`,
    ],
  );

  // Re-init store so it picks up the post-wipe state.
  await store.initialize();
  const { token, agent } = await store.create(`${AGENT_NAME_PREFIX}-${Date.now()}`, 'developer');
  return { tokenId: agent.id, rawToken: token, projectIds: RBAC_PROJECT_IDS };
}

describe('AgentTokenStore RBAC (migration 028)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    const migrationsDir = path.resolve(__dirname, '../storage/migrations');
    const migrator = new Migrator(pool, migrationsDir);
    await migrator.run();
    store = new AgentTokenStore(pool);
    await store.initialize();
  });

  afterAll(async () => {
    // Final cleanup so the DB is in the same state as before the suite ran.
    await pool.query(`DELETE FROM agent_tokens WHERE agent_name LIKE $1`, [`${AGENT_NAME_PREFIX}%`]);
    await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [RBAC_PROJECT_IDS]);
    await pool.end();
  });

  beforeEach(async () => {
    // Targeted wipe — see `fresh()` for rationale.
    await pool.query(`DELETE FROM agent_tokens WHERE agent_name LIKE $1`, [`${AGENT_NAME_PREFIX}%`]);
    await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [RBAC_PROJECT_IDS]);
  });

  it('new token starts with empty allowedProjects (secure default)', async () => {
    const { tokenId, rawToken } = await fresh();
    const resolved = store.resolve(rawToken);
    expect(resolved).not.toBeNull();
    expect(resolved!.allowedProjects.size).toBe(0);
    expect(await store.getAllowedProjects(tokenId)).toEqual([]);
  });

  it('hasProjectAccess returns false for unlisted project', async () => {
    const { tokenId, projectIds } = await fresh();
    expect(store.hasProjectAccess(tokenId, projectIds[0])).toBe(false);
  });

  it('setAllowedProjects grants access, hasProjectAccess reflects it synchronously', async () => {
    const { tokenId, projectIds } = await fresh();
    await store.setAllowedProjects(tokenId, [projectIds[0], projectIds[1]], 'master');
    expect(store.hasProjectAccess(tokenId, projectIds[0])).toBe(true);
    expect(store.hasProjectAccess(tokenId, projectIds[1])).toBe(true);
    expect(store.hasProjectAccess(tokenId, projectIds[2])).toBe(false);
    expect((await store.getAllowedProjects(tokenId)).sort()).toEqual([projectIds[0], projectIds[1]].sort());
  });

  it('setAllowedProjects replaces the previous list, not appends', async () => {
    const { tokenId, projectIds } = await fresh();
    await store.setAllowedProjects(tokenId, [projectIds[0], projectIds[1]]);
    await store.setAllowedProjects(tokenId, [projectIds[2]]);
    expect(store.hasProjectAccess(tokenId, projectIds[0])).toBe(false);
    expect(store.hasProjectAccess(tokenId, projectIds[1])).toBe(false);
    expect(store.hasProjectAccess(tokenId, projectIds[2])).toBe(true);
  });

  it('setAllowedProjects([]) revokes all access', async () => {
    const { tokenId, projectIds } = await fresh();
    await store.setAllowedProjects(tokenId, projectIds);
    await store.setAllowedProjects(tokenId, []);
    for (const p of projectIds) {
      expect(store.hasProjectAccess(tokenId, p)).toBe(false);
    }
  });

  it('deduplicates project IDs in the input', async () => {
    const { tokenId, projectIds } = await fresh();
    await store.setAllowedProjects(tokenId, [projectIds[0], projectIds[0], projectIds[1]]);
    const persisted = await store.getAllowedProjects(tokenId);
    expect(persisted.length).toBe(2);
  });

  it('list() includes allowedProjects per token', async () => {
    const { tokenId, projectIds } = await fresh();
    await store.setAllowedProjects(tokenId, [projectIds[0]]);
    const list = await store.list();
    const entry = list.find((t) => t.id === tokenId);
    expect(entry).toBeDefined();
    expect(entry!.allowedProjects).toEqual([projectIds[0]]);
  });

  it('CASCADE: deleting a project removes its rows from token_project_access', async () => {
    const { tokenId, projectIds } = await fresh();
    await store.setAllowedProjects(tokenId, projectIds);
    await pool.query('DELETE FROM projects WHERE id = $1', [projectIds[0]]);
    const persisted = await store.getAllowedProjects(tokenId);
    expect(persisted).not.toContain(projectIds[0]);
    expect(persisted.length).toBe(2);
  });

  it('CASCADE: deleting a token removes its rows from token_project_access', async () => {
    const { tokenId, projectIds } = await fresh();
    await store.setAllowedProjects(tokenId, projectIds);
    await store.remove(tokenId);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS c FROM token_project_access WHERE token_id = $1',
      [tokenId],
    );
    expect(rows[0].c).toBe(0);
  });

  it('activate() rehydrates allowedProjects from DB', async () => {
    const { tokenId, projectIds } = await fresh();
    await store.setAllowedProjects(tokenId, [projectIds[1]]);
    await store.revoke(tokenId);
    // Cache no longer holds the entry — revoked tokens are dropped.
    await store.activate(tokenId);
    // After activate, getAllowedProjects should return the persisted set.
    expect((await store.getAllowedProjects(tokenId)).sort()).toEqual([projectIds[1]]);
    // And the cache should reflect it too (sync check).
    expect(store.hasProjectAccess(tokenId, projectIds[1])).toBe(true);
  });
});
