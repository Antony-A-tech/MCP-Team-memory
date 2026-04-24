import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatStorage } from '../chat/storage.js';

function createMockPool() {
  return { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
}

describe('ChatStorage', () => {
  let storage: ChatStorage;
  let pool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    pool = createMockPool();
    storage = new ChatStorage(pool as any);
  });

  describe('createSession', () => {
    it('inserts row with agent_token_id and project_id', async () => {
      pool.query.mockResolvedValue({
        rows: [{
          id: 'sess-1',
          agent_token_id: 'tok-1',
          project_id: 'proj-1',
          title: 'Новый чат',
          title_is_user_set: false,
          onboard_injected: false,
          created_at: '2026-04-23T00:00:00Z',
          updated_at: '2026-04-23T00:00:00Z',
          archived_at: null,
        }],
        rowCount: 1,
      });

      const result = await storage.createSession({
        agentTokenId: 'tok-1',
        projectId: 'proj-1',
      });

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('INSERT INTO chat_sessions');
      expect(pool.query.mock.calls[0][1]).toEqual(['tok-1', 'proj-1', 'Новый чат', false]);
      expect(result.id).toBe('sess-1');
      expect(result.title).toBe('Новый чат');
    });
  });

  describe('listSessions', () => {
    it('filters by agent_token_id and excludes archived', async () => {
      pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
      await storage.listSessions('tok-1', { limit: 10, offset: 0 });
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('agent_token_id = $1');
      expect(sql).toContain('archived_at IS NULL');
    });

    it('adds project_id filter when provided', async () => {
      pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
      await storage.listSessions('tok-1', { projectId: 'proj-1', limit: 10, offset: 0 });
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('project_id = $2');
    });
  });
});
