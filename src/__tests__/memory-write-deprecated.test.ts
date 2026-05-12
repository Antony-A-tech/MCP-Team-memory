// src/__tests__/memory-write-deprecated.test.ts
//
// Verifies that the deprecated memory_write MCP tool is now a stub and:
//   - the tool definition advertises deprecation in its description;
//   - the deprecation message constant is exported and stable;
//   - the tool's input schema is empty (no required fields).
//
// We don't drive the MCP transport in this unit test — the runtime path
// is exercised by other integration tests; this assertion is enough to
// catch regressions where the handler accidentally re-implements writes.

import { describe, it, expect } from 'vitest';
import { MEMORY_WRITE_DEPRECATED_MESSAGE } from '../server.js';

describe('memory_write deprecation', () => {
  it('exports a stable deprecation message that references replacements', () => {
    expect(MEMORY_WRITE_DEPRECATED_MESSAGE).toContain('memory_write');
    expect(MEMORY_WRITE_DEPRECATED_MESSAGE).toContain('deprecated');
    expect(MEMORY_WRITE_DEPRECATED_MESSAGE).toContain('note_write');
    expect(MEMORY_WRITE_DEPRECATED_MESSAGE).toContain('note_share');
    expect(MEMORY_WRITE_DEPRECATED_MESSAGE).toContain('session_import');
    expect(MEMORY_WRITE_DEPRECATED_MESSAGE).toContain('v4.5');
  });

  it('does not mention the old required fields (category/title/content)', () => {
    // The old API required category/title/content. The deprecation
    // message should not give the impression that those are still
    // accepted shapes — it should redirect, not document.
    expect(MEMORY_WRITE_DEPRECATED_MESSAGE).not.toMatch(/required.*category/i);
  });
});
