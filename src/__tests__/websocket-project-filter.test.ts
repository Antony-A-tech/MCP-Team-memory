import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncWebSocketServer } from '../sync/websocket.js';

// Minimal mock for MemoryManager
const mockManager = {
  subscribe: vi.fn(() => () => {}),
} as any;

function createServer(): SyncWebSocketServer {
  return new SyncWebSocketServer(mockManager);
}

function addMockClient(
  server: SyncWebSocketServer,
  overrides: { id: string; name: string; clientType?: 'agent' | 'ui'; projectId?: string; sendSpy?: ReturnType<typeof vi.fn> }
): ReturnType<typeof vi.fn> {
  const clients = (server as any).clients as Map<string, any>;
  const sendSpy = overrides.sendSpy ?? vi.fn();
  clients.set(overrides.id, {
    ws: {
      readyState: 1,
      send: sendSpy,
    },
    id: overrides.id,
    name: overrides.name,
    clientType: overrides.clientType || 'agent',
    projectId: overrides.projectId,
    connectedAt: new Date(),
  });
  return sendSpy;
}

describe('Project-scoped connection filtering', () => {
  let server: SyncWebSocketServer;

  beforeEach(() => {
    server = createServer();
    addMockClient(server, { id: 'a1', name: 'Agent-1', clientType: 'agent', projectId: 'proj-A' });
    addMockClient(server, { id: 'a2', name: 'Agent-2', clientType: 'agent', projectId: 'proj-A' });
    addMockClient(server, { id: 'b1', name: 'Agent-3', clientType: 'agent', projectId: 'proj-B' });
    addMockClient(server, { id: 'u1', name: 'UI-1', clientType: 'ui', projectId: 'proj-A' });
    addMockClient(server, { id: 'g1', name: 'Global', clientType: 'agent' }); // no projectId
  });

  describe('getConnectedClientsInfo', () => {
    it('returns all clients when no projectId filter', () => {
      const result = server.getConnectedClientsInfo();
      expect(result).toHaveLength(5);
    });

    it('filters clients by projectId', () => {
      const result = server.getConnectedClientsInfo('proj-A');
      expect(result).toHaveLength(3); // a1, a2, u1
      expect(result.every(c => c.projectId === 'proj-A')).toBe(true);
    });

    it('returns only matching project clients', () => {
      const result = server.getConnectedClientsInfo('proj-B');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Agent-3');
    });

    it('returns empty array for unknown project', () => {
      const result = server.getConnectedClientsInfo('proj-unknown');
      expect(result).toHaveLength(0);
    });

    it('includes projectId in returned data', () => {
      const result = server.getConnectedClientsInfo('proj-A');
      expect(result[0].projectId).toBe('proj-A');
    });
  });

  describe('getConnectedCount', () => {
    it('returns total count when no projectId', () => {
      expect(server.getConnectedCount()).toBe(5);
    });

    it('counts only clients for specified project', () => {
      expect(server.getConnectedCount('proj-A')).toBe(3);
      expect(server.getConnectedCount('proj-B')).toBe(1);
    });

    it('returns 0 for unknown project', () => {
      expect(server.getConnectedCount('proj-unknown')).toBe(0);
    });
  });
});

describe('Project-scoped broadcast filtering (3.F)', () => {
  // These tests cover the leak fix: events scoped to one project must not
  // reach clients connected to other projects. Without the filter, a UI in
  // project A would see "agent:connected"/"memory:created" events from
  // project B and could be misled about activity in other projects.

  let server: SyncWebSocketServer;
  const sendSpies: Record<string, ReturnType<typeof vi.fn>> = {};

  beforeEach(() => {
    server = createServer();
    sendSpies.a1 = addMockClient(server, { id: 'a1', name: 'Agent-A1', clientType: 'agent', projectId: 'proj-A' });
    sendSpies.a2 = addMockClient(server, { id: 'a2', name: 'UI-A2',    clientType: 'ui',    projectId: 'proj-A' });
    sendSpies.b1 = addMockClient(server, { id: 'b1', name: 'Agent-B1', clientType: 'agent', projectId: 'proj-B' });
    sendSpies.g1 = addMockClient(server, { id: 'g1', name: 'Global',   clientType: 'agent' /* no projectId */ });
  });

  function callBroadcast(event: any): void {
    (server as any).broadcast(event);
  }

  function callBroadcastExcept(excludeId: string, event: any): void {
    (server as any).broadcastExcept(excludeId, event);
  }

  it('memory:created with projectId scoped to that project (does NOT leak to other projects)', () => {
    callBroadcast({
      type: 'memory:created',
      payload: { id: 'mem-1', projectId: 'proj-A', title: 'hello' },
      timestamp: '2026-05-15T00:00:00.000Z',
    });

    expect(sendSpies.a1).toHaveBeenCalledTimes(1);
    expect(sendSpies.a2).toHaveBeenCalledTimes(1);
    expect(sendSpies.b1).not.toHaveBeenCalled();
    // Clients without projectId still receive (legacy/global viewer).
    expect(sendSpies.g1).toHaveBeenCalledTimes(1);
  });

  it('memory:deleted carries projectId and respects filter', () => {
    callBroadcast({
      type: 'memory:deleted',
      payload: { id: 'mem-1', projectId: 'proj-B' },
      timestamp: '2026-05-15T00:00:00.000Z',
    });

    expect(sendSpies.b1).toHaveBeenCalledTimes(1);
    expect(sendSpies.a1).not.toHaveBeenCalled();
    expect(sendSpies.a2).not.toHaveBeenCalled();
    expect(sendSpies.g1).toHaveBeenCalledTimes(1);
  });

  it('agent:connected scoped — does NOT leak agent identity cross-project', () => {
    callBroadcastExcept('b1', {
      type: 'agent:connected',
      payload: { clientId: 'b1', clientName: 'Agent-B1', agentName: 'b1-agent', projectId: 'proj-B' },
      timestamp: '2026-05-15T00:00:00.000Z',
    });

    expect(sendSpies.a1).not.toHaveBeenCalled();
    expect(sendSpies.a2).not.toHaveBeenCalled();
    expect(sendSpies.b1).not.toHaveBeenCalled(); // self-excluded
    expect(sendSpies.g1).toHaveBeenCalledTimes(1);
  });

  it('agent:disconnected scoped — does NOT leak cross-project', () => {
    callBroadcast({
      type: 'agent:disconnected',
      payload: { clientId: 'b1', clientName: 'Agent-B1', projectId: 'proj-B' },
      timestamp: '2026-05-15T00:00:00.000Z',
    });

    expect(sendSpies.a1).not.toHaveBeenCalled();
    expect(sendSpies.a2).not.toHaveBeenCalled();
    expect(sendSpies.b1).toHaveBeenCalledTimes(1);
    expect(sendSpies.g1).toHaveBeenCalledTimes(1);
  });

  it('event without projectId in payload broadcasts to all (global)', () => {
    callBroadcast({
      type: 'memory:sync',
      payload: { pong: true },
      timestamp: '2026-05-15T00:00:00.000Z',
    });

    expect(sendSpies.a1).toHaveBeenCalledTimes(1);
    expect(sendSpies.a2).toHaveBeenCalledTimes(1);
    expect(sendSpies.b1).toHaveBeenCalledTimes(1);
    expect(sendSpies.g1).toHaveBeenCalledTimes(1);
  });

  it('broadcastExcept respects both exclusion and project filter', () => {
    callBroadcastExcept('a1', {
      type: 'agent:connected',
      payload: { clientId: 'a1', clientName: 'Agent-A1', projectId: 'proj-A' },
      timestamp: '2026-05-15T00:00:00.000Z',
    });

    expect(sendSpies.a1).not.toHaveBeenCalled(); // excluded
    expect(sendSpies.a2).toHaveBeenCalledTimes(1); // same project
    expect(sendSpies.b1).not.toHaveBeenCalled(); // different project
    expect(sendSpies.g1).toHaveBeenCalledTimes(1); // no projectId — global viewer
  });
});
