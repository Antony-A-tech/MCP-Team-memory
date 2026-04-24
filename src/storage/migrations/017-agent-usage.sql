-- Migration 017: Per-agent LLM usage accounting (tokens + $ cost)
-- Cumulative counters on agent_tokens. Updated fire-and-forget after each chat turn.

ALTER TABLE agent_tokens
  ADD COLUMN IF NOT EXISTS total_prompt_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_completion_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_cost_usd NUMERIC(14, 6) NOT NULL DEFAULT 0;
