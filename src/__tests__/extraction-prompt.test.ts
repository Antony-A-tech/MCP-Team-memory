// src/__tests__/extraction-prompt.test.ts
//
// Unit tests for the auto-notes extraction prompt builder, language detection,
// and message-sampling helper.

import { describe, it, expect } from 'vitest';
import {
  buildExtractionPrompt,
  detectLang,
  sampleMessagesForPrompt,
} from '../extraction/prompt.js';

describe('detectLang', () => {
  it('detects Russian when Cyrillic ratio > 15%', () => {
    expect(detectLang('Hello мир и тогда')).toBe('Russian');
  });

  it('defaults to English when Cyrillic ratio < 15%', () => {
    expect(detectLang('Just plain English without accents')).toBe('English');
  });

  it('handles empty input', () => {
    expect(detectLang('')).toBe('English');
  });

  it('treats whitespace/punctuation-only input as English', () => {
    expect(detectLang('   --- !!! ')).toBe('English');
  });
});

describe('sampleMessagesForPrompt', () => {
  it('returns all messages when count is at or under the cap', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({
      role: 'user',
      content: `m${i}`,
    }));
    expect(sampleMessagesForPrompt(msgs)).toHaveLength(30);
  });

  it('keeps first 10 + last 10 + sampled middle when above cap, ordered', () => {
    const msgs = Array.from({ length: 200 }, (_, i) => ({
      role: 'user',
      content: `m${i}`,
    }));
    const out = sampleMessagesForPrompt(msgs);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out[0].content).toBe('m0');
    expect(out[out.length - 1].content).toBe('m199');
  });

  it('sampling does not lose first or last messages on huge input', () => {
    const msgs = Array.from({ length: 5000 }, (_, i) => ({
      role: 'user',
      content: `m${i}`,
    }));
    const out = sampleMessagesForPrompt(msgs);
    expect(out[0].content).toBe('m0');
    expect(out[out.length - 1].content).toBe('m4999');
  });
});

describe('buildExtractionPrompt', () => {
  it('includes summary, transcript, language tag, and category JSON skeleton', () => {
    const prompt = buildExtractionPrompt({
      summary: 'Worked on auth refactor',
      messages: [{ role: 'user', content: 'Решили использовать JWT' }],
    });
    expect(prompt).toContain('Worked on auth refactor');
    expect(prompt).toContain('Решили использовать JWT');
    // Language hint appears somewhere in the prompt
    expect(prompt).toMatch(/Russian|English/);
    // All three valid categories must be in the JSON skeleton
    expect(prompt).toContain('"architecture"');
    expect(prompt).toContain('"decisions"');
    expect(prompt).toContain('"conventions"');
  });

  it('truncates very long messages to keep the prompt bounded', () => {
    const huge = 'x'.repeat(10_000);
    const prompt = buildExtractionPrompt({
      summary: 'Summary',
      messages: [{ role: 'user', content: huge }],
    });
    // Way under 10k but still nontrivial
    expect(prompt.length).toBeLessThan(8_000);
  });
});
