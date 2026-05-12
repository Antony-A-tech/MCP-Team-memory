-- Migration 020 — partial index supporting v4.5 importance-score batch recompute
--
-- The nightly job runs `UPDATE entries SET importance_score = ... WHERE status='active'`.
-- The existing idx_entries_status on (project_id, status) helps per-project
-- queries but isn't selected for the project-agnostic batch UPDATE — PostgreSQL
-- ends up scanning the whole entries table when the active rows are a small
-- fraction of the total.
--
-- A partial index on `status='active'` lets the UPDATE plan use an index-only
-- scan over just the active rows, cutting batch time on large datasets.

CREATE INDEX IF NOT EXISTS idx_entries_active
  ON entries (id)
  WHERE status = 'active';
