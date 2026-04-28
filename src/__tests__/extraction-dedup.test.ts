// src/__tests__/extraction-dedup.test.ts
//
// Unit tests for DedupResolver branching at the cosine-similarity boundaries
// 0.7 (MERGE) and 0.85 (CONFIRM). Embedding provider and vector store are
// fully mocked so we can pin the score returned by the search.

import { describe, it, expect, vi } from 'vitest';
import { DedupResolver } from '../extraction/dedup.js';
import type { CandidateNote } from '../extraction/types.js';

function mockProvider() {
  return {
    isReady: () => true,
    dimensions: 768,
    embed: vi.fn(async () => Array(768).fill(0)),
    embedBatch: vi.fn(async () => []),
    close: vi.fn(),
  };
}

function mockStore(score: number) {
  return {
    search: vi.fn(async () =>
      score >= 0
        ? [{ id: 'existing-id', score, payload: {} as Record<string, unknown> }]
        : [],
    ),
    upsert: vi.fn(),
    upsertBatch: vi.fn(),
    delete: vi.fn(),
    deleteByFilter: vi.fn(),
    setPayload: vi.fn(),
    ensureCollection: vi.fn(),
    createPayloadIndex: vi.fn(),
    getPointCount: vi.fn(),
    collectionExists: vi.fn(),
    close: vi.fn(),
  };
}

const candidate: CandidateNote = {
  category: 'decisions',
  title: 'JWT refresh',
  fact: 'Auth uses JWT plus 7-day refresh tokens for revocation.',
  why: 'Cross-domain rejected cookie sessions.',
  tags: ['auth'],
  confidence: 0.9,
  explicit_marker_strength: 0.8,
};

describe('DedupResolver', () => {
  it('cos > 0.85 → CONFIRM', async () => {
    const r = new DedupResolver(
      mockProvider() as never,
      mockStore(0.9) as never,
    );
    const out = await r.resolve('proj', [candidate]);
    expect(out.decisions[0].type).toBe('CONFIRM');
    if (out.decisions[0].type === 'CONFIRM') {
      expect(out.decisions[0].entry_id).toBe('existing-id');
      expect(out.decisions[0].score).toBeCloseTo(0.9);
    }
  });

  it('0.7 ≤ cos ≤ 0.85 → MERGE', async () => {
    const r = new DedupResolver(
      mockProvider() as never,
      mockStore(0.78) as never,
    );
    const out = await r.resolve('proj', [candidate]);
    expect(out.decisions[0].type).toBe('MERGE');
  });

  it('cos < 0.7 → CREATE_NEW', async () => {
    const r = new DedupResolver(
      mockProvider() as never,
      mockStore(0.5) as never,
    );
    const out = await r.resolve('proj', [candidate]);
    expect(out.decisions[0].type).toBe('CREATE_NEW');
  });

  it('exact 0.85 boundary → MERGE (not CONFIRM)', async () => {
    const r = new DedupResolver(
      mockProvider() as never,
      mockStore(0.85) as never,
    );
    const out = await r.resolve('proj', [candidate]);
    expect(out.decisions[0].type).toBe('MERGE');
  });

  it('exact 0.7 boundary → MERGE (not CREATE_NEW)', async () => {
    const r = new DedupResolver(
      mockProvider() as never,
      mockStore(0.7) as never,
    );
    const out = await r.resolve('proj', [candidate]);
    expect(out.decisions[0].type).toBe('MERGE');
  });

  it('no matches → CREATE_NEW', async () => {
    const r = new DedupResolver(
      mockProvider() as never,
      mockStore(-1) as never,
    );
    const out = await r.resolve('proj', [candidate]);
    expect(out.decisions[0].type).toBe('CREATE_NEW');
  });

  it('search filter pins project_id and category', async () => {
    const provider = mockProvider();
    const store = mockStore(0.5);
    const r = new DedupResolver(provider as never, store as never);
    await r.resolve('proj-X', [candidate]);
    const callArgs = store.search.mock.calls[0];
    const filter = callArgs[2] as {
      must: Array<{ key: string; match: { value: string } }>;
    };
    const projCond = filter.must.find(c => c.key === 'project_id');
    const catCond = filter.must.find(c => c.key === 'category');
    expect(projCond?.match.value).toBe('proj-X');
    expect(catCond?.match.value).toBe('decisions');
  });
});
