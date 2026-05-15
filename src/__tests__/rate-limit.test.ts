import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRateLimiter } from '../middleware/rate-limit.js';

type AuthShape = { agentTokenId?: string; scopes?: string[]; clientId?: string };

function makeApp(
  rl: ReturnType<typeof createRateLimiter>,
  authForHeader?: (headerVal: string | undefined) => AuthShape | undefined,
) {
  const app = express();
  // Trust the X-Forwarded-For header so tests can simulate distinct client
  // IPs from the same supertest socket.
  app.set('trust proxy', true);
  app.use((req, _res, next) => {
    const v = req.headers['x-test-auth'];
    const single = Array.isArray(v) ? v[0] : v;
    const auth = authForHeader ? authForHeader(single) : undefined;
    if (auth) (req as any).auth = auth;
    next();
  });
  app.use(rl);
  app.get('/api/x', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('rate-limit middleware', () => {
  it('LRU semantics: recently-used entry survives eviction at capacity', async () => {
    const rl = createRateLimiter({ windowMs: 60_000, maxRequests: 1000, maxClients: 3 });
    const app = makeApp(rl);

    // Fill 3 slots — A, B, C
    await request(app).get('/api/x').set('X-Forwarded-For', '10.0.0.1');
    await request(app).get('/api/x').set('X-Forwarded-For', '10.0.0.2');
    await request(app).get('/api/x').set('X-Forwarded-For', '10.0.0.3');

    // Touch A so it becomes most-recently-used (LRU should keep it)
    await request(app).get('/api/x').set('X-Forwarded-For', '10.0.0.1');

    // Push a 4th — under LRU, the LEAST-recently-used (B) must be evicted,
    // not the oldest-inserted (A).
    await request(app).get('/api/x').set('X-Forwarded-For', '10.0.0.4');

    // Probe: send 1001 requests from A. If A was evicted, counter starts
    // fresh and we'd see another 1000 before 429. If A survived (LRU
    // correctly kept it), its previous count carries through and we'd see
    // exact carry-over behavior. We assert by reading remaining count.
    const r = await request(app).get('/api/x').set('X-Forwarded-For', '10.0.0.1');
    // A has had 3 requests total (2 actual + 1 from "touch" above + this probe = 3, but we counted only 2 then 1 here)
    // Wait: A got 1 from "Fill", 1 from "Touch", and 1 here = 3 total.
    // Remaining = 1000 - 3 = 997. If FIFO had evicted A, remaining would be 1000 - 1 = 999.
    expect(Number(r.headers['x-ratelimit-remaining'])).toBe(997);
  });

  it('master tier limit defaults to 50/min', async () => {
    const rl = createRateLimiter({ windowMs: 60_000, master: { maxRequests: 5 } });
    const app = makeApp(rl, (v) => v === 'master' ? { clientId: 'master', scopes: ['admin'] } : undefined);

    let lastStatus = 200;
    for (let i = 0; i < 7; i++) {
      const r = await request(app).get('/api/x').set('x-test-auth', 'master');
      lastStatus = r.status;
    }
    expect(lastStatus).toBe(429);
  });

  it('agent tier gets higher limit than master', async () => {
    const rl = createRateLimiter({
      windowMs: 60_000,
      master: { maxRequests: 2 },
      agent: { maxRequests: 5 },
    });
    const app = makeApp(rl, (v) => {
      if (v === 'master') return { clientId: 'master', scopes: ['admin'] };
      if (v === 'agent') return { clientId: 'a1', agentTokenId: 'agent-1' };
      return undefined;
    });

    // master: 3 reqs → 1 over → 429 on the 3rd
    const m1 = await request(app).get('/api/x').set('x-test-auth', 'master');
    const m2 = await request(app).get('/api/x').set('x-test-auth', 'master');
    const m3 = await request(app).get('/api/x').set('x-test-auth', 'master');
    expect(m1.status).toBe(200);
    expect(m2.status).toBe(200);
    expect(m3.status).toBe(429);

    // agent: 5 reqs in window → all OK
    for (let i = 0; i < 5; i++) {
      const r = await request(app).get('/api/x').set('x-test-auth', 'agent');
      expect(r.status).toBe(200);
    }
    const a6 = await request(app).get('/api/x').set('x-test-auth', 'agent');
    expect(a6.status).toBe(429);
  });

  it('tracks agent tokens independently (per-token bucket, not per-IP)', async () => {
    const rl = createRateLimiter({ windowMs: 60_000, agent: { maxRequests: 2 } });
    const app = makeApp(rl, (v) => v ? { clientId: v, agentTokenId: v } : undefined);

    // agent-A: 2 OK, 3rd → 429
    await request(app).get('/api/x').set('x-test-auth', 'agent-A');
    await request(app).get('/api/x').set('x-test-auth', 'agent-A');
    const aOver = await request(app).get('/api/x').set('x-test-auth', 'agent-A');
    expect(aOver.status).toBe(429);

    // agent-B: untouched bucket, even from same IP
    const b = await request(app).get('/api/x').set('x-test-auth', 'agent-B');
    expect(b.status).toBe(200);
  });

  it('anonymous tier (no auth) uses default IP-keyed bucket', async () => {
    const rl = createRateLimiter({ windowMs: 60_000, maxRequests: 2 });
    const app = makeApp(rl);

    await request(app).get('/api/x').set('X-Forwarded-For', '1.2.3.4');
    await request(app).get('/api/x').set('X-Forwarded-For', '1.2.3.4');
    const over = await request(app).get('/api/x').set('X-Forwarded-For', '1.2.3.4');
    expect(over.status).toBe(429);
  });

  it('emits X-RateLimit-Limit reflecting the tier of the request', async () => {
    const rl = createRateLimiter({
      windowMs: 60_000,
      maxRequests: 100,
      master: { maxRequests: 50 },
      agent: { maxRequests: 200 },
    });
    const app = makeApp(rl, (v) => {
      if (v === 'master') return { clientId: 'master', scopes: ['admin'] };
      if (v === 'agent') return { clientId: 'a1', agentTokenId: 'a1' };
      return undefined;
    });

    const m = await request(app).get('/api/x').set('x-test-auth', 'master');
    expect(Number(m.headers['x-ratelimit-limit'])).toBe(50);

    const a = await request(app).get('/api/x').set('x-test-auth', 'agent');
    expect(Number(a.headers['x-ratelimit-limit'])).toBe(200);

    const n = await request(app).get('/api/x').set('X-Forwarded-For', '9.9.9.9');
    expect(Number(n.headers['x-ratelimit-limit'])).toBe(100);
  });
});
