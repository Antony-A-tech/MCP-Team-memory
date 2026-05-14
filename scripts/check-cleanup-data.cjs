#!/usr/bin/env node
// Live data audit for cleanup decisions: domains, tags, deprecated categories.
const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgres://memory:memory@localhost:5432/team_memory' });
const PID = '45c8f3bc-af69-404a-8fa2-897b53748e12';

(async () => {
  console.log('=== Project 45c8f3bc (Рефакторинг MCP Team Memory) ===\n');

  // Category x status full distribution
  const r1 = await p.query(
    `SELECT category, status, COUNT(*)::int AS n FROM entries WHERE project_id=$1 GROUP BY category, status ORDER BY category, status`,
    [PID],
  );
  console.log('Category × Status:');
  r1.rows.forEach(r => console.log(' ', r.category.padEnd(14), '|', r.status.padEnd(9), '|', r.n));

  // Domain distribution
  console.log('\nDomain distribution (active entries only):');
  const r2 = await p.query(
    `SELECT COALESCE(domain, '(null)') AS d, COUNT(*)::int AS n FROM entries WHERE project_id=$1 AND status='active' GROUP BY domain ORDER BY n DESC`,
    [PID],
  );
  r2.rows.forEach(r => console.log(' ', r.d.padEnd(20), '|', r.n));

  // Top 30 tags
  console.log('\nTop 30 tags (active entries):');
  const r3 = await p.query(
    `SELECT tag, COUNT(*)::int AS n FROM entries, unnest(tags) AS tag
     WHERE project_id=$1 AND status='active'
     GROUP BY tag ORDER BY n DESC LIMIT 30`,
    [PID],
  );
  r3.rows.forEach(r => console.log(' ', String(r.n).padStart(3), '·', r.tag));

  // Tag count summary
  const r4 = await p.query(
    `SELECT
       COUNT(DISTINCT tag) AS unique_tags,
       SUM(CASE WHEN c = 1 THEN 1 ELSE 0 END) AS singleton_tags,
       SUM(CASE WHEN c >= 5 THEN 1 ELSE 0 END) AS recurring_tags
     FROM (
       SELECT tag, COUNT(*)::int AS c FROM entries, unnest(tags) AS tag
       WHERE project_id=$1 AND status='active' GROUP BY tag
     ) sub`,
    [PID],
  );
  console.log('\nTag stats:');
  console.log('  unique tags:', r4.rows[0].unique_tags);
  console.log('  singleton tags (count=1):', r4.rows[0].singleton_tags);
  console.log('  recurring tags (count≥5):', r4.rows[0].recurring_tags);

  // pinned distribution
  const r5 = await p.query(
    `SELECT pinned, COUNT(*)::int AS n FROM entries WHERE project_id=$1 AND status='active' GROUP BY pinned`,
    [PID],
  );
  console.log('\nPinned distribution:');
  r5.rows.forEach(r => console.log(' ', r.pinned ? 'pinned' : 'not pinned', ':', r.n));

  // Across all projects: how many use which categories?
  console.log('\n=== Across ALL projects ===');
  const r6 = await p.query(
    `SELECT category, COUNT(*)::int AS n FROM entries WHERE status='active' GROUP BY category ORDER BY n DESC`,
  );
  r6.rows.forEach(r => console.log(' ', r.category.padEnd(14), '|', r.n));

  await p.end();
})().catch(e => { console.error(e); process.exit(1); });
