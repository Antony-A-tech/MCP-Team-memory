// src/__tests__/project-scope-enforcement.test.ts
//
// Tests for enforceProjectScope — Phase 0.E of
// docs/superpowers/plans/2026-05-15-v5-postwork-audit-fixes.md.

import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { enforceProjectScope } from '../middleware/project-scope.js';

const PROJECT_A = '00000000-0000-0000-0000-00000000000a';
const PROJECT_B = '00000000-0000-0000-0000-00000000000b';

function makeRes() {
  const status = vi.fn();
  const json = vi.fn();
  const res = { status, json } as unknown as Response;
  status.mockReturnValue(res);
  json.mockReturnValue(res);
  return { res, status, json };
}

function makeReq(auth: { projectId?: string; scopes?: string[] } | undefined): Request {
  return { headers: {}, query: {}, body: {}, ...(auth ? { auth } : {}) } as unknown as Request & { auth?: unknown };
}

describe('enforceProjectScope', () => {
  it('allows request when token is admin (master) regardless of target', () => {
    const req = makeReq({ projectId: PROJECT_A, scopes: ['admin'] });
    const { res, status } = makeRes();
    expect(enforceProjectScope(req, res, PROJECT_B)).toBe(true);
    expect(status).not.toHaveBeenCalled();
  });

  it('allows request when token has no scope (no header)', () => {
    const req = makeReq({ scopes: ['developer'] });
    const { res, status } = makeRes();
    expect(enforceProjectScope(req, res, PROJECT_B)).toBe(true);
    expect(status).not.toHaveBeenCalled();
  });

  it('allows request when no auth at all (auth disabled)', () => {
    const req = makeReq(undefined);
    const { res, status } = makeRes();
    expect(enforceProjectScope(req, res, PROJECT_B)).toBe(true);
    expect(status).not.toHaveBeenCalled();
  });

  it('allows when target equals token scope', () => {
    const req = makeReq({ projectId: PROJECT_A, scopes: ['developer'] });
    const { res, status } = makeRes();
    expect(enforceProjectScope(req, res, PROJECT_A)).toBe(true);
    expect(status).not.toHaveBeenCalled();
  });

  it('allows when no explicit target — handler will use scope', () => {
    const req = makeReq({ projectId: PROJECT_A, scopes: ['developer'] });
    const { res, status } = makeRes();
    expect(enforceProjectScope(req, res, undefined)).toBe(true);
    expect(status).not.toHaveBeenCalled();
  });

  it('rejects with 403 when target ≠ token scope and not admin', () => {
    const req = makeReq({ projectId: PROJECT_A, scopes: ['developer'] });
    const { res, status, json } = makeRes();
    expect(enforceProjectScope(req, res, PROJECT_B)).toBe(false);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalled();
    const body = json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/scope mismatch/i);
    expect(body.error).toContain(PROJECT_A);
    expect(body.error).toContain(PROJECT_B);
  });

  it('rejects with 403 for readonly token cross-project access', () => {
    const req = makeReq({ projectId: PROJECT_A, scopes: ['readonly'] });
    const { res, status } = makeRes();
    expect(enforceProjectScope(req, res, PROJECT_B)).toBe(false);
    expect(status).toHaveBeenCalledWith(403);
  });

  it('treats null target as absent (allows)', () => {
    const req = makeReq({ projectId: PROJECT_A, scopes: ['developer'] });
    const { res, status } = makeRes();
    expect(enforceProjectScope(req, res, null)).toBe(true);
    expect(status).not.toHaveBeenCalled();
  });
});
