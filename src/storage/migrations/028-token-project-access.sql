-- Migration 028: per-token project access control (RBAC)
--
-- Previously the project boundary was enforced only via the X-Project-Id
-- header — a token could be used with any project_id the client chose to
-- send. `enforceProjectScope` only caught header/body inconsistency, not
-- actual authorization (a malicious holder could just send X-Project-Id
-- pointing at any project and gain access).
--
-- This migration adds an explicit allowlist of (token, project) pairs.
-- An agent token's connection or request is allowed iff its X-Project-Id
-- is in this allowlist. Master tokens (admin scope) bypass — they're for
-- ops and cross-project work by design.
--
-- Default for new tokens: empty allowlist (= no access). Operators grant
-- access explicitly via the /agents page in the UI.
--
-- Existing tokens at migration time: empty allowlist too (per the
-- operator's call — explicit re-grant on UI before they keep working).
-- This is a breaking change for in-flight agent sessions; release notes
-- must call it out.
--
-- 028 closes the RBAC follow-up that was parked at the end of Phase 4.

CREATE TABLE IF NOT EXISTS token_project_access (
    token_id    UUID NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
    project_id  UUID NOT NULL REFERENCES projects(id)     ON DELETE CASCADE,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    granted_by  TEXT, -- optional: agent_name / 'master' / NULL for migration backfill
    PRIMARY KEY (token_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_token_project_access_token
    ON token_project_access (token_id);

CREATE INDEX IF NOT EXISTS idx_token_project_access_project
    ON token_project_access (project_id);

COMMENT ON TABLE token_project_access IS
'Per-token project access allowlist. An agent token may operate on a project iff a row exists here for (token_id, project_id). Master tokens (admin scope) bypass this table.';
