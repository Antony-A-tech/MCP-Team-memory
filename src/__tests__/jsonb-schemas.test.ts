// src/__tests__/jsonb-schemas.test.ts
//
// Unit tests for JSONB validation schemas — Phase 1.D of
// docs/superpowers/plans/2026-05-15-v5-postwork-audit-fixes.md.

import { describe, it, expect } from 'vitest';
import {
  ExternalRefsSchema,
  EvidenceSourceSchema,
  EvidenceSourcesArraySchema,
  EventRefsSchema,
} from '../memory/jsonb-schemas.js';

describe('ExternalRefsSchema', () => {
  it('accepts the canonical fields', () => {
    const result = ExternalRefsSchema.parse({
      pr_number: 42,
      commit_sha: 'abc1234',
      version_tag: 'v1.2.3',
      deployment_url: 'https://deploy.example.com/x',
      incident_id: 'INC-101',
    });
    expect(result.pr_number).toBe(42);
    expect(result.commit_sha).toBe('abc1234');
  });

  it('strips unknown fields silently (forward-compat)', () => {
    const result = ExternalRefsSchema.parse({
      pr_number: 1,
      unknown_garbage: 'whatever',
      another: { nested: 'thing' },
    });
    expect(result.pr_number).toBe(1);
    expect((result as Record<string, unknown>).unknown_garbage).toBeUndefined();
  });

  it('rejects negative pr_number', () => {
    expect(() => ExternalRefsSchema.parse({ pr_number: -1 })).toThrow();
  });

  it('rejects non-hex commit_sha', () => {
    expect(() => ExternalRefsSchema.parse({ commit_sha: 'not-a-sha-zzz' })).toThrow();
  });

  it('accepts full 40-char SHA', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    expect(ExternalRefsSchema.parse({ commit_sha: sha }).commit_sha).toBe(sha);
  });

  it('rejects malformed URL in deployment_url', () => {
    expect(() => ExternalRefsSchema.parse({ deployment_url: 'not a url' })).toThrow();
  });

  it('empty object is valid', () => {
    expect(ExternalRefsSchema.parse({})).toEqual({});
  });

  it('accepts work_item_id as either string or number', () => {
    expect(ExternalRefsSchema.parse({ work_item_id: 12345 }).work_item_id).toBe(12345);
    expect(ExternalRefsSchema.parse({ work_item_id: 'AB-123' }).work_item_id).toBe('AB-123');
  });
});

describe('EvidenceSourceSchema', () => {
  it('accepts session source', () => {
    const e = EvidenceSourceSchema.parse({
      type: 'session',
      id: 'sess-abc',
      agent_token_id: '550e8400-e29b-41d4-a716-446655440000',
      confirmed_at: '2026-05-15T10:00:00Z',
    });
    expect(e.type).toBe('session');
  });

  it('rejects unknown type', () => {
    expect(() => EvidenceSourceSchema.parse({ type: 'unknown', id: 'x' })).toThrow();
  });

  it('requires non-empty id', () => {
    expect(() => EvidenceSourceSchema.parse({ type: 'session', id: '' })).toThrow();
  });

  it('rejects non-UUID agent_token_id', () => {
    expect(() =>
      EvidenceSourceSchema.parse({ type: 'session', id: 'x', agent_token_id: 'not-uuid' }),
    ).toThrow();
  });
});

describe('EvidenceSourcesArraySchema', () => {
  it('accepts empty array', () => {
    expect(EvidenceSourcesArraySchema.parse([])).toEqual([]);
  });

  it('accepts up to 50 sources', () => {
    const arr = Array.from({ length: 50 }, (_, i) => ({ type: 'session' as const, id: `s${i}` }));
    expect(EvidenceSourcesArraySchema.parse(arr)).toHaveLength(50);
  });

  it('rejects more than 50 sources (runaway extraction guard)', () => {
    const arr = Array.from({ length: 51 }, (_, i) => ({ type: 'session' as const, id: `s${i}` }));
    expect(() => EvidenceSourcesArraySchema.parse(arr)).toThrow();
  });
});

describe('EventRefsSchema', () => {
  it('is an alias for ExternalRefsSchema (same shape)', () => {
    expect(EventRefsSchema).toBe(ExternalRefsSchema);
  });
});
