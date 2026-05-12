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
import logger from '../logger.js';

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

  /**
   * Run all sources in parallel and merge results into the layered output.
   *
   * Score contract: each source MUST return chunks whose `score` is a
   * normalised similarity in [0, 1] where higher = more relevant. Layered
   * filtering uses `score >= threshold`, so a source that emits raw distance
   * (lower-is-better) would invert the filter.
   *
   * Failure model: one source throwing does NOT collapse the whole call.
   * Each source is awaited via Promise.allSettled; rejections are logged
   * and treated as an empty layer, matching the spec's "degrade gracefully
   * across layers" guarantee.
   */
  async retrieve(
    query: string,
    filters: RetrievalFilters,
  ): Promise<RetrievalOutput> {
    const results = await Promise.allSettled(
      this.sources.map(s => this.callSource(s, query, filters)),
    );

    const out: RetrievalOutput = { notes: [], sessions: [], snippets: [] };
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        logger.warn(
          { err: r.reason, sourceType: this.sources[i]?.type },
          'HierarchicalRetrieval: source failed, treating as empty',
        );
        continue;
      }
      for (const c of r.value) {
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
          default:
            // 'work_item' / 'review' / unknown — log so a misrouted v5
            // source doesn't silently disappear during dev.
            logger.warn(
              { sourceType: c.source_type, sourceId: c.source_id },
              'HierarchicalRetrieval: unrouted source_type',
            );
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
    // Defensive: cap to `limit` even if the source ignored its argument and
    // returned a flood. Each KnowledgeSource SHOULD respect the limit, but
    // a buggy one shouldn't be able to balloon the orchestrator's memory.
    const chunks = (await s.search(q, f, limit)).slice(0, limit);
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
