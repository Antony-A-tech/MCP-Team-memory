// src/extraction/dedup.ts
//
// DedupResolver: for each candidate fact produced by NoteExtractor, embeds the
// fact, searches the `entries` Qdrant collection scoped to the same project +
// category, and branches the decision based on cosine similarity:
//
//   score >  confirmThreshold (0.85)             → CONFIRM existing
//   mergeThreshold ≤ score ≤ confirmThreshold    → MERGE into existing
//   score <  mergeThreshold (0.70)               → CREATE_NEW
//
// Boundary scores (exactly 0.85 or 0.70) fall into MERGE — the conservative
// choice that lets the merger LLM decide whether the candidate adds new info.

import type { EmbeddingProvider } from '../embedding/provider.js';
import type { VectorStore } from '../vector/vector-store.js';
import type { CandidateNote, DedupAction, DedupResult } from './types.js';

export interface DedupConfig {
  /** cos > confirmThreshold → CONFIRM (no edit). */
  confirmThreshold: number;
  /** cos in [mergeThreshold .. confirmThreshold] → MERGE. */
  mergeThreshold: number;
  /** Top-K from vector store; only the #1 match is used. Kept for visibility. */
  topK: number;
}

const DEFAULTS: DedupConfig = {
  confirmThreshold: 0.85,
  mergeThreshold: 0.7,
  topK: 3,
};

export class DedupResolver {
  private cfg: DedupConfig;
  constructor(
    private embedding: EmbeddingProvider,
    private vectorStore: VectorStore,
    cfg: Partial<DedupConfig> = {},
  ) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  async resolve(projectId: string, candidates: CandidateNote[]): Promise<DedupResult> {
    const decisions: DedupAction[] = [];
    for (const c of candidates) {
      const text = `${c.title}\n${c.fact}\n${c.why}`;
      const vec = await this.embedding.embed(text, 'document');
      const matches = await this.vectorStore.search(
        'entries',
        vec,
        {
          must: [
            { key: 'project_id', match: { value: projectId } },
            { key: 'category', match: { value: c.category } },
          ],
        },
        this.cfg.topK,
      );
      const top = matches[0];
      if (!top || top.score < this.cfg.mergeThreshold) {
        decisions.push({ type: 'CREATE_NEW', candidate: c });
      } else if (top.score > this.cfg.confirmThreshold) {
        decisions.push({
          type: 'CONFIRM',
          entry_id: String(top.id),
          candidate: c,
          score: top.score,
        });
      } else {
        decisions.push({
          type: 'MERGE',
          entry_id: String(top.id),
          candidate: c,
          score: top.score,
        });
      }
    }
    return { decisions };
  }
}
