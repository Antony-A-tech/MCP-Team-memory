import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseIntSafe, loadConfig } from '../config.js';

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

describe('loadConfig', () => {
  const savedEnv = process.env;

  beforeEach(() => {
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('loads Gemini API key from env', () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const config = loadConfig();
    expect(config.geminiApiKey).toBe('test-key');
  });

  it('defaults Gemini model to gemini-2.5-flash', () => {
    delete process.env.GEMINI_MODEL;
    const config = loadConfig();
    expect(config.geminiModel).toBe('gemini-2.5-flash');
  });

  it('defaults RAG_MAX_ITERATIONS to 5', () => {
    delete process.env.RAG_MAX_ITERATIONS;
    const config = loadConfig();
    expect(config.ragMaxIterations).toBe(5);
  });

  it('defaults RAG_TOOL_RESPONSE_MAX_CHARS to 20000', () => {
    delete process.env.RAG_TOOL_RESPONSE_MAX_CHARS;
    const config = loadConfig();
    expect(config.ragToolResponseMaxChars).toBe(20_000);
  });
});
