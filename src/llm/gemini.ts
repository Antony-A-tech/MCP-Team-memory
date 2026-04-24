import type { ChatLlmProvider, ProviderEvent, ToolDeclaration } from './chat-provider.js';
import type { ChatMessage } from '../chat/types.js';
import logger from '../logger.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 60_000;

export class GeminiChatProvider implements ChatLlmProvider {
  readonly name: string;
  private apiKey: string;
  private model: string;

  constructor(opts: { apiKey: string; model: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.name = opts.model;
  }

  isReady(): boolean {
    return this.apiKey.length > 0;
  }

  async generate(
    input: { prompt: string; maxTokens?: number; temperature?: number },
    signal?: AbortSignal,
  ): Promise<string> {
    const url = `${API_BASE}/${this.model}:generateContent?key=${this.apiKey}`;
    const body = {
      contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
      generationConfig: {
        maxOutputTokens: input.maxTokens ?? 200,
        temperature: input.temperature ?? 0.3,
      },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.warn({ status: res.status, model: this.model }, 'Gemini generate failed');
      throw new Error(`${this.classifyHttpError(res.status)}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json() as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return text.trim();
  }

  // stream() is implemented in Task 8 — stub that throws for now
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<ProviderEvent> {
    throw new Error('stream() not yet implemented');
  }

  async close(): Promise<void> {
    // no-op
  }

  private classifyHttpError(status: number): string {
    if (status === 401 || status === 403) return 'api_key_invalid';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'upstream_error';
    return 'upstream_error';
  }
}
