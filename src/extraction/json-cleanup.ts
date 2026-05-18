// src/extraction/json-cleanup.ts
//
// Shared normalizer for LLM JSON output. Small local models (e.g. qwen3.5:4b)
// ignore "no markdown" prompt instructions and wrap their reply in a ```json
// fence, and reasoning-tuned variants additionally emit <think>...</think>
// blocks. JSON.parse chokes on both. This strips the wrappers before parsing.
//
// Used by the notes extractor, the merge resolver and the events extractor —
// a single place so the three parsers stay consistent.

/**
 * Strip an enclosing markdown fence and <think>...</think> reasoning blocks
 * from a raw LLM response, returning the inner payload.
 *
 * - trims the input;
 * - removes every <think>...</think> block (case-insensitive, multiline);
 * - removes a leading ``` / ```json fence and a trailing ``` fence;
 * - if no fence is present, returns the (trimmed, think-stripped) input.
 *
 * Never throws. Does NOT validate that the result is JSON — that is the
 * caller's job, so callers keep control over their own parse-error handling.
 */
export function stripLlmJsonWrapper(raw: string): string {
  return raw
    .trim()
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}
