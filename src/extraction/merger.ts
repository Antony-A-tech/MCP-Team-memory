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
const MAX_TAGS = 8;

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
  ): Promise<MergedNote> {
    const prompt = `Объедини два связанных факта в один атомарный.
Сохрани WHY обоих, не теряй информацию, не превышай ${MAX_FACT_CHARS} символов в "fact".

EXISTING:
title: ${existing.title}
content: ${existing.content}

NEW:
title: ${candidate.title}
fact: ${candidate.fact}
why: ${candidate.why}

Output VALID JSON, no markdown:
{"title":"...","fact":"...","why":"...","tags":["..."]}`;

    const raw = await this.provider.generate(prompt, {
      temperature: 0.2,
      maxTokens: 700,
    });

    const parsed = tryParseMergeJson(raw);
    if (!parsed) {
      logger.warn(
        { rawSnippet: raw.slice(0, 200), provider: this.provider.name },
        'merger: malformed JSON, falling back to raw candidate',
      );
      return {
        title: candidate.title,
        fact: candidate.fact.slice(0, MAX_FACT_CHARS),
        why: candidate.why,
        tags: combineTags(existing.tags, candidate.tags, []),
      };
    }

    const fact = String(parsed.fact ?? candidate.fact).slice(0, MAX_FACT_CHARS);
    const llmTags = Array.isArray(parsed.tags)
      ? parsed.tags.map(t => String(t).toLowerCase())
      : [];

    return {
      title: String(parsed.title ?? existing.title),
      fact,
      why: String(parsed.why ?? candidate.why),
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
      const lower = String(t).toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        out.push(lower);
        if (out.length >= MAX_TAGS) return out;
      }
    }
  }
  return out;
}
