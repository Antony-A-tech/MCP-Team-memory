-- Migration 012: Personal notes with token-based access isolation
-- personal_notes has title/content/tags — can reuse update_search_vector()

CREATE TABLE IF NOT EXISTS personal_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_token_id UUID NOT NULL REFERENCES agent_tokens(id),
  project_id UUID REFERENCES projects(id),
  session_id UUID,  -- FK added in migration 013 after sessions table exists

  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  priority TEXT DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status TEXT DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),

  search_vector TSVECTOR,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_personal_notes_agent ON personal_notes(agent_token_id);
CREATE INDEX IF NOT EXISTS idx_personal_notes_project ON personal_notes(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_personal_notes_session ON personal_notes(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_personal_notes_status ON personal_notes(agent_token_id, status);
CREATE INDEX IF NOT EXISTS idx_personal_notes_search ON personal_notes USING GIN(search_vector);

-- FTS trigger (reuses existing update_search_vector function — personal_notes has title, content, tags)
DROP TRIGGER IF EXISTS trg_personal_notes_search ON personal_notes;
CREATE TRIGGER trg_personal_notes_search
  BEFORE INSERT OR UPDATE OF title, content, tags ON personal_notes
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();

-- Timestamp trigger
DROP TRIGGER IF EXISTS trg_personal_notes_updated ON personal_notes;
CREATE TRIGGER trg_personal_notes_updated
  BEFORE UPDATE ON personal_notes
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Update schema version
UPDATE schema_meta SET value = '2.4.0' WHERE key = 'version';
