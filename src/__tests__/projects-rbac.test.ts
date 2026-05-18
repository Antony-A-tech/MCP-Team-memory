// Integration test for project-create auto-grant + RBAC-filtered project list.
//
// Covers the user story from Session 2:
//   "Любой токен может создать свой проект. Проект становится «личным» —
//    его видит только автор. Master видит все проекты и может выдать
//    доступ другим токенам через /agents."
//
// Phase RBAC of v5-postwork plan.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import { AgentTokenStore } from '../auth/agent-tokens.js';
import { WebServer } from '../web/server.js';

const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  'postgres://memory:memory@localhost:5432/team_memory_test';

const NAME_PREFIX = '__projects-rbac-test';

describe('POST /api/projects auto-grant + GET /api/projects RBAC filter', () => {
  let pool: Pool;
  let storage: PgStorage;
  let manager: MemoryManager;
  let store: AgentTokenStore;
  let app: express.Express;

  // The two agent tokens we'll test with — created fresh per suite.
  let aliceTokenId: string;
  let bobTokenId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB });
    storage = new PgStorage(TEST_DB, 'simple');
    manager = new MemoryManager(storage);
    await manager.initialize();
    store = new AgentTokenStore(pool);
    await store.initialize();

    const ws = new WebServer(manager, null, store);
    app = express();
    app.use(express.json());
    // Tiny auth shim: an `X-Test-Auth` header selects which fake identity
    // the request runs as. Keeps the test focused on the RBAC logic
    // without dragging the full auth middleware in.
    app.use((req, _res, next) => {
      const v = req.headers['x-test-auth'] as string | undefined;
      if (v === 'master') {
        (req as any).auth = { clientId: 'master', scopes: ['admin'] };
      } else if (v === 'alice') {
        (req as any).auth = {
          clientId: 'alice',
          agentTokenId: aliceTokenId,
          scopes: ['developer'],
        };
      } else if (v === 'bob') {
        (req as any).auth = {
          clientId: 'bob',
          agentTokenId: bobTokenId,
          scopes: ['developer'],
        };
      }
      next();
    });
    ws.mountRoutes(app);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM agent_tokens WHERE agent_name LIKE $1`, [`${NAME_PREFIX}%`]);
    await pool.query(`DELETE FROM projects WHERE name LIKE $1`, [`${NAME_PREFIX}%`]);
    await manager.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM agent_tokens WHERE agent_name LIKE $1`, [`${NAME_PREFIX}%`]);
    await pool.query(`DELETE FROM projects WHERE name LIKE $1`, [`${NAME_PREFIX}%`]);
    await store.initialize();
    const alice = await store.create(`${NAME_PREFIX}-alice`, 'developer');
    const bob = await store.create(`${NAME_PREFIX}-bob`, 'developer');
    aliceTokenId = alice.agent.id;
    bobTokenId = bob.agent.id;
  });

  it('agent who creates a project is auto-granted access; other agents are not', async () => {
    const create = await request(app)
      .post('/api/projects')
      .set('x-test-auth', 'alice')
      .send({ name: `${NAME_PREFIX}-alice-private` });
    expect(create.status).toBe(200);
    expect(create.body.success).toBe(true);
    const projectId = create.body.project.id as string;

    // alice can see it
    const aliceList = await request(app)
      .get('/api/projects')
      .set('x-test-auth', 'alice');
    expect(aliceList.body.projects.map((p: any) => p.id)).toContain(projectId);

    // bob cannot
    const bobList = await request(app)
      .get('/api/projects')
      .set('x-test-auth', 'bob');
    expect(bobList.body.projects.map((p: any) => p.id)).not.toContain(projectId);
  });

  it('master sees every project regardless of creator', async () => {
    const create = await request(app)
      .post('/api/projects')
      .set('x-test-auth', 'alice')
      .send({ name: `${NAME_PREFIX}-master-view` });
    const projectId = create.body.project.id as string;

    const masterList = await request(app)
      .get('/api/projects')
      .set('x-test-auth', 'master');
    expect(masterList.body.projects.map((p: any) => p.id)).toContain(projectId);
  });

  it('master can create a project without ending up in any allowlist', async () => {
    const create = await request(app)
      .post('/api/projects')
      .set('x-test-auth', 'master')
      .send({ name: `${NAME_PREFIX}-master-orphan` });
    expect(create.status).toBe(200);
    const projectId = create.body.project.id as string;

    // No agent token has access yet — both alice and bob lists exclude it.
    const aliceList = await request(app)
      .get('/api/projects')
      .set('x-test-auth', 'alice');
    expect(aliceList.body.projects.map((p: any) => p.id)).not.toContain(projectId);

    const bobList = await request(app)
      .get('/api/projects')
      .set('x-test-auth', 'bob');
    expect(bobList.body.projects.map((p: any) => p.id)).not.toContain(projectId);

    // Master sees it (admin scope bypasses filter).
    const masterList = await request(app)
      .get('/api/projects')
      .set('x-test-auth', 'master');
    expect(masterList.body.projects.map((p: any) => p.id)).toContain(projectId);

    // And master can grant access to alice via the PUT endpoint we
    // exercise via the store directly here (REST PUT path is tested in
    // the agent-token-rbac unit suite).
    await store.setAllowedProjects(aliceTokenId, [projectId], 'master');
    const aliceListAfterGrant = await request(app)
      .get('/api/projects')
      .set('x-test-auth', 'alice');
    expect(aliceListAfterGrant.body.projects.map((p: any) => p.id)).toContain(projectId);
  });

  it('alice creating project A does NOT also grant access to project B that bob owns', async () => {
    const a = await request(app)
      .post('/api/projects')
      .set('x-test-auth', 'alice')
      .send({ name: `${NAME_PREFIX}-A` });
    const b = await request(app)
      .post('/api/projects')
      .set('x-test-auth', 'bob')
      .send({ name: `${NAME_PREFIX}-B` });

    const aliceList = (await request(app)
      .get('/api/projects')
      .set('x-test-auth', 'alice')).body.projects.map((p: any) => p.id);
    expect(aliceList).toContain(a.body.project.id);
    expect(aliceList).not.toContain(b.body.project.id);

    const bobList = (await request(app)
      .get('/api/projects')
      .set('x-test-auth', 'bob')).body.projects.map((p: any) => p.id);
    expect(bobList).toContain(b.body.project.id);
    expect(bobList).not.toContain(a.body.project.id);
  });
});
