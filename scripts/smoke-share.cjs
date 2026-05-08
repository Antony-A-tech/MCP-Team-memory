#!/usr/bin/env node
/**
 * Smoke test for the v4.5 manual-share path against a running team-memory-mcp.
 *
 * Drives this scenario through the MCP transport:
 *   1. note_write   — create a personal draft about an architectural decision
 *   2. note_share   (on_match=create_new)         → expect "Action: created"
 *   3. note_write   — create a SECOND note about the same topic
 *   4. note_share   (on_match=prompt)             → expect dedup match (cosine ≥ 0.85)
 *   5. note_share   (on_match=confirm_existing)   → confirmation_count++ on the 1st entry
 *
 * Exercises: MCP auth, note_write, semantic search via Qdrant + embedding,
 * DedupResolver thresholds, NotesManager.share onMatch branches, audit/emit.
 *
 * Usage:
 *   TM_TOKEN=tm_xxx node scripts/smoke-share.cjs [project_id]
 *
 * Pre-req: server running with EXTRACT_NOTES_ENABLED=true and a wired
 * embedding provider + vector store (Qdrant) so dedup actually fires.
 * Without dedup deps the prompt/confirm/merge branches will be rejected
 * with HTTP 400 (parity check between MCP and REST contracts).
 */
const http = require('http');

const TOKEN = process.env.TM_TOKEN;
const PROJECT_ID = process.argv[2] || '00000000-0000-0000-0000-000000000000';
if (!TOKEN) { console.error('TM_TOKEN required'); process.exit(1); }

let mcpSessionId = null;
function rpc(body) {
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
    req.on('error',reject); req.write(payload); req.end();
  });
}

(async () => {
  await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'smoke-share',version:'1'}}});
  await rpc({jsonrpc:'2.0',method:'notifications/initialized'});

  // Step 1: write a personal note
  console.log('=== Step 1: note_write ===');
  const r1 = await rpc({jsonrpc:'2.0',id:2,method:'tools/call',params:{
    name:'note_write',
    arguments:{
      title: 'JWT с 7-day refresh token',
      content: 'Решили использовать JWT с 7-day refresh token, потому что cookies блокируются cross-domain в нашем edge-deployment. Refresh-токен позволяет revocation и короткоживущие access-токены. Альтернатива (cookies) была отвергнута из-за SameSite=None требований.',
      tags: ['auth', 'jwt', 'security'],
      priority: 'high',
      project_id: PROJECT_ID,
    },
  }});
  console.log('Status:', r1.status);
  console.log(JSON.stringify(r1.body?.result || r1.body, null, 2));
  const noteText = r1.body?.result?.content?.[0]?.text || '';
  const noteIdMatch = noteText.match(/[0-9a-f-]{36}/);
  if (!noteIdMatch) { console.error('No note ID parsed'); process.exit(1); }
  const noteId = noteIdMatch[0];
  console.log(`note_id = ${noteId}`);

  // Step 2: share it — first try with on_match=create_new (no dedup decision)
  console.log('\n=== Step 2: note_share (create_new) ===');
  const r2 = await rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{
    name:'note_share',
    arguments:{
      note_id: noteId,
      category: 'decisions',
      on_match: 'create_new',
    },
  }});
  console.log('Status:', r2.status);
  console.log(JSON.stringify(r2.body?.result || r2.body, null, 2));

  // Step 3: write a SECOND note about the same topic and try `prompt` mode → should detect dedup match
  console.log('\n=== Step 3: note_write (similar topic) ===');
  const r3 = await rpc({jsonrpc:'2.0',id:4,method:'tools/call',params:{
    name:'note_write',
    arguments:{
      title: 'Auth: refresh tokens 7 дней',
      content: 'Используем JWT plus refresh tokens на 7 дней. Cookies не работают cross-domain. Refresh даёт revocation и короткие access tokens.',
      tags: ['auth'],
      priority: 'medium',
      project_id: PROJECT_ID,
    },
  }});
  const note2Id = (r3.body?.result?.content?.[0]?.text || '').match(/[0-9a-f-]{36}/)?.[0];
  console.log(`note2_id = ${note2Id}`);

  console.log('\n=== Step 4: note_share (prompt — expect match_found) ===');
  const r4 = await rpc({jsonrpc:'2.0',id:5,method:'tools/call',params:{
    name:'note_share',
    arguments:{
      note_id: note2Id,
      category: 'decisions',
      on_match: 'prompt',
    },
  }});
  console.log('Status:', r4.status);
  console.log(JSON.stringify(r4.body?.result || r4.body, null, 2));

  console.log('\n=== Step 5: note_share (confirm_existing) ===');
  const r5 = await rpc({jsonrpc:'2.0',id:6,method:'tools/call',params:{
    name:'note_share',
    arguments:{
      note_id: note2Id,
      category: 'decisions',
      on_match: 'confirm_existing',
    },
  }});
  console.log('Status:', r5.status);
  console.log(JSON.stringify(r5.body?.result || r5.body, null, 2));
})().catch(err => { console.error(err); process.exit(1); });
