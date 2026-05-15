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
import logger from '../logger.js';
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
    if (candidates.length === 0) return { decisions: [] };

    // Batch all candidate embeddings into a single LLM call when supported,
    // then run all vector searches in parallel. With 5 candidates the cost
    // drops from 5 sequential round-trips to 1 embedBatch + 5 parallel
    // searches — meaningfully cheaper under bursty session imports.
    const texts = candidates.map(c => `${c.title}\n${c.fact}\n${c.why}`);
    let vectors: number[][];
    try {
      vectors = this.embedding.embedBatch
        ? await this.embedding.embedBatch(texts, 'document')
        : await Promise.all(texts.map(t => this.embedding.embed(t, 'document')));
    } catch (err) {
      // If embedding fails for any candidate the batch is unusable. Don't
      // fall back to zero vectors (they corrupt cosine similarity); instead
      // skip dedup entirely and treat every candidate as CREATE_NEW. Worst
      // case is a duplicate row, which is recoverable; corrupting the dedup
      // graph is not. Logged at error level because the fallback creates
      // entries that would otherwise have been merged — operators need to
      // see this in alerting rather than as a routine warn.
      logger.error({ err, candidateCount: candidates.length, projectId },
        'Dedup embed failed — falling back to CREATE_NEW for all candidates');
      return { decisions: candidates.map((c) => ({ type: 'CREATE_NEW', candidate: c })) };
    }

    const matchesPerCandidate = await Promise.all(
      candidates.map((c, i) =>
        this.vectorStore.search(
          'entries',
          vectors[i],
          {
            must: [
              { key: 'project_id', match: { value: projectId } },
              { key: 'category', match: { value: c.category } },
            ],
          },
          this.cfg.topK,
        ),
      ),
    );

    const decisions: DedupAction[] = candidates.map((c, i) => {
      const top = matchesPerCandidate[i][0];
      if (!top || top.score < this.cfg.mergeThreshold) {
        return { type: 'CREATE_NEW', candidate: c };
      }
      // Prefer the canonical entry_id from the payload (Task 16 added it
      // to all upserts). Falling back to the Qdrant point id covers the
      // legacy collection where only the point id was stored — they
      // historically coincided but a future refactor could split them.
      const entryId = String(
        (top.payload?.entry_id as string | undefined) ?? top.id,
      );
      if (top.score > this.cfg.confirmThreshold) {
        return { type: 'CONFIRM', entry_id: entryId, candidate: c, score: top.score };
      }
      return { type: 'MERGE', entry_id: entryId, candidate: c, score: top.score };
    });

    return { decisions };
  }
}
