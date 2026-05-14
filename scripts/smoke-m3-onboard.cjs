#!/usr/bin/env node
// Quick smoke: invoke memory_onboard via MCP HTTP transport, print summary.
const http = require('http');

const TOKEN = process.env.TM_TOKEN;
const PID = process.argv[2] || process.env.TM_PROJECT_ID || '45c8f3bc-af69-404a-8fa2-897b53748e12';

if (!TOKEN) {
  console.error('TM_TOKEN env var is required');
  process.exit(1);
}

let mcpSid;

function call(body, sid) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Length': Buffer.byteLength(payload),
      'X-Project-Id': PID,
    };
    if (sid) headers['Mcp-Session-Id'] = sid;
    const req = http.request({
      hostname: 'localhost', port: 3846, path: '/mcp', method: 'POST', headers,
    }, res => {
      const newSid = res.headers['mcp-session-id'];
      if (newSid) mcpSid = newSid;
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        const m = buf.match(/data: (.+)/);
        const raw = m ? m[1] : buf;
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

(async () => {
  await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
  await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, mcpSid);
  const r = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_onboard', arguments: { project_id: PID } } }, mcpSid);
  const text = r?.result?.content?.[0]?.text || JSON.stringify(r);
  const lines = text.split('\n');
  console.log(lines.slice(0, 80).join('\n'));
  console.log('---');
  console.log('total length:', text.length, 'chars');
  console.log('has 🗺️ Profile:', text.includes('🗺️ Profile'));
  console.log('has 📈 Recent activity:', text.includes('📈 Recent activity'));
  console.log('has 📚 Knowledge:', text.includes('📚 Knowledge'));
  console.log('has 📏 Conventions:', text.includes('📏 Conventions'));
  console.log('has 🏗️ Architecture:', text.includes('🏗️ Architecture'));
  console.log('has ✅ Decisions:', text.includes('✅ Decisions'));
  console.log('has zombie tasks:', text.includes('Активные задачи'));
  console.log('has zombie issues:', text.includes('Известные проблемы'));
  console.log('has zombie progress section header:', text.includes('Последний прогресс'));
})().catch(e => { console.error(e); process.exit(1); });
