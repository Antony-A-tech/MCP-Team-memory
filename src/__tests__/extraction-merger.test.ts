// src/__tests__/extraction-merger.test.ts
//
// Unit tests for NoteMerger: LLM-based atomic merge that combines an existing
// entry with a new candidate. The provider is mocked.

import { describe, it, expect, vi } from 'vitest';
import { NoteMerger } from '../extraction/merger.js';
import type { ExtractionLlmProvider } from '../extraction/llm-provider.js';
import type { CandidateNote } from '../extraction/types.js';

function fakeProvider(responses: string[]): ExtractionLlmProvider {
  let i = 0;
  return {
    name: 'fake',
    isReady: () => true,
    generate: vi.fn(async () => responses[i++] ?? responses[responses.length - 1]),
  };
}

const candidate: CandidateNote = {
  category: 'decisions',
  title: 'New title',
  fact: 'New fact about JWT refresh tokens',
  why: 'New rationale',
  tags: ['new', 'jwt'],
  confidence: 1,
  explicit_marker_strength: 1,
};

describe('NoteMerger', () => {
  it('parses provider JSON and unions tags', async () => {
    const provider = fakeProvider([
      JSON.stringify({
        title: 'Merged title',
        fact: 'Merged fact under 500 chars',
        why: 'Merged why',
        tags: ['merged', 'a'],
      }),
    ]);
    const m = new NoteMerger(provider);
    const out = await m.merge(
      { title: 'Old', content: 'Old fact', tags: ['old'] },
      candidate,
    );
    expect(out.title).toBe('Merged title');
    expect(out.tags).toEqual(expect.arrayContaining(['merged', 'a', 'old', 'new', 'jwt']));
    expect(out.fact.length).toBeLessThanOrEqual(500);
  });

  it('truncates fact to 500 chars even if LLM emits longer', async () => {
    const longFact = 'x'.repeat(800);
    const provider = fakeProvider([
      JSON.stringify({
        title: 't',
        fact: longFact,
        why: 'y',
        tags: ['a'],
      }),
    ]);
    const m = new NoteMerger(provider);
    const out = await m.merge(
      { title: 'Old', content: 'Old fact', tags: [] },
      candidate,
    );
    expect(out.fact.length).toBe(500);
  });

  it('falls back to candidate fields when LLM returns malformed JSON', async () => {
    const provider = fakeProvider(['not even close to JSON']);
    const m = new NoteMerger(provider);
    const out = await m.merge(
      { title: 'Old', content: 'Old fact', tags: ['old'] },
      candidate,
    );
    expect(out.title).toBe(candidate.title);
    expect(out.fact).toBe(candidate.fact);
    // Tags still combined for the fallback path
    expect(out.tags).toEqual(expect.arrayContaining(['old', 'new', 'jwt']));
  });

  it('canMerge respects per-session counter limit', () => {
    expect(NoteMerger.canMerge(0, 3)).toBe(true);
    expect(NoteMerger.canMerge(2, 3)).toBe(true);
    expect(NoteMerger.canMerge(3, 3)).toBe(false);
    expect(NoteMerger.canMerge(5, 3)).toBe(false);
  });

  it('caps tag list at 8 to avoid runaway growth', async () => {
    const provider = fakeProvider([
      JSON.stringify({
        title: 't',
        fact: 'short fact',
        why: 'y',
        tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      }),
    ]);
    const m = new NoteMerger(provider);
    const out = await m.merge(
      { title: 'Old', content: 'Old fact', tags: ['x', 'y', 'z'] },
      candidate,
    );
    expect(out.tags.length).toBeLessThanOrEqual(8);
  });
});
