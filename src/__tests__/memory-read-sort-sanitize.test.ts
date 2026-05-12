// src/__tests__/memory-read-sort-sanitize.test.ts
//
// Unit test for the public-output sanitizer that strips internal IDs from
// `personal_note` evidence sources (since note IDs leak owner identity by
// joining against the personal_notes table).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import { sanitizeEvidenceSourcesForPublic } from '../memory/manager.js';
import { DEFAULT_PROJECT_ID } from '../memory/types.js';

const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  'postgres://memory:memory@localhost:5432/team_memory_test';

describe('sanitizeEvidenceSourcesForPublic', () => {
  it('strips id from personal_note evidence but keeps shared_by', () => {
    const out = sanitizeEvidenceSourcesForPublic([
      {
        type: 'personal_note',
        id: 'note-uuid',
        shared_by: 'agent-uuid',
        confirmed_at: '2026-04-28T00:00:00Z',
      },
      {
        type: 'session',
        id: 'sess-uuid',
        agent_token_id: 'agent-uuid',
        confirmed_at: '2026-04-28T00:00:00Z',
      },
    ]);
    expect(out[0]).toEqual({
      type: 'personal_note',
      shared_by: 'agent-uuid',
      confirmed_at: '2026-04-28T00:00:00Z',
    });
    // Non-personal_note entries are kept untouched
    expect(out[1]).toEqual({
      type: 'session',
      id: 'sess-uuid',
      agent_token_id: 'agent-uuid',
      confirmed_at: '2026-04-28T00:00:00Z',
    });
  });

  it('returns [] for empty/undefined inputs', () => {
    expect(sanitizeEvidenceSourcesForPublic(undefined)).toEqual([]);
    expect(sanitizeEvidenceSourcesForPublic([])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [
      {
        type: 'personal_note' as const,
        id: 'note-uuid',
        shared_by: 'agent-uuid',
        confirmed_at: '2026-04-28T00:00:00Z',
      },
    ];
    const out = sanitizeEvidenceSourcesForPublic(input);
    expect(input[0].id).toBe('note-uuid');
    expect((out[0] as { id?: string }).id).toBeUndefined();
  });
});

describe('MemoryManager.update — public-output sanitization', () => {
  let pool: Pool;
  let storage: PgStorage;
  let manager: MemoryManager;
  const cleanupIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB });
    storage = new PgStorage(TEST_DB, 'simple');
    manager = new MemoryManager(storage);
    await manager.initialize();
  });

  afterAll(async () => {
    if (cleanupIds.length > 0) {
      await pool.query(`DELETE FROM entries WHERE id = ANY($1::uuid[])`, [cleanupIds]);
    }
    await manager.close();
    await pool.end();
  });

  it('strips personal_note id from update() return value', async () => {
    const created = await manager.write({
      projectId: DEFAULT_PROJECT_ID,
      category: 'decisions',
      title: 'sanitize-update-test',
      content: 'initial',
      tags: ['t'],
    });
    cleanupIds.push(created.id);

    // Seed evidence_sources directly: write() doesn't accept the field yet.
    const evidence = [
      {
        type: 'personal_note',
        id: 'leak-id-should-be-stripped',
        shared_by: 'agent-A',
        confirmed_at: '2026-04-28T00:00:00Z',
      },
      {
        type: 'session',
        id: 'sess-keep',
        agent_token_id: 'agent-A',
        confirmed_at: '2026-04-28T00:00:00Z',
      },
    ];
    await pool.query(
      `UPDATE entries SET evidence_sources = $1::jsonb WHERE id = $2`,
      [JSON.stringify(evidence), created.id],
    );

    const updated = await manager.update({
      id: created.id,
      content: 'updated content',
    });
    if (updated && 'conflict' in updated) {
      throw new Error('unexpected conflict on update');
    }
    expect(updated).not.toBeNull();
    const sources = updated!.evidenceSources;
    expect(sources).toBeDefined();
    expect(sources!.length).toBe(2);
    const note = sources!.find(s => s.type === 'personal_note');
    const sess = sources!.find(s => s.type === 'session');
    expect((note as { id?: string }).id).toBeUndefined();
    expect(note!.shared_by).toBe('agent-A');
    expect(sess!.id).toBe('sess-keep');
  });
});
