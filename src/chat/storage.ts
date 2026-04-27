import type { Pool } from 'pg';
import type {
  ChatSession,
  PersistedChatMessage,
  ChatSessionFilters,
  ChatRole,
  ToolCall,
} from './types.js';

export class ChatStorage {
  constructor(private pool: Pool) {}

  async createSession(input: {
    agentTokenId: string;
    projectId: string | null;
    title?: string;
  }): Promise<ChatSession> {
    const title = input.title ?? 'Новый чат';
    const titleIsUserSet = input.title !== undefined;
    const { rows } = await this.pool.query(
      `INSERT INTO chat_sessions (agent_token_id, project_id, title, title_is_user_set)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.agentTokenId, input.projectId, title, titleIsUserSet],
    );
    return this.rowToSession(rows[0]);
  }

  async getSession(id: string, agentTokenId: string): Promise<ChatSession | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM chat_sessions WHERE id = $1 AND agent_token_id = $2 AND archived_at IS NULL`,
      [id, agentTokenId],
    );
    return rows[0] ? this.rowToSession(rows[0]) : null;
  }

  async listSessions(agentTokenId: string, filters: ChatSessionFilters): Promise<ChatSession[]> {
    const conditions: string[] = ['agent_token_id = $1', 'archived_at IS NULL'];
    const params: unknown[] = [agentTokenId];
    let idx = 2;

    if (filters.projectId) {
      conditions.push(`project_id = $${idx++}`);
      params.push(filters.projectId);
    }

    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const { rows } = await this.pool.query(
      `SELECT * FROM chat_sessions WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );
    return rows.map(r => this.rowToSession(r));
  }

  async renameSession(id: string, agentTokenId: string, title: string): Promise<void> {
    await this.pool.query(
      `UPDATE chat_sessions
       SET title = $3, title_is_user_set = TRUE, updated_at = NOW()
       WHERE id = $1 AND agent_token_id = $2`,
      [id, agentTokenId, title],
    );
  }

  async updateAutoTitle(id: string, title: string): Promise<void> {
    // Only update if user hasn't manually renamed
    await this.pool.query(
      `UPDATE chat_sessions
       SET title = $2, updated_at = NOW()
       WHERE id = $1 AND title_is_user_set = FALSE`,
      [id, title],
    );
  }

  async markOnboarded(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE chat_sessions SET onboard_injected = TRUE WHERE id = $1`,
      [id],
    );
  }

  /** Hard delete — physically removes the session and its messages (via FK cascade).
   * Chat sessions are personal, so the owner can always wipe their own data. */
  async deleteSession(id: string, agentTokenId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM chat_sessions WHERE id = $1 AND agent_token_id = $2`,
      [id, agentTokenId],
    );
  }

  async touchSession(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  async appendMessage(sessionId: string, msg: {
    role: ChatRole;
    content: string;
    toolCalls?: ToolCall[];
    toolCallId?: string;
    toolName?: string;
  }): Promise<PersistedChatMessage> {
    const { rows } = await this.pool.query(
      `INSERT INTO chat_messages (session_id, role, content, tool_calls, tool_call_id, tool_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        sessionId,
        msg.role,
        msg.content,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        msg.toolCallId ?? null,
        msg.toolName ?? null,
      ],
    );
    return this.rowToMessage(rows[0]);
  }

  async listMessages(sessionId: string): Promise<PersistedChatMessage[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY id ASC`,
      [sessionId],
    );
    return rows.map(r => this.rowToMessage(r));
  }

  private rowToSession(r: any): ChatSession {
    return {
      id: r.id,
      agentTokenId: r.agent_token_id,
      projectId: r.project_id,
      title: r.title,
      titleIsUserSet: r.title_is_user_set,
      onboardInjected: r.onboard_injected,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      archivedAt: r.archived_at,
    };
  }

  private rowToMessage(r: any): PersistedChatMessage {
    return {
      id: Number(r.id),
      sessionId: r.session_id,
      role: r.role as ChatRole,
      content: r.content,
      toolCalls: r.tool_calls ?? undefined,
      toolCallId: r.tool_call_id ?? undefined,
      toolName: r.tool_name ?? undefined,
      createdAt: r.created_at,
    };
  }
}
