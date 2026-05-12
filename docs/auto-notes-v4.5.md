# Auto-Notes (v4.5) — User Guide

This document describes the v4.5 release that replaces the manual
`memory_write` MCP tool with two kinds of automated paths.

## What changed

| Before v4.5 | v4.5 |
|---|---|
| Agents call `memory_write` directly | `memory_write` returns 410-Gone |
| Categories: 6 (`architecture`, `tasks`, `decisions`, `issues`, `progress`, `conventions`) | Active: `architecture`, `decisions`, `conventions`. Deprecated: `tasks`, `progress`, `issues` |
| Manual write only | Two paths: manual share + auto-extract |
| No dedup; same fact written multiple times | Cosine-similarity dedup with CONFIRM / MERGE / CREATE_NEW |
| No decay rule for low-evidence entries | Singleton auto-records archive after 30 days unless re-confirmed |
| `evidence_sources` empty | Every entry tracks where the evidence came from |

## Two replacement paths

### 1. Manual share (intentional)

```
note_write {title, content, tags, project_id}
   ↓
note_share {note_id, category, on_match}
   ↓
team-memory entry (pinned, auto_generated=true, evidence='personal_note:<id>')
```

Web UI also exposes a "Расшарить" button on every personal note card.

The `on_match` parameter controls behaviour when dedup finds a similar
existing entry:

- `prompt` (default) — return the match without writing; UI confirms with
  the user before re-submitting as `confirm_existing`.
- `confirm_existing` — increment `confirmation_count` and append the new
  evidence source.
- `merge` — call the merger LLM to atomically combine into a single
  ≤500-char fact, preserving the WHY of both inputs.
- `create_new` — ignore the match and insert a new pinned entry anyway.

Manual shares are **pinned by default** so the singleton-auto-decay rule
won't archive them after 30 days — agents who manually publish are saying
"this is important," and the system trusts that.

### 2. Auto-extraction (background)

```
session_import { messages, summary, project_id }
   ↓
worker: queued → summarizing → embedding → extracting_notes → complete
                                                   ↓
                                       NoteExtractor (LLM)
                                                   ↓
                                       DedupResolver (Qdrant cosine)
                                                   ↓
                                CONFIRM existing | MERGE | CREATE_NEW
```

The extractor only emits **atomic, why-bearing** facts in the three durable
categories (`architecture`, `decisions`, `conventions`). Each candidate
must satisfy:

- **Atomic**: one statement, not a paragraph.
- **WHY**, not WHAT: explains rationale, not just what's already in code.
- **Reusable**: durable beyond this session's specific bug.
- **30–500 characters** in the `fact` field.
- **Confidence ≥ 0.6** and **explicit_marker_strength ≥ 0.3** (defaults).

Routine work that produces no atomic facts results in **zero candidates** —
this is the expected outcome for most sessions. The extractor is silent;
nothing is written.

## Dedup thresholds

```
cosine > 0.85           → CONFIRM existing entry
0.70 ≤ cosine ≤ 0.85    → MERGE candidate into existing
cosine < 0.70           → CREATE_NEW
```

Boundaries fall into MERGE (the conservative branch). MERGE is capped at
3 per session by default — exhausted MERGE decisions fall back to CONFIRM
so the signal isn't lost.

## Importance score & decay

Each entry now carries an **importance_score** (0..1) recomputed nightly:

```
0.4 × min(confirmation_count / 5, 1)
+ 0.3 × exp(-days_since_last_confirmed / 60)
+ 0.2 × explicit_marker_strength
+ 0.1 × min(unique_evidence_authors / 3, 1)
```

`memory_read` orders by `pinned DESC, importance_score DESC, updated_at DESC`,
so high-importance auto-records surface above stale ones.

The **singleton-auto-decay** rule archives entries that are:

- `auto_generated = true`
- `pinned = false`
- `confirmation_count = 1`
- `created_at` older than `AUTO_DECAY_DAYS` (default 30)
- `last_confirmed_at IS NULL` (never re-confirmed)

Manual shares are pinned so they're immune. Multi-confirmed auto-records
are immune (count > 1). The rule only sweeps "one-time mentions that
nobody ever validated."

## Privacy

- **personal_note evidence**: when an entry's `evidence_sources` includes
  a `personal_note` source, the note's `id` is stripped before exposure
  on the read API. `shared_by` (the agent token id) is kept since
  authorship is already public.
- **Session messages**: agent-scoped only. The `MessagesSource` retriever
  refuses to run without an `agent_token_id` filter and additionally
  validates `session.projectId` matches the requested project — preventing
  cross-project content leaks.

## Backfill past sessions

Re-run extraction over already-imported sessions:

```bash
node scripts/backfill-extract-notes.cjs --project=<uuid> --limit=50 --dry-run
```

Drop `--dry-run` to actually flip the sessions back to
`embedding_status='extracting_notes'`. The running worker picks them up;
a session-level idempotency guard prevents duplicate auto-entries.

## Configuration

All knobs are environment variables — see the README for the full list.
Common ones:

```sh
EXTRACT_NOTES_ENABLED=true             # set false to disable auto-extraction
EXTRACT_LLM_PROVIDER=gemini            # or 'ollama'
EXTRACT_MIN_CONFIDENCE=0.6
EXTRACT_MIN_MARKER_STRENGTH=0.3
EXTRACT_MAX_NOTES_PER_SESSION=5
EXTRACT_MAX_MERGES_PER_SESSION=3
DEDUP_CONFIRM_THRESHOLD=0.85
DEDUP_MERGE_THRESHOLD=0.7
AUTO_DECAY_DAYS=30
```

## Operational notes

### `memory_conventions` carve-out

The `memory_conventions add` MCP action still calls `MemoryManager.write()`
directly. This is intentional: conventions are an opinionated, low-volume,
high-importance subset that doesn't fit the dedup-then-share flow (you
don't want a "prompt for match" UX every time the team agrees on a naming
rule). Conventions written this way are still subject to importance
scoring and search ordering — they're just not gated on dedup.

### Re-embed best-effort caveat

`mergeIntoExisting` calls `vectorStore.upsert` fire-and-forget. If Qdrant
is briefly unavailable during a merge, the entry stays in PostgreSQL with
a stale vector — it's still findable via FTS, just not via vector search
until the next manual re-embed or the pgvector backfill catches up at
boot. Future v4.5.x will add an `embedding_status` column on entries to
make this gap observable.

### WebSocket events to v4.4 clients

`memory:created`/`memory:updated` events for v4.5 entries carry the new
`auto_generated`, `confirmation_count`, `importance_score`,
`evidence_sources` (sanitized), `external_refs` fields. Older v4.4 clients
that destructure the payload should be unaffected (extra fields are
forward-compatible JSON), but UI code that assumes the old field set
should be reviewed.

### Production rollout runbook

1. **Apply migrations** — `npm run build && node dist/scripts/migrate.js`
   (migrations 018, 019, 020 are forward-only; rollback SQL is in
   `src/storage/migrations/rollbacks/`).
2. **Deploy with `EXTRACT_NOTES_ENABLED=false` first** — observe one
   import cycle, then flip to `true`. Lets you validate the new
   migrations on real data without LLM cost.
3. **Watch for the first 24 h:**
   - `SELECT embedding_status, COUNT(*) FROM sessions GROUP BY 1` —
     should show no permanent `extraction_failed` build-up;
   - Tail logs for `'extraction applied'` and `'singleton auto-entries
     archived'` to confirm both paths fire;
   - Compare `SELECT COUNT(*) FROM entries WHERE auto_generated`
     before/after each session import day to see extraction yield.
4. **Cost monitoring** — Gemini extraction costs roughly the same as
   summary generation (one prompt per session, ~1500 tokens output max).
   Set `EXTRACT_LLM_PROVIDER=ollama` if costs spike.
5. **Disable / rollback** — flip `EXTRACT_NOTES_ENABLED=false`. Existing
   auto-extracted entries keep working; the pipeline just skips the
   extracting-notes step. Hard rollback: run rollbacks/018, 019, 020 in
   reverse order.
6. **Backfill past sessions** — once stable, run
   `node scripts/backfill-extract-notes.cjs --limit=50 --dry-run` to
   preview, then drop `--dry-run`. The session-level idempotency guard
   makes the script safe to re-run.

## Migration from v4.x

Existing entries are unchanged. The new columns
(`auto_generated`, `extraction_confidence`, `confirmation_count`,
`evidence_sources`, `external_refs`, `importance_score`, `last_confirmed_at`,
`explicit_marker_strength`) are added by migration `018-auto-notes.sql`
with sensible defaults: existing entries get `auto_generated=false`,
`confirmation_count=1`, `importance_score=0.5`, `evidence_sources=[]`.

The next nightly importance recompute pass will give every existing entry
a real score.

Direct callers of the deprecated `memory_write` MCP tool now receive a
410-style error message pointing them at `note_write`+`note_share` or
`session_import`. Update automation accordingly.
