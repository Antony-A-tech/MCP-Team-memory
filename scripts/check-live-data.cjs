#!/usr/bin/env node
const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgres://memory:memory@localhost:5432/team_memory' });
const PID = '45c8f3bc-af69-404a-8fa2-897b53748e12';

(async () => {
  const r1 = await p.query(
    `SELECT category, status, COUNT(*)::int AS n FROM entries WHERE project_id=$1 GROUP BY category, status ORDER BY category, status`,
    [PID],
  );
  console.log('Category/status distribution:');
  r1.rows.forEach(r => console.log(' ', r.category, '/', r.status, ':', r.n));

  console.log('\nSample active knowledge entries:');
  const r2 = await p.query(
    `SELECT title, tags FROM entries WHERE project_id=$1 AND category='knowledge' AND status='active' ORDER BY updated_at DESC LIMIT 5`,
    [PID],
  );
  r2.rows.forEach(row => console.log(' -', row.title.slice(0, 60), 'tags=', JSON.stringify(row.tags)));

  console.log('\nActive entries with plural decision/convention tag:');
  const r3 = await p.query(
    `SELECT title, tags FROM entries WHERE project_id=$1 AND status='active' AND ('decisions' = ANY(tags) OR 'conventions' = ANY(tags)) LIMIT 5`,
    [PID],
  );
  r3.rows.forEach(row => console.log(' -', row.title.slice(0, 60), 'tags=', JSON.stringify(row.tags)));

  await p.end();
})().catch(e => { console.error(e); process.exit(1); });
