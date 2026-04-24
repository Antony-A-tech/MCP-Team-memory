import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatManager } from '../chat/manager.js';
import type { ChatStorage } from '../chat/storage.js';

function createMockStorage(): ChatStorage {
  return {
    createSession: vi.fn(),
    getSession: vi.fn(),
    listSessions: vi.fn(),
    renameSession: vi.fn(),
    updateAutoTitle: vi.fn(),
    markOnboarded: vi.fn(),
    deleteSession: vi.fn(),
    touchSession: vi.fn(),
    appendMessage: vi.fn(),
    listMessages: vi.fn(),
  } as any;
}

describe('ChatManager', () => {
  let manager: ChatManager;
  let storage: ChatStorage;

  beforeEach(() => {
    storage = createMockStorage();
    manager = new ChatManager(storage);
  });

  describe('create', () => {
    it('delegates to storage', async () => {
      (storage.createSession as any).mockResolvedValue({ id: 'sess-1' });
      const result = await manager.create({ agentTokenId: 'tok', projectId: 'proj' });
      expect(storage.createSession).toHaveBeenCalledWith({ agentTokenId: 'tok', projectId: 'proj', title: undefined });
      expect(result.id).toBe('sess-1');
    });
  });

  describe('loadSessionWithMessages', () => {
    it('returns null when session not found or not owned by token', async () => {
      (storage.getSession as any).mockResolvedValue(null);
      const result = await manager.loadSessionWithMessages('sess-1', 'tok-1');
      expect(result).toBeNull();
      expect(storage.listMessages).not.toHaveBeenCalled();
    });

    it('returns session with filtered orphan tool messages', async () => {
      (storage.getSession as any).mockResolvedValue({
        id: 'sess-1', agentTokenId: 'tok-1', projectId: null, title: 't',
        titleIsUserSet: false, onboardInjected: false,
        createdAt: '', updatedAt: '', archivedAt: null,
      });
      (storage.listMessages as any).mockResolvedValue([
        { id: 1, role: 'user', content: 'Hi' },
        { id: 2, role: 'tool', content: '{}', toolCallId: 'missing' }, // orphan — no preceding assistant with this id
        { id: 3, role: 'assistant', content: 'Hey', toolCalls: [{ id: 'c1', name: 'x', args: {} }] },
        { id: 4, role: 'tool', content: '{}', toolCallId: 'c1', toolName: 'x' }, // valid — matches id:3
      ]);
      const result = await manager.loadSessionWithMessages('sess-1', 'tok-1');
      expect(result?.messages.map(m => m.id)).toEqual([1, 3, 4]);
    });
  });

  describe('rollingWindow', () => {
    it('keeps system + last 30 non-system messages', () => {
      const system = { role: 'system', content: 's' };
      const many = Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `msg ${i}`,
      }));
      const all = [system, ...many];
      const window = manager.rollingWindow(all as any);
      expect(window.length).toBe(31);
      expect(window[0].role).toBe('system');
      expect(window[1].content).toBe('msg 10');
      expect(window[30].content).toBe('msg 39');
    });

    it('returns all when under window size', () => {
      const msgs = [
        { role: 'system', content: 's' },
        { role: 'user', content: 'hi' },
      ];
      expect(manager.rollingWindow(msgs as any).length).toBe(2);
    });
  });
});
