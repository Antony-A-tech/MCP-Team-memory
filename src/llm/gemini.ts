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

  async *stream(
    input: { messages: ChatMessage[]; tools?: ToolDeclaration[]; systemInstruction?: string },
    signal?: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const url = `${API_BASE}/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    const body: Record<string, unknown> = {
      contents: this.messagesToContents(input.messages),
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
    };
    if (input.systemInstruction) {
      body.systemInstruction = { parts: [{ text: input.systemInstruction }] };
    }
    if (input.tools && input.tools.length > 0) {
      body.tools = [{ functionDeclarations: input.tools }];
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (err: any) {
      yield { type: 'error', code: 'upstream_error', message: err?.message ?? 'Network error' };
      return;
    }

    if (!res.ok) {
      const errText = await res.text();
      const code = this.classifyHttpError(res.status);
      logger.warn({ status: res.status, model: this.model }, 'Gemini stream failed');
      yield { type: 'error', code, message: errText.slice(0, 200) };
      return;
    }

    if (!res.body) {
      yield { type: 'error', code: 'upstream_error', message: 'No response body' };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let usage: { promptTokens: number; completionTokens: number } | undefined;
    let emittedDone = false;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = event.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          const payload = line.slice(6).trim();
          if (!payload || payload === '[DONE]') continue;

          let parsed: any;
          try { parsed = JSON.parse(payload); } catch { continue; }

          const candidate = parsed.candidates?.[0];
          if (!candidate) continue;

          const finishReason = candidate.finishReason;
          if (finishReason === 'SAFETY') {
            yield { type: 'error', code: 'safety_block', message: 'Response blocked by safety filters' };
            emittedDone = true;
            break;
          }

          for (const part of candidate.content?.parts ?? []) {
            if (typeof part.text === 'string' && part.text.length > 0) {
              yield { type: 'text', delta: part.text };
            }
            if (part.functionCall) {
              yield {
                type: 'tool_call',
                call: {
                  id: this.makeCallId(),
                  name: part.functionCall.name,
                  args: part.functionCall.args ?? {},
                },
              };
            }
          }

          if (parsed.usageMetadata) {
            usage = {
              promptTokens: parsed.usageMetadata.promptTokenCount ?? 0,
              completionTokens: parsed.usageMetadata.candidatesTokenCount ?? 0,
            };
          }
        }
      }
    } catch (err: any) {
      yield { type: 'error', code: 'upstream_error', message: err?.message ?? 'Stream error' };
      return;
    }

    if (!emittedDone) yield { type: 'done', usage };
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

  private messagesToContents(messages: ChatMessage[]): any[] {
    return messages
      .filter(m => m.role !== 'system')  // systemInstruction is handled separately
      .map(m => {
        if (m.role === 'user') {
          return { role: 'user', parts: [{ text: m.content }] };
        }
        if (m.role === 'assistant') {
          const parts: any[] = [];
          if (m.content) parts.push({ text: m.content });
          for (const tc of m.toolCalls ?? []) {
            parts.push({ functionCall: { name: tc.name, args: tc.args } });
          }
          return { role: 'model', parts };
        }
        // tool
        return {
          role: 'user',
          parts: [{
            functionResponse: {
              name: m.toolName ?? 'unknown',
              response: this.parseToolResult(m.content),
            },
          }],
        };
      });
  }

  private parseToolResult(content: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(content);
      return typeof parsed === 'object' && parsed !== null ? parsed : { result: parsed };
    } catch {
      return { result: content };
    }
  }

  private makeCallId(): string {
    return 'call_' + Math.random().toString(36).slice(2, 12);
  }
}
