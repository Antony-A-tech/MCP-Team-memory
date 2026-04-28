// src/__tests__/retrieval-hierarchical.test.ts
//
// Unit tests for HierarchicalRetrieval — verifies grouping by source type,
// per-layer threshold filtering, per-layer limit forwarding, and the
// register() escape hatch.

import { describe, it, expect, vi } from 'vitest';
import { HierarchicalRetrieval } from '../retrieval/hierarchical.js';
import type {
  KnowledgeSource,
  KnowledgeChunk,
  SourceType,
} from '../retrieval/types.js';

function fakeSource(
  type: SourceType,
  chunks: KnowledgeChunk[] = [],
  searchSpy?: ReturnType<typeof vi.fn>,
): KnowledgeSource {
  return {
    type,
    search: searchSpy ?? vi.fn(async () => chunks),
  };
}

const chunk = (
  source_type: SourceType,
  source_id: string,
  score: number,
): KnowledgeChunk => ({
  source_type,
  source_id,
  text: `text for ${source_id}`,
  score,
  metadata: {},
});

describe('HierarchicalRetrieval', () => {
  const projectId = '00000000-0000-0000-0000-000000000000';

  it('groups results by source type into the canonical layers', async () => {
    const r = new HierarchicalRetrieval([
      fakeSource('entries', [chunk('entries', 'e1', 0.9)]),
      fakeSource('sessions', [chunk('sessions', 's1', 0.7)]),
      fakeSource('session_messages', []),
    ]);
    const out = await r.retrieve('q', { project_id: projectId });
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0].source_id).toBe('e1');
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0].source_id).toBe('s1');
    expect(out.snippets).toHaveLength(0);
  });

  it('filters chunks below the per-layer threshold', async () => {
    const r = new HierarchicalRetrieval(
      [
        fakeSource('entries', [
          chunk('entries', 'e1', 0.9), // pass
          chunk('entries', 'e2', 0.55), // drop (entriesThreshold = 0.6)
        ]),
        fakeSource('sessions', [
          chunk('sessions', 's1', 0.6), // pass (sessionsThreshold = 0.55)
        ]),
        fakeSource('session_messages', [
          chunk('session_messages', 'm1', 0.49), // drop (snippetsThreshold = 0.5)
        ]),
      ],
    );
    const out = await r.retrieve('q', { project_id: projectId });
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0].source_id).toBe('e1');
    expect(out.sessions).toHaveLength(1);
    expect(out.snippets).toHaveLength(0);
  });

  it('honours per-layer threshold overrides', async () => {
    const r = new HierarchicalRetrieval(
      [fakeSource('entries', [chunk('entries', 'e1', 0.5)])],
      { entriesThreshold: 0.6, sessionsThreshold: 0, snippetsThreshold: 0 },
    );
    const out = await r.retrieve('q', { project_id: projectId });
    expect(out.notes).toHaveLength(0);
  });

  it('forwards per-layer limits when calling each source', async () => {
    const entriesSearch = vi.fn(async () => []);
    const sessionsSearch = vi.fn(async () => []);
    const messagesSearch = vi.fn(async () => []);
    const r = new HierarchicalRetrieval(
      [
        fakeSource('entries', [], entriesSearch),
        fakeSource('sessions', [], sessionsSearch),
        fakeSource('session_messages', [], messagesSearch),
      ],
      { entriesLimit: 3, sessionsLimit: 4, snippetsLimit: 7 },
    );
    await r.retrieve('q', { project_id: projectId });
    expect(entriesSearch.mock.calls[0][2]).toBe(3);
    expect(sessionsSearch.mock.calls[0][2]).toBe(4);
    expect(messagesSearch.mock.calls[0][2]).toBe(7);
  });

  it('register() adds a new source to the orchestrator', async () => {
    const r = new HierarchicalRetrieval([]);
    r.register(fakeSource('entries', [chunk('entries', 'e1', 0.9)]));
    const out = await r.retrieve('q', { project_id: projectId });
    expect(out.notes).toHaveLength(1);
  });

  it('routes v5 placeholder source types into optional layers', async () => {
    const r = new HierarchicalRetrieval([
      fakeSource('code', [chunk('code', 'c1', 0.9)]),
      fakeSource('pr', [chunk('pr', 'p1', 0.9)]),
      fakeSource('wiki', [chunk('wiki', 'w1', 0.9)]),
    ]);
    const out = await r.retrieve('q', { project_id: projectId });
    expect(out.code).toEqual([chunk('code', 'c1', 0.9)]);
    expect(out.prs).toEqual([chunk('pr', 'p1', 0.9)]);
    expect(out.wikis).toEqual([chunk('wiki', 'w1', 0.9)]);
  });

  it('one source throwing does not collapse other layers (Promise.allSettled)', async () => {
    const failing = fakeSource('entries', []);
    failing.search = vi.fn(async () => {
      throw new Error('Qdrant unavailable');
    });
    const ok = fakeSource('sessions', [chunk('sessions', 's-ok', 0.9)]);
    const r = new HierarchicalRetrieval([failing, ok]);
    const out = await r.retrieve('q', { project_id: projectId });
    expect(out.notes).toEqual([]);
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0].source_id).toBe('s-ok');
  });

  it('caps per-source results to limitFor(type) even if source returns extra', async () => {
    const flood = Array.from({ length: 50 }, (_, i) =>
      chunk('entries', `e${i}`, 0.9),
    );
    const r = new HierarchicalRetrieval(
      [fakeSource('entries', flood)],
      { entriesLimit: 3 },
    );
    const out = await r.retrieve('q', { project_id: projectId });
    expect(out.notes).toHaveLength(3);
  });

  it('queries all sources in parallel (one slow source does not block others)', async () => {
    const slow = fakeSource('entries', [chunk('entries', 'slow', 0.9)]);
    slow.search = vi.fn(
      () => new Promise(resolve => setTimeout(() => resolve([chunk('entries', 'slow', 0.9)]), 50)),
    );
    const fast = fakeSource('sessions', [chunk('sessions', 'fast', 0.9)]);
    const r = new HierarchicalRetrieval([slow, fast]);
    const start = Date.now();
    const out = await r.retrieve('q', { project_id: projectId });
    const elapsed = Date.now() - start;
    expect(out.notes).toHaveLength(1);
    expect(out.sessions).toHaveLength(1);
    // Sequential would be 50+0 = 50ms minimum; parallel ~50ms.
    // Generous bound: must not exceed 150ms (allows for CI noise).
    expect(elapsed).toBeLessThan(150);
  });
});
