import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import logger from '../logger.js';
import type { AgentTokenStore } from '../auth/agent-tokens.js';

// RFC 4122 UUID format (any version). Defence-in-depth — SQL injection is
// already blocked by parameterized queries, but rejecting malformed input at
// the edge gives clearer 400s and keeps logs free of postgres syntax errors.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads and validates the X-Project-Id header. Returns the trimmed value if
 * present and well-formed, or undefined if absent. Sends a 400 and returns
 * `false` if the header is present but malformed.
 */
function readProjectIdHeader(req: Request, res: Response): string | undefined | false {
  const raw = req.headers['x-project-id'];
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (!UUID_RE.test(trimmed)) {
    res.status(400).json({ error: 'Invalid X-Project-Id header: must be a UUID' });
    return false;
  }
  return trimmed;
}

/**
 * Creates Bearer token auth middleware.
 * If token is undefined — auth is disabled (all requests pass through).
 * Static files and health checks are excluded from auth.
 *
 * With agentTokenStore: resolves per-agent tokens first, then falls back to master token.
 * Sets req.agentName and req.agentRole for downstream handlers.
 * Sets (req as any).auth for MCP SDK StreamableHTTPServerTransport compatibility.
 */
export function createAuthMiddleware(
  token: string | undefined,
  agentTokenStore?: AgentTokenStore,
  options?: { allowReadonly?: boolean }
) {
  const trimmedToken = token?.trim() || undefined;
  if (token !== undefined && !trimmedToken) {
    logger.warn('MEMORY_API_TOKEN is empty/whitespace — auth is disabled');
  }
  const allowReadonly = options?.allowReadonly ?? false;

  return (req: Request, res: Response, next: NextFunction): void => {
    // No token configured — auth disabled, but still extract X-Project-Id
    if (!trimmedToken) {
      const projectId = readProjectIdHeader(req, res);
      if (projectId === false) return; // 400 already sent
      if (projectId) {
        (req as any).auth = { clientId: 'master', scopes: [], projectId };
      }
      next();
      return;
    }

    // Skip auth for static files, root page, and health
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/mcp')) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      // Allow readonly access without token when enabled
      if (allowReadonly) {
        req.readOnly = true;
        const projectId = readProjectIdHeader(req, res);
        if (projectId === false) return;
        (req as any).auth = { clientId: 'viewer', scopes: ['readonly'], projectId };
        next();
        return;
      }
      res.status(401).json({ error: 'Authorization header required' });
      return;
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      res.status(401).json({ error: 'Bearer token required' });
      return;
    }

    const provided = match[1];

    // 1. Try agent token store (per-agent identity)
    if (agentTokenStore) {
      const agentInfo = agentTokenStore.resolve(provided);
      if (agentInfo) {
        req.agentName = agentInfo.agentName;
        req.agentRole = agentInfo.role;
        // MCP SDK reads req.auth for StreamableHTTPServerTransport → extra.authInfo
        const projectId = readProjectIdHeader(req, res);
        if (projectId === false) return;
        // RBAC enforcement (migration 028): an agent token may only assert
        // X-Project-Id values that appear in its token_project_access
        // allowlist. Master tokens bypass via the admin scope path below.
        // Empty header is allowed — caller may be hitting an endpoint that
        // doesn't require a project (e.g., /api/agent-tokens list).
        //
        // Fail-closed: if hasProjectAccess is somehow missing from the
        // store (broken mock or future refactor), we reject rather than
        // silently allow. Tests must provide a working hasProjectAccess
        // method on their mocks.
        if (projectId) {
          if (typeof agentTokenStore.hasProjectAccess !== 'function') {
            res.status(500).json({
              error: 'Server misconfigured',
              message: 'Agent token store is missing hasProjectAccess (RBAC enforcement broken)',
            });
            return;
          }
          if (!agentTokenStore.hasProjectAccess(agentInfo.id, projectId)) {
            res.status(403).json({
              error: 'Forbidden',
              message: `Agent token has no access to project ${projectId}. Grant access from the Agents page.`,
            });
            return;
          }
        }
        (req as any).auth = {
          clientId: agentInfo.agentName,
          agentTokenId: agentInfo.id,
          scopes: [agentInfo.role],
          projectId,
        };
        agentTokenStore.trackLastUsed(agentInfo.id);
        next();
        return;
      }
    }

    // 2. Fallback: master token (MEMORY_API_TOKEN) — timing-safe comparison
    const tokenBuffer = Buffer.from(trimmedToken);
    const providedBuffer = Buffer.from(provided);

    if (tokenBuffer.length !== providedBuffer.length ||
        !crypto.timingSafeEqual(tokenBuffer, providedBuffer)) {
      res.status(403).json({ error: 'Invalid token' });
      return;
    }

    // Master token — full admin access, no agentName (author comes from params)
    const projectId = readProjectIdHeader(req, res);
    if (projectId === false) return;
    (req as any).auth = { clientId: 'master', scopes: ['admin'], projectId };
    next();
  };
}
