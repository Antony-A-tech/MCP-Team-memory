-- 023-project-events.sql
-- Append-only WHAT-event timeline per project.
-- Auto-populated by extraction pipeline + manual API.
-- See plan: docs/superpowers/plans/2026-05-13-v5-profile-events-knowledge.md

CREATE TABLE IF NOT EXISTS project_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL CHECK (event_type IN ('merge','release','deploy','incident','milestone')),
  occurred_at     TIMESTAMPTZ NOT NULL,
  actor           TEXT,
  title           TEXT NOT NULL,
  description     TEXT,
  refs            JSONB NOT NULL DEFAULT '{}'::jsonb,
  auto_generated  BOOLEAN NOT NULL DEFAULT FALSE,
  evidence_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_events_recent
  ON project_events(project_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_events_type
  ON project_events(project_id, event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_events_evidence
  ON project_events USING GIN (evidence_sources);
