// src/retrieval/hierarchical.ts
//
// HierarchicalRetrieval orchestrates multiple KnowledgeSource instances and
// returns chunks grouped by their canonical layer (notes / sessions /
// snippets / future v5 layers). Each layer has its own per-call limit and
// score threshold, so a chatty source (e.g. session_messages) can return
// many low-precision hits without polluting the high-precision layers.

import type {
  KnowledgeSource,
  KnowledgeChunk,
  RetrievalFilters,
  SourceType,
} from './types.js';

export interface RetrievalConfig {
  entriesLimit: number;
  entriesThreshold: number;
  sessionsLimit: number;
  sessionsThreshold: number;
  snippetsLimit: number;
  snippetsThreshold: number;
}

const DEFAULTS: RetrievalConfig = {
  entriesLimit: 5,
  entriesThreshold: 0.6,
  sessionsLimit: 5,
  sessionsThreshold: 0.55,
  snippetsLimit: 10,
  snippetsThreshold: 0.5,
};

/**
 * Layered retrieval output. `notes/sessions/snippets` are populated by the
 * v4.5 sources; `code/prs/wikis` are placeholders for v5 external sources.
 */
export interface RetrievalOutput {
  notes: KnowledgeChunk[];
  sessions: KnowledgeChunk[];
  snippets: KnowledgeChunk[];
  code?: KnowledgeChunk[];
  prs?: KnowledgeChunk[];
  wikis?: KnowledgeChunk[];
}

export class HierarchicalRetrieval {
  private cfg: RetrievalConfig;

  constructor(
    private sources: KnowledgeSource[],
    cfg: Partial<RetrievalConfig> = {},
  ) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  /** Add a source after construction (used by app.ts wiring + tests). */
  register(source: KnowledgeSource): void {
    this.sources.push(source);
  }

  async retrieve(
    query: string,
    filters: RetrievalFilters,
  ): Promise<RetrievalOutput> {
    // Run all sources in parallel — the slowest source determines latency.
    const results = await Promise.all(
      this.sources.map(s => this.callSource(s, query, filters)),
    );

    const out: RetrievalOutput = { notes: [], sessions: [], snippets: [] };
    for (const chunks of results) {
      for (const c of chunks) {
        switch (c.source_type) {
          case 'entries':
            out.notes.push(c);
            break;
          case 'sessions':
            out.sessions.push(c);
            break;
          case 'session_messages':
            out.snippets.push(c);
            break;
          case 'code':
            (out.code ??= []).push(c);
            break;
          case 'pr':
            (out.prs ??= []).push(c);
            break;
          case 'wiki':
            (out.wikis ??= []).push(c);
            break;
          // 'work_item' / 'review' fall through — caller can extend the
          // RetrievalOutput shape when adding sources for them.
        }
      }
    }
    return out;
  }

  private async callSource(
    s: KnowledgeSource,
    q: string,
    f: RetrievalFilters,
  ): Promise<KnowledgeChunk[]> {
    const limit = this.limitFor(s.type);
    const threshold = this.thresholdFor(s.type);
    const chunks = await s.search(q, f, limit);
    return chunks.filter(c => c.score >= threshold);
  }

  private limitFor(t: SourceType): number {
    if (t === 'entries') return this.cfg.entriesLimit;
    if (t === 'sessions') return this.cfg.sessionsLimit;
    if (t === 'session_messages') return this.cfg.snippetsLimit;
    return 5;
  }

  private thresholdFor(t: SourceType): number {
    if (t === 'entries') return this.cfg.entriesThreshold;
    if (t === 'sessions') return this.cfg.sessionsThreshold;
    if (t === 'session_messages') return this.cfg.snippetsThreshold;
    return 0.5;
  }
}
