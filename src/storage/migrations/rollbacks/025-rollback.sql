-- Rollback for 025-personal-notes-project-required.sql
-- Restores the v4.5/v5-pre column nullability. Backfilled rows keep their
-- project_id — rollback is not destructive.

ALTER TABLE personal_notes
  ALTER COLUMN project_id DROP NOT NULL;

DROP INDEX IF EXISTS idx_personal_notes_project;
CREATE INDEX IF NOT EXISTS idx_personal_notes_project
  ON personal_notes(project_id) WHERE project_id IS NOT NULL;
