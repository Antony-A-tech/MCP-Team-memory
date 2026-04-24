import { describe, it, expect, vi } from 'vitest';
import { RagAgent } from '../rag/agent.js';

function makeProvider(eventsByCall: any[][]) {
  let callIdx = 0;
  return {
    name: 'mock',
    isReady: () => true,
    async *stream(_input: any) {
      const events = eventsByCall[callIdx++] ?? [];
      for (const e of events) yield e;
    },
    generate: vi.fn(),
    close: vi.fn(),
  } as any;
}

function makeAdapter(toolResults: Record<string, unknown>) {
  return {
    declarations: [
      { name: 'memory_read', description: 'test', parameters: { type: 'object', properties: {} } },
      { name: 'memory_onboard', description: 'test', parameters: { type: 'object', properties: {} } },
    ],
    call: vi.fn().mockImplementation(async (name: string) => toolResults[name] ?? { ok: true }),
    callAsSerializedString: vi.fn().mockImplementation(async (name: string) => JSON.stringify(toolResults[name] ?? {})),
  } as any;
}

function makeChatManager() {
  return {
    appendMessage: vi.fn().mockResolvedValue({ id: 1 }),
    markOnboarded: vi.fn(),
    touch: vi.fn(),
    rollingWindow: (msgs: any[]) => msgs,
  } as any;
}

describe('RagAgent', () => {
  it('injects onboard into system on first run then marks onboard_injected', async () => {
    const provider = makeProvider([
      [{ type: 'text', delta: 'Hi' }, { type: 'done' }],
    ]);
    const adapter = makeAdapter({ memory_onboard: '# Context' });
    const chatManager = makeChatManager();
    const agent = new RagAgent({ provider, adapter, chatManager, maxIterations: 5 });

    const session = {
      id: 'sess-1', agentTokenId: 'tok', projectId: 'proj', title: 't',
      titleIsUserSet: false, onboardInjected: false,
      createdAt: '', updatedAt: '', archivedAt: null,
      messages: [],
    };

    const events: any[] = [];
    for await (const ev of agent.run(session as any, 'Hi')) events.push(ev);

    expect(adapter.call).toHaveBeenCalledWith('memory_onboard', expect.any(Object));
    expect(chatManager.markOnboarded).toHaveBeenCalledWith('sess-1');
    expect(events.map(e => e.type)).toEqual(['text', 'done']);
  });

  it('skips onboard when session.onboardInjected=true', async () => {
    const provider = makeProvider([
      [{ type: 'text', delta: 'ok' }, { type: 'done' }],
    ]);
    const adapter = makeAdapter({});
    const chatManager = makeChatManager();
    const agent = new RagAgent({ provider, adapter, chatManager, maxIterations: 5 });

    const session = {
      id: 'sess-1', agentTokenId: 'tok', projectId: 'proj', title: 't',
      titleIsUserSet: false, onboardInjected: true,
      createdAt: '', updatedAt: '', archivedAt: null,
      messages: [{ role: 'system', content: 'already-onboarded' }],
    };

    for await (const _ of agent.run(session as any, 'Hi')) { /* drain */ }
    expect(adapter.call).not.toHaveBeenCalledWith('memory_onboard', expect.anything());
  });

  it('executes tool calls and loops back to model', async () => {
    const provider = makeProvider([
      [{ type: 'tool_call', call: { id: 'c1', name: 'memory_read', args: { search: 'foo' } } }, { type: 'done' }],
      [{ type: 'text', delta: 'Found 1 record' }, { type: 'done' }],
    ]);
    const adapter = makeAdapter({ memory_read: [{ id: 'e1', title: 'Foo' }] });
    const chatManager = makeChatManager();
    const agent = new RagAgent({ provider, adapter, chatManager, maxIterations: 5 });

    const session = {
      id: 'sess-1', agentTokenId: 'tok', projectId: 'proj', title: 't',
      titleIsUserSet: false, onboardInjected: true,
      createdAt: '', updatedAt: '', archivedAt: null,
      messages: [{ role: 'system', content: 'sys' }],
    };
    const events: any[] = [];
    for await (const ev of agent.run(session as any, 'Find foo')) events.push(ev);
    expect(events.map(e => e.type)).toEqual(['tool_start', 'tool_end', 'text', 'done']);
    expect((events[0] as any).name).toBe('memory_read');
  });

  it('emits max_iterations error when exceeding limit', async () => {
    const loopingEvents = Array.from({ length: 10 }, () => [
      { type: 'tool_call', call: { id: 'c', name: 'memory_read', args: {} } },
      { type: 'done' },
    ]);
    const provider = makeProvider(loopingEvents);
    const adapter = makeAdapter({ memory_read: [] });
    const chatManager = makeChatManager();
    const agent = new RagAgent({ provider, adapter, chatManager, maxIterations: 3 });

    const session = {
      id: 'sess-1', agentTokenId: 'tok', projectId: 'proj', title: 't',
      titleIsUserSet: false, onboardInjected: true,
      createdAt: '', updatedAt: '', archivedAt: null,
      messages: [{ role: 'system', content: 'sys' }],
    };
    const events: any[] = [];
    for await (const ev of agent.run(session as any, 'Find')) events.push(ev);
    const last = events[events.length - 1];
    expect(last.type).toBe('error');
    expect((last as any).code).toBe('max_iterations');
  });
});
