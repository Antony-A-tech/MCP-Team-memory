-- 021-profile-category.sql
-- Adds 'profile' category for project-level always-on entry (one per project).
-- See plan: docs/superpowers/plans/2026-05-13-v5-profile-events-knowledge.md

ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_category_check;
ALTER TABLE entries ADD CONSTRAINT entries_category_check
  CHECK (category IN ('architecture','tasks','decisions','issues','progress','conventions','profile'));

-- Partial UNIQUE: at most one active profile per project
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_one_active_profile
  ON entries(project_id) WHERE category='profile' AND status='active';

COMMENT ON INDEX idx_entries_one_active_profile IS
  'Enforces invariant: one active profile entry per project. Archived profiles do not conflict.';
