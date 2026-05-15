-- Migration 027: partial UNIQUE index for session tuple dedup
--
-- Phase 4.F (commit f21df2d) added findByTuple() as a fallback when
-- external_id is missing: dedup on (agent_token_id, project_id, name,
-- started_at). The lookup is non-atomic against createSession — two
-- concurrent webhook redeliveries with the same tuple both miss the
-- SELECT and both INSERT, producing duplicates.
--
-- This index enforces the invariant at the database level. PARTIAL
-- (WHERE external_id IS NULL) because rows with external_id are already
-- dedup'd by the existing unique constraint on (agent_token_id,
-- external_id). The tuple fallback only matters when external_id is
-- absent.
--
-- The four columns must ALL be present in a row for the index to fire;
-- if any is NULL the row is allowed in (Postgres unique-index semantics
-- treat NULL as distinct). started_at is NOT NULL in the table; name
-- and project_id can be NULL today but a future tightening could add
-- their own check.
--
-- 027 closes M6 of the v5-postwork review.

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_tuple_dedup
    ON sessions (agent_token_id, project_id, name, started_at)
    WHERE external_id IS NULL
      AND project_id IS NOT NULL
      AND name IS NOT NULL
      AND started_at IS NOT NULL;

COMMENT ON INDEX idx_sessions_tuple_dedup IS
'Partial unique index enforcing the (agent_token_id, project_id, name, started_at) dedup invariant when external_id is missing. Matches the findByTuple() lookup in SessionManager.importSession.';
