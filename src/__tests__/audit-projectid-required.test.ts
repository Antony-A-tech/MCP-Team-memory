// src/__tests__/audit-projectid-required.test.ts
//
// Regression test: GET /api/audit MUST require project_id (query or header) and
// MUST NOT fall back to AuditLogger.getRecent(), which leaks audit entries from
// all projects to any authenticated caller (Phase 0.A of postwork fixes,
// 2026-05-15).
//
// Requires a real PostgreSQL instance.
// Set TEST_DATABASE_URL to override the default connection string.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import { AuditLogger } from '../storage/audit.js';
import { WebServer } from '../web/server.js';

const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  'postgres://memory:memory@localhost:5432/team_memory_test';

const PROJECT_A = '00000000-aaaa-aaaa-aaaa-000000000001';
const PROJECT_B = '00000000-bbbb-bbbb-bbbb-000000000002';

describe('GET /api/audit — project_id required (no global leak)', () => {
  let pool: Pool;
  let storage: PgStorage;
  let manager: MemoryManager;
  let auditLogger: AuditLogger;
  let app: express.Express;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB });
    storage = new PgStorage(TEST_DB, 'simple');
    auditLogger = new AuditLogger(pool);
    manager = new MemoryManager(storage, auditLogger);
    await manager.initialize();

    // Ensure both test projects exist (they may not by default).
    await pool.query(
      `INSERT INTO projects (id, name, description) VALUES ($1, $2, $3), ($4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [PROJECT_A, 'audit-test-A', 'audit isolation test A',
       PROJECT_B, 'audit-test-B', 'audit isolation test B'],
    );

    const ws = new WebServer(manager);
    app = express();
    app.use(express.json());
    ws.mountRoutes(app);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_log WHERE project_id IN ($1, $2)`, [PROJECT_A, PROJECT_B]);
    await pool.query(`DELETE FROM projects WHERE id IN ($1, $2)`, [PROJECT_A, PROJECT_B]);
    await manager.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM audit_log WHERE project_id IN ($1, $2)`, [PROJECT_A, PROJECT_B]);
    // Seed: 2 audit entries in A, 3 in B
    await auditLogger.log({ entryId: null, projectId: PROJECT_A, action: 'create', actor: 'tester', changes: { seed: 'a1' } });
    await auditLogger.log({ entryId: null, projectId: PROJECT_A, action: 'update', actor: 'tester', changes: { seed: 'a2' } });
    await auditLogger.log({ entryId: null, projectId: PROJECT_B, action: 'create', actor: 'tester', changes: { seed: 'b1' } });
    await auditLogger.log({ entryId: null, projectId: PROJECT_B, action: 'update', actor: 'tester', changes: { seed: 'b2' } });
    await auditLogger.log({ entryId: null, projectId: PROJECT_B, action: 'archive', actor: 'tester', changes: { seed: 'b3' } });
  });

  it('returns 400 when neither query nor header provides project_id', async () => {
    const res = await request(app).get('/api/audit');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/project_id is required/i);
    expect(res.body.audit).toBeUndefined();
  });

  it('returns only project A entries when project_id query is set to A', async () => {
    const res = await request(app).get('/api/audit').query({ project_id: PROJECT_A });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.audit)).toBe(true);
    expect(res.body.audit.length).toBe(2);
    for (const a of res.body.audit) {
      expect(a.projectId).toBe(PROJECT_A);
    }
  });

  it('returns only project A entries when X-Project-Id header is set to A (no query)', async () => {
    const res = await request(app).get('/api/audit').set('X-Project-Id', PROJECT_A);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.audit.length).toBe(2);
    for (const a of res.body.audit) {
      expect(a.projectId).toBe(PROJECT_A);
    }
  });

  it('query project_id wins over header', async () => {
    const res = await request(app)
      .get('/api/audit')
      .query({ project_id: PROJECT_B })
      .set('X-Project-Id', PROJECT_A);
    expect(res.status).toBe(200);
    expect(res.body.audit.length).toBe(3);
    for (const a of res.body.audit) {
      expect(a.projectId).toBe(PROJECT_B);
    }
  });
});
