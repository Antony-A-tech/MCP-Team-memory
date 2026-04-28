import type { PersonalNotesStorage } from './storage.js';
import type { PersonalNote, CompactPersonalNote, NoteFilters } from './types.js';
import type { VectorStore, VectorFilter } from '../vector/vector-store.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import type { MemoryManager } from '../memory/manager.js';
import type { DedupResolver } from '../extraction/dedup.js';
import type { NoteMerger } from '../extraction/merger.js';
import type {
  CandidateNote,
  AutoCategory,
  EvidenceSource,
} from '../extraction/types.js';
import { DEFAULT_PROJECT_ID } from '../memory/types.js';
import logger from '../logger.js';

export type ShareAction =
  | 'created'
  | 'confirmed_existing'
  | 'merged'
  | 'match_found_pending_user_decision';

export interface ShareResult {
  action: ShareAction;
  entryId: string | null;
  existingEntry?: { id: string; title: string; content: string; score: number };
  matchScore?: number;
}

export interface ShareParams {
  noteId: string;
  agentTokenId: string;
  category: AutoCategory;
  override?: {
    title?: string;
    content?: string;
    tags?: string[];
    externalRefs?: Record<string, unknown>;
  };
  /**
   * What to do when dedup finds a match.
   * 'prompt' (default) returns the match without writing — UI confirms with the user.
   * 'create_new' ignores the match and inserts a new entry anyway.
   * 'confirm_existing' increments confirmation_count on the match.
   * 'merge' calls NoteMerger to atomically combine.
   */
  onMatch?: 'prompt' | 'confirm_existing' | 'create_new' | 'merge';
  memoryManager: MemoryManager;
  dedupResolver?: DedupResolver;
  merger?: NoteMerger;
}

export class NotesManager {
  constructor(
    private storage: PersonalNotesStorage,
    private vectorStore?: VectorStore,
    private embeddingProvider?: EmbeddingProvider,
  ) {}

  async write(agentTokenId: string, data: {
    title: string;
    content: string;
    tags: string[];
    priority: string;
    projectId: string | null;
    sessionId: string | null;
  }): Promise<PersonalNote> {
    const note = await this.storage.create({ agentTokenId, ...data });

    if (this.embeddingProvider?.isReady() && this.vectorStore) {
      this.embeddingProvider.embed(note.title + '\n' + note.content, 'document')
        .then(vector => this.vectorStore!.upsert('personal_notes', note.id, vector, {
          note_id: note.id,
          agent_token_id: agentTokenId,
          project_id: note.projectId ?? '',
          session_id: note.sessionId ?? '',
          tags: note.tags,
          status: note.status,
        }))
        .catch(err => logger.error({ err, noteId: note.id }, 'Failed to embed note'));
    }

    return note;
  }

  async getById(noteId: string, agentTokenId: string | null): Promise<PersonalNote | null> {
    return this.storage.getById(noteId, agentTokenId);
  }

  async count(agentTokenId: string | null, filters: NoteFilters): Promise<number> {
    return this.storage.countNotes(agentTokenId, filters);
  }

  async read(agentTokenId: string | null, filters: NoteFilters): Promise<(PersonalNote | CompactPersonalNote)[]> {
    if (filters.search) {
      return this.storage.search(agentTokenId, filters.search, filters);
    }
    return this.storage.getAll(agentTokenId, filters);
  }

  async update(noteId: string, agentTokenId: string | null, updates: Record<string, unknown>): Promise<PersonalNote> {
    const note = await this.storage.update(noteId, agentTokenId, updates as any);

    if ((updates.title || updates.content) && this.embeddingProvider?.isReady() && this.vectorStore) {
      this.embeddingProvider.embed(note.title + '\n' + note.content, 'document')
        .then(vector => this.vectorStore!.upsert('personal_notes', note.id, vector, {
          note_id: note.id,
          agent_token_id: note.agentTokenId,
          project_id: note.projectId ?? '',
          session_id: note.sessionId ?? '',
          tags: note.tags,
          status: note.status,
        }))
        .catch(err => logger.error({ err, noteId: note.id }, 'Failed to re-embed note'));
    } else if (this.vectorStore) {
      // Metadata-only change — update payload without re-embedding
      const payload: Record<string, unknown> = {};
      if (updates.status !== undefined) payload.status = note.status;
      if (updates.tags !== undefined) payload.tags = note.tags;
      if (Object.keys(payload).length > 0) {
        this.vectorStore.setPayload('personal_notes', note.id, payload)
          .catch(err => logger.warn({ err, noteId: note.id }, 'Failed to update note Qdrant payload'));
      }
    }

    return note;
  }

  async delete(noteId: string, agentTokenId: string | null, archive: boolean): Promise<boolean> {
    const result = await this.storage.delete(noteId, agentTokenId, archive);

    if (!archive && this.vectorStore) {
      this.vectorStore.delete('personal_notes', [noteId])
        .catch(err => logger.warn({ err, noteId }, 'Failed to delete note vector'));
    } else if (archive && this.vectorStore) {
      this.vectorStore.setPayload('personal_notes', noteId, { status: 'archived' })
        .catch(err => logger.warn({ err, noteId }, 'Failed to update note status in Qdrant'));
    }

    return result;
  }

  async semanticSearch(agentTokenId: string, query: string, options?: {
    projectId?: string;
    sessionId?: string;
    limit?: number;
  }): Promise<Array<PersonalNote & { score: number }>> {
    if (!this.embeddingProvider?.isReady() || !this.vectorStore) {
      return [];
    }

    const queryVector = await this.embeddingProvider.embed(query, 'query');
    const filter: VectorFilter = {
      must: [{ key: 'agent_token_id', match: { value: agentTokenId } }],
    };
    if (options?.projectId) {
      filter.must!.push({ key: 'project_id', match: { value: options.projectId } });
    }
    if (options?.sessionId) {
      filter.must!.push({ key: 'session_id', match: { value: options.sessionId } });
    }

    const results = await this.vectorStore.search('personal_notes', queryVector, filter, options?.limit ?? 10);

    const notes = await Promise.all(
      results.map(async r => {
        const note = await this.storage.getById(r.payload.note_id as string, agentTokenId);
        return note ? { ...note, score: r.score } : null;
      }),
    );

    return notes.filter((n): n is PersonalNote & { score: number } => n !== null);
  }

  /**
   * Share a personal note into the team-memory `entries` table. This is the
   * v4.5 manual-share path: agents who explicitly want to publish a private
   * note as durable team knowledge call this method (instead of the
   * deprecated direct memory_write API). When a similar entry already exists
   * the caller controls the behaviour via `onMatch`.
   *
   * Notes shared via this path are pinned (decay-immune): manual share is
   * treated as guaranteed-important, so the singleton-auto-decay rule from
   * Task 9 doesn't archive them after 30 days.
   */
  async share(p: ShareParams): Promise<ShareResult> {
    const note = await this.storage.getById(p.noteId, p.agentTokenId);
    if (!note) {
      throw new Error('Note not found or not yours');
    }

    const title = p.override?.title ?? note.title;
    const content = p.override?.content ?? note.content;
    const tags = p.override?.tags ?? note.tags;

    const candidate: CandidateNote = {
      category: p.category,
      title,
      // The extraction pipeline expects "fact" + "why"; for a manual share
      // we use the note's content as the fact and a flag value for why.
      // Confidence/marker = 1 because the human deliberately published it.
      fact: content,
      why: 'Manual share',
      tags,
      confidence: 1.0,
      explicit_marker_strength: 1.0,
    };

    const evidence: EvidenceSource = {
      type: 'personal_note',
      id: note.id,
      shared_by: p.agentTokenId,
      confirmed_at: new Date().toISOString(),
    };

    const projectId = note.projectId ?? DEFAULT_PROJECT_ID;
    const onMatch = p.onMatch ?? 'prompt';

    // Dedup against existing entries when a resolver is wired in.
    if (p.dedupResolver) {
      const dedup = await p.dedupResolver.resolve(projectId, [candidate]);
      const decision = dedup.decisions[0];

      if (decision && (decision.type === 'CONFIRM' || decision.type === 'MERGE')) {
        const existing = await p.memoryManager.getById(decision.entry_id);

        if (onMatch === 'prompt') {
          return {
            action: 'match_found_pending_user_decision',
            entryId: null,
            existingEntry: existing
              ? {
                  id: existing.id,
                  title: existing.title,
                  content: existing.content,
                  score: decision.score,
                }
              : undefined,
            matchScore: decision.score,
          };
        }

        if (onMatch === 'confirm_existing') {
          await p.memoryManager.confirmExisting(decision.entry_id, evidence);
          await this.storage.setSharedToEntry(note.id, decision.entry_id);
          return { action: 'confirmed_existing', entryId: decision.entry_id };
        }

        if (onMatch === 'merge' && p.merger && existing) {
          const merged = await p.merger.merge(
            { title: existing.title, content: existing.content, tags: existing.tags },
            candidate,
          );
          await p.memoryManager.mergeIntoExisting(decision.entry_id, merged, evidence);
          await this.storage.setSharedToEntry(note.id, decision.entry_id);
          return { action: 'merged', entryId: decision.entry_id };
        }
        // onMatch='create_new' (or 'merge' without merger) → fall through to create.
      }
    }

    const entryId = await p.memoryManager.createFromCandidate(
      projectId,
      candidate,
      [evidence],
    );
    // Manual share = guaranteed important → pin to opt out of decay.
    await p.memoryManager.update({ id: entryId, pinned: true });
    await this.storage.setSharedToEntry(note.id, entryId);
    return { action: 'created', entryId };
  }
}
