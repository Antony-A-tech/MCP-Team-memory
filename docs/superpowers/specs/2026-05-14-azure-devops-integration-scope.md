# Azure DevOps Server Integration — Research & Scope

> **Status:** research only. Not a plan. Inputs for a future brainstorming + planning session.
> **Date:** 2026-05-14
> **Target:** integrate team-memory-mcp (`D:\MCP\team-memory-mcp`) with on-prem Azure DevOps Server 2025 H2 at `https://s-tfs.intellectika.ru/DeveloperCollection`.
> **Author context:** v5 memory model is live (`profile` + `knowledge` + `project_events` per `2026-05-13-v5-profile-events-knowledge.md`). Migrations 021–024 applied. `EventsManager.add` exists. PAT auth + on-prem TFS pattern is already battle-tested by `@tiberriver256/mcp-server-azure-devops` in `d:/Moorinet2.0`.

---

## 1. Mapping: Azure DevOps entity → v5 team-memory layer

The v5 model has three native layers (Profile, Knowledge, project_events) and one auxiliary store (personal notes). Below is the proposed routing for each Azure DevOps surface.

| Azure DevOps entity | Target v5 layer | Auto/manual | Direction | Rationale |
|---|---|---|---|---|
| **PR merged** (`git.pullrequest.merged`) | `project_events` → `eventType=merge` | Auto (webhook) | Azure → memory | Already maps 1:1 to existing event type. `refs.pr_number`, `refs.commit_sha` already declared in `EventRefs`. |
| **PR created/updated/abandoned** | (none) — out of scope for MVP | n/a | n/a | Volume is too high for the 5-event timeline philosophy. Resurface on demand via MCP read-tool if needed. |
| **Pipeline run completed (CI build)** (`build.complete`, `ms.vss-pipelines.run-state-changed-event`) | `project_events` → `eventType=incident` *if `result=failed` on main/release branch*; otherwise drop | Auto (webhook, filtered) | Azure → memory | Daily CI noise must not pollute the timeline. Only failures on protected branches qualify as incidents. |
| **Release deployment completed** (`ms.azure-devops-release.deployment-completed-event`) | `project_events` → `eventType=deploy` (env != prod) or `release` (env == prod, status=succeeded) | Auto (webhook) | Azure → memory | Discriminate by `environment.name` + `status`. `refs.deployment_url`, `refs.version_tag` already in `EventRefs`. |
| **Release abandoned** | (none) | n/a | n/a | Operational noise. |
| **Work item: Bug created with severity=Critical** | `project_events` → `eventType=incident` *(optional; phase 2)* | Auto (webhook with filter) | Azure → memory | Bridge between operational events and the knowledge graph. Most bugs are NOT incidents — only Sev1/Sev2 production bugs. |
| **Work item: Task/Bug/Feature lifecycle (create/update/state change)** | **NOT shadowed in entries**. Expose via MCP read-tools (`work_item_get`, `work_item_search` via WIQL). | On-demand | Azure → memory (transient) | Work items are the source of truth in Azure. Mirroring drift-prone. We treat ADO as the system of record and only persist *derived knowledge* about them (decisions, conventions extracted by LLM from session transcripts). |
| **Sprint/Iteration closed** | `project_events` → `eventType=milestone` | Auto (polling cron — see §2) | Azure → memory | No native service-hook for sprint-close. Detect via `/work/teamsettings/iterations` + `attributes.finishDate < now()`. `refs.iteration_path`, `refs.iteration_id`. |
| **Wiki page created/updated** | Personal notes (per-author) on auto-import → manual `note_share` to `knowledge` | Auto-import via polling; manual share | Azure → memory | Wiki pages are author-curated WHY-content. Mirrors v4.5 path: import as session-like artifact, agent reviews, shares to knowledge. Avoids automatic write-amplification. |
| **Git push to main / release tag created** | `project_events` → `eventType=release` *(only annotated tags matching `vX.Y.Z`)* | Auto (webhook on `git.push` + filter) | Azure → memory | A tag push is the cleanest "release" signal. Filter on `refUpdates[].name LIKE 'refs/tags/v*'`. |
| **Test plan / test run completion** | (none — phase 3+) | n/a | n/a | Out of MVP. Could feed `incident` events if mass-fail on release branch. |
| **Project metadata (description, members, areas)** | `Profile.external_refs.azure_project_url`, surfaced in onboarding | Manual one-time setup | Memory ← user | Lives in Profile so every agent knows the Azure project URL. No automatic sync of project membership. |
| **PR review comments** | (none) | n/a | n/a | Too noisy. Could be referenced from a session transcript via URL and surfaced through evidence sources. |

**Identity mapping (Azure user → team-memory actor).** Azure DevOps payloads carry users in three shapes: `displayName`, `uniqueName` (email/UPN), `id` (Azure user GUID). The `project_events.actor` column is `TEXT` (free-form). Recommendation: store `uniqueName` (email) — it survives display-name renames and matches the convention used by team-memory's session imports. A future mapping table (`azure_user_links`: `azure_unique_name` ↔ `agent_token_id`) can promote events to be attributed to a specific agent, but is **not** required for MVP.

**Why not shadow work items into `entries`?** Three blockers:

1. **State drift.** Azure work items change continuously (state, assignee, tags). Cache invalidation is painful. The 200 TSTU rate limit makes "full sync" expensive.
2. **Ownership ambiguity.** If a work item is shadowed and a user edits the entry, which wins?
3. **v5 philosophy.** `knowledge` is for WHY-facts, not transactional records. A work item is WHAT (and Azure already stores it well). The team-memory value-add is extracting decisions/conventions from session transcripts that *reference* work items.

---

## 2. Integration patterns — comparison

### Pattern A — Webhooks (Azure pushes to team-memory)

- **Endpoint:** Azure DevOps service hook subscription → `POST /api/azure-webhook` on the team-memory app.
- **API:** `POST {tfs}/_apis/hooks/subscriptions?api-version=7.1` with `consumerId=webHooks`, `consumerActionId=httpRequest`, `publisherInputs.eventType=git.pullrequest.merged` (etc.), `consumerInputs.url=https://team-memory.example.com/api/azure-webhook`.
- **Pros:** Real-time. Lowest latency. Native event filtering at source (per-pipeline, per-repo, per-build-result). Doesn't burn TSTU on the team-memory side.
- **Cons:**
  - **On-prem TFS is firewalled.** `https://s-tfs.intellectika.ru` likely cannot reach a public team-memory endpoint without a tunnel (Cloudflare Tunnel, ngrok, or a reverse proxy on the intranet). If team-memory is co-located on intellectika.ru intranet, this is moot.
  - **No HMAC signature on webhook bodies.** Azure DevOps service hooks do NOT sign payloads. The only auth on the receiving side is HTTP Basic (PAT or shared secret in `consumerInputs.basicAuthUsername` / `basicAuthPassword`). Required mitigation: TLS + basic auth + IP allowlist of the TFS server.
  - **Subscription management overhead.** One subscription per event type per project. Lifecycle (create/update/delete on project rotation) must be scripted.
  - **At-least-once delivery.** Webhook may retry. Need idempotency keys — use `payload.id` (event GUID) and `payload.resource.pullRequestId` / `payload.resource.id` to dedupe in `project_events.refs.azure_event_id`.

### Pattern B — Polling (team-memory pulls from Azure)

- **Cron job** (e.g., every 5 minutes) calls Azure REST: PRs since cursor, builds since cursor, etc.
- **Pros:** No public endpoint needed. Server-controlled cadence. Easy to backfill historical data. Works through any HTTPS-allowed network.
- **Cons:**
  - **TSTU burn.** A "list PRs / list builds / list deployments / list iterations" sweep across N projects every 5 min eats into the 200 TSTU / 5 min budget per user (the PAT identity). For 1–3 projects this is fine; at 20+ projects you would need throttling. Must respect `X-RateLimit-*` and `Retry-After` headers.
  - **Latency.** ~poll interval in worst case. Acceptable for `milestone`/`deploy` events (low-frequency), bad for `incident` (you want fast).
  - **Cursor state.** Needs persistent `last_polled_at` per (project, resource_type). New tiny table.

### Pattern C — MCP read-on-demand (no persistence)

- Wrap Azure REST as MCP tools (`work_item_get`, `pr_list`, `pipeline_status`, `wiki_search`). Agent dereferences on demand. No team-memory state.
- **Pros:** Zero sync. Fresh data per call. No public endpoint. Lowest schema impact.
- **Cons:**
  - **Heavy overlap with existing `@tiberriver256/mcp-server-azure-devops`** already configured in `d:/Moorinet2.0`. Re-implementing the same tool surface in team-memory creates two MCP servers competing for the same purpose. Scope creep.
  - **No persistence** ⇒ no contribution to onboard digest, no timeline, no events.
  - **Per-call latency** in agent loops.

### Pattern D — Hybrid (recommended)

- **Webhooks** for the 5 high-value, low-volume timeline events (`merge`, `release`, `deploy`, `incident`, `milestone`) → these write to `project_events`.
- **Polling** (low-frequency, ~hourly) for sprint-close detection (since service hooks don't cover it) and wiki page diffs (since wiki has no service hook either).
- **Read-on-demand**: delegate to the existing `@tiberriver256/mcp-server-azure-devops` for work item / PR / pipeline lookup. Do **not** re-implement those tools in team-memory.

Recommendation: **Pattern D**. Reuse existing MCP server for read-on-demand. Add a minimal webhook receiver + a small polling worker only for the gaps (sprint close, wiki).

---

## 3. Existing team-memory infrastructure to reuse

| Component | File / table | What we reuse |
|---|---|---|
| `EventsManager.add` | `src/events/manager.ts` | Single sink for merge/release/deploy/incident/milestone. Already validates `event_type` against `EVENT_TYPES`. |
| `EventsStorage.insert` | `src/events/storage.ts` | Direct PG insert. `refs JSONB`, `evidence_sources JSONB`, `auto_generated BOOLEAN`. Perfect for webhook payloads. |
| `EventRefs` interface | `src/events/types.ts:7-14` | Already permissive (`[key: string]: unknown`). Pre-declared keys: `pr_number`, `commit_sha`, `version_tag`, `deployment_url`, `incident_id`. Add (no schema change): `azure_event_id`, `pipeline_id`, `definition_id`, `iteration_path`, `repo_name`. |
| `entries.external_refs` JSONB | migration 018, `src/storage/migrations/018-auto-notes.sql:12` + GIN index | For knowledge entries derived from Wiki: put `azure_wiki_page_id`, `azure_wiki_url`, `last_updated_in_azure`. Already indexed (GIN), queryable. |
| `evidence_sources JSONB` | migration 018 + `EvidenceSource` type | For each auto-extracted knowledge entry derived from a Wiki page, emit one evidence source `{type: 'azure_wiki', page_id, url, revision}`. |
| `Profile.external_refs` | (profile uses same `entries.external_refs` per migration 021) | Bind project to Azure: `external_refs.azure_project_url = "https://s-tfs.intellectika.ru/DeveloperCollection/Moorinet"`, `external_refs.azure_default_branch = "main"`. Onboard text uses these to print clickable links. |
| `personal_notes` table | migration 012 + `note_share` flow | Wiki pages auto-imported land here as drafts per agent. User reviews + calls `note_share` to promote to `knowledge`. Matches v4.5 manual-share UX. |
| Auth/agent-tokens | `src/auth/agent-tokens.ts` | Agent token can carry an `azure_unique_name` (email) attribute later for actor resolution. No schema change needed if we put it in a new mapping table. |
| Migration runner | `src/storage/migrator.ts` | Auto-picks new `NNN-name.sql`. No bootstrap work. |
| WebSocket sync | `src/sync/websocket.ts` | Broadcast `memory:created` for new events so UI updates live. Already wired for entries; need to mirror for `project_events` (separate effort). |

**No conflict with existing v5 layer.** Webhook-driven `EventsManager.add` writes through the same code path as manual `event_add` MCP tool from milestone 2 of the v5 plan.

---

## 4. Schema additions needed

Minimal set:

| New schema element | Justification | Sketch |
|---|---|---|
| **Migration 025: `azure_project_links`** | Map a team-memory project to one Azure project (one-to-one for MVP, see open questions). Stores base URL, project name, default branch, webhook secret. | `(project_id UUID PK FK → projects, azure_base_url TEXT, azure_project_name TEXT, azure_default_branch TEXT, webhook_basic_auth_user TEXT, webhook_basic_auth_pass_encrypted BYTEA, pat_encrypted BYTEA, pat_expires_at TIMESTAMPTZ, created_at, updated_at)` |
| **Migration 026: `azure_poll_cursors`** | Polling cursor per (project, resource) to avoid replay. | `(project_id UUID, resource TEXT, cursor TEXT, last_polled_at TIMESTAMPTZ, PRIMARY KEY (project_id, resource))` — resources: `iterations`, `wiki_pages`. |
| **Migration 027: `azure_event_dedup`** | Idempotency log. Webhooks deliver at-least-once; we MUST dedupe by `payload.id`. Could also live as a unique index on `project_events.refs->>'azure_event_id'` — cheaper. | `CREATE UNIQUE INDEX idx_azure_event_dedup ON project_events ((refs->>'azure_event_id')) WHERE refs ? 'azure_event_id';` — preferred. No new table. |
| **HTTP endpoint `POST /api/azure-webhook`** | Receive Azure service hook deliveries. Auth = HTTP Basic against `webhook_basic_auth_user/pass`. Parse `eventType` → route to `EventsManager.add`. | New route in `src/app.ts`. Returns 200 fast (Azure considers >5s a failure). Queue heavy work. |
| **HTTP endpoint `POST /api/projects/:id/azure/setup`** | Idempotent: provision the 5 service hook subscriptions for this project via Azure REST `POST /_apis/hooks/subscriptions`. Saves subscription IDs to `azure_project_links`. | Admin-only. Reads PAT from request body, encrypts at rest. |
| **MCP tool `azure_link_project`** | Same operation via MCP. Returns event-type → subscription_id map. | Wraps the setup endpoint. |
| **Cron worker `src/sync/azure-poller.ts`** | Cron at 5–15 min interval. For each linked project: poll sprint iterations + wiki revisions. | Lives alongside `src/sync/websocket.ts`. |

**Deliberately NOT adding:**

- No shadow work-item table. Delegated to read-on-demand via existing MCP.
- No "Azure user" table. Actor is a free-form email/string in `project_events.actor`.
- No bidirectional sync. Team-memory does not write to Azure (no comment-back, no work-item create) in MVP.

---

## 5. Identity & permissions

### Minimal PAT scopes required

For the team-memory server identity (one PAT per Azure project linked):

| Capability | PAT scope | Why |
|---|---|---|
| Read PRs, commits, refs (for `merge`/`release` event enrichment) | `vso.code` (read-only is `vso.code` — Azure deprecated separate read scope; the granular `vso.code_full` is for write) | Verify webhook payload, fetch commit metadata. |
| Read pipeline runs | `vso.build` (read) | Verify build status when handling `build.complete`. |
| Read releases / deployments | `vso.release` (read) | Verify deployment when handling deployment event. |
| Read work items | `vso.work` (read) | For optional incident extraction from Sev1 bugs. |
| Read wiki | `vso.wiki` (read) | Poll wiki page revisions. |
| Create / manage service hook subscriptions | `vso.hooks_write` | Programmatic webhook provisioning. |
| Read iterations / classification nodes | `vso.work` (covers it) | Sprint-close detection. |

PAT scope strings come from the Azure DevOps PAT scope reference; an admin generates a PAT with exactly these scopes and **no others** (least privilege).

### PAT rotation

- Azure DevOps caps PAT lifetime at 1 year (admin can set shorter; default UI offers 90 days). On-prem ADS 2025 H2 inherits this.
- **Plan:** `azure_project_links.pat_expires_at` is set at creation; a daily cron emits a `project_events` row of type `incident` (or a `personal_note` to the admin agent) 14 days before expiry: "Azure PAT for project X expires on 2026-MM-DD".
- Encrypt-at-rest: PAT stored as `BYTEA` encrypted with a server-side master key (env `TM_AZURE_PAT_ENC_KEY`, AES-256-GCM). Master key never persisted to DB.

### Multi-tenant — one team-memory ↔ many Azure projects

- The proposed schema (`azure_project_links` keyed by `project_id`) supports many team-memory projects, each linked to its own Azure project, each with its own PAT and webhook secret.
- **Open question (see §8):** can two team-memory projects map to the same Azure project? E.g., for staging/prod splits. Not blocked by schema (PK is `project_id`, not `azure_project_name`).

### Actor attribution

- Webhook payload: `resource.createdBy.uniqueName` or `resource.pushedBy.uniqueName` → write into `project_events.actor`.
- Polling payload: same — Azure REST returns identity refs uniformly.
- Future enhancement: if `actor` matches any registered `agent_tokens.email`, link the event to that agent for analytics. Not in MVP.

---

## 6. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **On-prem TFS not reachable from team-memory webhook host** | High | Host team-memory inside the same intranet, OR set up a reverse-proxy/tunnel. Confirm network path before committing to webhook pattern. Fallback: polling-only. |
| **TFS network blip during webhook delivery** | Medium | Azure DevOps retries webhooks several times with backoff. Dedupe by `azure_event_id`. Webhook handler must be <5s. |
| **PAT rotation breaks integration** | Medium | Pre-expiry reminder (see §5). UI/MCP tool `azure_rotate_pat`. Webhook subscriptions don't break on PAT rotation (subscription is owned by the user who created it, separate auth from the webhook delivery's basic-auth secret). |
| **Rate limit (200 TSTU/5min)** | Medium | Hybrid pattern minimizes API calls. Polling backoff on `Retry-After`. Track `X-RateLimit-Cost` per request to budget initial backfill. Avoid first-link backfill of `>30 days` of history without explicit user opt-in. |
| **Webhook payloads have no HMAC** | High (security) | Use HTTPS only; HTTP Basic with strong random secret stored in `azure_project_links`; IP allowlist of TFS server IP at reverse proxy. Reject `POST /api/azure-webhook` if basic-auth credential doesn't match. |
| **Schema drift in Azure DevOps Server API** | Low | Pin `api-version=7.1` (compatible with ADS 2022+ and ADS 2025 H2). Test against the live TFS instance during dev. Microsoft commits to backward compatibility per Versioning REST API docs. |
| **Data ownership on migration** | Medium | Wiki sync writes to personal notes first (per agent), not directly to `knowledge`. User explicitly promotes via `note_share`. Removes the "who owns this if Azure changes the source page" question — answer: Azure is the source, team-memory is a curated derivation. |
| **Initial backfill blowback** | Medium | First link MUST NOT backfill historical PRs/builds. Only subscribe to new events forward. Optional manual command `azure_backfill --since=ISO --limit=100` exists but is rate-limit-aware and explicit. |
| **Webhook duplicates between webhook + polling** | Low | Both paths write through `EventsManager.add` which checks the `azure_event_id` unique index (mig 027). Last writer wins is fine because both produce identical payloads. |
| **Wiki page renames / deletions** | Medium | Polling diff detects deletion → mark linked knowledge `entries.status='archived'` with audit trail, do not hard-delete. |
| **Localization** (e.g. `Microsoft.VSTS.TCM.AutomationStatus` = "Автоматический") | Low | Documented in user memory (`feedback_azure_tcm_field_values.md`). For READ-only integration this is mostly fine; if we ever WRITE to Azure work items, must use exact-match localized values per server. |

---

## 7. Phasing recommendation

### MVP (phase 1) — minimal value, validate plumbing

1. Migration 025 (`azure_project_links`) + master encryption key.
2. Migration 027 (`azure_event_id` unique index).
3. `POST /api/projects/:id/azure/link` — admin links a project (provides PAT, base URL, project name). Saves encrypted.
4. `POST /api/azure-webhook` — basic-auth-protected. Handles ONE event type: `git.pullrequest.merged`. Writes `project_events` row, `eventType=merge`.
5. Programmatic creation of the one subscription on link.
6. End-to-end smoke: merge a PR in Moorinet on `s-tfs.intellectika.ru` → see event in team-memory timeline within 30s.

**Why this MVP?** Single event, one auth path, no polling, no Wiki, no PAT rotation. Validates the entire pipeline: network reachability, schema, idempotency, subscription provisioning.

### Phase 2 — full event timeline

7. Add subscriptions: `git.push` (filtered to tag refs → `release`), `ms.azure-devops-release.deployment-completed-event` (→ `deploy` or `release` by env), `build.complete` (filtered to failed-on-main → `incident`).
8. Migration 026 (`azure_poll_cursors`).
9. Polling worker for iteration close → `milestone`.
10. Profile auto-population of `external_refs.azure_project_url` and links in onboard digest.

### Phase 3 — Wiki ⇄ knowledge

11. Wiki poller: detect added/changed pages, import as personal notes (one per agent? or one shared draft? — open question).
12. UI/CLI surface for "share wiki page as knowledge".
13. Wiki-page deletion → archive linked knowledge entries.

### Phase 4 — work item bridge (optional)

14. Incident extraction from Sev1/Sev2 bugs (manual opt-in per project).
15. MCP tool `event_link_work_item` — manually associate an existing event with an Azure work item URL (writes to `refs.work_item_url`, `refs.work_item_id`).
16. Read-on-demand stays delegated to `@tiberriver256/mcp-server-azure-devops`.

### Explicitly out of scope (forever, unless re-scoped)

- Writing comments back to Azure from team-memory.
- Bi-directional work-item sync.
- Test plan / test run automation feedback loop.
- Multi-instance TFS (one team-memory talking to two TFS servers at once).

---

## 8. Open questions for the future brainstorming session

These are decisions the user must make before a plan can be written. **Do not assume answers; collect them.**

1. **Network reachability.** Where will team-memory be hosted? Same intranet as `s-tfs.intellectika.ru` (webhooks viable) or external (need tunnel / fall back to polling)?
2. **Cardinality.** One team-memory project ↔ one Azure project? Or many-to-many (e.g., Moorinet has 3 sub-products that should aggregate into one team-memory project)?
3. **Webhook vs polling preference** for an on-prem TFS where firewall traversal is sometimes painful. Operations would prefer polling; latency would prefer webhooks. What's the network reality at intellectika.ru?
4. **Wiki sync direction.** Wiki is read-only source from Azure (one-way push to team-memory)? Or do we ever write summaries *back* to Azure Wiki (e.g., "onboarding doc auto-generated by team-memory")?
5. **Legacy backfill.** On first link, do we want to backfill the last 30/90 days of merge/deploy/release events, or strictly forward-only? Backfill is rate-limit-expensive.
6. **Incident triggers.** Which counts as `incident`?
   - Pipeline failure on main branch?
   - Sev1 bug created?
   - Production deployment failed?
   - All of the above?
7. **Sprint mapping.** When iteration closes, what's the event title? `"Sprint 2026.05 closed"` vs `"Sprint closed: <iteration path>"`?  Do we attach the sprint's accepted work-item count (requires an extra API call)?
8. **Wiki granularity.** Each wiki page = one knowledge entry (after share)? Or wiki section / heading = one entry? Some pages are massive (architecture docs, 5000+ lines).
9. **Per-author vs shared wiki drafts.** When a wiki page is imported, does it become a personal note for every active agent (privacy-isolated), or one shared draft (anyone can promote)?
10. **PAT ownership.** Whose PAT do we use? A dedicated service account (best practice but requires admin)? Each user's personal PAT (multi-link, more lifecycle work)?
11. **Webhook URL stability.** If team-memory's public URL changes (host rename, port shift), subscriptions break silently. Do we need a watchdog (ping the subscription health endpoint) or a retry-on-fail dashboard?
12. **Auth on the webhook endpoint.** HTTP Basic is the only practical option since Azure doesn't HMAC-sign. Acceptable, or do we wrap it in a tunnel-level auth (e.g., Cloudflare Access)?
13. **Identity bridging.** Should we surface Azure `uniqueName` in `project_events.actor`, or normalize to `agent_tokens.agent_name` if a mapping exists? Affects onboard digest readability.
14. **MCP tool surface.** Re-implement read-on-demand work-item / PR tools in team-memory (convenient, redundant), or strictly delegate to `@tiberriver256/mcp-server-azure-devops` (clean, two MCPs to configure)?
15. **Localization of work-item field writes** (out of MVP scope, but flag): if we ever write back, do we maintain a per-server dictionary of allowed values (e.g., `"Автоматический"` not `"Автоматизировано"`)?

---

## Reference URLs (curated)

**Service Hooks**
- Events catalog: https://learn.microsoft.com/en-us/azure/devops/service-hooks/events?view=azure-devops
- Programmatic subscription creation: https://learn.microsoft.com/en-us/azure/devops/service-hooks/create-subscription?view=azure-devops
- Subscriptions REST API: https://learn.microsoft.com/en-us/rest/api/azure/devops/hooks/subscriptions/create?view=azure-devops-rest-7.1
- Webhook consumer details + basic auth: https://learn.microsoft.com/en-us/azure/devops/service-hooks/services/webhooks?view=azure-devops

**REST API basics**
- Get started + URL formats (on-prem `{server:port}/tfs/{collection}`): https://learn.microsoft.com/en-us/azure/devops/integrate/how-to/call-rest-api?view=azure-devops
- API versioning (compat across ADS versions): https://learn.microsoft.com/en-us/azure/devops/integrate/concepts/rest-api-versioning?view=azure-devops

**Rate limits**
- TSTU + headers reference: https://learn.microsoft.com/en-us/azure/devops/integrate/concepts/rate-limits?view=azure-devops

**Specific surfaces**
- Work Items: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-item?view=azure-devops-rest-7.1
- WIQL: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql?view=azure-devops-rest-7.1
- Iterations (sprint-close detection): https://learn.microsoft.com/en-us/rest/api/azure/devops/work/iterations/list?view=azure-devops-rest-7.1
- Wiki pages: https://learn.microsoft.com/en-us/rest/api/azure/devops/wiki/pages?view=azure-devops-rest-7.1
- Build status: https://learn.microsoft.com/en-us/rest/api/azure/devops/build/status/get?view=azure-devops-rest-7.1
- Pipeline runs: https://learn.microsoft.com/en-us/rest/api/azure/devops/pipelines/runs/get?view=azure-devops-rest-7.1

**Auth**
- PAT usage + scope reference: https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops
- All REST APIs support scoped PATs: https://devblogs.microsoft.com/devops/all-azure-devops-rest-apis-now-support-pat-scopes/

**Existing reference implementation**
- `@tiberriver256/mcp-server-azure-devops` (NPM): https://www.npmjs.com/package/@tiberriver256/mcp-server-azure-devops
- GitHub: https://github.com/Tiberriver256/mcp-server-azure-devops

---

## Recommendation summary (one-paragraph TL;DR)

Adopt **Pattern D (hybrid)**: real-time webhooks for the five v5 timeline event types, low-frequency polling only for sprint-close and Wiki page diffs, and delegate ad-hoc read tools (work items, PR lookup) to the already-configured `@tiberriver256/mcp-server-azure-devops`. Schema impact is small: one link table (`azure_project_links`) with encrypted PAT and webhook basic-auth secret, one poll-cursor table, and one unique index on `project_events.refs.azure_event_id` for webhook dedupe. Phase MVP = single event type (PR merged) end-to-end before adding any other surface. Do **not** shadow Azure work items into `entries`; treat Azure as the system of record and team-memory as the curated WHY-derivation layer. The decisions blocking a plan are network reachability of TFS to the team-memory host, project cardinality (1:1 vs N:1), and the incident-trigger policy — those should open the future brainstorming session.
