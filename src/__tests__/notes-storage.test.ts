import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PersonalNotesStorage } from '../notes/storage.js';

function createMockPool() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  };
}

describe('PersonalNotesStorage', () => {
  let storage: PersonalNotesStorage;
  let pool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    pool = createMockPool();
    storage = new PersonalNotesStorage(pool as any);
  });

  describe('create', () => {
    it('inserts note with agent_token_id', async () => {
      pool.query.mockResolvedValue({
        rows: [{
          id: 'note-1', agent_token_id: 'token-1', title: 'My note', content: 'Content',
          tags: ['test'], priority: 'medium', status: 'active', project_id: null,
          session_id: null, created_at: '2026-01-01', updated_at: '2026-01-01',
        }],
        rowCount: 1,
      });

      const result = await storage.create({
        agentTokenId: 'token-1',
        title: 'My note',
        content: 'Content',
        tags: ['test'],
        priority: 'medium',
        projectId: null,
        sessionId: null,
      });

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('INSERT INTO personal_notes');
      expect(sql).toContain('agent_token_id');
      expect(result.id).toBe('note-1');
      expect(result.agentTokenId).toBe('token-1');
    });
  });

  describe('getAll', () => {
    it('always filters by agent_token_id', async () => {
      await storage.getAll('token-1', {});

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('agent_token_id = $1');
      expect(pool.query.mock.calls[0][1]![0]).toBe('token-1');
    });

    it('allows master token to see all notes (null agentTokenId)', async () => {
      await storage.getAll(null, {});

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).not.toContain('agent_token_id = $1');
    });

    it('filters by project_id when provided', async () => {
      await storage.getAll('token-1', { projectId: 'proj-1' });

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('project_id');
    });

    it('returns compact by default', async () => {
      pool.query.mockResolvedValue({
        rows: [{ id: 'n1', agent_token_id: 't1', title: 'T', tags: [], priority: 'medium', status: 'active', updated_at: '2026-01-01', project_id: null, session_id: null }],
        rowCount: 1,
      });

      const results = await storage.getAll('t1', {});

      expect(results[0]).not.toHaveProperty('content');
    });
  });

  describe('update', () => {
    it('verifies ownership before updating', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ agent_token_id: 'token-1' }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{ id: 'note-1', agent_token_id: 'token-1', title: 'Updated', content: 'C', tags: [], priority: 'medium', status: 'active', project_id: null, session_id: null, created_at: '2026-01-01', updated_at: '2026-01-01' }],
          rowCount: 1,
        });

      await storage.update('note-1', 'token-1', { title: 'Updated' });

      const ownershipSql = pool.query.mock.calls[0][0] as string;
      expect(ownershipSql).toContain('agent_token_id');
    });

    it('throws on ownership mismatch', async () => {
      pool.query.mockResolvedValue({ rows: [{ agent_token_id: 'other-token' }], rowCount: 1 });

      await expect(
        storage.update('note-1', 'token-1', { title: 'Hack' }),
      ).rejects.toThrow(/access denied/i);
    });
  });

  describe('delete', () => {
    it('verifies ownership before deleting', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ agent_token_id: 'token-1' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await storage.delete('note-1', 'token-1', false);

      expect(pool.query).toHaveBeenCalledTimes(2);
    });

    it('throws on ownership mismatch', async () => {
      pool.query.mockResolvedValue({ rows: [{ agent_token_id: 'other' }], rowCount: 1 });

      await expect(
        storage.delete('note-1', 'token-1', false),
      ).rejects.toThrow(/access denied/i);
    });

    it('archives instead of deleting by default', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ agent_token_id: 'token-1' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await storage.delete('note-1', 'token-1', true);

      const archiveSql = pool.query.mock.calls[1][0] as string;
      expect(archiveSql).toContain('archived');
    });
  });
});
