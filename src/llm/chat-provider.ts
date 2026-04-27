import type { ChatMessage, ToolCall } from '../chat/types.js';

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // Gemini-compatible JSON schema subset
}

// Events emitted by the provider during streaming (low-level, LLM-only)
export type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; usage?: { promptTokens: number; completionTokens: number } }
  | { type: 'error'; code: string; message: string };

// Events RagAgent emits to SSE (superset: includes tool_start/tool_end
// which are wrapped around provider-level tool_call events)
export type SseEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; summary?: string; error?: string }
  | { type: 'done'; usage?: { promptTokens: number; completionTokens: number } }
  | { type: 'error'; code: string; message: string };

export interface ChatLlmProvider {
  readonly name: string;
  isReady(): boolean;
  stream(
    input: { messages: ChatMessage[]; tools?: ToolDeclaration[]; systemInstruction?: string },
    signal?: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
  /** Non-streaming one-shot. Used for title generation. */
  generate(
    input: { prompt: string; maxTokens?: number; temperature?: number },
    signal?: AbortSignal,
  ): Promise<string>;
  close(): Promise<void>;
}
