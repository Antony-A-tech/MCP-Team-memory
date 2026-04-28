// src/extraction/llm-provider.ts
//
// Thin adapter layer around the project's chat LLM clients (Gemini, Ollama)
// so the auto-notes extractor can talk to either one without depending on
// chat-specific message/tool plumbing. The extractor is single-shot
// prompt → text, so we only need a `generate()` surface here.

import type { GeminiChatProvider } from '../llm/gemini.js';
import type { OllamaLlmClient } from '../llm/ollama.js';
import logger from '../logger.js';

export interface ExtractionGenerateOptions {
  /** 0..1, kept low for deterministic JSON output. */
  temperature: number;
  /** Upper bound on response tokens. ~1500 leaves room for 5 candidates. */
  maxTokens: number;
  /** Optional cancellation. */
  signal?: AbortSignal;
}

export interface ExtractionLlmProvider {
  readonly name: string;
  isReady(): boolean;
  /**
   * Run a one-shot prompt and return raw text. The caller (NoteExtractor)
   * is responsible for JSON parsing and retry on malformed output.
   */
  generate(prompt: string, opts: ExtractionGenerateOptions): Promise<string>;
}

export class GeminiExtractionProvider implements ExtractionLlmProvider {
  readonly name: string;
  constructor(private readonly chat: GeminiChatProvider) {
    this.name = chat.name;
  }
  isReady(): boolean {
    return this.chat.isReady();
  }
  async generate(prompt: string, opts: ExtractionGenerateOptions): Promise<string> {
    return this.chat.generate(
      { prompt, temperature: opts.temperature, maxTokens: opts.maxTokens },
      opts.signal,
    );
  }
}

export class OllamaExtractionProvider implements ExtractionLlmProvider {
  readonly name: string;
  constructor(private readonly client: OllamaLlmClient) {
    this.name = client.modelName;
  }
  isReady(): boolean {
    return this.client.isReady();
  }
  async generate(prompt: string, opts: ExtractionGenerateOptions): Promise<string> {
    if (opts.signal?.aborted) {
      throw new Error('Extraction LLM call aborted before start');
    }
    return this.client.generate(prompt, {
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    });
  }
}

/**
 * Pick the best available provider given the configured preference and which
 * clients are wired up at runtime. Falls back to whichever is ready when the
 * preferred one is missing. Returns null when neither is available — caller
 * should treat extraction as disabled.
 */
export function pickExtractionProvider(
  gemini: GeminiChatProvider | null,
  ollama: OllamaLlmClient | undefined,
  configured: 'gemini' | 'ollama',
): ExtractionLlmProvider | null {
  if (configured === 'gemini' && gemini && gemini.isReady()) {
    return new GeminiExtractionProvider(gemini);
  }
  if (configured === 'ollama' && ollama && ollama.isReady()) {
    return new OllamaExtractionProvider(ollama);
  }
  // Fallback chain: prefer Gemini, then Ollama.
  if (gemini && gemini.isReady()) return new GeminiExtractionProvider(gemini);
  if (ollama && ollama.isReady()) return new OllamaExtractionProvider(ollama);
  logger.warn(
    { configured },
    'No extraction LLM provider available — auto-notes extraction will be skipped',
  );
  return null;
}
