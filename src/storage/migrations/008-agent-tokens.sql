-- Migration 008: Agent tokens for per-agent identity
-- Each agent/team member gets a unique token; author is derived from token, not user input

CREATE TABLE IF NOT EXISTS agent_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT UNIQUE NOT NULL,
  agent_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_tokens_active ON agent_tokens (token) WHERE is_active = TRUE;
