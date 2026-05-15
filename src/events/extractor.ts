import type { InsertEventParams, EventType } from './types.js';
import { EVENT_TYPES } from './types.js';
import { sampleMessagesForPrompt, detectLang } from '../extraction/prompt.js';

export interface BuildEventsPromptInput {
  summary: string;
  messages: Array<{ role: string; content: string }>;
}

export function buildEventsPrompt(input: BuildEventsPromptInput): string {
  const sampled = sampleMessagesForPrompt(input.messages);
  const conversation = sampled.map(m => `[${m.role}]: ${m.content.slice(0, 300)}`).join('\n');
  const lang = detectLang(input.summary + ' ' + conversation);

  return `You analyze a development session and extract concrete events that happened
during it. Events are WHAT-facts (something completed, deployed, broke) — NOT
WHY-knowledge (architecture decisions, conventions).

Event types you may extract:
- "merge"     — a branch/PR was merged into main (e.g. "смержил feat/X в main", "merged #42")
- "release"   — a version was released (e.g. "релиз v4.5", "tagged v1.2.0")
- "deploy"    — code was deployed to an environment (e.g. "задеплоил на staging")
- "incident"  — production issue / outage / bug discovered
- "milestone" — a major work milestone reached (e.g. "Phase 3 готова", "MVP закрыт")

For each event provide:
- "event_type": one of the 5 above
- "occurred_at": ISO timestamp when it happened (use session date if not explicit)
- "title": short identifier in ${lang}, 5-15 words
- "description": optional 1-2 sentences in ${lang}
- "refs": object — { pr_number, commit_sha, version_tag, deployment_url, incident_id } — include only what is mentioned
- "actor": who did it (only if explicitly named)
- "confidence": 0.0-1.0

ONLY extract events EXPLICITLY stated as having happened (past tense in completion context).
Do NOT extract:
- Plans ("надо смержить") — these are future
- Failures/blockers — those are incidents only if they hit prod
- Routine progress ("сделал task 5") — too noisy

If no events — return empty array. Empty is correct.

Output VALID JSON, no markdown:
{"events":[...]}

Session summary:
${input.summary}

Session transcript:
${conversation}`;
}

// Default confidence threshold for accepting an LLM-extracted event.
// Lowered from 0.7 → 0.55 after backfill of ~1000 sessions yielded only
// 2 events: confidence below 0.7 happens often on routine sessions (bug
// fix / refactor) where the model is uncertain whether the work is "an
// event" — recall trade-off documented in scope-note 0593646d.
// Can be overridden per-call (e.g. an admin tool that wants strict 0.7).
// Env override: TM_EVENTS_MIN_CONFIDENCE (read by caller and passed in).
export const EVENTS_MIN_CONFIDENCE_DEFAULT = 0.55;

export class EventsParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'EventsParseError';
  }
}

/**
 * Strict variant of parseEventsResponse: throws EventsParseError when the
 * input can't be parsed as JSON or doesn't have the expected shape.
 *
 * Used by the extraction pipeline so it can retry once with backoff
 * before giving up. The non-strict parseEventsResponse() wraps this and
 * returns [] on any failure, preserving backwards compatibility with
 * callers that don't care about the distinction.
 */
export function parseEventsResponseStrict(
  raw: string,
  opts: { minConfidence?: number } = {},
): InsertEventParams[] {
  const minConf = opts.minConfidence ?? EVENTS_MIN_CONFIDENCE_DEFAULT;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new EventsParseError('events response is not valid JSON', err);
  }
  if (!obj || typeof obj !== 'object') {
    throw new EventsParseError('events response is not a JSON object');
  }
  const eventsField = (obj as { events?: unknown }).events;
  if (!Array.isArray(eventsField)) {
    throw new EventsParseError('events response missing `events` array');
  }
  return filterValidEvents(eventsField, minConf);
}

export function parseEventsResponse(
  raw: string,
  opts: { minConfidence?: number } = {},
): InsertEventParams[] {
  const minConf = opts.minConfidence ?? EVENTS_MIN_CONFIDENCE_DEFAULT;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== 'object') return [];
  const eventsField = (obj as { events?: unknown }).events;
  if (!Array.isArray(eventsField)) return [];
  return filterValidEvents(eventsField, minConf);
}

function filterValidEvents(eventsField: unknown[], minConf: number): InsertEventParams[] {
  const result: InsertEventParams[] = [];
  for (const ev of eventsField) {
    if (!ev || typeof ev !== 'object') continue;
    const e = ev as Record<string, unknown>;
    if (!EVENT_TYPES.includes(e.event_type as EventType)) continue;
    if (typeof e.title !== 'string' || !e.title.trim()) continue;
    if (typeof e.occurred_at !== 'string') continue;
    if (typeof e.confidence !== 'number' || e.confidence < minConf) continue;

    result.push({
      projectId: '',
      eventType: e.event_type as EventType,
      occurredAt: e.occurred_at,
      title: (e.title as string).trim(),
      description: typeof e.description === 'string' ? e.description : undefined,
      refs: typeof e.refs === 'object' && e.refs !== null ? (e.refs as Record<string, unknown>) : {},
      actor: typeof e.actor === 'string' ? e.actor : undefined,
      autoGenerated: true,
    });
  }
  return result;
}
