import { describe, it, expect } from 'vitest';
import { parseLlmSummary } from '../sessions/manager.js';

describe('parseLlmSummary', () => {
  it('parses the canonical Title / Tags / Summary block', () => {
    const raw = [
      'Title: JWT auth migration discussion',
      'Tags: auth, backend, jwt',
      'Summary: The team reviewed three options and picked refresh tokens stored httpOnly. Reasoning was XSS risk on localStorage and CSRF risk on cookies; refresh in httpOnly + short-lived access in memory threads both needles.',
    ].join('\n');

    const result = parseLlmSummary(raw);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('JWT auth migration discussion');
    expect(result!.tags).toEqual(['auth', 'backend', 'jwt']);
    expect(result!.summary).toMatch(/^The team reviewed/);
  });

  it('preserves multi-line summary body', () => {
    const raw = [
      'Title: Multi-line case',
      'Summary: Line one.',
      'Line two.',
      '',
      'Line three after blank line.',
    ].join('\n');

    const result = parseLlmSummary(raw);
    expect(result!.summary).toContain('Line one.');
    expect(result!.summary).toContain('Line two.');
    expect(result!.summary).toContain('Line three after blank line.');
  });

  it('handles missing Tags line', () => {
    const raw = [
      'Title: No tags emitted',
      'Summary: This is a reasonably long summary that meets the twenty char minimum.',
    ].join('\n');
    const result = parseLlmSummary(raw);
    expect(result!.title).toBe('No tags emitted');
    expect(result!.tags).toEqual([]);
    expect(result!.summary).toMatch(/^This is a reasonably long/);
  });

  it('drops title that is too short (< 3 chars)', () => {
    const raw = 'Title: AB\nSummary: Long enough summary to be valid here.';
    const result = parseLlmSummary(raw);
    expect(result!.title).toBeUndefined();
  });

  it('drops title that is too long (> 120 chars)', () => {
    const raw = `Title: ${'x'.repeat(121)}\nSummary: Long enough summary that fits.`;
    const result = parseLlmSummary(raw);
    expect(result!.title).toBeUndefined();
  });

  it('falls back to whole raw text when no Summary: section was emitted', () => {
    const raw = 'The LLM ignored the template and just wrote prose here, plenty of words to clear the twenty character minimum.';
    const result = parseLlmSummary(raw);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe(raw);
    expect(result!.title).toBeUndefined();
  });

  it('falls back to raw when Summary section is shorter than the minimum', () => {
    // LLM emits "Summary: short" — 5 chars, below the 20 minimum. Whole raw
    // text is also short, but we still return what we have rather than
    // returning null.
    const raw = 'Title: Some title\nSummary: short';
    const result = parseLlmSummary(raw);
    expect(result).not.toBeNull();
    // Falls back to raw text — title prefix still embedded.
    expect(result!.summary.length).toBeGreaterThan(0);
  });

  it('returns null for empty input', () => {
    expect(parseLlmSummary('')).toBeNull();
    expect(parseLlmSummary('   \n  \n   ')).toBeNull();
  });

  it('returns null for non-string input', () => {
    // @ts-expect-error: testing runtime guard.
    expect(parseLlmSummary(undefined)).toBeNull();
    // @ts-expect-error: testing runtime guard.
    expect(parseLlmSummary(null)).toBeNull();
  });

  it('lowercases and trims tags', () => {
    const raw = 'Title: tag normalisation\nTags:  Auth ,  BACKEND, jwt ,, \nSummary: Plenty of summary content here please.';
    const result = parseLlmSummary(raw);
    expect(result!.tags).toEqual(['auth', 'backend', 'jwt']);
  });

  it('ignores leading prose before Title line', () => {
    const raw = [
      'Here is the requested summary block:',
      'Title: After preamble',
      'Summary: This summary follows a preamble line that should not become the title.',
    ].join('\n');
    const result = parseLlmSummary(raw);
    expect(result!.title).toBe('After preamble');
  });
});
