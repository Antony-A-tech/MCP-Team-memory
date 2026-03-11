import { describe, it, expect } from 'vitest';
import { escapeIlike } from '../storage/pg-storage.js';

describe('escapeIlike', () => {
  it('should escape % character', () => {
    expect(escapeIlike('100%')).toBe('100\\%');
  });

  it('should escape _ character', () => {
    expect(escapeIlike('file_name')).toBe('file\\_name');
  });

  it('should escape backslash', () => {
    expect(escapeIlike('path\\to')).toBe('path\\\\to');
  });

  it('should escape all special chars together', () => {
    expect(escapeIlike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  it('should leave normal strings unchanged', () => {
    expect(escapeIlike('normal query')).toBe('normal query');
  });
});
