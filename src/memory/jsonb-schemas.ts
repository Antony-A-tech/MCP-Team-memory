// src/memory/jsonb-schemas.ts
//
// Zod schemas for JSONB columns that previously accepted any shape. Validation
// is enforced at the application boundary (REST/MCP handlers and storage
// inserts) so the DB never receives malformed or unbounded payloads.
//
// Phase 1.D of docs/superpowers/plans/2026-05-15-v5-postwork-audit-fixes.md.

import { z } from 'zod';

// ===== external_refs =====
//
// `entries.external_refs` and `personal_notes.external_refs` are intended for
// stable references into external systems. Whitelist matches what Azure
// integration and the existing prompt extraction emit; unknown fields are
// stripped rather than rejected so future field additions don't break old
// clients.
export const ExternalRefsSchema = z
  .object({
    pr_number: z.number().int().nonnegative().optional(),
    commit_sha: z.string().regex(/^[0-9a-f]{7,40}$/i, 'commit_sha must be a hex SHA').optional(),
    version_tag: z.string().max(64).optional(),
    deployment_url: z.string().url().max(2048).optional(),
    incident_id: z.string().max(128).optional(),
    pipeline_id: z.string().max(128).optional(),
    work_item_id: z.union([z.string().max(64), z.number().int()]).optional(),
    azure_pr_url: z.string().url().max(2048).optional(),
    azure_event_id: z.string().max(128).optional(),
  })
  .strip(); // unknown fields silently dropped

export type ExternalRefs = z.infer<typeof ExternalRefsSchema>;

// ===== evidence_sources =====
//
// One element describes "where did this entry originate" (which session,
// which personal note, etc.). Used by auto-extractor and the dedup confirm
// path. Max 50 evidence sources per entry — anything beyond that is almost
// certainly a runaway extractor loop.
// Lenient UUID regex (any version) — matches our auth middleware. Strict
// version-aware z.string().uuid() rejects legacy v1/v3 ids that may still
// linger in agent_tokens / sessions tables.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const EvidenceSourceSchema = z.object({
  type: z.enum(['session', 'personal_note', 'pr', 'wiki', 'code_review', 'work_item']),
  id: z.string().min(1).max(256),
  agent_token_id: z.string().regex(UUID_RE, 'Invalid UUID').optional(),
  shared_by: z.string().max(128).optional(),
  confirmed_at: z.string().datetime().optional(),
});

export const EvidenceSourcesArraySchema = z.array(EvidenceSourceSchema).max(50);

export type EvidenceSourceValidated = z.infer<typeof EvidenceSourceSchema>;

// ===== project_events.refs =====
//
// Same shape as ExternalRefs — events use the same canonical reference
// fields. Exported separately so the call sites read clearly.
export const EventRefsSchema = ExternalRefsSchema;
export type EventRefs = ExternalRefs;
