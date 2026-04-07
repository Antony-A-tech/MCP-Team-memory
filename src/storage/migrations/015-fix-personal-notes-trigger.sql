-- Fix: personal_notes was using entries' update_timestamp trigger which references
-- columns (read_count, pinned, domain, related_ids) that don't exist on personal_notes.
-- Replace with a simple timestamp updater.

DROP TRIGGER IF EXISTS trg_personal_notes_updated ON personal_notes;

CREATE OR REPLACE FUNCTION update_personal_notes_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_personal_notes_updated
  BEFORE UPDATE ON personal_notes
  FOR EACH ROW
  EXECUTE FUNCTION update_personal_notes_timestamp();
