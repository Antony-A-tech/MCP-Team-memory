// src/__tests__/mcp-note-share.test.ts
//
// Unit tests for the note_share Zod schema and the buildMcpServer wiring.
// Full end-to-end exercise of the tool runtime is covered by the
// sessions+extraction integration test (Task 25); here we just verify
// the public schema rejects bad inputs and the server constructs cleanly
// when extraction deps are passed.

import { describe, it, expect } from 'vitest';
import { NoteShareSchema } from '../notes/validation.js';
import { buildMcpServer } from '../server.js';

describe('NoteShareSchema', () => {
  it('accepts a minimal valid payload', () => {
    const r = NoteShareSchema.safeParse({
      note_id: '11111111-1111-4111-9111-111111111111',
      category: 'decisions',
    });
    expect(r.success).toBe(true);
  });

  it('rejects invalid UUID for note_id', () => {
    const r = NoteShareSchema.safeParse({
      note_id: 'not-a-uuid',
      category: 'decisions',
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown category values (deprecated tasks/progress/issues)', () => {
    for (const cat of ['tasks', 'progress', 'issues', 'random', '']) {
      const r = NoteShareSchema.safeParse({
        note_id: '11111111-1111-4111-9111-111111111111',
        category: cat,
      });
      expect(r.success).toBe(false);
    }
  });

  it('accepts override with allowed fields', () => {
    const r = NoteShareSchema.safeParse({
      note_id: '11111111-1111-4111-9111-111111111111',
      category: 'architecture',
      override: {
        title: 'New title',
        content: 'New content',
        tags: ['a', 'b'],
        external_refs: { pr: 'https://example.com/pr/1' },
      },
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty title in override', () => {
    const r = NoteShareSchema.safeParse({
      note_id: '11111111-1111-4111-9111-111111111111',
      category: 'decisions',
      override: { title: '' },
    });
    expect(r.success).toBe(false);
  });

  it('accepts all four on_match values', () => {
    for (const v of ['prompt', 'confirm_existing', 'create_new', 'merge'] as const) {
      const r = NoteShareSchema.safeParse({
        note_id: '11111111-1111-4111-9111-111111111111',
        category: 'decisions',
        on_match: v,
      });
      expect(r.success).toBe(true);
    }
  });

  it('rejects unknown on_match values', () => {
    const r = NoteShareSchema.safeParse({
      note_id: '11111111-1111-4111-9111-111111111111',
      category: 'decisions',
      on_match: 'auto',
    });
    expect(r.success).toBe(false);
  });
});

describe('buildMcpServer with extraction deps', () => {
  it('constructs without error when extraction deps are provided', () => {
    const manager = { initialize: async () => {} } as never;
    const server = buildMcpServer(manager, undefined, undefined, undefined, {
      dedupResolver: undefined,
      merger: undefined,
    });
    expect(server).toBeDefined();
  });

  it('constructs without error when extraction deps are omitted', () => {
    const manager = { initialize: async () => {} } as never;
    const server = buildMcpServer(manager);
    expect(server).toBeDefined();
  });
});
