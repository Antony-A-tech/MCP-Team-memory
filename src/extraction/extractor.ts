// src/extraction/extractor.ts
//
// NoteExtractor: runs the extraction prompt against an `ExtractionLlmProvider`,
// parses JSON output (with one retry on malformed responses), applies
// server-side filters, and caps the final list to `maxNotesPerSession`.

import type { ExtractionLlmProvider } from './llm-provider.js';
import type { CandidateNote, ExtractionResult } from './types.js';
import { buildExtractionPrompt, type BuildExtractionPromptInput } from './prompt.js';
import logger from '../logger.js';

export interface ExtractorConfig {
  /** Drop candidates with confidence below this. */
  minConfidence: number;
  /** Drop candidates whose explicit_marker_strength is below this. */
  minMarkerStrength: number;
  minFactLen: number;
  maxFactLen: number;
  /** Hard upper bound on the number of accepted candidates per session. */
  maxNotesPerSession: number;
}

const DEFAULTS: ExtractorConfig = {
  minConfidence: 0.6,
  minMarkerStrength: 0.3,
  minFactLen: 30,
  maxFactLen: 500,
  maxNotesPerSession: 5,
};

export class NoteExtractor {
  private cfg: ExtractorConfig;
  constructor(
    private provider: ExtractionLlmProvider,
    cfg: Partial<ExtractorConfig> = {},
  ) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  async extract(
    input: BuildExtractionPromptInput & { signal?: AbortSignal },
  ): Promise<ExtractionResult> {
    const prompt = buildExtractionPrompt(input);

    let raw = await this.provider.generate(prompt, {
      temperature: 0.2,
      maxTokens: 1500,
      signal: input.signal,
    });
    let parsed = tryParseJson(raw);

    if (!parsed) {
      logger.warn(
        { rawSnippet: raw.slice(0, 200), provider: this.provider.name },
        'extractor: malformed JSON, retrying with stricter prompt',
      );
      raw = await this.provider.generate(
        prompt + '\n\nReturn ONLY valid JSON, no markdown fences, no commentary.',
        { temperature: 0.0, maxTokens: 1500, signal: input.signal },
      );
      parsed = tryParseJson(raw);
    }

    if (!parsed) {
      logger.warn(
        { provider: this.provider.name },
        'extractor: still malformed after retry, returning empty result',
      );
      return {
        candidates: [],
        rejected: [],
        llm_input_chars: prompt.length,
        llm_output_chars: raw.length,
      };
    }

    const all = collectCandidates(parsed);

    const accepted: CandidateNote[] = [];
    const rejected: ExtractionResult['rejected'] = [];
    for (const c of all) {
      const reason = this.reject(c);
      if (reason) rejected.push({ candidate: c, reason });
      else accepted.push(c);
    }

    accepted.sort(
      (a, b) =>
        b.confidence * b.explicit_marker_strength -
        a.confidence * a.explicit_marker_strength,
    );
    const capped = accepted.slice(0, this.cfg.maxNotesPerSession);

    return {
      candidates: capped,
      rejected,
      llm_input_chars: prompt.length,
      llm_output_chars: raw.length,
    };
  }

  private reject(c: CandidateNote): string | null {
    if (c.confidence < this.cfg.minConfidence) {
      return `confidence ${c.confidence} < ${this.cfg.minConfidence}`;
    }
    if (c.explicit_marker_strength < this.cfg.minMarkerStrength) {
      return `marker_strength ${c.explicit_marker_strength} < ${this.cfg.minMarkerStrength}`;
    }
    if (c.fact.length < this.cfg.minFactLen) {
      return `fact too short (${c.fact.length} < ${this.cfg.minFactLen})`;
    }
    if (c.fact.length > this.cfg.maxFactLen) {
      return `fact too long (${c.fact.length} > ${this.cfg.maxFactLen})`;
    }
    if (c.title.length < 5) return 'title too short';
    if (c.tags.length < 1) return 'no tags';
    return null;
  }
}

function collectCandidates(parsed: unknown): CandidateNote[] {
  if (parsed === null || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;
  const out: CandidateNote[] = [];

  // v5: primary input is { knowledge: [...] }
  const knowledgeArr = obj.knowledge;
  if (Array.isArray(knowledgeArr)) {
    for (const it of knowledgeArr) {
      if (!it || typeof it !== 'object') continue;
      const item = it as Record<string, unknown>;
      out.push({
        category: 'knowledge',
        title: String(item.title ?? ''),
        fact: String(item.fact ?? ''),
        why: String(item.why ?? ''),
        tags: Array.isArray(item.tags)
          ? item.tags.map(t => String(t).toLowerCase())
          : [],
        confidence: Number(item.confidence ?? 0),
        explicit_marker_strength: Number(item.explicit_marker_strength ?? 0),
      });
    }
  }

  // Legacy fallback: { architecture: [...], decisions: [...], conventions: [...] }
  // Auto-derive a kind tag from the array key.
  const legacyKeys: Array<{ key: string; tag: string }> = [
    { key: 'architecture', tag: 'architecture' },
    { key: 'decisions', tag: 'decision' },
    { key: 'conventions', tag: 'convention' },
  ];
  for (const { key, tag } of legacyKeys) {
    const arr = obj[key];
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const item = it as Record<string, unknown>;
      const existingTags = Array.isArray(item.tags)
        ? item.tags.map(t => String(t).toLowerCase())
        : [];
      const tags = existingTags.includes(tag) ? existingTags : [tag, ...existingTags];
      out.push({
        category: 'knowledge',
        title: String(item.title ?? ''),
        fact: String(item.fact ?? ''),
        why: String(item.why ?? ''),
        tags,
        confidence: Number(item.confidence ?? 0),
        explicit_marker_strength: Number(item.explicit_marker_strength ?? 0),
      });
    }
  }

  return out;
}

function tryParseJson(text: string): unknown | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
