COMMENT ON COLUMN entries.category IS
  'Active categories: architecture, decisions, conventions.
   DEPRECATED since v4.5 (2026-04-28): tasks, progress, issues
   - new memory_write API rejects them (410 Gone);
   - auto-extractor never produces them;
   - existing rows decay normally.';
