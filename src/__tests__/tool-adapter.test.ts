import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpToolAdapter } from '../rag/tool-adapter.js';

function makeManagers() {
  return {
    memoryManager: {
      generateOnboarding: vi.fn().mockResolvedValue('# Onboarding'),
      read: vi.fn().mockResolvedValue([]),
      crossSearch: vi.fn().mockResolvedValue([]),
      sync: vi.fn().mockResolvedValue({ changes: [] }),
    },
    notesManager: {
      read: vi.fn().mockResolvedValue([]),
      semanticSearch: vi.fn().mockResolvedValue([]),
    },
    sessionManager: {
      listSessions: vi.fn().mockResolvedValue([]),
      searchSessions: vi.fn().mockResolvedValue([]),
      searchMessages: vi.fn().mockResolvedValue([]),
      readSession: vi.fn().mockResolvedValue({}),
    },
  } as any;
}

describe('McpToolAdapter', () => {
  let managers: any;
  let adapter: McpToolAdapter;

  beforeEach(() => {
    managers = makeManagers();
    adapter = new McpToolAdapter(managers, { agentTokenId: 'tok-1', projectId: 'proj-1', toolResponseMaxChars: 5000 });
  });

  it('forces project_id from session, ignoring LLM-provided value', async () => {
    await adapter.call('memory_read', { search: 'x', project_id: 'EVIL-OTHER-PROJECT' });
    const [firstCallArgs] = managers.memoryManager.read.mock.calls[0];
    expect(firstCallArgs.projectId).toBe('proj-1');
  });

  it('forces exclude_project_id=session for memory_cross_search', async () => {
    await adapter.call('memory_cross_search', { query: 'foo' });
    const [, filters] = managers.memoryManager.crossSearch.mock.calls[0];
    expect(filters.excludeProjectId).toBe('proj-1');
  });

  it('throws unknown_tool for unknown name', async () => {
    await expect(adapter.call('bogus', {})).rejects.toThrow(/unknown_tool/);
  });

  it('truncates tool response to toolResponseMaxChars', async () => {
    const longArray = Array.from({ length: 100 }, (_, i) => ({ id: i, text: 'x'.repeat(100) }));
    managers.memoryManager.read.mockResolvedValue(longArray);
    const result = await adapter.callAsSerializedString('memory_read', {});
    expect(result.length).toBeLessThanOrEqual(5000 + 50);
    expect(result).toContain('[truncated]');
  });

  it('returns declarations from registry', () => {
    const decls = adapter.declarations;
    expect(decls.length).toBe(12);
    expect(decls.every(d => !('project_id' in ((d.parameters as any).properties ?? {})))).toBe(true);
  });
});
