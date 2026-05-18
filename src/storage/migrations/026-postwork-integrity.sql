-- 026-postwork-integrity.sql
-- Postwork data-integrity tidy-up before Azure DevOps integration.
--
-- Three independent changes bundled because they all touch FK + comment
-- conventions on the same set of tables:
--
-- 1. personal_notes.project_id → ON DELETE CASCADE
--    Before: NO ACTION. deleteProject() raised FK violation if any notes
--    existed, leaving the project undeleteable. Now notes are removed
--    together with their owning project. Personal notes are token-scoped
--    drafts; once the project they're filed under is gone, there's no UI
--    path that can show them anyway.
--
-- 2. sessions.project_id → ON DELETE SET NULL
--    Before: NO ACTION. Same blocking behaviour as personal_notes. Sessions
--    are independent artefacts (imported chat transcripts with their own
--    summaries and extracted notes); we keep them as historical record but
--    detach from the deleted project. The Web UI already tolerates
--    project_id=NULL on sessions list views.
--
-- 3. Documentation comments on status/lifecycle columns that had drifted
--    across tables (entries/sessions/personal_notes use different vocab).
--
-- Rationale: see docs/superpowers/plans/2026-05-15-v5-postwork-audit-fixes.md
-- Phase 1.A.

-- 1. personal_notes — CASCADE
ALTER TABLE personal_notes
  DROP CONSTRAINT IF EXISTS personal_notes_project_id_fkey;
ALTER TABLE personal_notes
  ADD CONSTRAINT personal_notes_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

-- 2. sessions — SET NULL
ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_project_id_fkey;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

-- 3. Documentation comments
COMMENT ON COLUMN entries.status IS
  'Entry lifecycle: active | completed | archived. Default active. archived rows are excluded from default reads and from auto-decay scoring.';

COMMENT ON COLUMN sessions.embedding_status IS
  'Pipeline lifecycle: queued → summarizing → extracting_notes → complete | failed. Distinct from entries.status — sessions have no archival state of their own.';

COMMENT ON COLUMN personal_notes.status IS
  'Note lifecycle: active | archived. Token-scoped drafts only — no completed state.';

COMMENT ON COLUMN project_events.event_type IS
  'Canonical: merge | release | deploy | incident | milestone. Enforced by app-level validation in src/events/storage.ts AND DB CHECK constraint from migration 023.';
