// src/__tests__/extraction-extractor.test.ts
//
// Unit tests for NoteExtractor: LLM-call mocking, JSON-parse retry,
// server-side filters, and top-N capping.

import { describe, it, expect, vi } from 'vitest';
import { NoteExtractor } from '../extraction/extractor.js';
import type { ExtractionLlmProvider } from '../extraction/llm-provider.js';

function fakeProvider(responses: string[]): ExtractionLlmProvider {
  let i = 0;
  return {
    name: 'fake',
    isReady: () => true,
    generate: vi.fn(async () => responses[i++] ?? responses[responses.length - 1]),
  };
}

const goodResponse = JSON.stringify({
  architecture: [],
  decisions: [
    {
      title: 'Use JWT with refresh',
      fact: 'Auth uses JWT plus 7-day refresh tokens because cookie session storage was rejected for cross-domain reasons.',
      why: 'Refresh allows revocation and short access tokens.',
      tags: ['auth', 'jwt'],
      confidence: 0.9,
      explicit_marker_strength: 0.8,
    },
  ],
  conventions: [],
});

describe('NoteExtractor', () => {
  it('parses well-formed JSON and applies filters', async () => {
    const ex = new NoteExtractor(fakeProvider([goodResponse]));
    const res = await ex.extract({ summary: 's', messages: [] });
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].category).toBe('decisions');
  });

  it('retries once if first response is wrapped in markdown fences', async () => {
    const fenced = '```json\n' + goodResponse + '\n```';
    const ex = new NoteExtractor(fakeProvider([fenced, goodResponse]));
    const res = await ex.extract({ summary: 's', messages: [] });
    expect(res.candidates).toHaveLength(1);
  });

  it('rejects low confidence', async () => {
    const r = JSON.stringify({
      architecture: [],
      decisions: [
        {
          title: 'x'.repeat(6),
          fact: 'a'.repeat(50),
          why: 'y',
          tags: ['a'],
          confidence: 0.4,
          explicit_marker_strength: 0.9,
        },
      ],
      conventions: [],
    });
    const ex = new NoteExtractor(fakeProvider([r]));
    const res = await ex.extract({ summary: 's', messages: [] });
    expect(res.candidates).toHaveLength(0);
    expect(res.rejected[0].reason).toMatch(/confidence/);
  });

  it('rejects fact shorter than minFactLen', async () => {
    const r = JSON.stringify({
      architecture: [],
      decisions: [
        {
          title: 'longer title',
          fact: 'short',
          why: 'y',
          tags: ['a'],
          confidence: 0.9,
          explicit_marker_strength: 0.9,
        },
      ],
      conventions: [],
    });
    const ex = new NoteExtractor(fakeProvider([r]));
    const res = await ex.extract({ summary: 's', messages: [] });
    expect(res.candidates).toHaveLength(0);
  });

  it('caps to top 5 by confidence × marker', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      title: `title-${i}`,
      fact: 'a'.repeat(50),
      why: 'y',
      tags: ['a'],
      confidence: 0.6 + i * 0.05,
      explicit_marker_strength: 0.5 + i * 0.05,
    }));
    const r = JSON.stringify({ architecture: items, decisions: [], conventions: [] });
    const ex = new NoteExtractor(fakeProvider([r]));
    const res = await ex.extract({ summary: 's', messages: [] });
    expect(res.candidates).toHaveLength(5);
    expect(res.candidates[0].title).toBe('title-7'); // highest score
  });

  it('returns empty candidates when LLM emits {}', async () => {
    const ex = new NoteExtractor(fakeProvider(['{}']));
    const res = await ex.extract({ summary: 's', messages: [] });
    expect(res.candidates).toHaveLength(0);
  });

  it('still returns empty when both attempts produce malformed JSON', async () => {
    const ex = new NoteExtractor(fakeProvider(['not json', 'still not json']));
    const res = await ex.extract({ summary: 's', messages: [] });
    expect(res.candidates).toHaveLength(0);
  });
});
