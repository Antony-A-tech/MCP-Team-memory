import { describe, it, expect } from 'vitest';
import { createAuthMiddleware } from '../middleware/auth.js';

// Minimal Express mock
function mockReq(headers: Record<string, string> = {}) {
  return { headers, path: '/api/memory' } as any;
}

function mockRes() {
  const res: any = { statusCode: 200, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

describe('Auth middleware', () => {
  it('passes through when no token configured', () => {
    const middleware = createAuthMiddleware(undefined);
    const next = () => {};
    const req = mockReq();
    const res = mockRes();

    middleware(req, res, next);
    expect(res.statusCode).toBe(200);
  });

  it('rejects request without token when token is configured', () => {
    const middleware = createAuthMiddleware('secret-token-123');
    const next = () => {};
    const req = mockReq();
    const res = mockRes();

    middleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toContain('required');
  });

  it('rejects request with wrong token', () => {
    const middleware = createAuthMiddleware('secret-token-123');
    const next = () => {};
    const req = mockReq({ authorization: 'Bearer wrong-token' });
    const res = mockRes();

    middleware(req, res, next);
    expect(res.statusCode).toBe(403);
  });

  it('allows request with correct token', () => {
    const middleware = createAuthMiddleware('secret-token-123');
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    const req = mockReq({ authorization: 'Bearer secret-token-123' });
    const res = mockRes();

    middleware(req, res, next);
    expect(nextCalled).toBe(true);
  });

  it('skips auth for static files (no /api/ prefix)', () => {
    const middleware = createAuthMiddleware('secret-token-123');
    let nextCalled = false;
    const next = () => { nextCalled = true; };
    const req = mockReq();
    req.path = '/styles.css';
    const res = mockRes();

    middleware(req, res, next);
    expect(nextCalled).toBe(true);
  });
});
