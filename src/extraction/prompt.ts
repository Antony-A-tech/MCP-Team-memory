// src/extraction/prompt.ts
//
// Builder for the auto-notes extraction prompt and helpers it depends on:
//   - language detection (Russian vs English) so the LLM produces output in the
//     same language the team writes their session in
//   - message sampling so very long sessions still fit in a single LLM call
//
// Pure functions, no I/O — easy to unit test.

const MAX_MESSAGES_FIRST = 10;
const MAX_MESSAGES_LAST = 10;
const MAX_MESSAGES_MIDDLE = 20;
const MAX_MESSAGE_CHARS = 300;

const RUSSIAN_THRESHOLD = 0.15;

export type PromptLanguage = 'Russian' | 'English';

export function detectLang(text: string): PromptLanguage {
  const filtered = text.replace(/[^a-zA-Zа-яА-ЯёЁ]/g, '');
  if (filtered.length === 0) return 'English';
  const cyrillic = (filtered.match(/[а-яА-ЯёЁ]/g) ?? []).length;
  return cyrillic / filtered.length > RUSSIAN_THRESHOLD ? 'Russian' : 'English';
}

/**
 * Down-sample a list of session messages to at most
 * `MAX_MESSAGES_FIRST + MAX_MESSAGES_MIDDLE + MAX_MESSAGES_LAST` items, always
 * preserving the very first and very last messages so the prompt sees both how
 * the session opened and how it ended.
 */
export function sampleMessagesForPrompt<T extends { role: string; content: string }>(
  messages: T[],
): T[] {
  const cap = MAX_MESSAGES_FIRST + MAX_MESSAGES_LAST + MAX_MESSAGES_MIDDLE;
  if (messages.length <= cap) return messages;

  const first = messages.slice(0, MAX_MESSAGES_FIRST);
  const last = messages.slice(-MAX_MESSAGES_LAST);
  const middle = messages.slice(MAX_MESSAGES_FIRST, -MAX_MESSAGES_LAST);
  const step = Math.max(1, Math.ceil(middle.length / MAX_MESSAGES_MIDDLE));
  const middleSampled = middle.filter((_, i) => i % step === 0).slice(0, MAX_MESSAGES_MIDDLE);
  return [...first, ...middleSampled, ...last];
}

export interface BuildExtractionPromptInput {
  summary: string;
  messages: Array<{ role: string; content: string }>;
  projectId?: string;
  gitBranch?: string;
}

export function buildExtractionPrompt(input: BuildExtractionPromptInput): string {
  const sampled = sampleMessagesForPrompt(input.messages);
  const conversation = sampled
    .map(m => `[${m.role}]: ${m.content.slice(0, MAX_MESSAGE_CHARS)}`)
    .join('\n');
  const lang = detectLang(input.summary + ' ' + conversation);

  return `You analyze a development session and extract ONLY atomic facts
worth preserving as long-term team knowledge.

Output schema: a single JSON object with one key "knowledge" whose value
is an array of facts. Each fact MUST include exactly one kind tag in its
"tags" array, one of:
  - "architecture" — system invariants, contracts, structural patterns
  - "decision"     — explicit "why X, not Y" choices the team committed to
  - "convention"   — rules, standards, agreed-upon practices

Each fact MUST satisfy:
- Atomic: one statement, not a paragraph of multiple ideas.
- Explains WHY (rationale, constraint, trade-off), not just WHAT
  (what's already in code, commits, PRs).
- Reusable beyond this session's specific bug or task.
- Length 30-500 characters in the "fact" field.

For each fact provide:
- "title": short identifier (5-10 words), language: ${lang}
- "fact": the WHY statement, language: ${lang}
- "why": background/rationale (1-2 sentences), language: ${lang}
- "tags": 2-5 lowercase tags. MUST contain exactly one of: architecture, decision, convention.
- "confidence": 0.0-1.0 — how confident you are this is a real durable fact
- "explicit_marker_strength": 0.0-1.0 — how clearly the session marks this
  as a closure (phrases like "решили", "договорились", "конвенция",
  "итого", "root cause", final user "ОК так и делаем") vs casual mention

If the session contains no such facts — return empty array.
Empty output is correct and expected for routine work.

Output VALID JSON, no markdown, no commentary:
{"knowledge":[...]}

Session summary:
${input.summary}

Session transcript (sample):
${conversation}`;
}
