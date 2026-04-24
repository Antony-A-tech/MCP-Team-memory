import type { ChatLlmProvider, SseEvent } from '../llm/chat-provider.js';
import type { McpToolAdapter } from './tool-adapter.js';
import type { ChatManager } from '../chat/manager.js';
import type { ChatSessionWithMessages, ChatMessage, ToolCall } from '../chat/types.js';
import { ToolError } from './tool-adapter.js';
import logger from '../logger.js';

const SYSTEM_PROMPT = `Ты — RAG-ассистент проекта Team Memory. У тебя есть инструменты для чтения памяти текущего проекта: решений, задач, проблем, архитектуры, заметок, сессий.

Правила:
1. ПЕРЕД ответом ВСЕГДА проверь память — вызывай инструменты вместо того чтобы угадывать или полагаться на общие знания.
2. Цитируй источник: упоминай ID записи/сессии или её заголовок, когда ссылаешься.
3. Если поиск не дал результата — скажи об этом прямо, не выдумывай.
4. Отвечай на языке пользователя.
5. Краткость — до 300 слов, если не просят развёрнуто.`;

const ONBOARD_MAX_CHARS = 8_000;

export interface RagAgentConfig {
  provider: ChatLlmProvider;
  adapter: McpToolAdapter;
  chatManager: ChatManager;
  maxIterations: number;
}

export class RagAgent {
  constructor(private cfg: RagAgentConfig) {}

  async *run(
    session: ChatSessionWithMessages,
    userMessage: string,
    signal?: AbortSignal,
  ): AsyncIterable<SseEvent> {
    const { provider, adapter, chatManager, maxIterations } = this.cfg;
    const runStart = Date.now();
    let iterations = 0;
    const toolsCalled: string[] = [];
    const aggregateUsage = { promptTokens: 0, completionTokens: 0 };

    // 1. Onboard (once per chat session)
    let systemPrompt = SYSTEM_PROMPT;
    if (!session.onboardInjected) {
      try {
        const onboard = await adapter.call('memory_onboard', {}) as string;
        const truncated = typeof onboard === 'string' ? onboard.slice(0, ONBOARD_MAX_CHARS) : '';
        systemPrompt += '\n\nКонтекст проекта:\n' + truncated;
        const sysMsg: ChatMessage = { role: 'system', content: systemPrompt };
        await chatManager.appendMessage(session.id, sysMsg);
        await chatManager.markOnboarded(session.id);
        session.messages.unshift(sysMsg as any);
        session.onboardInjected = true;
      } catch (err: any) {
        logger.warn({ err: err?.message, sessionId: session.id }, 'Onboard failed; continuing without project context');
      }
    } else {
      const existingSystem = session.messages.find(m => m.role === 'system');
      if (existingSystem) systemPrompt = existingSystem.content;
    }

    // 2. User message
    const userMsg: ChatMessage = { role: 'user', content: userMessage };
    await chatManager.appendMessage(session.id, userMsg);
    session.messages.push(userMsg as any);
    await chatManager.touch(session.id);

    // 3. Agent loop
    for (let iter = 0; iter < maxIterations; iter++) {
      iterations = iter + 1;
      const windowMessages = chatManager.rollingWindow(session.messages as ChatMessage[]);
      const stream = provider.stream({
        messages: windowMessages,
        tools: adapter.declarations,
        systemInstruction: systemPrompt,
      }, signal);

      const pendingCalls: ToolCall[] = [];
      let assistantText = '';
      let providerError: { code: string; message: string } | null = null;

      for await (const ev of stream) {
        if (ev.type === 'text') {
          assistantText += ev.delta;
          yield ev;
        } else if (ev.type === 'tool_call') {
          pendingCalls.push(ev.call);
        } else if (ev.type === 'error') {
          providerError = { code: ev.code, message: ev.message };
          break;
        } else if (ev.type === 'done') {
          if (ev.usage) {
            aggregateUsage.promptTokens += ev.usage.promptTokens;
            aggregateUsage.completionTokens += ev.usage.completionTokens;
          }
          break;
        }
      }

      if (providerError) {
        yield { type: 'error', code: providerError.code, message: providerError.message };
        return;
      }

      if (pendingCalls.length > 0) {
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: assistantText,
          toolCalls: pendingCalls,
        };
        await chatManager.appendMessage(session.id, assistantMsg);
        session.messages.push(assistantMsg as any);

        for (const call of pendingCalls) {
          toolsCalled.push(call.name);
          yield { type: 'tool_start', id: call.id, name: call.name, args: call.args };
          try {
            const serialized = await adapter.callAsSerializedString(call.name, call.args);
            const toolMsg: ChatMessage = {
              role: 'tool',
              content: serialized,
              toolCallId: call.id,
              toolName: call.name,
            };
            await chatManager.appendMessage(session.id, toolMsg);
            session.messages.push(toolMsg as any);
            yield {
              type: 'tool_end',
              id: call.id,
              name: call.name,
              ok: true,
              summary: this.summarizeForUi(call.name, serialized),
            };
          } catch (err: any) {
            const errCode = err instanceof ToolError ? err.code : 'tool_failure';
            const errMsg = err?.message ?? String(err);
            const errPayload = JSON.stringify({ error: errMsg, code: errCode });
            const toolMsg: ChatMessage = {
              role: 'tool',
              content: errPayload,
              toolCallId: call.id,
              toolName: call.name,
            };
            await chatManager.appendMessage(session.id, toolMsg);
            session.messages.push(toolMsg as any);
            yield {
              type: 'tool_end',
              id: call.id,
              name: call.name,
              ok: false,
              error: errMsg,
            };
          }
        }
        continue;
      }

      // No tool calls → final answer
      if (assistantText.trim().length > 0) {
        const finalMsg: ChatMessage = { role: 'assistant', content: assistantText };
        await chatManager.appendMessage(session.id, finalMsg);
        session.messages.push(finalMsg as any);
      }
      logger.info({
        chatSessionId: session.id,
        projectId: session.projectId,
        iterations,
        toolsCalled,
        totalLatencyMs: Date.now() - runStart,
        promptTokens: aggregateUsage.promptTokens,
        completionTokens: aggregateUsage.completionTokens,
      }, 'RagAgent run completed');
      yield { type: 'done', usage: aggregateUsage };
      return;
    }

    logger.warn({
      chatSessionId: session.id,
      iterations,
      toolsCalled,
    }, 'RagAgent exceeded max iterations');
    yield { type: 'error', code: 'max_iterations', message: `Agent exceeded ${maxIterations} iterations` };
  }

  private summarizeForUi(toolName: string, serialized: string): string {
    try {
      const parsed = JSON.parse(serialized);
      if (Array.isArray(parsed)) return `${parsed.length} записей`;
      if (typeof parsed === 'string') return parsed.length > 60 ? parsed.slice(0, 60) + '…' : parsed;
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray((parsed as any).changes)) return `${(parsed as any).changes.length} изменений`;
        const keys = Object.keys(parsed);
        return keys.length > 0 ? `объект (${keys.length} полей)` : 'пусто';
      }
    } catch { /* fallthrough */ }
    return toolName === 'memory_onboard' ? 'контекст загружен' : 'готово';
  }
}
