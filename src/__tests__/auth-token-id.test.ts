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
    }),
    trackLastUsed: vi.fn(),
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
        'x-project-id': 'proj-1',
      },
    } as unknown as Request;
    const res = {} as Response;
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
