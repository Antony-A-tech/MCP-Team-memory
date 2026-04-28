#!/usr/bin/env node

/**
 * Backfill the v4.5 auto-notes extraction over existing imported sessions.
 *
 * Resets selected sessions to embedding_status='extracting_notes', then lets
 * the running SessionManager worker pick them up and run the extractor +
 * dedup + memory writes. Safe to re-run — the runExtraction guard
 * (hasExtractionEvidence) skips sessions that already contributed evidence.
 *
 * Usage:
 *   node scripts/backfill-extract-notes.cjs [--project=<uuid>] [--limit=20] [--dry-run]
 *
 * Filters:
 *   --project=<uuid>   only sessions in this project (default: all projects)
 *   --since=YYYY-MM-DD only sessions imported on/after this date
 *   --limit=<n>        max sessions to flip (default: 20)
 *   --dry-run          show what would change without writing
 *
 * Environment:
 *   PG_URL  PostgreSQL connection string
 *           (default: postgresql://memory:memory@127.0.0.1:5432/team_memory)
 *
 * Notes:
 * - This script does NOT call the extractor itself; it only requeues
 *   sessions. The running team-memory-mcp server (with its background
 *   SessionManager worker) is what actually performs the work.
 * - Sessions whose embedding_status is currently 'extracting_notes' are
 *   left alone unless --include-active is also set.
 */

'use strict';

const PG_URL =
  process.env.PG_URL ||
  process.env.DATABASE_URL ||
  'postgresql://memory:memory@127.0.0.1:5432/team_memory';

function parseArg(name, fallback = undefined) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  return arg.slice(name.length + 3);
}
const PROJECT = parseArg('project');
const SINCE = parseArg('since');
const LIMIT = parseInt(parseArg('limit', '20'), 10);
const DRY_RUN = process.argv.includes('--dry-run');
const INCLUDE_ACTIVE = process.argv.includes('--include-active');

async function main() {
  let pg;
  try {
    pg = require('pg');
  } catch {
    console.error('pg module not found. Run: npm install pg');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: PG_URL });

  const conditions = [`embedding_status = 'complete'`];
  const params = [];
  let idx = 1;
  if (PROJECT) {
    conditions.push(`project_id = $${idx++}`);
    params.push(PROJECT);
  }
  if (SINCE) {
    conditions.push(`imported_at >= $${idx++}`);
    params.push(SINCE);
  }
  if (!INCLUDE_ACTIVE) {
    // Skip sessions that are still mid-pipeline.
    conditions.push(`embedding_status NOT IN ('queued','queued_embed','summarizing','embedding','extracting_notes','extraction_failed')`);
  }
  conditions.push(`project_id IS NOT NULL`); // extraction needs a project

  const whereClause = conditions.join(' AND ');
  params.push(LIMIT);
  const limitParam = idx;

  const { rows } = await pool.query(
    `SELECT id, project_id, name, summary, imported_at
     FROM sessions
     WHERE ${whereClause}
     ORDER BY imported_at DESC
     LIMIT $${limitParam}`,
    params,
  );

  console.log(`Found ${rows.length} session(s) eligible for backfill.`);
  if (rows.length === 0) {
    await pool.end();
    return;
  }

  for (const r of rows) {
    console.log(`  - ${r.id}  project=${r.project_id}  name="${(r.name || '').slice(0, 40)}"  imported=${r.imported_at?.toISOString?.() ?? r.imported_at}`);
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: no rows updated.');
    await pool.end();
    return;
  }

  const ids = rows.map(r => r.id);
  const { rowCount } = await pool.query(
    `UPDATE sessions
     SET embedding_status = 'extracting_notes',
         updated_at = NOW() - INTERVAL '15 minutes'
     WHERE id = ANY($1::uuid[])`,
    [ids],
  );

  console.log(`\nFlipped ${rowCount} session(s) to embedding_status='extracting_notes'.`);
  console.log('Background worker will pick them up on the next poll cycle.');
  console.log('Watch progress via: SELECT embedding_status, COUNT(*) FROM sessions GROUP BY 1');

  await pool.end();
}

main().catch(err => {
  console.error('backfill failed:', err);
  process.exit(1);
});
