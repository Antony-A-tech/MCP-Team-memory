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
   * Drops tool messages whose tool_call_id has no matching assistant tool_call
   * in preceding messages. Happens when a turn was interrupted mid-execution.
   */
  private filterOrphanToolMessages(messages: PersistedChatMessage[]): PersistedChatMessage[] {
    const knownCallIds = new Set<string>();
    const result: PersistedChatMessage[] = [];
    for (const m of messages) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) knownCallIds.add(tc.id);
      }
      if (m.role === 'tool') {
        if (!m.toolCallId || !knownCallIds.has(m.toolCallId)) continue;
      }
      result.push(m);
    }
    return result;
  }
}
