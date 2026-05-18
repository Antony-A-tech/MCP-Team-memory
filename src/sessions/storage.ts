import type { Pool } from 'pg';
import type { Session, SessionMessage, SessionFilters } from './types.js';
import logger from '../logger.js';

export class SessionStorage {
  constructor(private pool: Pool) {}

  async createSession(data: {
    agentTokenId: string;
    externalId?: string;
    name?: string;
    summary: string;
    projectId?: string;
    workingDirectory?: string;
    gitBranch?: string;
    tags?: string[];
    startedAt?: string;
    endedAt?: string;
    messages: Array<{
      role: string;
      content: string;
      timestamp?: string;
      toolNames: string[];
    }>;
  }): Promise<Session> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [session] } = await client.query(
        `INSERT INTO sessions (agent_token_id, external_id, name, summary, project_id, working_directory, git_branch, tags, started_at, ended_at, message_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          data.agentTokenId, data.externalId ?? null, data.name ?? null, data.summary,
          data.projectId ?? null, data.workingDirectory ?? null, data.gitBranch ?? null,
          data.tags ?? [], data.startedAt ?? null, data.endedAt ?? null, data.messages.length,
        ],
      );

      // Batch insert messages (max ~5000 per batch to stay within PG 65535 param limit, 7 params/row).
      // After the loop we assert total inserted == messages.length so any
      // partial-insert scenario (DEFERRABLE constraints, triggers swallowing
      // rows, etc.) throws and rolls back the transaction — sessions.message_count
      // can never drift from the actual row count in session_messages.
      let totalInserted = 0;
      if (data.messages.length > 0) {
        const BATCH_SIZE = 5000;
        for (let batchStart = 0; batchStart < data.messages.length; batchStart += BATCH_SIZE) {
          const batch = data.messages.slice(batchStart, batchStart + BATCH_SIZE);
          const values: string[] = [];
          const params: unknown[] = [];
          let idx = 1;

          batch.forEach((msg, i) => {
            const hasToolUse = msg.toolNames.length > 0;
            values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
            params.push(session.id, msg.role, msg.content, batchStart + i, hasToolUse, msg.toolNames, msg.timestamp ?? null);
          });

          const insertRes = await client.query(
            `INSERT INTO session_messages (session_id, role, content, message_index, has_tool_use, tool_names, timestamp)
             VALUES ${values.join(', ')}`,
            params,
          );
          totalInserted += insertRes.rowCount ?? 0;
        }
      }
      if (totalInserted !== data.messages.length) {
        throw new Error(
          `Session batch insert count mismatch: expected ${data.messages.length} messages, ` +
          `actually inserted ${totalInserted} (sessionId=${session.id}). Aborting to prevent drift.`,
        );
      }

      await client.query('COMMIT');
      return this.rowToSession(session);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async findByExternalId(agentTokenId: string, externalId: string): Promise<Session | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM sessions WHERE agent_token_id = $1 AND external_id = $2',
      [agentTokenId, externalId],
    );
    return rows.length > 0 ? this.rowToSession(rows[0]) : null;
  }

  /**
   * Fallback dedup lookup for session_import calls that don't carry an
   * external_id. Matches on (agent_token_id, project_id, name, started_at)
   * — the four fields a client-side caller can plausibly stabilise across
   * retries. Returns the first match.
   *
   * Used by importSession when externalId is undefined: webhooks that
   * predate the external_id contract, or manual UI imports.
   */
  async findByTuple(
    agentTokenId: string,
    projectId: string | undefined,
    name: string | undefined,
    startedAt: string | undefined,
  ): Promise<Session | null> {
    // All four parts must be present to make a stable tuple. Missing any
    // one means the caller hasn't given us enough to dedup against, so we
    // return null and let importSession create a new row.
    if (!projectId || !name || !startedAt) return null;
    const { rows } = await this.pool.query(
      `SELECT * FROM sessions
       WHERE agent_token_id = $1
         AND project_id = $2
         AND name = $3
         AND started_at = $4
       LIMIT 1`,
      [agentTokenId, projectId, name, startedAt],
    );
    return rows.length > 0 ? this.rowToSession(rows[0]) : null;
  }

  async listSessions(agentTokenId: string, filters: SessionFilters): Promise<Session[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (agentTokenId) {
      conditions.push(`agent_token_id = $${idx++}`);
      params.push(agentTokenId);
    }

    if (filters.projectId) {
      conditions.push(`project_id = $${idx++}`);
      params.push(filters.projectId);
    }
    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`tags && $${idx++}`);
      params.push(filters.tags);
    }
    if (filters.dateFrom) {
      conditions.push(`started_at >= $${idx++}`);
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push(`started_at <= $${idx++}`);
      params.push(filters.dateTo);
    }
    if (filters.search) {
      const escaped = filters.search.replace(/[%_\\]/g, '\\$&');
      conditions.push(`(search_vector @@ plainto_tsquery($${idx}) OR name ILIKE $${idx + 1} ESCAPE '\\' OR summary ILIKE $${idx + 1} ESCAPE '\\')`);
      params.push(filters.search, `%${escaped}%`);
      idx += 2;
    }

    const limit = filters.limit ?? 20;
    const offset = filters.offset ?? 0;

    const { rows } = await this.pool.query(
      `SELECT * FROM sessions${conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''} ORDER BY started_at DESC NULLS LAST LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );

    return rows.map(r => this.rowToSession(r));
  }

  async countSessions(agentTokenId: string, filters: SessionFilters): Promise<number> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (agentTokenId) {
      conditions.push(`agent_token_id = $${idx++}`);
      params.push(agentTokenId);
    }

    if (filters.projectId) {
      conditions.push(`project_id = $${idx++}`);
      params.push(filters.projectId);
    }
    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`tags && $${idx++}`);
      params.push(filters.tags);
    }
    if (filters.dateFrom) {
      conditions.push(`started_at >= $${idx++}`);
      params.push(filters.dateFrom);
    }
    if (filters.search) {
      const escaped = filters.search.replace(/[%_\\]/g, '\\$&');
      conditions.push(`(search_vector @@ plainto_tsquery($${idx}) OR name ILIKE $${idx + 1} ESCAPE '\\' OR summary ILIKE $${idx + 1} ESCAPE '\\')`);
      params.push(filters.search, `%${escaped}%`);
      idx += 2;
    }

    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS count FROM sessions${conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''}`,
      params,
    );
    return rows[0].count;
  }

  async countByEmbeddingStatus(projectId?: string): Promise<Record<string, number>> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (projectId) { conditions.push('project_id = $1'); params.push(projectId); }
    const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await this.pool.query(
      `SELECT embedding_status, COUNT(*)::int AS count FROM sessions${where} GROUP BY embedding_status`,
      params,
    );
    const result: Record<string, number> = {};
    for (const row of rows) result[row.embedding_status] = row.count;
    return result;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const { rows } = await this.pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    return rows.length > 0 ? this.rowToSession(rows[0]) : null;
  }

  async getMessages(sessionId: string, from: number = 0, to?: number): Promise<SessionMessage[]> {
    let sql = 'SELECT * FROM session_messages WHERE session_id = $1 AND message_index >= $2';
    const params: unknown[] = [sessionId, from];
    let idx = 3;

    if (to !== undefined) {
      sql += ` AND message_index <= $${idx++}`;
      params.push(to);
    }

    sql += ' ORDER BY message_index ASC';

    const { rows } = await this.pool.query(sql, params);
    return rows.map(r => this.rowToMessage(r));
  }

  async getMessageById(messageId: string): Promise<SessionMessage | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM session_messages WHERE id = $1`,
      [messageId],
    );
    return rows.length > 0 ? this.rowToMessage(rows[0]) : null;
  }

  /** Batch lookup — single round-trip for N message IDs. Used by retrieval. */
  async getMessagesByIds(messageIds: string[]): Promise<SessionMessage[]> {
    if (messageIds.length === 0) return [];
    const { rows } = await this.pool.query(
      `SELECT * FROM session_messages WHERE id = ANY($1::uuid[])`,
      [messageIds],
    );
    return rows.map(r => this.rowToMessage(r));
  }

  /** Batch lookup — single round-trip for N session IDs. Used by retrieval. */
  async getSessionsByIds(sessionIds: string[]): Promise<Session[]> {
    if (sessionIds.length === 0) return [];
    const { rows } = await this.pool.query(
      `SELECT * FROM sessions WHERE id = ANY($1::uuid[])`,
      [sessionIds],
    );
    return rows.map(r => this.rowToSession(r));
  }

  async searchMessagesByText(sessionId: string, query: string, limit: number = 20): Promise<SessionMessage[]> {
    const escaped = query.replace(/[%_\\]/g, '\\$&');
    const { rows } = await this.pool.query(
      `SELECT * FROM session_messages
       WHERE session_id = $1 AND content ILIKE $2 ESCAPE '\\'
       ORDER BY message_index ASC
       LIMIT $3`,
      [sessionId, `%${escaped}%`, limit],
    );
    return rows.map(r => this.rowToMessage(r));
  }

  async updateEmbeddingStatus(sessionId: string, status: string): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET embedding_status = $1 WHERE id = $2',
      [status, sessionId],
    );
  }

  async replaceMessages(sessionId: string, messages: Array<{ role: string; content: string; timestamp?: string; toolNames: string[] }>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM session_messages WHERE session_id = $1', [sessionId]);

      if (messages.length > 0) {
        const BATCH_SIZE = 5000;
        for (let batchStart = 0; batchStart < messages.length; batchStart += BATCH_SIZE) {
          const batch = messages.slice(batchStart, batchStart + BATCH_SIZE);
          const values: string[] = [];
          const params: unknown[] = [];
          let idx = 1;

          batch.forEach((msg, i) => {
            const hasToolUse = msg.toolNames.length > 0;
            values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
            params.push(sessionId, msg.role, msg.content, batchStart + i, hasToolUse, msg.toolNames, msg.timestamp ?? null);
          });

          await client.query(
            `INSERT INTO session_messages (session_id, role, content, message_index, has_tool_use, tool_names, timestamp)
             VALUES ${values.join(', ')}`,
            params,
          );
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async updateSessionMeta(sessionId: string, meta: { messageCount?: number; endedAt?: string | null; name?: string; tags?: string[] }): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (meta.messageCount !== undefined) { sets.push(`message_count = $${idx++}`); params.push(meta.messageCount); }
    if (meta.endedAt !== undefined) { sets.push(`ended_at = $${idx++}`); params.push(meta.endedAt); }
    if (meta.name !== undefined) { sets.push(`name = $${idx++}`); params.push(meta.name); }
    if (meta.tags !== undefined) { sets.push(`tags = $${idx++}`); params.push(meta.tags); }

    if (sets.length > 0) {
      params.push(sessionId);
      await this.pool.query(`UPDATE sessions SET ${sets.join(', ')} WHERE id = $${idx}`, params);
    }
  }

  async updateSummary(sessionId: string, summary: string): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET summary = $1 WHERE id = $2',
      [summary, sessionId],
    );
  }

  /**
   * Atomic claim of the next queueable session. Selects + flips the chosen
   * row to a transient `*_processing` state inside a single transaction with
   * `FOR UPDATE SKIP LOCKED`, so two replicas calling concurrently always
   * pick different rows (or one returns null). Without the in-transaction
   * status flip, `pool.query` releases the row lock immediately and a second
   * replica could re-pick the same row before the worker writes a follow-up.
   *
   * Reverse mapping for stuck-state recovery is in `recoverStuckSessions`.
   */
  async getNextQueued(): Promise<Session | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT * FROM sessions
         WHERE embedding_status IN ('queued', 'queued_embed')
            OR (
              embedding_status = 'extracting_notes'
              AND updated_at < NOW() - INTERVAL '5 minutes'
            )
         ORDER BY imported_at ASC LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      if (rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }
      const session = this.rowToSession(rows[0]);
      // Flip to a processing-marked state inside the same tx so concurrent
      // workers immediately see this row as busy.
      const next =
        session.embeddingStatus === 'queued'
          ? 'summarizing'
          : session.embeddingStatus === 'queued_embed'
            ? 'embedding'
            : 'extracting_notes'; // already in extracting_notes — leave as-is, runtime handles retry
      await client.query(
        `UPDATE sessions SET embedding_status = $1, updated_at = NOW() WHERE id = $2`,
        [next, session.id],
      );
      await client.query('COMMIT');
      // Return the session with its ORIGINAL status — the SessionManager
      // pipeline branches on `embedding_status === 'queued'` etc. The row
      // has already been flipped on disk so concurrent workers won't re-
      // pick it; subsequent updateEmbeddingStatus calls from the manager
      // are idempotent confirmations.
      return session;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async recoverStuckSessions(): Promise<number> {
    // Move stuck transient states back to a queueable state. Done via CASE so
    // we don't redo summary work for sessions that were stuck in `embedding`.
    // `extracting_notes` rows that have been stuck longer than the recovery
    // window are flipped to `extraction_failed` so operators see them in the
    // dashboard rather than having them silently linger.
    const { rowCount } = await this.pool.query(
      `UPDATE sessions
       SET embedding_status = CASE embedding_status
         WHEN 'summarizing'      THEN 'queued'
         WHEN 'embedding'        THEN 'queued_embed'
         WHEN 'extracting_notes' THEN 'extraction_failed'
         ELSE embedding_status
       END
       WHERE embedding_status IN ('summarizing', 'embedding', 'extracting_notes')
         AND updated_at < NOW() - INTERVAL '30 minutes'`,
    );
    if (rowCount && rowCount > 0) {
      logger.info({ count: rowCount }, 'Recovered stuck sessions back to queue');
    }
    return rowCount ?? 0;
  }

  /**
   * Returns true if any entry in the project carries an evidence source that
   * points to this session. Used by the extraction-pipeline retry guard:
   * a worker that died mid-extraction would otherwise re-create entries that
   * were already written but not yet visible to the dedup vector search
   * (Qdrant upserts are fire-and-forget).
   */
  async hasExtractionEvidence(projectId: string, sessionId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM entries
       WHERE project_id = $1
         AND evidence_sources @> $2::jsonb
       LIMIT 1`,
      [projectId, JSON.stringify([{ type: 'session', id: sessionId }])],
    );
    return rows.length > 0;
  }

  async deleteSession(sessionId: string, agentTokenId: string): Promise<boolean> {
    // Single query with ownership check (skip ownership check for master token — empty agentTokenId)
    const sql = agentTokenId
      ? 'DELETE FROM sessions WHERE id = $1 AND agent_token_id = $2'
      : 'DELETE FROM sessions WHERE id = $1';
    const params = agentTokenId ? [sessionId, agentTokenId] : [sessionId];
    const { rowCount } = await this.pool.query(sql, params);

    if (rowCount === 0) {
      const { rows } = await this.pool.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);
      if (rows.length === 0) return false;
      throw new Error('Access denied: not your session');
    }
    return true;
  }

  private rowToSession(row: any): Session {
    return {
      id: row.id,
      agentTokenId: row.agent_token_id,
      projectId: row.project_id,
      externalId: row.external_id,
      name: row.name,
      summary: row.summary,
      workingDirectory: row.working_directory,
      gitBranch: row.git_branch,
      messageCount: row.message_count,
      embeddingStatus: row.embedding_status,
      startedAt: row.started_at?.toISOString?.() ?? row.started_at,
      endedAt: row.ended_at?.toISOString?.() ?? row.ended_at,
      importedAt: row.imported_at?.toISOString?.() ?? row.imported_at,
      tags: row.tags || [],
    };
  }

  private rowToMessage(row: any): SessionMessage {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      messageIndex: row.message_index,
      hasToolUse: row.has_tool_use,
      toolNames: row.tool_names || [],
      timestamp: row.timestamp?.toISOString?.() ?? row.timestamp,
    };
  }
}
