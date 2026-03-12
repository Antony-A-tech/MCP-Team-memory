import { describe, it, expect } from 'vitest';
import { parseIntSafe } from '../config.js';

describe('parseIntSafe', () => {
  it('should parse valid integer', () => {
    expect(parseIntSafe('3846', 3846)).toBe(3846);
  });

  it('should return default for NaN', () => {
    expect(parseIntSafe('abc', 3846)).toBe(3846);
  });

  it('should return default for empty string', () => {
    expect(parseIntSafe('', 3846)).toBe(3846);
  });

  it('should parse negative numbers', () => {
    expect(parseIntSafe('-1', 0)).toBe(-1);
  });
});
