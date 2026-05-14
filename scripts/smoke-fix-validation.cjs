#!/usr/bin/env node
// Smoke-test the new validation paths added in v5 fixes.
const http = require('http');

const TOKEN = process.env.TM_TOKEN;
const PID = process.env.TM_PROJECT_ID || '45c8f3bc-af69-404a-8fa2-897b53748e12';

if (!TOKEN) {
  console.error('TM_TOKEN env var is required');
  process.exit(1);
}

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: 'localhost', port: 3846, path, method,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${TOKEN}`,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  console.log('=== Oversize profile (>64KB) → expect 413 ===');
  const r1 = await call('PUT', `/api/projects/${PID}/profile`, { content: 'x'.repeat(70 * 1024) });
  console.log('  HTTP', r1.status, '| body:', r1.body.slice(0, 200));

  console.log('=== Invalid event_type → expect 400 ===');
  const r2 = await call('POST', `/api/projects/${PID}/events`, { event_type: 'foo', title: 'x' });
  console.log('  HTTP', r2.status, '| body:', r2.body.slice(0, 200));

  console.log('=== Valid event_type → expect 200 ===');
  const r3 = await call('POST', `/api/projects/${PID}/events`, {
    event_type: 'milestone',
    title: 'v5 fixes round 2 — C1/M1/M2/M3/M4 applied',
    refs: { commit_sha: '0f33323' },
  });
  console.log('  HTTP', r3.status, '| event_type:', JSON.parse(r3.body).event?.eventType);
})().catch(e => { console.error(e); process.exit(1); });
