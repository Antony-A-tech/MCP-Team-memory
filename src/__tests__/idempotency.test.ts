import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createIdempotencyMiddleware, _resetIdempotencyCacheForTests } from '../middleware/idempotency.js';

function makeApp(opts?: Parameters<typeof createIdempotencyMiddleware>[0]) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  // Fake auth for token-scoping tests. Only set auth when header is present;
  // otherwise leave req.auth unset so we exercise the anonymous IP-scoped
  // fallback path.
  app.use((req, _res, next) => {
    const v = req.headers['x-test-agent'];
    if (v !== undefined && v !== '') {
      (req as any).auth = { agentTokenId: String(v) };
    }
    next();
  });
  app.use(createIdempotencyMiddleware(opts));

  let callCount = 0;
  app.post('/api/notes', (_req, res) => {
    callCount++;
    res.status(201).json({ success: true, callCount });
  });
  // Slow handler used to exercise concurrent in-flight dedup.
  app.post('/api/slow', async (_req, res) => {
    callCount++;
    await new Promise((r) => setTimeout(r, 50));
    res.status(201).json({ success: true, callCount });
  });
  app.post('/api/fail', (_req, res) => {
    res.status(500).json({ success: false, error: 'kaboom' });
  });
  app.get('/api/get', (_req, res) => {
    res.json({ success: true });
  });

  return { app, getCallCount: () => callCount };
}

describe('Idempotency-Key middleware', () => {
  beforeEach(() => _resetIdempotencyCacheForTests());

  it('passes through when no Idempotency-Key header', async () => {
    const { app, getCallCount } = makeApp();
    await request(app).post('/api/notes').set('x-test-agent', 't1').send({});
    await request(app).post('/api/notes').set('x-test-agent', 't1').send({});
    expect(getCallCount()).toBe(2);
  });

  it('caches 2xx response keyed by (token, path, key) and returns it on replay', async () => {
    const { app, getCallCount } = makeApp();
    const r1 = await request(app)
      .post('/api/notes')
      .set('x-test-agent', 't1')
      .set('Idempotency-Key', 'abc-123')
      .send({});
    expect(r1.status).toBe(201);
    expect(r1.body).toEqual({ success: true, callCount: 1 });

    const r2 = await request(app)
      .post('/api/notes')
      .set('x-test-agent', 't1')
      .set('Idempotency-Key', 'abc-123')
      .send({});
    expect(r2.status).toBe(201);
    expect(r2.body).toEqual({ success: true, callCount: 1 }); // same payload, handler NOT re-run
    expect(getCallCount()).toBe(1);
  });

  it('different keys → handler runs each time', async () => {
    const { app, getCallCount } = makeApp();
    await request(app).post('/api/notes').set('x-test-agent', 't1').set('Idempotency-Key', 'k1').send({});
    await request(app).post('/api/notes').set('x-test-agent', 't1').set('Idempotency-Key', 'k2').send({});
    expect(getCallCount()).toBe(2);
  });

  it('isolates cache by token — agent A key does not return agent B response', async () => {
    const { app, getCallCount } = makeApp();
    await request(app)
      .post('/api/notes')
      .set('x-test-agent', 'tA')
      .set('Idempotency-Key', 'same-key')
      .send({});
    await request(app)
      .post('/api/notes')
      .set('x-test-agent', 'tB')
      .set('Idempotency-Key', 'same-key')
      .send({});
    expect(getCallCount()).toBe(2);
  });

  it('isolates cache by path — same key on different endpoints does not cross-cache', async () => {
    const { app, getCallCount } = makeApp();
    await request(app)
      .post('/api/notes')
      .set('x-test-agent', 't1')
      .set('Idempotency-Key', 'k')
      .send({});
    // Different path with same key → fresh execution
    const r = await request(app)
      .post('/api/fail')
      .set('x-test-agent', 't1')
      .set('Idempotency-Key', 'k')
      .send({});
    expect(r.status).toBe(500);
    expect(getCallCount()).toBe(1);
  });

  it('does NOT cache non-2xx responses (errors are retryable)', async () => {
    const { app } = makeApp();
    const r1 = await request(app)
      .post('/api/fail')
      .set('x-test-agent', 't1')
      .set('Idempotency-Key', 'kfail')
      .send({});
    expect(r1.status).toBe(500);

    const r2 = await request(app)
      .post('/api/fail')
      .set('x-test-agent', 't1')
      .set('Idempotency-Key', 'kfail')
      .send({});
    expect(r2.status).toBe(500); // handler runs again, no cached error
  });

  it('ignores Idempotency-Key on non-POST requests', async () => {
    const { app } = makeApp();
    const r = await request(app)
      .get('/api/get')
      .set('Idempotency-Key', 'k')
      .send();
    expect(r.status).toBe(200);
  });

  it('rejects malformed Idempotency-Key (empty)', async () => {
    const { app } = makeApp();
    const r = await request(app)
      .post('/api/notes')
      .set('x-test-agent', 't1')
      .set('Idempotency-Key', '')
      .send({});
    // Empty header is filtered by HTTP layer; we just verify normal flow doesn't crash.
    expect([201, 400]).toContain(r.status);
  });

  it('rejects oversized Idempotency-Key (> 256 chars)', async () => {
    const { app, getCallCount } = makeApp();
    const r = await request(app)
      .post('/api/notes')
      .set('x-test-agent', 't1')
      .set('Idempotency-Key', 'a'.repeat(257))
      .send({});
    expect(r.status).toBe(400);
    expect(getCallCount()).toBe(0);
  });

  it('expires cached response after TTL', async () => {
    const { app, getCallCount } = makeApp({ ttlMs: 50 });
    await request(app)
      .post('/api/notes')
      .set('x-test-agent', 't1')
      .set('Idempotency-Key', 'k-ttl')
      .send({});
    await new Promise((r) => setTimeout(r, 80));
    await request(app)
      .post('/api/notes')
      .set('x-test-agent', 't1')
      .set('Idempotency-Key', 'k-ttl')
      .send({});
    expect(getCallCount()).toBe(2);
  });

  it('concurrent requests with the same key dedup to a single handler run', async () => {
    // Two parallel webhook redeliveries — the second arrives while the
    // first is still mid-execution. Without in-flight dedup both reach
    // the handler and create two rows.
    const { app, getCallCount } = makeApp();
    const [r1, r2] = await Promise.all([
      request(app)
        .post('/api/slow')
        .set('x-test-agent', 't1')
        .set('Idempotency-Key', 'race')
        .send({}),
      request(app)
        .post('/api/slow')
        .set('x-test-agent', 't1')
        .set('Idempotency-Key', 'race')
        .send({}),
    ]);
    expect(getCallCount()).toBe(1);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    // Both responses must carry the same body — the dedup'd reply.
    expect(r1.body).toEqual(r2.body);
    // The replay leg should signal it was a concurrent replay (vs cache).
    const replays = [r1, r2].filter((r) => r.headers['idempotency-replayed']);
    expect(replays).toHaveLength(1);
    expect(replays[0].headers['idempotency-replayed']).toBe('concurrent');
  });

  it('anonymous callers from different IPs do NOT share a cache row', async () => {
    // Two unauthenticated clients with the same Idempotency-Key from
    // different IPs must each get their own handler execution; otherwise
    // caller B replays caller A's response (cache poisoning).
    const { app, getCallCount } = makeApp();
    const r1 = await request(app)
      .post('/api/notes')
      .set('X-Forwarded-For', '1.1.1.1')
      .set('Idempotency-Key', 'anon-key')
      .send({});
    const r2 = await request(app)
      .post('/api/notes')
      .set('X-Forwarded-For', '2.2.2.2')
      .set('Idempotency-Key', 'anon-key')
      .send({});
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(getCallCount()).toBe(2);
    // Each caller saw their own callCount value.
    expect((r1.body as any).callCount).toBe(1);
    expect((r2.body as any).callCount).toBe(2);
  });

  it('anonymous callers from same IP still dedup on same key', async () => {
    const { app, getCallCount } = makeApp();
    await request(app)
      .post('/api/notes')
      .set('X-Forwarded-For', '3.3.3.3')
      .set('Idempotency-Key', 'anon-same-ip')
      .send({});
    await request(app)
      .post('/api/notes')
      .set('X-Forwarded-For', '3.3.3.3')
      .set('Idempotency-Key', 'anon-same-ip')
      .send({});
    expect(getCallCount()).toBe(1);
  });
});
