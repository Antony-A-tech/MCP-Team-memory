import { describe, it, expect, vi } from 'vitest';
import { createAuthMiddleware } from '../middleware/auth.js';
import type { Request, Response, NextFunction } from 'express';

function createMockAgentTokenStore() {
  return {
    resolve: vi.fn().mockReturnValue({
      id: '550e8400-e29b-41d4-a716-446655440000',
      agentName: 'test-agent',
      role: 'developer',
      isActive: true,
      allowedProjects: new Set(['660e8400-e29b-41d4-a716-446655441111']),
    }),
    trackLastUsed: vi.fn(),
    // Required by auth middleware RBAC check. Tests grant the project
    // matching the X-Project-Id header used below — without this the
    // middleware fails closed at 403.
    hasProjectAccess: vi.fn((_tokenId: string, projectId: string) =>
      projectId === '660e8400-e29b-41d4-a716-446655441111',
    ),
  };
}

describe('Auth middleware — agentTokenId propagation', () => {
  it('sets agentTokenId (UUID) in auth object for agent tokens', () => {
    const store = createMockAgentTokenStore();
    const middleware = createAuthMiddleware('master-token', store as any);

    const req = {
      path: '/mcp',
      headers: {
        authorization: 'Bearer tm_agent_token_123',
        'x-project-id': '660e8400-e29b-41d4-a716-446655441111',
      },
    } as unknown as Request;
    const res = { status: () => ({ json: () => undefined }) } as unknown as Response;
    const next: NextFunction = vi.fn();

    middleware(req, res, next);

    const auth = (req as any).auth;
    expect(auth.clientId).toBe('test-agent');
    expect(auth.agentTokenId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(next).toHaveBeenCalled();
  });

  it('does NOT set agentTokenId for master token', () => {
    const store = createMockAgentTokenStore();
    store.resolve.mockReturnValue(null);
    const middleware = createAuthMiddleware('master-secret', store as any);

    const req = {
      path: '/mcp',
      headers: { authorization: 'Bearer master-secret' },
    } as unknown as Request;
    const res = {} as Response;
    const next: NextFunction = vi.fn();

    middleware(req, res, next);

    const auth = (req as any).auth;
    expect(auth.clientId).toBe('master');
    expect(auth.agentTokenId).toBeUndefined();
  });
});
