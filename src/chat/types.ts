export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCalls?: ToolCall[];   // for assistant messages
  toolCallId?: string;      // for tool-result messages
  toolName?: string;        // for tool-result messages
}

export interface PersistedChatMessage extends ChatMessage {
  id: number;
  sessionId: string;
  createdAt: string;
}

export interface ChatSession {
  id: string;
  agentTokenId: string;
  projectId: string | null;
  title: string;
  titleIsUserSet: boolean;
  onboardInjected: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ChatSessionWithMessages extends ChatSession {
  messages: PersistedChatMessage[];
}

export interface ChatSessionFilters {
  projectId?: string;
  limit?: number;
  offset?: number;
}
