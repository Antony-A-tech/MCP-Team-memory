-- 018-auto-notes.sql
-- Adds auto-extraction columns to entries and personal_notes,
-- and extends sessions.embedding_status with extracting_notes / extraction_failed.

ALTER TABLE entries
  ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS extraction_confidence FLOAT,
  ADD COLUMN IF NOT EXISTS explicit_marker_strength FLOAT,
  ADD COLUMN IF NOT EXISTS confirmation_count INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS evidence_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS external_refs JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS importance_score FLOAT NOT NULL DEFAULT 0.5;

CREATE INDEX IF NOT EXISTS idx_entries_importance       ON entries(project_id, importance_score DESC);
CREATE INDEX IF NOT EXISTS idx_entries_evidence_sources ON entries USING GIN (evidence_sources);
CREATE INDEX IF NOT EXISTS idx_entries_external_refs    ON entries USING GIN (external_refs);
CREATE INDEX IF NOT EXISTS idx_entries_auto_generated   ON entries(project_id, auto_generated);

ALTER TABLE personal_notes
  ADD COLUMN IF NOT EXISTS shared_to_entry_id UUID REFERENCES entries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_personal_notes_shared
  ON personal_notes(shared_to_entry_id) WHERE shared_to_entry_id IS NOT NULL;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_embedding_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_embedding_status_check
  CHECK (embedding_status IN (
    'queued', 'queued_embed', 'summarizing', 'embedding',
    'extracting_notes', 'complete', 'failed', 'extraction_failed'
  ));
