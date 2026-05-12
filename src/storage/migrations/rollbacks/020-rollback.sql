-- Rollback migration 020-active-status-index.
DROP INDEX IF EXISTS idx_entries_active;
