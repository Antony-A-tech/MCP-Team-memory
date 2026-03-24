import { describe, it, expect, beforeEach } from 'vitest';
import { isInitializeRequest } from '../http.js';

describe('isInitializeRequest', () => {
  it('returns true for initialize JSON-RPC request', () => {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    };
    expect(isInitializeRequest(body)).toBe(true);
  });

  it('returns true for initialize in batched request', () => {
    const body = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ];
    expect(isInitializeRequest(body)).toBe(true);
  });

  it('returns false for tool call', () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_read' } };
    expect(isInitializeRequest(body)).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isInitializeRequest(null)).toBe(false);
    expect(isInitializeRequest(undefined)).toBe(false);
  });
});
