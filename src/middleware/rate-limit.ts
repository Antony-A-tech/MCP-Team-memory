import type { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface TierConfig {
  /** Max requests per `windowMs` for this tier. */
  maxRequests: number;
}

export interface RateLimitOptions {
  /** Time window in ms (default: 60s). */
  windowMs?: number;
  /** Anonymous (unauthenticated) tier default — also fallback for master/agent
   *  if those tiers are not configured explicitly. Default: 100. */
  maxRequests?: number;
  /** Max tracked bucket keys before LRU eviction kicks in. Default: 10000. */
  maxClients?: number;
  /** Master-token tier override. Plan default: 50 req/min. */
  master?: TierConfig;
  /** Agent-token tier override. Plan default: 200 req/min. */
  agent?: TierConfig;
}

interface AuthLike {
  agentTokenId?: string;
  scopes?: string[];
  clientId?: string;
}

type Tier = 'master' | 'agent' | 'anonymous';

function classifyRequest(req: Request, opts: Required<Pick<RateLimitOptions, 'maxRequests'>> & RateLimitOptions): {
  tier: Tier;
  bucketKey: string;
  limit: number;
} {
  const auth = (req as Request & { auth?: AuthLike }).auth;
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  // Agent tier first — agent tokens are most specific and should bucket per-
  // token (so the same agent across multiple IPs shares the same budget).
  if (auth?.agentTokenId) {
    return {
      tier: 'agent',
      bucketKey: `agent|${auth.agentTokenId}`,
      limit: opts.agent?.maxRequests ?? opts.maxRequests,
    };
  }

  // Master tier — clientId='master' is set by auth middleware for both the
  // master token path AND the "no token configured" pass-through. We use
  // scopes presence to distinguish: 'admin' = actual master token, empty
  // scopes = bypass mode where rate limiting should fall back to anon
  // semantics (otherwise a no-auth deploy would falsely rate-limit everyone
  // as if they had the master token).
  if (auth?.clientId === 'master' && auth.scopes?.includes('admin')) {
    return {
      tier: 'master',
      bucketKey: `master|${ip}`,
      limit: opts.master?.maxRequests ?? opts.maxRequests,
    };
  }

  return {
    tier: 'anonymous',
    bucketKey: `ip|${ip}`,
    limit: opts.maxRequests,
  };
}

/**
 * In-memory rate limiter with token-aware tiers and LRU eviction.
 *
 * Tiers (Phase 4.D):
 *   - master (50 req/min default) — admin/master token holders, keyed by IP
 *     so one user across multiple sessions shares the same budget. Default
 *     is intentionally low: master is for ops, not for app traffic.
 *   - agent (200 req/min default) — agent tokens, keyed by tokenId so the
 *     same agent moving between machines stays in the same bucket.
 *   - anonymous (100 req/min default) — IP-keyed, used when no auth or when
 *     auth is bypassed (MEMORY_API_TOKEN not set).
 *
 * Eviction: Map-backed LRU. On every hit we move the touched key to the end
 * via `delete` + `set`, so when the store overflows `maxClients` the oldest
 * untouched entry is the first iterator value and is evicted. This fixes
 * the FIFO bug (4.C) where an attacker could push out legitimate clients by
 * cycling through new IPs faster than legitimate clients refreshed.
 */
export function createRateLimiter(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const baseMax = options.maxRequests ?? 100;
  const maxClients = options.maxClients ?? 10_000;
  const opts = { ...options, windowMs, maxRequests: baseMax, maxClients };

  // Resolve tier defaults if caller didn't specify — matches plan tiers.
  const masterTier: TierConfig = opts.master ?? { maxRequests: 50 };
  const agentTier: TierConfig = opts.agent ?? { maxRequests: 200 };
  const resolved = { ...opts, master: masterTier, agent: agentTier };

  const store = new Map<string, RateLimitEntry>();

  // Periodic cleanup of expired entries — bounds memory in idle periods.
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  }, windowMs).unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip rate limiting for static files.
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/mcp')) {
      next();
      return;
    }

    const { bucketKey, limit } = classifyRequest(req, resolved);
    const now = Date.now();

    let entry = store.get(bucketKey);
    if (!entry || now > entry.resetAt) {
      // Evict least-recently-used when at capacity. Map iteration order is
      // insertion order; we keep "insertion order = recency" by doing
      // delete + set on every hit (below), so the first key is the LRU.
      if (!entry && store.size >= maxClients) {
        const lru = store.keys().next().value;
        if (lru !== undefined) store.delete(lru);
      }
      entry = { count: 0, resetAt: now + windowMs };
    } else {
      // Hit on an existing live bucket — bump it to most-recently-used.
      store.delete(bucketKey);
    }
    entry.count++;
    store.set(bucketKey, entry);

    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - entry.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000));

    if (entry.count > limit) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      res.status(429).json({
        error: 'Too many requests',
        retryAfter,
      });
      return;
    }

    next();
  };
}
