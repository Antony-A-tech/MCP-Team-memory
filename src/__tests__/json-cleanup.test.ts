import { describe, it, expect } from 'vitest';
import { stripLlmJsonWrapper } from '../extraction/json-cleanup.js';

describe('stripLlmJsonWrapper', () => {
  it('strips a ```json markdown fence', () => {
    expect(stripLlmJsonWrapper('```json\n{"events":[]}\n```')).toBe('{"events":[]}');
  });

  it('strips a bare ``` markdown fence', () => {
    expect(stripLlmJsonWrapper('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips the fence case-insensitively (```JSON)', () => {
    expect(stripLlmJsonWrapper('```JSON\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('removes <think>...</think> reasoning blocks', () => {
    expect(stripLlmJsonWrapper('<think>let me think</think>\n{"a":1}')).toBe('{"a":1}');
  });

  it('removes <think> blocks case-insensitively and across lines', () => {
    expect(stripLlmJsonWrapper('<THINK>line one\nline two</THINK>\n{"a":1}')).toBe('{"a":1}');
  });

  it('removes a <think> block AND an enclosing fence (real qwen shape)', () => {
    const raw = '<think>reasoning here</think>\n```json\n{"events":[]}\n```';
    expect(stripLlmJsonWrapper(raw)).toBe('{"events":[]}');
  });

  it('returns non-fenced input unchanged (after trim)', () => {
    expect(stripLlmJsonWrapper('not json')).toBe('not json');
    expect(stripLlmJsonWrapper('  {"a":1}  ')).toBe('{"a":1}');
  });

  it('does not throw on empty or garbage input', () => {
    expect(() => stripLlmJsonWrapper('')).not.toThrow();
    expect(() => stripLlmJsonWrapper('```')).not.toThrow();
    expect(() => stripLlmJsonWrapper('<think>unclosed')).not.toThrow();
  });
});
