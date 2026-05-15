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

  it('throws when an individual text still fails in per-item fallback (5.C: no zero-vector)', async () => {
    const vec = (fill: number) => new Array(4).fill(fill);

    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 400, text: 'input length exceeds context length' }))
      .mockResolvedValueOnce(mockResponse({ body: { embeddings: [vec(0.3)] } }))
      // Second per-text call fails even with truncate:true → must throw, not zero-vector
      .mockResolvedValueOnce(mockResponse({ status: 400, text: 'still too long somehow' }));

    await expect(provider.embedBatch(['ok text', 'broken text'])).rejects.toThrow(/Ollama embed failed for batch index 1/);
  });

  it('propagates non-400 errors (does NOT trigger fallback on 500)', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ status: 500, text: 'internal error' }));

    await expect(provider.embedBatch(['a text'])).rejects.toThrow(/Ollama embed error 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when fallback fails for every text (5.C: no zero-vector substitution)', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 400, text: 'too long' }))
      .mockResolvedValueOnce(mockResponse({ status: 400, text: 'still too long' }))
      .mockResolvedValueOnce(mockResponse({ status: 400, text: 'still too long' }));

    // First per-item failure (index 0) aborts the batch; caller treats the
    // whole input as un-embeddable and decides what to do (e.g., CREATE_NEW
    // for dedup candidates) rather than silently corrupting comparisons.
    await expect(provider.embedBatch(['a', 'b'])).rejects.toThrow(/Ollama embed failed for batch index 0/);
  });

  it('throws on a non-timeout fetch error in fallback (5.C: no zero-vector)', async () => {
    fetchMock
      .mockResolvedValueOnce(mockResponse({ status: 400, text: 'too long' }))
      .mockRejectedValueOnce(new Error('network blip'));

    await expect(provider.embedBatch(['bad', 'good'])).rejects.toThrow(/network blip/);
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
