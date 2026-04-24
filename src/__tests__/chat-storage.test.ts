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

  describe('renameSession', () => {
    it('updates title and sets title_is_user_set=true', async () => {
      pool.query.mockResolvedValue({ rowCount: 1 });
      await storage.renameSession('sess-1', 'tok-1', 'My chat');
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('UPDATE chat_sessions');
      expect(sql).toContain('title = $3');
      expect(sql).toContain('title_is_user_set = TRUE');
      expect(pool.query.mock.calls[0][1]).toEqual(['sess-1', 'tok-1', 'My chat']);
    });
  });

  describe('markOnboarded', () => {
    it('sets onboard_injected=true', async () => {
      pool.query.mockResolvedValue({ rowCount: 1 });
      await storage.markOnboarded('sess-1');
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('onboard_injected = TRUE');
    });
  });

  describe('softDeleteSession', () => {
    it('sets archived_at=NOW()', async () => {
      pool.query.mockResolvedValue({ rowCount: 1 });
      await storage.softDeleteSession('sess-1', 'tok-1');
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('archived_at = NOW()');
      expect(sql).toContain('agent_token_id = $2');
    });
  });

  describe('touchSession', () => {
    it('updates updated_at=NOW()', async () => {
      pool.query.mockResolvedValue({ rowCount: 1 });
      await storage.touchSession('sess-1');
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('updated_at = NOW()');
    });
  });

  describe('appendMessage', () => {
    it('inserts user message with null tool fields', async () => {
      pool.query.mockResolvedValue({
        rows: [{
          id: 1, session_id: 'sess-1', role: 'user', content: 'Hi',
          tool_calls: null, tool_call_id: null, tool_name: null,
          created_at: '2026-04-23T00:00:00Z',
        }],
      });
      const result = await storage.appendMessage('sess-1', {
        role: 'user',
        content: 'Hi',
      });
      expect(result.id).toBe(1);
      expect(result.role).toBe('user');
      const params = pool.query.mock.calls[0][1];
      expect(params[0]).toBe('sess-1');
      expect(params[1]).toBe('user');
      expect(params[3]).toBeNull();
    });

    it('serializes tool_calls JSONB for assistant message', async () => {
      pool.query.mockResolvedValue({
        rows: [{
          id: 2, session_id: 'sess-1', role: 'assistant', content: 'Let me check',
          tool_calls: [{ id: 'c1', name: 'memory_read', args: {} }],
          tool_call_id: null, tool_name: null,
          created_at: '2026-04-23T00:00:00Z',
        }],
      });
      await storage.appendMessage('sess-1', {
        role: 'assistant',
        content: 'Let me check',
        toolCalls: [{ id: 'c1', name: 'memory_read', args: {} }],
      });
      const params = pool.query.mock.calls[0][1];
      expect(JSON.parse(params[3] as string)).toEqual([{ id: 'c1', name: 'memory_read', args: {} }]);
    });

    it('stores tool_call_id and tool_name for tool message', async () => {
      pool.query.mockResolvedValue({
        rows: [{
          id: 3, session_id: 'sess-1', role: 'tool', content: '{}',
          tool_calls: null, tool_call_id: 'c1', tool_name: 'memory_read',
          created_at: '2026-04-23T00:00:00Z',
        }],
      });
      await storage.appendMessage('sess-1', {
        role: 'tool',
        content: '{}',
        toolCallId: 'c1',
        toolName: 'memory_read',
      });
      const params = pool.query.mock.calls[0][1];
      expect(params[4]).toBe('c1');
      expect(params[5]).toBe('memory_read');
    });
  });

  describe('listMessages', () => {
    it('orders by id ascending', async () => {
      pool.query.mockResolvedValue({ rows: [] });
      await storage.listMessages('sess-1');
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('session_id = $1');
      expect(sql).toContain('ORDER BY id ASC');
    });
  });
});
