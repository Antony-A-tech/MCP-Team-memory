-- Rollback for 026-postwork-integrity.sql
-- Restores NO ACTION on personal_notes and sessions, removes comments.

ALTER TABLE personal_notes
  DROP CONSTRAINT IF EXISTS personal_notes_project_id_fkey;
ALTER TABLE personal_notes
  ADD CONSTRAINT personal_notes_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id);

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_project_id_fkey;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id);

COMMENT ON COLUMN entries.status IS NULL;
COMMENT ON COLUMN sessions.embedding_status IS NULL;
COMMENT ON COLUMN personal_notes.status IS NULL;
COMMENT ON COLUMN project_events.event_type IS NULL;
