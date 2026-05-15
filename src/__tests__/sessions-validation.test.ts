import { describe, it, expect } from 'vitest';
import { SessionReadSchema } from '../sessions/validation.js';

describe('SessionReadSchema', () => {
  const validId = '45c8f3bc-af69-404a-8fa2-897b53748e12';

  it('accepts a valid session_id alone (defaults message_from=0)', () => {
    const result = SessionReadSchema.safeParse({ session_id: validId });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message_from).toBe(0);
      expect(result.data.message_to).toBeUndefined();
    }
  });

  it('accepts message_from < message_to', () => {
    const result = SessionReadSchema.safeParse({
      session_id: validId,
      message_from: 5,
      message_to: 20,
    });
    expect(result.success).toBe(true);
  });

  it('accepts message_from === message_to', () => {
    // Edge case: single-message window. Schema must allow equality.
    const result = SessionReadSchema.safeParse({
      session_id: validId,
      message_from: 10,
      message_to: 10,
    });
    expect(result.success).toBe(true);
  });

  it('rejects message_from > message_to', () => {
    const result = SessionReadSchema.safeParse({
      session_id: validId,
      message_from: 20,
      message_to: 5,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('message_to'));
      expect(issue?.message).toMatch(/message_to must be >= message_from/);
    }
  });

  it('rejects negative message_from', () => {
    const result = SessionReadSchema.safeParse({
      session_id: validId,
      message_from: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer message_from', () => {
    const result = SessionReadSchema.safeParse({
      session_id: validId,
      message_from: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-UUID session_id', () => {
    const result = SessionReadSchema.safeParse({
      session_id: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });
});
