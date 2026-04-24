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
