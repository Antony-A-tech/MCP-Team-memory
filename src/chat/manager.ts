import type { ChatStorage } from './storage.js';
import type {
  ChatSession,
  ChatSessionWithMessages,
  ChatSessionFilters,
  ChatMessage,
  PersistedChatMessage,
} from './types.js';

const ROLLING_WINDOW_NON_SYSTEM = 30;

export class ChatManager {
  constructor(private storage: ChatStorage) {}

  create(input: {
    agentTokenId: string;
    projectId: string | null;
    title?: string;
  }): Promise<ChatSession> {
    return this.storage.createSession({ ...input, title: input.title });
  }

  list(agentTokenId: string, filters: ChatSessionFilters): Promise<ChatSession[]> {
    return this.storage.listSessions(agentTokenId, filters);
  }

  async loadSessionWithMessages(id: string, agentTokenId: string): Promise<ChatSessionWithMessages | null> {
    const session = await this.storage.getSession(id, agentTokenId);
    if (!session) return null;
    const rawMessages = await this.storage.listMessages(id);
    const messages = this.filterOrphanToolMessages(rawMessages);
    return { ...session, messages };
  }

  rename(id: string, agentTokenId: string, title: string): Promise<void> {
    return this.storage.renameSession(id, agentTokenId, title);
  }

  delete(id: string, agentTokenId: string): Promise<void> {
    return this.storage.deleteSession(id, agentTokenId);
  }

  appendMessage(sessionId: string, msg: ChatMessage): Promise<PersistedChatMessage> {
    return this.storage.appendMessage(sessionId, msg);
  }

  markOnboarded(id: string): Promise<void> {
    return this.storage.markOnboarded(id);
  }

  updateAutoTitle(id: string, title: string): Promise<void> {
    return this.storage.updateAutoTitle(id, title);
  }

  touch(id: string): Promise<void> {
    return this.storage.touchSession(id);
  }

  /**
   * Keeps system messages + the last N non-system messages.
   * Used to cap LLM context while persisting full history on disk.
   */
  rollingWindow(messages: ChatMessage[]): ChatMessage[] {
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    const tail = nonSystem.slice(-ROLLING_WINDOW_NON_SYSTEM);
    return [...systemMessages, ...tail];
  }

  /**
   * Cleans up unbalanced function-call sequences left over from interrupted
   * turns:
   *   1. tool messages whose tool_call_id has no matching assistant beforehand
   *   2. assistant messages with tool_calls where some/all calls never received
   *      a tool reply (the next iteration would crash Gemini, which rejects
   *      function-call sequences without responses).
   *
   * Pass 1 collects every tool_call_id that DID receive a tool reply.
   * Pass 2 drops orphan tools (case 1) and strips/drops assistants whose
   * tool_calls reference unanswered call ids (case 2).
   */
  private filterOrphanToolMessages(messages: PersistedChatMessage[]): PersistedChatMessage[] {
    // Pass 1: collect call ids that got a tool reply.
    const repliedCallIds = new Set<string>();
    for (const m of messages) {
      if (m.role === 'tool' && m.toolCallId) repliedCallIds.add(m.toolCallId);
    }

    // Pass 2: assemble the cleaned list.
    const knownCallIds = new Set<string>();
    const result: PersistedChatMessage[] = [];
    for (const m of messages) {
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        const balanced = m.toolCalls.filter(tc => repliedCallIds.has(tc.id));
        if (balanced.length === 0) {
          // No replies arrived for any of this assistant's tool_calls —
          // dropping toolCalls keeps the text content (if any) alive while
          // shielding the next turn from an unanswered function-call request.
          if (m.content && m.content.trim().length > 0) {
            result.push({ ...m, toolCalls: undefined });
          }
          continue;
        }
        const cleaned = balanced.length === m.toolCalls.length ? m : { ...m, toolCalls: balanced };
        for (const tc of cleaned.toolCalls!) knownCallIds.add(tc.id);
        result.push(cleaned);
        continue;
      }
      if (m.role === 'tool') {
        if (!m.toolCallId || !knownCallIds.has(m.toolCallId)) continue;
      }
      result.push(m);
    }
    return result;
  }
}
