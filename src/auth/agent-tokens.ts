import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { ProjectRole } from '../memory/types.js';
import logger from '../logger.js';

export interface AgentInfo {
  id: string;
  agentName: string;
  role: ProjectRole;
  isActive: boolean;
  createdAt?: string;
  lastUsedAt?: string;
  totalPromptTokens?: number;
  totalCompletionTokens?: number;
  totalCostUsd?: number;
  /**
   * Project IDs this token is allowed to operate on (RBAC allowlist).
   * Migration 028. Loaded into cache at initialize() and synced on every
   * setAllowedProjects() call. Empty Set = no access to any project.
   * Master tokens bypass — this field only applies to agent tokens.
   */
  allowedProjects: Set<string>;
}

/**
 * Manages per-agent tokens for identity resolution.
 * Tokens are cached in memory for fast lookup; DB is source of truth.
 * Gracefully degrades if agent_tokens table doesn't exist yet (migration not run).
 */
export class AgentTokenStore {
  private cache = new Map<string, AgentInfo>();
  private tableExists = false;
  private accessTableExists = false;
  private lastUsedDebounce = new Map<string, number>();
  private static DEBOUNCE_MS = 60_000;

  constructor(private pool: Pool) {}

  /** Load all active tokens + their project allowlists into the in-memory cache. */
  async initialize(): Promise<void> {
    try {
      const { rows } = await this.pool.query(
        `SELECT id, token, agent_name, role, is_active FROM agent_tokens WHERE is_active = TRUE`
      );
      // Bulk-load allowlists for all active tokens in a single query.
      let accessByToken = new Map<string, Set<string>>();
      try {
        const accessRows = await this.pool.query(
          `SELECT token_id, project_id FROM token_project_access`,
        );
        this.accessTableExists = true;
        for (const r of accessRows.rows) {
          let set = accessByToken.get(r.token_id);
          if (!set) {
            set = new Set();
            accessByToken.set(r.token_id, set);
          }
          set.add(r.project_id);
        }
      } catch (accessErr: any) {
        if (accessErr.code === '42P01') {
          logger.warn('token_project_access table not found — RBAC disabled, every token sees every project');
          // Backward-compat: if the table is absent (migration 028 not yet
          // applied), retain pre-RBAC behaviour where every token implicitly
          // has access to every project. We mark this by leaving
          // `accessTableExists = false`; resolve() will return an
          // allowedProjects=undefined sentinel that auth treats as "all".
          this.accessTableExists = false;
        } else {
          throw accessErr;
        }
      }

      for (const row of rows) {
        this.cache.set(row.token, {
          id: row.id,
          agentName: row.agent_name,
          role: row.role as ProjectRole,
          isActive: row.is_active,
          allowedProjects: accessByToken.get(row.id) ?? new Set<string>(),
        });
      }
      this.tableExists = true;
      logger.info(
        { count: rows.length, rbacEnabled: this.accessTableExists },
        'Agent token store initialized',
      );
    } catch (err: any) {
      if (err.code === '42P01') {
        logger.warn('agent_tokens table not found — agent token auth disabled');
        return;
      }
      throw err;
    }
  }

  /** Synchronous cache lookup — returns null if token not found or table doesn't exist */
  resolve(token: string): AgentInfo | null {
    if (!this.tableExists) return null;
    return this.cache.get(token) || null;
  }

  /** Create a new agent token. Returns the raw token (show once) and agent info. */
  async create(agentName: string, role: string = 'developer'): Promise<{ token: string; agent: AgentInfo }> {
    const token = 'tm_' + crypto.randomBytes(16).toString('hex');
    const { rows } = await this.pool.query(
      `INSERT INTO agent_tokens (token, agent_name, role) VALUES ($1, $2, $3) RETURNING id, created_at`,
      [token, agentName, role]
    );
    // New tokens start with an empty allowlist (per operator decision). The
    // /agents UI shows "0 projects" and the operator grants access
    // explicitly. This matches the secure-by-default principle: a freshly
    // minted token can't read anything until you say so.
    const agent: AgentInfo = {
      id: rows[0].id,
      agentName,
      role: role as ProjectRole,
      isActive: true,
      createdAt: rows[0].created_at,
      allowedProjects: new Set<string>(),
    };
    this.cache.set(token, agent);
    return { token, agent };
  }

  /** Revoke token by ID. Sets is_active = FALSE and removes from cache. */
  async revoke(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE agent_tokens SET is_active = FALSE WHERE id = $1`,
      [id]
    );
    for (const [tok, info] of this.cache) {
      if (info.id === id) this.cache.delete(tok);
    }
    return (rowCount ?? 0) > 0;
  }

  /** Activate a previously revoked token by ID */
  async activate(id: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `UPDATE agent_tokens SET is_active = TRUE WHERE id = $1 RETURNING token, agent_name, role`,
      [id]
    );
    if (rows.length === 0) return false;
    const row = rows[0];
    // Rehydrate the project allowlist for the re-activated token — it was
    // pruned from the cache on revoke() but the rows in token_project_access
    // survive (no CASCADE on revoke; rows are only purged on remove()).
    const allowed = await this.fetchAllowedProjects(id);
    this.cache.set(row.token, {
      id,
      agentName: row.agent_name,
      role: row.role as ProjectRole,
      isActive: true,
      allowedProjects: allowed,
    });
    return true;
  }

  private async fetchAllowedProjects(tokenId: string): Promise<Set<string>> {
    if (!this.accessTableExists) return new Set();
    try {
      const { rows } = await this.pool.query(
        `SELECT project_id FROM token_project_access WHERE token_id = $1`,
        [tokenId],
      );
      return new Set(rows.map((r) => r.project_id as string));
    } catch (err: any) {
      if (err.code === '42P01') return new Set();
      throw err;
    }
  }

  /** Permanently delete a token from DB */
  async remove(id: string): Promise<boolean> {
    // Remove from cache first
    for (const [tok, info] of this.cache) {
      if (info.id === id) this.cache.delete(tok);
    }
    const { rowCount } = await this.pool.query(
      `DELETE FROM agent_tokens WHERE id = $1`,
      [id]
    );
    return (rowCount ?? 0) > 0;
  }

  /** List all tokens (active and revoked). Includes raw token for admin panel. */
  async list(): Promise<(Omit<AgentInfo, 'allowedProjects'> & { token: string; allowedProjects: string[] })[]> {
    if (!this.tableExists) return [];
    const { rows } = await this.pool.query(
      `SELECT id, token, agent_name, role, is_active, created_at, last_used_at,
              total_prompt_tokens, total_completion_tokens, total_cost_usd
       FROM agent_tokens ORDER BY created_at DESC`
    );
    // Bulk-load allowlists in one query so the listing isn't O(N) round-trips.
    const allowedByToken = new Map<string, string[]>();
    if (this.accessTableExists && rows.length > 0) {
      try {
        const acc = await this.pool.query(
          `SELECT token_id, project_id FROM token_project_access WHERE token_id = ANY($1::uuid[])`,
          [rows.map((r) => r.id)],
        );
        for (const r of acc.rows) {
          const list = allowedByToken.get(r.token_id) ?? [];
          list.push(r.project_id);
          allowedByToken.set(r.token_id, list);
        }
      } catch (err: any) {
        if (err.code !== '42P01') throw err;
      }
    }
    return rows.map(r => ({
      id: r.id,
      token: r.token,
      agentName: r.agent_name,
      role: r.role,
      isActive: r.is_active,
      createdAt: r.created_at?.toISOString?.() || r.created_at,
      lastUsedAt: r.last_used_at?.toISOString?.() || r.last_used_at,
      totalPromptTokens: Number(r.total_prompt_tokens ?? 0),
      totalCompletionTokens: Number(r.total_completion_tokens ?? 0),
      totalCostUsd: Number(r.total_cost_usd ?? 0),
      allowedProjects: allowedByToken.get(r.id) ?? [],
    }));
  }

  /** Return the allowed-project list for one token. */
  async getAllowedProjects(tokenId: string): Promise<string[]> {
    const allowed = await this.fetchAllowedProjects(tokenId);
    return Array.from(allowed);
  }

  /**
   * Single-row grant: add ONE project to a token's allowlist atomically.
   * Used by POST /api/projects auto-grant — when an agent creates a
   * project we want it visible to that agent immediately without a
   * full setAllowedProjects() (which would also clobber any existing
   * grants for that token).
   *
   * Idempotent: ON CONFLICT DO NOTHING. Updates the in-memory cache so
   * the very next auth check sees the new project.
   */
  async grantProjectAccess(tokenId: string, projectId: string, granter?: string): Promise<void> {
    if (!this.accessTableExists) {
      throw new Error('token_project_access table is not available — apply migration 028');
    }
    await this.pool.query(
      `INSERT INTO token_project_access (token_id, project_id, granted_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (token_id, project_id) DO NOTHING`,
      [tokenId, projectId, granter ?? null],
    );
    for (const entry of this.cache.values()) {
      if (entry.id === tokenId) {
        entry.allowedProjects.add(projectId);
        break;
      }
    }
  }

  /**
   * Replace the allowlist for a token. Diffs new vs old, applies INSERTs
   * and DELETEs in a single transaction so the row state is consistent.
   * `granter` is the agent name / 'master' attribution for audit (NULL ok).
   */
  async setAllowedProjects(tokenId: string, projectIds: string[], granter?: string): Promise<void> {
    if (!this.accessTableExists) {
      // Migration 028 not applied — best to fail loudly rather than silently
      // accept writes that won't persist past restart.
      throw new Error('token_project_access table is not available — apply migration 028');
    }
    const dedup = Array.from(new Set(projectIds));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Wipe and rewrite: simpler than diff and the table is tiny per token.
      await client.query(`DELETE FROM token_project_access WHERE token_id = $1`, [tokenId]);
      if (dedup.length > 0) {
        const values = dedup.map((_, i) => `($1, $${i + 2}, NOW(), $${dedup.length + 2})`).join(', ');
        await client.query(
          `INSERT INTO token_project_access (token_id, project_id, granted_at, granted_by) VALUES ${values}`,
          [tokenId, ...dedup, granter ?? null],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    // Refresh the in-memory cache for THIS token so the new allowlist is
    // visible on the very next auth check. Find the cached entry by id.
    for (const entry of this.cache.values()) {
      if (entry.id === tokenId) {
        entry.allowedProjects = new Set(dedup);
        break;
      }
    }
  }

  /**
   * Sync check used at every request boundary. Returns true if the token
   * is allowed to operate on the given project. Master tokens never reach
   * this method — they bypass at the auth middleware level via the admin
   * scope check.
   *
   * If the access table doesn't exist (migration 028 not applied), we
   * preserve pre-RBAC behaviour: every active token has access to every
   * project. This avoids breaking deployments that haven't migrated yet.
   */
  hasProjectAccess(tokenId: string, projectId: string): boolean {
    if (!this.accessTableExists) return true;
    for (const entry of this.cache.values()) {
      if (entry.id === tokenId) {
        return entry.allowedProjects.has(projectId);
      }
    }
    return false;
  }

  /** Fire-and-forget: increment cumulative usage for a token after a chat turn. */
  addUsage(tokenId: string, promptTokens: number, completionTokens: number, costUsd: number): void {
    if (!this.tableExists) return;
    this.pool.query(
      `UPDATE agent_tokens
         SET total_prompt_tokens = total_prompt_tokens + $1,
             total_completion_tokens = total_completion_tokens + $2,
             total_cost_usd = total_cost_usd + $3
       WHERE id = $4`,
      [promptTokens, completionTokens, costUsd, tokenId],
    ).catch(err => logger.error({ err, tokenId }, 'Failed to record agent usage'));
  }

  /** Fire-and-forget: update last_used_at (debounced — at most once per 60s per token) */
  trackLastUsed(tokenId: string): void {
    const now = Date.now();
    const last = this.lastUsedDebounce.get(tokenId) || 0;
    if (now - last < AgentTokenStore.DEBOUNCE_MS) return;
    this.lastUsedDebounce.set(tokenId, now);
    this.pool.query(`UPDATE agent_tokens SET last_used_at = NOW() WHERE id = $1`, [tokenId])
      .catch(err => logger.error({ err }, 'Failed to update last_used_at'));
  }

  isAvailable(): boolean {
    return this.tableExists;
  }
}
