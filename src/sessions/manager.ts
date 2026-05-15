import crypto from 'crypto';
import type { SessionStorage } from './storage.js';
import type { Session, SessionMessage, SessionFilters, SessionChunk } from './types.js';
import type { VectorStore, VectorFilter } from '../vector/vector-store.js';
import type { EmbeddingProvider } from '../embedding/provider.js';
import type { OllamaLlmClient } from '../llm/ollama.js';
import type { NoteExtractor } from '../extraction/extractor.js';
import type { DedupResolver } from '../extraction/dedup.js';
import { NoteMerger } from '../extraction/merger.js';
import type { MemoryManager } from '../memory/manager.js';
import type { EvidenceSource } from '../extraction/types.js';
import type { EventsManager } from '../events/manager.js';
import { buildEventsPrompt, parseEventsResponseStrict, EventsParseError } from '../events/extractor.js';
import { chunkMessage } from './chunking.js';
import logger from '../logger.js';

/** Generate a deterministic UUID v5 from message ID + chunk index */
function chunkPointId(messageId: string, chunkIndex: number): string {
  const hash = crypto.createHash('sha1').update(`${messageId}:${chunkIndex}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Parse the "Title: ...\nTags: a, b\nSummary: ..." block emitted by the
 * summarisation prompt. The old regex implementation was fragile: missing a
 * section, an extra blank line, or a multi-line summary all confused it.
 *
 * Strategy: line-based scan. Header lines are recognised by their literal
 * prefix; everything after a `Summary:` line is collected into the summary
 * body. Title/tags validation is permissive — anything that doesn't pass
 * just gets dropped, letting the caller fall back to defaults.
 *
 * Exported for unit tests.
 */
export interface ParsedLlmSummary {
  title?: string;
  summary: string;
  tags: string[];
}

const SUMMARY_MIN_LENGTH = 20;
const TITLE_MIN_LENGTH = 3;
const TITLE_MAX_LENGTH = 120;

export function parseLlmSummary(raw: string): ParsedLlmSummary | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;

  const lines = raw.split('\n');
  let title: string | undefined;
  const tags: string[] = [];
  const summaryLines: string[] = [];
  let inSummary = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!inSummary) {
      const titleMatch = /^Title:\s*(.*)$/i.exec(trimmed);
      if (titleMatch) {
        const value = titleMatch[1].trim();
        if (value.length >= TITLE_MIN_LENGTH && value.length <= TITLE_MAX_LENGTH) {
          title = value;
        }
        continue;
      }
      const tagsMatch = /^Tags:\s*(.*)$/i.exec(trimmed);
      if (tagsMatch) {
        const list = tagsMatch[1]
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);
        tags.push(...list);
        continue;
      }
      const summaryMatch = /^Summary:\s*(.*)$/i.exec(trimmed);
      if (summaryMatch) {
        inSummary = true;
        if (summaryMatch[1].trim()) summaryLines.push(summaryMatch[1]);
        continue;
      }
      // Line outside any known section — ignored before Summary: appears.
    } else {
      // Inside the Summary body: keep original line (preserves indentation
      // and blank-line spacing the LLM emitted).
      summaryLines.push(rawLine);
    }
  }

  const explicitSummary = summaryLines.join('\n').trim();
  // If we got nothing labelled `Summary:`, fall back to using the whole raw
  // text — the LLM may have ignored the prompt template. If we got something
  // too short to be useful, also fall back (caller may decide to discard).
  const summaryCandidate = explicitSummary.length >= SUMMARY_MIN_LENGTH
    ? explicitSummary
    : raw.trim();

  if (summaryCandidate.length === 0) return null;

  return { title, summary: summaryCandidate, tags };
}

export class SessionManager {
  private processing = false;
  private workerInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private storage: SessionStorage,
    private vectorStore?: VectorStore,
    private embeddingProvider?: EmbeddingProvider,
    private llmClient?: OllamaLlmClient,
    private noteExtractor?: NoteExtractor,
    private dedupResolver?: DedupResolver,
    private noteMerger?: NoteMerger,
    private memoryManager?: MemoryManager,
    private extractionEnabled: boolean = true,
    private maxMergesPerSession: number = 3,
    private eventsManager?: EventsManager,
    // Per-instance override for events confidence threshold; falls back to
    // the EVENTS_MIN_CONFIDENCE_DEFAULT inside parseEventsResponse if absent.
    private eventsMinConfidence?: number,
  ) {}

  setEventsManager(em: EventsManager): void {
    this.eventsManager = em;
  }

  /**
   * Import session — saves to PG immediately, queues LLM + embedding for background processing.
   * Returns instantly (~2-3 sec) regardless of session size.
   */
  async importSession(agentTokenId: string, data: {
    externalId?: string;
    name?: string;
    summary?: string;
    projectId?: string;
    workingDirectory?: string;
    gitBranch?: string;
    tags?: string[];
    startedAt?: string;
    endedAt?: string;
    messages: Array<{ role: string; content: string; timestamp?: string; toolNames: string[] }>;
  }): Promise<Session> {
    // Resolve a possible duplicate via two paths:
    //   1. external_id — strongest signal, used when the caller controls a
    //      stable identifier (Claude Code session UUID, Azure event id).
    //   2. (project_id, name, started_at) tuple — fallback for callers that
    //      can't supply external_id (legacy webhooks, manual UI imports).
    //      All three parts must be set to form a stable key; otherwise we
    //      fall through and create a new row.
    // The "if grew, upsert" logic below applies to either match.
    const existing = data.externalId
      ? await this.storage.findByExternalId(agentTokenId, data.externalId)
      : await this.storage.findByTuple(agentTokenId, data.projectId, data.name, data.startedAt);
    if (existing) {
      // If new data has more messages, update the session
      if (data.messages.length > existing.messageCount) {
        // Skip upsert if worker is actively processing this session
        if (existing.embeddingStatus === 'summarizing' || existing.embeddingStatus === 'embedding') {
          logger.info({ sessionId: existing.id, status: existing.embeddingStatus },
            'Session upsert skipped — worker is processing, will retry next sync');
          return existing;
        }

        await this.storage.replaceMessages(existing.id, data.messages);
        await this.storage.updateSessionMeta(existing.id, {
          messageCount: data.messages.length,
          endedAt: data.endedAt,
        });

        // Re-queue for LLM summary + embedding (content changed)
        const needsSummary = !data.summary;
        await this.storage.updateEmbeddingStatus(existing.id, needsSummary ? 'queued' : 'queued_embed');

        // Clean old vectors — worker will regenerate
        if (this.vectorStore) {
          this.vectorStore.delete('sessions', [existing.id]).catch(err =>
            logger.warn({ err, sessionId: existing.id }, 'Failed to clean old session vector during upsert'));
          this.vectorStore.deleteByFilter('session_messages', {
            must: [{ key: 'session_id', match: { value: existing.id } }],
          }).catch(err =>
            logger.warn({ err, sessionId: existing.id }, 'Failed to clean old message vectors during upsert'));
        }

        logger.info({ sessionId: existing.id, oldCount: existing.messageCount, newCount: data.messages.length },
          'Session updated with new messages, re-queued');
        return { ...existing, messageCount: data.messages.length, endedAt: data.endedAt ?? existing.endedAt };
      }
      // Same or fewer messages — no update needed
      return existing;
    }

    // New session
    const summary = data.summary || 'Pending summarization...';
    const needsSummary = !data.summary;

    const session = await this.storage.createSession({ agentTokenId, ...data, summary });

    // Set status to 'queued' — background worker will process LLM + embedding
    await this.storage.updateEmbeddingStatus(session.id, needsSummary ? 'queued' : 'queued_embed');

    logger.info({ sessionId: session.id, messageCount: session.messageCount, needsSummary },
      'Session imported, queued for processing');

    return session;
  }

  /**
   * Background worker: processes one queued session at a time.
   * Call via setInterval — safe to call concurrently (uses lock flag).
   */
  async processQueue(): Promise<void> {
    if (this.processing) return; // Already processing one
    this.processing = true;

    try {
      // Find next queued session
      const session = await this.storage.getNextQueued();
      if (!session) return;

      logger.info({ sessionId: session.id, status: session.embeddingStatus }, 'Processing queued session');

      // Step 1: LLM summarization (if needed)
      if (session.embeddingStatus === 'queued') {
        await this.storage.updateEmbeddingStatus(session.id, 'summarizing');

        const messages = await this.storage.getMessages(session.id, 0);

        if (this.llmClient?.isReady()) {
          try {
            const llmResult = await this.llmClient.summarizeSession(
              messages.map(m => ({ role: m.role, content: m.content })),
            );

            const parsed = parseLlmSummary(llmResult);
            if (!parsed) {
              // 5.H — empty / unparseable LLM output. Don't overwrite the
              // placeholder with empty string. Skip and let the fallback
              // path below populate from the first user message.
              logger.warn({ sessionId: session.id, rawLength: llmResult?.length ?? 0 },
                'LLM returned empty or unparseable summary; using fallback');
            } else {
              await this.storage.updateSummary(session.id, parsed.summary);
              const meta: { name?: string; tags?: string[] } = {};
              if (parsed.title) meta.name = parsed.title;
              if (parsed.tags.length > 0) {
                // Merge LLM tags with existing import tags (auto-sync, mass-import)
                const existingTags = session.tags || [];
                meta.tags = [...new Set([...existingTags, ...parsed.tags])];
              }
              if (Object.keys(meta).length > 0) {
                await this.storage.updateSessionMeta(session.id, meta);
              }
              const updated = await this.storage.getSession(session.id);
              if (updated) Object.assign(session, updated);
              logger.info({ sessionId: session.id, title: parsed.title }, 'Session summary generated by LLM');
            }
          } catch (err) {
            logger.warn({ err, sessionId: session.id }, 'LLM summarization failed, using fallback');
          }
        }

        // If summary is still the placeholder, use fallback from first user message
        if (session.summary === 'Pending summarization...') {
          const firstUser = messages.find(m => m.role === 'user');
          const fallback = firstUser
            ? (firstUser.content.length > 200 ? firstUser.content.slice(0, 200) + '...' : firstUser.content)
            : 'Imported session';
          await this.storage.updateSummary(session.id, fallback);
          session.summary = fallback;
        }

        await this.storage.updateEmbeddingStatus(session.id, 'embedding');
      } else {
        // queued_embed — summary already provided, skip to embedding
        await this.storage.updateEmbeddingStatus(session.id, 'embedding');
      }

      // Step 2: Embedding (summary + messages → Qdrant). Skip if the session
      // was picked up directly in `extracting_notes` (recovery path).
      let embeddingOk = true;
      if (session.embeddingStatus !== 'extracting_notes') {
        if (this.embeddingProvider?.isReady() && this.vectorStore) {
          try {
            await this.embedSession(session);
            logger.info({ sessionId: session.id }, 'Session embedding complete');
          } catch (err) {
            embeddingOk = false;
            await this.storage.updateEmbeddingStatus(session.id, 'failed');
            logger.error({ err, sessionId: session.id }, 'Session embedding failed');
          }
        } else {
          logger.info({ sessionId: session.id }, 'Session embedding skipped (no provider)');
        }
      }

      if (!embeddingOk) {
        // Already marked as 'failed' above — pipeline halts here.
        return;
      }

      // Step 3: Extract auto-notes (v4.5). Optional — controlled by extractionEnabled
      // and presence of all three deps (extractor, dedup, memory manager).
      const extractionAvailable =
        this.extractionEnabled &&
        this.noteExtractor !== undefined &&
        this.dedupResolver !== undefined &&
        this.memoryManager !== undefined &&
        session.projectId !== null;

      if (extractionAvailable) {
        await this.storage.updateEmbeddingStatus(session.id, 'extracting_notes');
        try {
          await this.runExtraction(session);
          await this.storage.updateEmbeddingStatus(session.id, 'complete');
          logger.info({ sessionId: session.id }, 'Session extraction complete');
        } catch (err) {
          await this.storage.updateEmbeddingStatus(session.id, 'extraction_failed');
          logger.error({ err, sessionId: session.id }, 'Session note extraction failed');
        }
      } else {
        await this.storage.updateEmbeddingStatus(session.id, 'complete');
        if (this.extractionEnabled && session.projectId === null) {
          logger.info({ sessionId: session.id }, 'Session complete — extraction skipped (no projectId)');
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Run the v4.5 auto-notes extraction step on a freshly-embedded session.
   * Calls the extractor to produce candidate facts, the dedup resolver to
   * decide CONFIRM/MERGE/CREATE_NEW vs existing entries, and the memory
   * manager to persist the resulting writes. Each session has a small merge
   * budget so a single noisy session can't trigger an unbounded LLM cost.
   *
   * Idempotency: if any entry in the project already references this session
   * in its `evidence_sources`, treat the run as a retry of a previously-
   * partially-applied extraction and skip the entire pipeline. CONFIRM/MERGE
   * deduplicate evidence per (type,id), but CREATE_NEW would otherwise
   * produce duplicate auto-entries on retry (the just-created row may not
   * yet be in Qdrant, so dedup search would miss it). Skipping retries is
   * the conservative choice: a partial extraction is preferred over duplicate
   * records — operators can re-run via the backfill script if needed.
   */
  private async runExtraction(session: Session): Promise<void> {
    if (
      !session.projectId ||
      !this.noteExtractor ||
      !this.dedupResolver ||
      !this.memoryManager
    ) {
      return;
    }

    if (await this.storage.hasExtractionEvidence(session.projectId, session.id)) {
      logger.info(
        { sessionId: session.id },
        'extraction skipped — session already has applied evidence (retry guard)',
      );
      return;
    }

    const messages = await this.storage.getMessages(session.id, 0);
    const promptMessages = messages.map(m => ({ role: m.role, content: m.content }));

    // v5: run notes-extraction and events-extraction in parallel.
    // Events extraction is idempotent (hasEventForSession guard), so a worker
    // retry doesn't duplicate events. We AWAIT both so the session is only
    // marked complete after both passes have finished or surfaced an error.
    // The notes pass is mandatory; the events pass is best-effort — its
    // failures are logged but do not propagate so they can't block the
    // (much more critical) knowledge extraction.
    const eventsPromise = this.eventsManager && this.llmClient
      ? this.runEventsExtraction(session, promptMessages).catch(err => {
          logger.error({ err, sessionId: session.id }, 'events extraction failed');
        })
      : Promise.resolve();

    const result = await this.noteExtractor.extract({
      summary: session.summary,
      messages: promptMessages,
    });

    // Wait for events pass before continuing dedup — guarantees that if the
    // worker process is shut down between these two awaits, we still flushed
    // (or recorded the failure of) the events insert.
    await eventsPromise;

    if (result.candidates.length === 0) {
      logger.info(
        {
          sessionId: session.id,
          rejected: result.rejected.length,
          inputChars: result.llm_input_chars,
          outputChars: result.llm_output_chars,
        },
        'extraction yielded zero candidates',
      );
      return;
    }

    const dedup = await this.dedupResolver.resolve(session.projectId, result.candidates);
    let mergesUsed = 0;
    const summary = {
      create: 0,
      confirm: 0,
      merge: 0,
      fallback_confirm: 0,
      missing: 0,
      errors: 0,
    };

    for (const decision of dedup.decisions) {
      const evidence: EvidenceSource = {
        type: 'session',
        id: session.id,
        agent_token_id: session.agentTokenId,
        confirmed_at: new Date().toISOString(),
      };

      try {
        if (decision.type === 'CREATE_NEW') {
          await this.memoryManager.createFromCandidate(
            session.projectId,
            decision.candidate,
            [evidence],
          );
          summary.create++;
          continue;
        }

        if (decision.type === 'CONFIRM') {
          await this.memoryManager.confirmExisting(decision.entry_id, evidence);
          summary.confirm++;
          continue;
        }

        // MERGE — fall through to confirm if budget exhausted or merger missing,
        // so we never lose the signal that the candidate matched something.
        if (
          !this.noteMerger ||
          !NoteMerger.canMerge(mergesUsed, this.maxMergesPerSession)
        ) {
          await this.memoryManager.confirmExisting(decision.entry_id, evidence);
          summary.fallback_confirm++;
          continue;
        }

        const existing = await this.memoryManager.getById(decision.entry_id);
        if (!existing) {
          summary.missing++;
          continue;
        }

        const merged = await this.noteMerger.merge(
          {
            title: existing.title,
            content: existing.content,
            tags: existing.tags,
          },
          decision.candidate,
        );
        await this.memoryManager.mergeIntoExisting(decision.entry_id, merged, evidence);
        mergesUsed++;
        summary.merge++;
      } catch (err) {
        // Per-decision errors are logged and the loop continues, but we
        // count them so the caller can decide whether the session is
        // actually healthy.
        summary.errors++;
        logger.warn(
          { err, sessionId: session.id, decision: decision.type },
          'extraction write failed, continuing with remaining decisions',
        );
      }
    }

    logger.info(
      { sessionId: session.id, ...summary, mergesUsed },
      'extraction applied',
    );

    // If every single decision failed, the issue is systemic (DB down, schema
    // mismatch, ...). Surface it so the session lands in `extraction_failed`
    // and operators get a real signal instead of a silent "complete".
    if (dedup.decisions.length > 0 && summary.errors === dedup.decisions.length) {
      throw new Error(
        `extraction: all ${summary.errors} decisions failed for session ${session.id}`,
      );
    }
  }

  /**
   * v5: LLM-pass that extracts WHAT-events from a session (merge/release/deploy/incident/milestone).
   * Independent from notes extraction.
   *
   * Idempotency: before doing the (expensive) LLM call, we check whether
   * any event already references this session in evidence_sources — if so,
   * the previous pass succeeded and we skip. This makes retries from the
   * worker (e.g. after a crash) safe and cheap.
   */
  private async runEventsExtraction(
    session: Session,
    messages: Array<{ role: string; content: string }>,
  ): Promise<void> {
    if (!this.eventsManager || !this.llmClient || !session.projectId) return;

    // Retry guard — skip if events already extracted for this session
    const alreadyExtracted = await this.eventsManager.hasEventForSession(
      session.projectId,
      session.id,
    );
    if (alreadyExtracted) {
      logger.info(
        { sessionId: session.id },
        'events extraction skipped — events for this session already exist',
      );
      return;
    }

    const prompt = buildEventsPrompt({
      summary: session.summary,
      messages,
    });

    // Two attempts: malformed JSON is sometimes a transient LLM glitch
    // (rate-limit retry, truncated response). One retry after a brief
    // backoff recovers most of those without burning resources on
    // persistent failures.
    const EVENTS_RETRY_BACKOFF_MS = 2000;
    let candidates: ReturnType<typeof parseEventsResponseStrict>;
    try {
      const raw = await this.llmClient.generate(prompt, { temperature: 0.1, maxTokens: 800 });
      candidates = parseEventsResponseStrict(raw, { minConfidence: this.eventsMinConfidence });
    } catch (parseErr) {
      if (!(parseErr instanceof EventsParseError)) throw parseErr;
      logger.warn({ err: parseErr, sessionId: session.id, backoffMs: EVENTS_RETRY_BACKOFF_MS },
        'events extraction parse failed; retrying once after backoff');
      await new Promise((r) => setTimeout(r, EVENTS_RETRY_BACKOFF_MS));
      try {
        const raw2 = await this.llmClient.generate(prompt, { temperature: 0.1, maxTokens: 800 });
        candidates = parseEventsResponseStrict(raw2, { minConfidence: this.eventsMinConfidence });
      } catch (retryErr) {
        logger.warn({ err: retryErr, sessionId: session.id },
          'events extraction parse failed on retry; skipping for this session');
        return;
      }
    }

    if (candidates.length === 0) {
      logger.info({ sessionId: session.id }, 'events extraction yielded zero candidates');
      return;
    }

    const evidence: EvidenceSource = {
      type: 'session',
      id: session.id,
      agent_token_id: session.agentTokenId,
      confirmed_at: new Date().toISOString(),
    };

    let added = 0;
    for (const candidate of candidates) {
      try {
        await this.eventsManager.add({
          ...candidate,
          projectId: session.projectId,
          evidenceSources: [evidence],
        });
        added++;
      } catch (err) {
        logger.warn({ err, sessionId: session.id, eventType: candidate.eventType }, 'failed to add event');
      }
    }

    logger.info(
      { sessionId: session.id, added, total: candidates.length },
      'events extraction completed',
    );
  }

  /**
   * Start background worker — processes queued sessions every N seconds.
   */
  async startWorker(intervalSec: number = 30): Promise<void> {
    if (this.workerInterval) return;

    // Recovery: reset any sessions stuck in transient states from a previous crash
    await this.storage.recoverStuckSessions();

    this.workerInterval = setInterval(() => {
      this.processQueue().catch(err =>
        logger.error({ err }, 'Session queue worker error'),
      );
    }, intervalSec * 1000);

    // Also run immediately on start
    this.processQueue().catch(err =>
      logger.error({ err }, 'Session queue worker initial run error'),
    );

    logger.info({ intervalSec }, 'Session queue worker started');
  }

  stopWorker(): void {
    if (this.workerInterval) {
      clearInterval(this.workerInterval);
      this.workerInterval = null;
    }
  }

  private async embedSession(session: Session): Promise<void> {
    const agentTokenId = session.agentTokenId;

    // 1. Embed summary → sessions collection
    const summaryVector = await this.embeddingProvider!.embed(session.summary, 'document');
    await this.vectorStore!.upsert('sessions', session.id, summaryVector, {
      session_id: session.id,
      agent_token_id: agentTokenId,
      project_id: session.projectId ?? '',
      name: session.name ?? '',
      tags: session.tags,
      started_at: session.startedAt ? new Date(session.startedAt).getTime() : 0,
      message_count: session.messageCount,
    });

    // 2. Chunk and embed messages → session_messages collection
    const dbMessages = await this.storage.getMessages(session.id, 0);
    const allChunks: SessionChunk[] = [];

    for (const msg of dbMessages) {
      const chunks = chunkMessage(msg.content, msg.id);
      allChunks.push(...chunks);
    }

    if (allChunks.length > 0) {
      logger.info({ sessionId: session.id, chunks: allChunks.length, messages: dbMessages.length },
        'Embedding session messages');
      const texts = allChunks.map(c => c.text);
      const vectors = this.embeddingProvider!.embedBatch
        ? await this.embeddingProvider!.embedBatch(texts, 'document')
        : await Promise.all(texts.map(t => this.embeddingProvider!.embed(t, 'document')));

      const points = allChunks.map((chunk, i) => {
        const msg = dbMessages.find(m => m.id === chunk.messageId)!;
        return {
          id: chunkPointId(chunk.messageId, chunk.chunkIndex),
          vector: vectors[i],
          payload: {
            message_id: chunk.messageId,
            session_id: session.id,
            agent_token_id: agentTokenId,
            role: msg.role,
            message_index: msg.messageIndex,
            chunk_index: chunk.chunkIndex,
            total_chunks: chunk.totalChunks,
            has_tool_use: msg.hasToolUse,
            tool_names: msg.toolNames,
          },
        };
      });

      await this.vectorStore!.upsertBatch('session_messages', points);
    }

    logger.info({ sessionId: session.id, chunks: allChunks.length }, 'Session vectors stored');
  }

  async listSessions(agentTokenId: string, filters: SessionFilters): Promise<Session[]> {
    return this.storage.listSessions(agentTokenId, filters);
  }

  async countSessions(agentTokenId: string, filters: SessionFilters): Promise<number> {
    return this.storage.countSessions(agentTokenId, filters);
  }

  async countByEmbeddingStatus(projectId?: string): Promise<Record<string, number>> {
    return this.storage.countByEmbeddingStatus(projectId);
  }

  async readSession(sessionId: string, agentTokenId: string, from?: number, to?: number): Promise<{
    session: Session;
    messages: SessionMessage[];
  } | null> {
    const session = await this.storage.getSession(sessionId);
    if (!session) return null;
    if (agentTokenId && session.agentTokenId !== agentTokenId) throw new Error('Access denied: not your session');

    const messages = await this.storage.getMessages(sessionId, from ?? 0, to);
    return { session, messages };
  }

  async searchSessions(agentTokenId: string, query: string, options?: {
    projectId?: string;
    limit?: number;
  }): Promise<Array<Session & { score: number }>> {
    if (!this.embeddingProvider?.isReady() || !this.vectorStore) return [];

    const queryVector = await this.embeddingProvider.embed(query, 'query');
    const filter: VectorFilter = {
      must: [{ key: 'agent_token_id', match: { value: agentTokenId } }],
    };
    if (options?.projectId) {
      filter.must!.push({ key: 'project_id', match: { value: options.projectId } });
    }

    const results = await this.vectorStore.search('sessions', queryVector, filter, options?.limit ?? 10);

    const sessions = await Promise.all(
      results.map(async r => {
        const session = await this.storage.getSession(r.payload.session_id as string);
        return session ? { ...session, score: r.score } : null;
      }),
    );

    return sessions.filter((s): s is Session & { score: number } => s !== null);
  }

  async searchMessages(agentTokenId: string, query: string, options?: {
    sessionId?: string;
    limit?: number;
  }): Promise<Array<{ messageId: string; sessionId: string; role: string; score: number; chunkIndex: number; messageIndex: number }>> {
    if (!this.embeddingProvider?.isReady() || !this.vectorStore) return [];

    const queryVector = await this.embeddingProvider.embed(query, 'query');
    const filter: VectorFilter = {
      must: [{ key: 'agent_token_id', match: { value: agentTokenId } }],
    };
    if (options?.sessionId) {
      filter.must!.push({ key: 'session_id', match: { value: options.sessionId } });
    }

    const results = await this.vectorStore.search('session_messages', queryVector, filter, options?.limit ?? 10);

    return results.map(r => ({
      messageId: r.payload.message_id as string,
      sessionId: r.payload.session_id as string,
      role: r.payload.role as string,
      score: r.score,
      chunkIndex: (r.payload.chunk_index as number) ?? 0,
      messageIndex: (r.payload.message_index as number) ?? 0,
    }));
  }

  async searchMessagesInSession(sessionId: string, agentTokenId: string, query: string, limit: number = 20): Promise<SessionMessage[]> {
    const session = await this.storage.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    if (agentTokenId && session.agentTokenId !== agentTokenId) throw new Error('Access denied: not your session');

    // Try semantic search first
    if (session.embeddingStatus === 'complete' && this.embeddingProvider?.isReady() && this.vectorStore) {
      const results = await this.searchMessages(agentTokenId, query, { sessionId, limit });
      if (results.length > 0) {
        const messages = await Promise.all(
          results.map(r => this.storage.getMessages(sessionId, r.messageIndex, r.messageIndex))
        );
        return messages.flat();
      }
    }

    // Fallback: text search
    return this.storage.searchMessagesByText(sessionId, query, limit);
  }

  async deleteSession(sessionId: string, agentTokenId: string): Promise<boolean> {
    const result = await this.storage.deleteSession(sessionId, agentTokenId);

    if (this.vectorStore) {
      await this.vectorStore.delete('sessions', [sessionId]).catch(err =>
        logger.warn({ err, sessionId }, 'Failed to delete session vector'));
      await this.vectorStore.deleteByFilter('session_messages', {
        must: [{ key: 'session_id', match: { value: sessionId } }],
      }).catch(err =>
        logger.warn({ err, sessionId }, 'Failed to delete message vectors'));
    }

    return result;
  }
}
