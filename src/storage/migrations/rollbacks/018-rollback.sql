-- 018-rollback.sql
-- Manual rollback for migration 018-auto-notes.
-- Run by hand: psql $DATABASE_URL -f src/storage/migrations/rollbacks/018-rollback.sql
-- Then delete row: DELETE FROM schema_migrations WHERE version = 18;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_embedding_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_embedding_status_check
  CHECK (embedding_status IN ('queued','queued_embed','summarizing','embedding','complete','failed'));

DROP INDEX IF EXISTS idx_personal_notes_shared;
ALTER TABLE personal_notes DROP COLUMN IF EXISTS shared_to_entry_id;

DROP INDEX IF EXISTS idx_entries_importance;
DROP INDEX IF EXISTS idx_entries_evidence_sources;
DROP INDEX IF EXISTS idx_entries_external_refs;
DROP INDEX IF EXISTS idx_entries_auto_generated;
ALTER TABLE entries
  DROP COLUMN IF EXISTS auto_generated,
  DROP COLUMN IF EXISTS extraction_confidence,
  DROP COLUMN IF EXISTS explicit_marker_strength,
  DROP COLUMN IF EXISTS confirmation_count,
  DROP COLUMN IF EXISTS last_confirmed_at,
  DROP COLUMN IF EXISTS evidence_sources,
  DROP COLUMN IF EXISTS external_refs,
  DROP COLUMN IF EXISTS importance_score;
