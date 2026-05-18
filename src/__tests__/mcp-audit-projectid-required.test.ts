// src/__tests__/mcp-audit-projectid-required.test.ts
//
// Regression test for MCP memory_audit tool: must NOT fall back to
// AuditLogger.getRecent() when neither project_id nor entry_id is given.
// Companion to the REST-side test in audit-projectid-required.test.ts —
// covers the MCP code path at src/server.ts:746-756 that REST cannot
// exercise.
//
// Phase 0.A regression test (added per Code Review feedback for
// docs/superpowers/plans/2026-05-15-v5-postwork-audit-fixes.md).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import { AuditLogger } from '../storage/audit.js';
import { buildMcpServer } from '../server.js';

const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  'postgres://memory:memory@localhost:5432/team_memory_test';

const PROJECT_A = '00000000-aaaa-aaaa-aaaa-000000000a01';
const PROJECT_B = '00000000-bbbb-bbbb-bbbb-000000000b02';

describe('MCP memory_audit — project_id required (no global leak)', () => {
  let pool: Pool;
  let storage: PgStorage;
  let manager: MemoryManager;
  let auditLogger: AuditLogger;
  let client: Client;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB });
    storage = new PgStorage(TEST_DB, 'simple');
    auditLogger = new AuditLogger(pool);
    manager = new MemoryManager(storage, auditLogger);
    await manager.initialize();

    await pool.query(
      `INSERT INTO projects (id, name, description) VALUES ($1, $2, $3), ($4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [PROJECT_A, 'mcp-audit-test-A', 'mcp audit test A',
       PROJECT_B, 'mcp-audit-test-B', 'mcp audit test B'],
    );

    const server = buildMcpServer(manager);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: 'audit-test-client', version: '0.0.1' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM audit_log WHERE project_id IN ($1, $2)`, [PROJECT_A, PROJECT_B]);
    await pool.query(`DELETE FROM projects WHERE id IN ($1, $2)`, [PROJECT_A, PROJECT_B]);
    await client.close();
    await manager.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM audit_log WHERE project_id IN ($1, $2)`, [PROJECT_A, PROJECT_B]);
    await auditLogger.log({ entryId: undefined, projectId: PROJECT_A, action: 'create', actor: 't', changes: { seed: 'a1' } });
    await auditLogger.log({ entryId: undefined, projectId: PROJECT_A, action: 'update', actor: 't', changes: { seed: 'a2' } });
    await auditLogger.log({ entryId: undefined, projectId: PROJECT_B, action: 'create', actor: 't', changes: { seed: 'b1' } });
    await auditLogger.log({ entryId: undefined, projectId: PROJECT_B, action: 'update', actor: 't', changes: { seed: 'b2' } });
    await auditLogger.log({ entryId: undefined, projectId: PROJECT_B, action: 'archive', actor: 't', changes: { seed: 'b3' } });
  });

  it('returns isError when neither project_id nor entry_id is given (no global leak)', async () => {
    const result = await client.callTool({
      name: 'memory_audit',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    // Result text must NOT contain leaked audit data
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(text).toMatch(/project_id.*или.*entry_id|entry_id.*или.*project_id/i);
    expect(text).not.toMatch(/seed.*a1|seed.*b1/);
  });

  it('returns only project A audit entries when project_id=A', async () => {
    const result = await client.callTool({
      name: 'memory_audit',
      arguments: { project_id: PROJECT_A },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(text).toContain('seed');
    expect(text).toMatch(/a1[\s\S]*a2|a2[\s\S]*a1/);
    expect(text).not.toMatch(/b1|b2|b3/);
  });
});
