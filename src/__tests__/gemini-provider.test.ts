import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiChatProvider } from '../llm/gemini.js';

describe('GeminiChatProvider.generate', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('calls generateContent endpoint and returns text', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      }),
    });

    const provider = new GeminiChatProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    const result = await provider.generate({ prompt: 'Hi', maxTokens: 50 });

    expect(result).toBe('Hello');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('gemini-2.5-flash:generateContent');
    expect(url).toContain('key=k');
    const body = JSON.parse((init as any).body);
    expect(body.contents[0].parts[0].text).toBe('Hi');
    expect(body.generationConfig.maxOutputTokens).toBe(50);
  });

  it('throws api_key_invalid on 401', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' });
    const provider = new GeminiChatProvider({ apiKey: 'bad', model: 'gemini-2.5-flash' });
    await expect(provider.generate({ prompt: 'x' })).rejects.toThrow(/api_key_invalid/);
  });

  it('throws rate_limited on 429', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => 'Quota exceeded' });
    const provider = new GeminiChatProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    await expect(provider.generate({ prompt: 'x' })).rejects.toThrow(/rate_limited/);
  });

  it('throws upstream_error on 500', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'oops' });
    const provider = new GeminiChatProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    await expect(provider.generate({ prompt: 'x' })).rejects.toThrow(/upstream_error/);
  });
});

describe('GeminiChatProvider lifecycle', () => {
  it('isReady returns true when apiKey set', () => {
    const provider = new GeminiChatProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    expect(provider.isReady()).toBe(true);
    expect(provider.name).toBe('gemini-2.5-flash');
  });

  it('isReady returns false when apiKey missing', () => {
    const provider = new GeminiChatProvider({ apiKey: '', model: 'gemini-2.5-flash' });
    expect(provider.isReady()).toBe(false);
  });
});

describe('GeminiChatProvider.stream', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function mockSseResponse(chunks: string[]) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return { ok: true, status: 200, body: stream } as any;
  }

  it('parses text deltas from SSE stream', async () => {
    const chunks = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n',
      'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\n\n',
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(mockSseResponse(chunks)) as any;

    const provider = new GeminiChatProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    const events: any[] = [];
    for await (const ev of provider.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
      events.push(ev);
    }
    expect(events.filter(e => e.type === 'text').map(e => e.delta).join('')).toBe('Hello');
    expect(events[events.length - 1].type).toBe('done');
  });

  it('parses functionCall events', async () => {
    const chunks = [
      `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"memory_read","args":{"search":"foo"}}}]}}]}\n\n`,
      `data: {"candidates":[{"finishReason":"STOP"}]}\n\n`,
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(mockSseResponse(chunks)) as any;

    const provider = new GeminiChatProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    const events: any[] = [];
    for await (const ev of provider.stream({ messages: [{ role: 'user', content: 'Find foo' }] })) {
      events.push(ev);
    }
    const toolCall = events.find(e => e.type === 'tool_call');
    expect(toolCall).toBeDefined();
    expect(toolCall.call.name).toBe('memory_read');
    expect(toolCall.call.args).toEqual({ search: 'foo' });
    expect(typeof toolCall.call.id).toBe('string');
  });

  it('emits safety_block when finishReason is SAFETY', async () => {
    const chunks = [`data: {"candidates":[{"finishReason":"SAFETY"}]}\n\n`];
    globalThis.fetch = vi.fn().mockResolvedValue(mockSseResponse(chunks)) as any;
    const provider = new GeminiChatProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    const events: any[] = [];
    for await (const ev of provider.stream({ messages: [{ role: 'user', content: 'x' }] })) events.push(ev);
    expect(events.some(e => e.type === 'error' && e.code === 'safety_block')).toBe(true);
  });

  it('converts role=tool into functionResponse in request body', async () => {
    const chunks = [`data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}, "finishReason":"STOP"}]}\n\n`];
    const fetchMock = vi.fn().mockResolvedValue(mockSseResponse(chunks));
    globalThis.fetch = fetchMock as any;
    const provider = new GeminiChatProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });

    for await (const _ of provider.stream({
      messages: [
        { role: 'user', content: 'Find' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'memory_read', args: {} }] },
        { role: 'tool', content: '[]', toolCallId: 'c1', toolName: 'memory_read' },
      ],
    })) { /* consume */ }

    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const lastContent = body.contents[body.contents.length - 1];
    expect(lastContent.role).toBe('user');
    expect(lastContent.parts[0].functionResponse.name).toBe('memory_read');
  });
});
