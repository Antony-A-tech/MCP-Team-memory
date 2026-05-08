#!/usr/bin/env node
/**
 * Smoke import a single Claude Code session jsonl through MCP session_import.
 *
 * Drives the full v4.5 pipeline against a running team-memory-mcp:
 *   queued → summarizing → embedding → extracting_notes → complete
 *
 * Useful as a manual deployment-verification step ("does the new server
 * actually process a real session end-to-end?") or as a building block
 * for ops scripts that import a fixture session before running smokes.
 *
 * Usage:
 *   TM_TOKEN=tm_xxx node scripts/smoke-import-one.cjs <jsonl-path> [project_id]
 *
 * Where <jsonl-path> points at a Claude Code session log (one JSON object
 * per line, with `message.role`/`message.content` fields). The script picks
 * out user/assistant turns, normalises tool calls into `[tool_use:NAME]`
 * markers, and forwards the resulting messages array to the MCP session_import
 * tool. Watch progress in the server log or via SQL:
 *
 *   SELECT embedding_status FROM sessions WHERE id='<returned id>';
 *
 * Exit codes:
 *   0 — session_import returned 200 (queued for processing)
 *   1 — auth failure, network error, or no parseable messages in the file
 *
 * Note: success here means "the import was accepted." Whether extraction
 * yields candidates depends on the LLM and the session content — many
 * routine sessions correctly produce zero auto-entries.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const TOKEN = process.env.TM_TOKEN;
const FILE = process.argv[2];
const PROJECT_ID = process.argv[3] || '00000000-0000-0000-0000-000000000000';

if (!TOKEN || !FILE) {
  console.error('Usage: TM_TOKEN=tm_... node scripts/smoke-import-one.cjs <jsonl> [project_id]');
  process.exit(1);
}

let mcpSessionId = null;

function mcpRequest(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Length': Buffer.byteLength(payload),
      'X-Project-Id': PROJECT_ID,
    };
    if (mcpSessionId) headers['Mcp-Session-Id'] = mcpSessionId;
    const req = http.request({hostname:'localhost',port:3846,path:'/mcp',method:'POST',headers}, res => {
      const sid = res.headers['mcp-session-id']; if (sid) mcpSessionId = sid;
      let buf=''; res.on('data',c=>buf+=c);
      res.on('end', () => {
        const m = buf.match(/data: (.+)/);
        const raw = m ? m[1] : buf;
        try { resolve({status:res.statusCode, body:JSON.parse(raw)}); }
        catch { resolve({status:res.statusCode, body:buf}); }
      });
    });
    req.on('error',reject);
    req.write(payload);
    req.end();
  });
}

function parseJsonl(filePath) {
  const externalId = path.basename(filePath, '.jsonl');
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  const messages = [];
  let startedAt = null, endedAt = null, firstUserText = null;

  for (const line of lines) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (!rec.message || !rec.message.role) continue;
    const role = rec.message.role;
    if (role !== 'user' && role !== 'assistant') continue;

    let content = ''; const toolNames = [];
    const c = rec.message.content;
    if (typeof c === 'string') content = c;
    else if (Array.isArray(c)) {
      const parts = [];
      for (const p of c) {
        if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
        else if (p.type === 'tool_use' && p.name) { toolNames.push(p.name); parts.push(`[tool_use:${p.name}]`); }
        else if (p.type === 'tool_result') {
          const t = typeof p.content === 'string' ? p.content : JSON.stringify(p.content);
          parts.push(`[tool_result] ${t.slice(0, 500)}`);
        }
      }
      content = parts.join('\n');
    }
    if (!content) continue;
    const ts = rec.timestamp;
    if (!startedAt && ts) startedAt = ts;
    if (ts) endedAt = ts;
    if (role === 'user' && !firstUserText) firstUserText = content.slice(0, 200);
    messages.push({role, content, timestamp: ts, tool_names: toolNames});
  }
  return {externalId, messages, startedAt, endedAt, firstUserText};
}

(async () => {
  console.log(`Reading ${FILE} ...`);
  const {externalId, messages, startedAt, endedAt, firstUserText} = parseJsonl(FILE);
  console.log(`  external_id: ${externalId}`);
  console.log(`  messages:    ${messages.length}`);
  console.log(`  preview:     ${firstUserText?.slice(0, 100)}`);
  if (messages.length === 0) { console.error('No messages'); process.exit(1); }

  const r1 = await mcpRequest({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'smoke',version:'1'}}});
  console.log('init:', r1.status, typeof r1.body === 'string' ? r1.body.slice(0,80) : 'OK');
  if (r1.status !== 200) process.exit(1);

  await mcpRequest({jsonrpc:'2.0',method:'notifications/initialized'});

  const r3 = await mcpRequest({
    jsonrpc:'2.0', id:Date.now(), method:'tools/call',
    params:{
      name:'session_import',
      arguments:{
        external_id: externalId,
        project_id: PROJECT_ID,
        started_at: startedAt,
        ended_at: endedAt,
        tags: ['smoke-test'],
        messages,
      },
    },
  });
  console.log('import:', r3.status);
  console.log(JSON.stringify(r3.body, null, 2));
})().catch(err => { console.error(err); process.exit(1); });
