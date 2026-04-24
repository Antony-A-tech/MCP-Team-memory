import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { registerChatRoutes } from '../app.js';

function buildTestApp(chatManager: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).auth = { agentTokenId: 'tok-1' }; next(); });
  registerChatRoutes(app, { chatManager, ragAgentFactory: null, titleGenerator: null } as any);
  return app;
}

describe('POST /api/chat/sessions', () => {
  it('creates session', async () => {
    const chatManager = { create: vi.fn().mockResolvedValue({ id: 'sess-1', title: 'Новый чат' }) };
    const res = await request(buildTestApp(chatManager)).post('/api/chat/sessions').send({ project_id: 'proj-1' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('sess-1');
    expect(chatManager.create).toHaveBeenCalledWith({ agentTokenId: 'tok-1', projectId: 'proj-1', title: undefined });
  });

  it('allows null project_id', async () => {
    const chatManager = { create: vi.fn().mockResolvedValue({ id: 'sess-2', title: 'Новый чат' }) };
    const res = await request(buildTestApp(chatManager)).post('/api/chat/sessions').send({});
    expect(res.status).toBe(201);
    expect(chatManager.create).toHaveBeenCalledWith({ agentTokenId: 'tok-1', projectId: null, title: undefined });
  });
});

describe('GET /api/chat/sessions', () => {
  it('returns list filtered by project_id', async () => {
    const chatManager = { list: vi.fn().mockResolvedValue([{ id: 'sess-1' }]) };
    const res = await request(buildTestApp(chatManager)).get('/api/chat/sessions?project_id=proj-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'sess-1' }]);
    expect(chatManager.list).toHaveBeenCalledWith('tok-1', expect.objectContaining({ projectId: 'proj-1' }));
  });
});

describe('GET /api/chat/sessions/:id', () => {
  it('returns 404 for nonexistent', async () => {
    const chatManager = { loadSessionWithMessages: vi.fn().mockResolvedValue(null) };
    const res = await request(buildTestApp(chatManager)).get('/api/chat/sessions/missing');
    expect(res.status).toBe(404);
  });

  it('returns session with messages', async () => {
    const chatManager = {
      loadSessionWithMessages: vi.fn().mockResolvedValue({ id: 'sess-1', messages: [{ id: 1, role: 'user', content: 'hi' }] }),
    };
    const res = await request(buildTestApp(chatManager)).get('/api/chat/sessions/sess-1');
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
  });
});

describe('PATCH /api/chat/sessions/:id', () => {
  it('renames session', async () => {
    const chatManager = { rename: vi.fn().mockResolvedValue(undefined) };
    const res = await request(buildTestApp(chatManager)).patch('/api/chat/sessions/sess-1').send({ title: 'New' });
    expect(res.status).toBe(204);
    expect(chatManager.rename).toHaveBeenCalledWith('sess-1', 'tok-1', 'New');
  });

  it('rejects missing title', async () => {
    const chatManager = {} as any;
    const res = await request(buildTestApp(chatManager)).patch('/api/chat/sessions/sess-1').send({});
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/chat/sessions/:id', () => {
  it('soft deletes', async () => {
    const chatManager = { softDelete: vi.fn().mockResolvedValue(undefined) };
    const res = await request(buildTestApp(chatManager)).delete('/api/chat/sessions/sess-1');
    expect(res.status).toBe(204);
    expect(chatManager.softDelete).toHaveBeenCalledWith('sess-1', 'tok-1');
  });
});
