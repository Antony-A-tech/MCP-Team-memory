import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaEmbeddingProvider } from '../embedding/ollama.js';

function mockResponse(init: { ok?: boolean; status?: number; body?: unknown; text?: string }): Response {
  const ok = init.ok ?? (init.status ?? 200) < 400;
  const status = init.status ?? (ok ? 200 : 400);
  return {
    ok,
    status,
    json: async () => init.body ?? {},
    text: async () => init.text ?? JSON.stringify(init.body ?? ''),
  } as unknown as Response;
}

describe('OllamaEmbeddingProvider.embedBatch — HTTP 400 fallback', () => {
  let provider: OllamaEmbeddingProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = new OllamaEmbeddingProvider('http://localhost:11434');
    // Mark as ready without running initialize() so we don't need to mock the
    // health/pull/test-embed round-trip.
    (provider as unknown as { ready: boolean }).ready = true;
    (provider as unknown as { dimensions: number }).dimensions = 4;

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to per-text embedding when batch call returns 400', async () => {
    const vec = (fill: number) => new Array(4).fill(fill);

    fetchMock
      // First call: batch request for both texts → 400
      .mockResolvedValueOnce(mockResponse({ status: 400, text: 'input length exceeds context length' }))
      // Fallback: two per-text requests succeed
      .mockResolvedValueOnce(mockResponse({ body: { embeddings: [vec(0.1)] } }))
      .mockResolvedValueOnce(mockResponse({ body: { embeddings: [vec(0.2)] } }));

    const result = await provider.embedBatch(['short ok text', 'another short text']);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(vec(0.1));
    expect(result[1]).toEqual(vec(0.2));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('substitutes a zero-vector for an individual text that still fails in fallback', async () => {
    const vec = (fill: number) => new Array(4).fill(fill);

    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 400, text: 'input length exceeds context length' }))
      .mockResolvedValueOnce(mockResponse({ body: { embeddings: [vec(0.3)] } }))
      // Second per-text call fails even with truncate:true
      .mockResolvedValueOnce(mockResponse({ status: 400, text: 'still too long somehow' }));

    const result = await provider.embedBatch(['ok text', 'broken text']);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(vec(0.3));
    // Zero-vector placeholder, matches provider.dimensions
    expect(result[1]).toEqual(new Array(4).fill(0));
  });

  it('propagates non-400 errors (does NOT trigger fallback on 500)', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 500, text: 'internal error' }));

    await expect(provider.embedBatch(['a text'])).rejects.toThrow(/Ollama embed error 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('substitutes zero-vectors for every text when fallback fails for all of them', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 400, text: 'too long' }))
      .mockResolvedValueOnce(mockResponse({ status: 400, text: 'still too long' }))
      .mockResolvedValueOnce(mockResponse({ status: 400, text: 'still too long' }));

    const result = await provider.embedBatch(['a', 'b']);

    // Length must match input to preserve the index-zip contract used by callers.
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(new Array(4).fill(0));
    expect(result[1]).toEqual(new Array(4).fill(0));
  });

  it('substitutes a zero-vector when a thrown (non-abort) fetch error occurs in fallback', async () => {
    const vec = (fill: number) => new Array(4).fill(fill);

    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 400, text: 'too long' }))
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce(mockResponse({ body: { embeddings: [vec(0.7)] } }));

    const result = await provider.embedBatch(['bad', 'good']);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(new Array(4).fill(0));
    expect(result[1]).toEqual(vec(0.7));
  });

  it('rethrows TimeoutError / AbortError from fallback rather than masking it as zero-vector', async () => {
    const timeoutErr = new Error('request timed out');
    timeoutErr.name = 'TimeoutError';

    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 400, text: 'too long' }))
      .mockRejectedValueOnce(timeoutErr);

    await expect(provider.embedBatch(['anything'])).rejects.toThrow(/timed out/);
  });

  it('continues to later sub-batches after a 400 in an earlier sub-batch', async () => {
    // Force splitting into two sub-batches by using > 50 texts.
    const vec = (fill: number) => new Array(4).fill(fill);
    const texts = Array.from({ length: 51 }, (_, i) => `text-${i}`);

    // Sub-batch 1 (50 texts): 400 → 50 fallback calls (all succeed)
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 400, text: 'too long' }));
    for (let i = 0; i < 50; i++) {
      fetchMock.mockResolvedValueOnce(mockResponse({ body: { embeddings: [vec(0.5)] } }));
    }
    // Sub-batch 2 (1 text): normal path succeeds
    fetchMock.mockResolvedValueOnce(mockResponse({ body: { embeddings: [vec(0.9)] } }));

    const result = await provider.embedBatch(texts);

    expect(result).toHaveLength(51);
    expect(result[0]).toEqual(vec(0.5));
    expect(result[49]).toEqual(vec(0.5));
    expect(result[50]).toEqual(vec(0.9));
    // 1 batch + 50 fallback + 1 batch
    expect(fetchMock).toHaveBeenCalledTimes(52);
  });
});
