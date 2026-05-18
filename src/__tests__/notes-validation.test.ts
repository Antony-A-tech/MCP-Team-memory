import { describe, it, expect } from 'vitest';
import { NoteWriteSchema } from '../notes/validation.js';

describe('NoteWriteSchema', () => {
  it('accepts a minimal valid payload', () => {
    const result = NoteWriteSchema.safeParse({
      title: 'hello',
      content: 'world',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual([]);
      expect(result.data.priority).toBe('medium');
    }
  });

  it('rejects empty title', () => {
    const result = NoteWriteSchema.safeParse({ title: '', content: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects oversize title (> 500 chars)', () => {
    const result = NoteWriteSchema.safeParse({
      title: 'a'.repeat(501),
      content: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects oversize content (> 50000 chars)', () => {
    const result = NoteWriteSchema.safeParse({
      title: 'x',
      content: 'a'.repeat(50001),
    });
    expect(result.success).toBe(false);
  });

  it('accepts tags as array', () => {
    const result = NoteWriteSchema.safeParse({
      title: 't',
      content: 'c',
      tags: ['a', 'b', 'c'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual(['a', 'b', 'c']);
    }
  });

  it('coerces comma-separated tag string to array', () => {
    const result = NoteWriteSchema.safeParse({
      title: 't',
      content: 'c',
      tags: 'one, two,three',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual(['one', 'two', 'three']);
    }
  });

  it('drops empty entries when coercing tag string', () => {
    const result = NoteWriteSchema.safeParse({
      title: 't',
      content: 'c',
      tags: 'a,,b,  ,c',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual(['a', 'b', 'c']);
    }
  });

  it('caps tags to 20', () => {
    const tags = Array.from({ length: 21 }, (_, i) => `t${i}`);
    const result = NoteWriteSchema.safeParse({
      title: 't',
      content: 'c',
      tags,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid UUID in project_id', () => {
    const result = NoteWriteSchema.safeParse({
      title: 't',
      content: 'c',
      project_id: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid UUIDs for project_id and session_id', () => {
    const result = NoteWriteSchema.safeParse({
      title: 't',
      content: 'c',
      project_id: '45c8f3bc-af69-404a-8fa2-897b53748e12',
      session_id: '7b9e3f2a-1d4c-4e5f-8a6b-2c3d4e5f6a7b',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid priority enum value', () => {
    const result = NoteWriteSchema.safeParse({
      title: 't',
      content: 'c',
      priority: 'urgent',
    });
    expect(result.success).toBe(false);
  });
});
