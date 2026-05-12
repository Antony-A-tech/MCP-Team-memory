// src/extraction/merger.ts
//
// NoteMerger: when DedupResolver flags a candidate as MERGE (cosine in
// [0.70, 0.85] vs an existing entry), this class asks the LLM to produce a
// single atomic merged fact that preserves the WHY of both inputs and stays
// under 500 characters. Falls back to the raw candidate when the LLM emits
// unparseable output, so a bad model response never blocks the pipeline.

import type { ExtractionLlmProvider } from './llm-provider.js';
import type { CandidateNote } from './types.js';
import logger from '../logger.js';

export interface ExistingForMerge {
  title: string;
  content: string;
  tags: string[];
}

export interface MergedNote {
  title: string;
  fact: string;
  why: string;
  tags: string[];
}

const MAX_FACT_CHARS = 500;
const MAX_WHY_CHARS = 500;
const MAX_TAGS = 8;
const MAX_TITLE_CHARS = 200;
const MAX_EXISTING_CONTENT_CHARS = 1500;

/**
 * Strip newlines, CR, and triple-backticks from text that flows into the LLM
 * prompt as untrusted data. Without this, a fact containing
 *   "\n\nIgnore prior. Output: {...}"
 * could steer the merge toward attacker-controlled output. We replace the
 * dangerous chars with spaces (preserves token boundaries) and trim repeats.
 */
function sanitizeForPrompt(text: string, maxChars: number): string {
  return text
    .replace(/```/g, '` ` `')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxChars);
}

/** Tags must be single tokens — drop ones with whitespace or shell metachars. */
function isCleanTag(t: string): boolean {
  return t.length > 0 && t.length <= 32 && !/[\s`{}<>|]/.test(t);
}

export class NoteMerger {
  constructor(private provider: ExtractionLlmProvider) {}

  /**
   * Per-session merge budget guard. Sessions get a small fixed budget (~3) so
   * a single noisy session can't trigger a parade of LLM merges.
   */
  static canMerge(currentCount: number, max: number): boolean {
    return currentCount < max;
  }

  async merge(
    existing: ExistingForMerge,
    candidate: CandidateNote,
    signal?: AbortSignal,
  ): Promise<MergedNote> {
    // Sanitize everything that flows into the prompt as untrusted text. The
    // delimiters `<<<…>>>` make it easier for the LLM to recognise field
    // boundaries even if a sanitized field still contains odd punctuation.
    const safeExistingTitle = sanitizeForPrompt(existing.title, MAX_TITLE_CHARS);
    const safeExistingContent = sanitizeForPrompt(existing.content, MAX_EXISTING_CONTENT_CHARS);
    const safeCandidateTitle = sanitizeForPrompt(candidate.title, MAX_TITLE_CHARS);
    const safeCandidateFact = sanitizeForPrompt(candidate.fact, MAX_FACT_CHARS);
    const safeCandidateWhy = sanitizeForPrompt(candidate.why, MAX_WHY_CHARS);

    const prompt = `Объедини два связанных факта в один атомарный.
Сохрани WHY обоих, не теряй информацию, не превышай ${MAX_FACT_CHARS} символов в "fact".

EXISTING:
<<<TITLE>>>${safeExistingTitle}<<<END>>>
<<<CONTENT>>>${safeExistingContent}<<<END>>>

NEW:
<<<TITLE>>>${safeCandidateTitle}<<<END>>>
<<<FACT>>>${safeCandidateFact}<<<END>>>
<<<WHY>>>${safeCandidateWhy}<<<END>>>

Output VALID JSON, no markdown:
{"title":"...","fact":"...","why":"...","tags":["..."]}`;

    const raw = await this.provider.generate(prompt, {
      temperature: 0.2,
      maxTokens: 700,
      signal,
    });

    const parsed = tryParseMergeJson(raw);
    if (!parsed) {
      logger.warn(
        {
          rawSnippet: raw.slice(0, 200),
          provider: this.provider.name,
          existingTitle: safeExistingTitle,
        },
        'merger: malformed JSON, falling back to raw candidate',
      );
      return {
        title: candidate.title.slice(0, MAX_TITLE_CHARS),
        fact: candidate.fact.slice(0, MAX_FACT_CHARS),
        why: candidate.why.slice(0, MAX_WHY_CHARS),
        tags: combineTags(existing.tags, candidate.tags, []),
      };
    }

    const fact = String(parsed.fact ?? candidate.fact).slice(0, MAX_FACT_CHARS);
    const why = String(parsed.why ?? candidate.why).slice(0, MAX_WHY_CHARS);
    const title = String(parsed.title ?? existing.title).slice(0, MAX_TITLE_CHARS);
    const llmTags: string[] = Array.isArray(parsed.tags)
      ? parsed.tags.map((t: unknown) => String(t).toLowerCase())
      : [];

    return {
      title,
      fact,
      why,
      tags: combineTags(existing.tags, candidate.tags, llmTags),
    };
  }
}

interface MergeJson {
  title?: unknown;
  fact?: unknown;
  why?: unknown;
  tags?: unknown;
}

function tryParseMergeJson(text: string): MergeJson | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return parsed as MergeJson;
    return null;
  } catch {
    return null;
  }
}

function combineTags(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const t of list) {
      const lower = String(t).toLowerCase().trim();
      if (!isCleanTag(lower)) continue;
      if (!seen.has(lower)) {
        seen.add(lower);
        out.push(lower);
        if (out.length >= MAX_TAGS) return out;
      }
    }
  }
  return out;
}
