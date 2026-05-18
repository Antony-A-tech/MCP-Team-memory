-- 025-personal-notes-project-required.sql
-- Make personal_notes.project_id mandatory.
--
-- Before v5 the column was nullable (migration 012) and the MCP note_write
-- handler quietly accepted requests without project_id, producing orphaned
-- rows the Web UI couldn't display under any project filter. Code is fixed,
-- but we also enforce the invariant in the schema so no future code path
-- can re-introduce orphans.
--
-- Backfill: every existing orphaned row is bound to the DEFAULT_PROJECT_ID
-- ('00000000-0000-0000-0000-000000000000'). Admins can re-bind any individual
-- note via note_update after the migration if the default is wrong for their
-- case — we never had a non-default fallback anyway, so the choice is
-- information-preserving.

UPDATE personal_notes
SET project_id = '00000000-0000-0000-0000-000000000000'
WHERE project_id IS NULL;

ALTER TABLE personal_notes
  ALTER COLUMN project_id SET NOT NULL;

-- Replace the partial index with a plain one (column is now always non-null,
-- partial filter is redundant — keeping the same name to preserve the query
-- planner's choices).
DROP INDEX IF EXISTS idx_personal_notes_project;
CREATE INDEX IF NOT EXISTS idx_personal_notes_project
  ON personal_notes(project_id);
