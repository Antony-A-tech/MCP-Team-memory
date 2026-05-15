// src/middleware/idempotency.ts
//
// Idempotency-Key support for POST endpoints, modelled on Stripe's pattern.
// Clients that retry the same logical operation (e.g., Azure DevOps webhook
// redeliveries, mobile clients with flaky network) must be able to send the
// same `Idempotency-Key` header and get back the original response without
// the handler running twice — preventing duplicate inserts, double-charges,
// or duplicate sessions.
//
// Cache shape: `${tokenId}|${path}|${key}` → { status, body, expiresAt }.
// Scoping by token + path is intentional:
//   - token scope stops agent A's keys from leaking responses to agent B.
//   - path scope means the same key on different endpoints is not the same
//     "logical operation".
// Errors (non-2xx) are NEVER cached — retries should re-execute the handler
// because the failure may have been transient.
//
// Storage is in-memory and process-local. Restart wipes the cache, which
// means redelivered webhooks within minutes of a restart could double-run.
// For team-memory's load profile this is acceptable; persisting to Postgres
// is a follow-up if Azure webhook reliability requires it.
//
// Phase 4.B of docs/superpowers/plans/2026-05-15-v5-postwork-audit-fixes.md.

import type { Request, Response, NextFunction } from 'express';

interface CachedResponse {
  status: number;
  body: unknown;
  expiresAt: number;
}

interface IdempotencyOptions {
  ttlMs?: number;       // how long to remember a key — default 24h
  maxEntries?: number;  // LRU cap to bound memory — default 10000
  keyMaxLength?: number;
}

const cache = new Map<string, CachedResponse>();

// In-flight tracker: when a request is mid-execution we record a promise
// keyed the same way as `cache`. A concurrent duplicate (same key) awaits
// that promise instead of racing the handler, so two simultaneous webhook
// redeliveries don't both create a row. The promise resolves with the
// cached response if the original succeeded (2xx) or rejects/timeouts so
// the duplicate falls through to fresh execution on any non-2xx outcome.
const inflight = new Map<string, Promise<CachedResponse | null>>();

/** Exported for test isolation. Production code never calls this. */
export function _resetIdempotencyCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

function evictExpiredAndOverflow(maxEntries: number): void {
  // Pass 1: always prune expired entries. Cheap O(n) scan; without it we'd
  // never reclaim memory in steady-state when cap is never reached.
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
  }
  if (cache.size <= maxEntries) return;
  // Pass 2: drop in insertion order (Map iteration order = insertion order
  // in JS — oldest first). The cap is large enough that this approximates
  // LRU well enough for the access pattern (POST retries within seconds,
  // then idle).
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function createIdempotencyMiddleware(opts: IdempotencyOptions = {}) {
  const ttlMs = opts.ttlMs ?? 24 * 3600 * 1000;
  const maxEntries = opts.maxEntries ?? 10000;
  const keyMaxLength = opts.keyMaxLength ?? 256;

  return function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Only POSTs get idempotency semantics. GET is already idempotent by
    // definition; PUT/DELETE are application-defined idempotent and don't
    // need replay protection at this layer.
    if (req.method !== 'POST') {
      next();
      return;
    }

    const raw = req.headers['idempotency-key'];
    // No header → normal flow.
    if (raw === undefined || raw === '') {
      next();
      return;
    }
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (typeof key !== 'string' || key.length === 0) {
      next();
      return;
    }
    if (key.length > keyMaxLength) {
      res.status(400).json({
        success: false,
        error: `Idempotency-Key must be 1..${keyMaxLength} characters`,
      });
      return;
    }

    const tokenId = (req as { auth?: { agentTokenId?: string } }).auth?.agentTokenId;
    // For unauthenticated callers (or `anon` mode where token wasn't set),
    // fall back to IP so two anonymous clients with the same Idempotency-Key
    // don't share a cache row. Otherwise caller A's success body would be
    // replayed to caller B — a real cache-poisoning surface, not just a
    // theoretical collision.
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const identity = tokenId ? `tok:${tokenId}` : `ip:${ip}`;
    const cacheKey = `${identity}|${req.path}|${key}`;

    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      // Replay: return the original response untouched.
      res.setHeader('Idempotency-Replayed', 'true');
      res.status(cached.status).json(cached.body);
      return;
    }
    if (cached) {
      // Expired — drop it so a fresh attempt can repopulate.
      cache.delete(cacheKey);
    }

    // In-flight dedup: if a duplicate request arrives while the original is
    // mid-execution, wait for the original to finish and replay its result
    // instead of racing the handler.
    const pending = inflight.get(cacheKey);
    if (pending) {
      pending
        .then((result) => {
          if (result) {
            res.setHeader('Idempotency-Replayed', 'concurrent');
            res.status(result.status).json(result.body);
          } else {
            // Original ended non-2xx → no cache, this duplicate should
            // execute fresh. We can't go "back" to next() because the
            // request has been awaited; fall through to handler manually
            // by calling next() now.
            next();
          }
        })
        .catch(() => next());
      return;
    }

    // Claim the slot synchronously so racing requests see `inflight` set.
    let resolvePending!: (v: CachedResponse | null) => void;
    const promise = new Promise<CachedResponse | null>((resolve) => {
      resolvePending = resolve;
    });
    inflight.set(cacheKey, promise);

    // Wrap res.json so we can capture the response body the handler emits.
    // We intentionally don't wrap res.send: REST API in this app emits JSON
    // everywhere via res.json(), and capturing arbitrary streams would
    // explode memory bounds.
    const origJson = res.json.bind(res);
    let settled = false;
    const settle = (result: CachedResponse | null) => {
      if (settled) return;
      settled = true;
      inflight.delete(cacheKey);
      resolvePending(result);
    };
    res.json = (body: unknown): Response => {
      const status = res.statusCode;
      // Only cache successful responses. Retry semantics: a transient 5xx or
      // a 4xx validation error should re-execute on retry — clients can fix
      // the request and resend.
      if (status >= 200 && status < 300) {
        const entry: CachedResponse = { status, body, expiresAt: Date.now() + ttlMs };
        cache.set(cacheKey, entry);
        evictExpiredAndOverflow(maxEntries);
        settle(entry);
      } else {
        settle(null);
      }
      return origJson(body);
    };
    // Always release the in-flight slot when the response ends, even if the
    // handler threw before calling res.json or used res.end directly.
    res.on('close', () => settle(null));
    res.on('finish', () => settle(null));

    next();
  };
}
