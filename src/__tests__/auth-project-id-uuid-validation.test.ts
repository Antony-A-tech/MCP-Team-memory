// src/__tests__/auth-project-id-uuid-validation.test.ts
//
// Regression test: X-Project-Id header must be a UUID. Defence-in-depth
// against SQL injection attempts and malformed input — already blocked by
// parameterized queries, but rejecting at the edge yields clean 400s instead
// of postgres invalid-uuid-syntax errors becoming generic 500s.
//
// Phase 0.D of docs/superpowers/plans/2026-05-15-v5-postwork-audit-fixes.md.

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthMiddleware } from '../middleware/auth.js';

describe('createAuthMiddleware — X-Project-Id UUID validation', () => {
  const VALID_UUID = '11111111-2222-3333-4444-555555555555';

  function buildApp(opts: { token?: string; allowReadonly?: boolean }) {
    const app = express();
    app.use(createAuthMiddleware(opts.token, undefined, { allowReadonly: opts.allowReadonly }));
    app.get('/api/probe', (req, res) => {
      res.json({ auth: (req as any).auth ?? null });
    });
    return app;
  }

  describe('with no token (auth disabled)', () => {
    let app: express.Express;
    beforeEach(() => { app = buildApp({}); });

    it('accepts a valid UUID and exposes it on req.auth', async () => {
      const res = await request(app).get('/api/probe').set('X-Project-Id', VALID_UUID);
      expect(res.status).toBe(200);
      expect(res.body.auth?.projectId).toBe(VALID_UUID);
    });

    it('rejects SQL-injection-shaped value with 400', async () => {
      const res = await request(app).get('/api/probe').set('X-Project-Id', "'; DROP TABLE entries; --");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/X-Project-Id/i);
    });

    it('rejects a non-UUID short string with 400', async () => {
      const res = await request(app).get('/api/probe').set('X-Project-Id', 'foo');
      expect(res.status).toBe(400);
    });

    it('rejects extra whitespace UUID variant with 400 only if not a UUID', async () => {
      // Trailing whitespace is trimmed, so this should pass.
      const res = await request(app).get('/api/probe').set('X-Project-Id', `  ${VALID_UUID}  `);
      expect(res.status).toBe(200);
      expect(res.body.auth?.projectId).toBe(VALID_UUID);
    });

    it('passes through when header is absent', async () => {
      const res = await request(app).get('/api/probe');
      expect(res.status).toBe(200);
      expect(res.body.auth).toBeNull();
    });

    it('treats empty header value as absent', async () => {
      const res = await request(app).get('/api/probe').set('X-Project-Id', '');
      expect(res.status).toBe(200);
      expect(res.body.auth).toBeNull();
    });
  });

  describe('with token + readonly fallback', () => {
    let app: express.Express;
    beforeEach(() => { app = buildApp({ token: 'secret', allowReadonly: true }); });

    it('rejects malformed UUID in readonly path with 400', async () => {
      const res = await request(app).get('/api/probe').set('X-Project-Id', 'not-a-uuid');
      expect(res.status).toBe(400);
    });

    it('accepts valid UUID in readonly path', async () => {
      const res = await request(app).get('/api/probe').set('X-Project-Id', VALID_UUID);
      expect(res.status).toBe(200);
      expect(res.body.auth?.scopes).toContain('readonly');
      expect(res.body.auth?.projectId).toBe(VALID_UUID);
    });
  });

  describe('with master token', () => {
    let app: express.Express;
    beforeEach(() => { app = buildApp({ token: 'secret' }); });

    it('rejects malformed UUID even with valid Bearer token', async () => {
      const res = await request(app)
        .get('/api/probe')
        .set('Authorization', 'Bearer secret')
        .set('X-Project-Id', "' OR 1=1");
      expect(res.status).toBe(400);
    });

    it('accepts valid UUID with master Bearer', async () => {
      const res = await request(app)
        .get('/api/probe')
        .set('Authorization', 'Bearer secret')
        .set('X-Project-Id', VALID_UUID);
      expect(res.status).toBe(200);
      expect(res.body.auth?.scopes).toContain('admin');
      expect(res.body.auth?.projectId).toBe(VALID_UUID);
    });
  });
});
