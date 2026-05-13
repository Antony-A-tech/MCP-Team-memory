-- 024-cleanup-deprecated.sql
-- Update entries.category comment to reflect v5 model.
-- See plan: docs/superpowers/plans/2026-05-13-v5-profile-events-knowledge.md

COMMENT ON COLUMN entries.category IS
  'v5 active categories: profile (one-per-project always-on entry), knowledge (WHY-facts with kind tags: architecture | decision | convention).
   v5 deprecated (read-only, migrated by 022): architecture, decisions, conventions — collapsed into knowledge.
   v4.5 deprecated (read-only): tasks, progress, issues.';
