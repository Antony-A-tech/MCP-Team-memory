import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

describe('Client ID generation', () => {
  it('generates unique UUIDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => crypto.randomUUID()));
    expect(ids.size).toBe(100);
  });

  it('generates valid UUID v4 format', () => {
    const id = crypto.randomUUID();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});
