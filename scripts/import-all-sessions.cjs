#!/usr/bin/env node

// Mass import of all existing Claude Code sessions.
// Usage: node scripts/import-all-sessions.cjs [--dry-run] [--project d--MCP]
// Safe to re-run — duplicate detection by external_id.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// === Config ===
const SERVER_URL = process.env.TM_SERVER_URL || 'http://10.61.11.54:3846';
const TOKEN = process.env.TM_TOKEN;
const MIN_MESSAGES = 4;

// === CLI args ===
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FILTER_PROJECT = args.find((a, i) => args[i - 1] === '--project');

// Project directory → cwd mapping (for .mcp.json resolution)
const PROJECT_CWD_MAP = {
  'd--MCP': 'd:/MCP',
  'D--MCP-team-memory-mcp': 'd:/MCP/team-memory-mcp',
  'd--Moorinet2-0': 'd:/Moorinet2.0',
  'D--Moorinet-2-0': 'd:/Moorinet2.0',
  'D--Chess-site': 'd:/Chess-site',
  'C--Users-a-nozhenko': 'C:/Users/a.nozhenko',
};

// === Main ===
async function main() {
  if (!TOKEN) {
    console.error('TM_TOKEN not set. Export it or set in env.');
    process.exit(1);
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const projectsDir = path.join(homeDir, '.claude', 'projects');

  if (!fs.existsSync(projectsDir)) {
    console.error('No projects directory found:', projectsDir);
    process.exit(1);
  }

  // Scan all projects
  const projectDirs = fs.readdirSync(projectsDir).filter(d => {
    const stat = fs.statSync(path.join(projectsDir, d));
    return stat.isDirectory();
  });

  let totalSessions = 0;
  let imported = 0;
  let skipped = 0;
  let duplicates = 0;
  let errors = 0;

  for (const projectSlug of projectDirs) {
    if (FILTER_PROJECT && projectSlug !== FILTER_PROJECT) continue;

    const projectPath = path.join(projectsDir, projectSlug);
    const jsonlFiles = fs.readdirSync(projectPath)
      .filter(f => f.endsWith('.jsonl') && !f.includes('subagent'));

    if (jsonlFiles.length === 0) continue;

    // Resolve project_id
    const cwd = PROJECT_CWD_MAP[projectSlug];
    const projectId = cwd ? resolveProjectId(cwd) : null;

    if (!projectId) {
      console.log(`\n⏭️  ${projectSlug}: ${jsonlFiles.length} sessions — SKIP (no .mcp.json)`);
      skipped += jsonlFiles.length;
      continue;
    }

    console.log(`\n📁 ${projectSlug}: ${jsonlFiles.length} sessions → project ${projectId.substring(0, 8)}...`);

    for (let i = 0; i < jsonlFiles.length; i++) {
      const file = jsonlFiles[i];
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(projectPath, file);
      const fileSize = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);

      totalSessions++;
      process.stdout.write(`  [${i + 1}/${jsonlFiles.length}] ${sessionId.substring(0, 8)}... (${fileSize}MB) `);

      // Parse messages
      const messages = parseSessionFile(filePath);
      if (messages.length < MIN_MESSAGES) {
        console.log('— skip (< 3 messages)');
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`— ${messages.length} msgs (dry run)`);
        imported++;
        continue;
      }

      // Detect git branch
      const gitBranch = cwd ? detectGitBranch(cwd) : null;

      try {
        const result = await importSession({
          externalId: sessionId,
          name: `Session ${sessionId.substring(0, 8)}`,
          projectId,
          workingDirectory: cwd,
          gitBranch: gitBranch || '',
          startedAt: messages[0]?.timestamp,
          endedAt: messages[messages.length - 1]?.timestamp,
          messages,
        });

        // Check if it was a duplicate
        const text = result?.result?.content?.[0]?.text || '';
        if (text.includes('в очереди')) {
          console.log(`— ✅ ${messages.length} msgs → queued`);
          imported++;
        } else {
          console.log(`— ♻️ duplicate`);
          duplicates++;
        }
      } catch (err) {
        console.log(`— ❌ ${err.message}`);
        errors++;
      }

      // Small delay between imports to not flood server
      await sleep(500);
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 Results:`);
  console.log(`   Total scanned: ${totalSessions}`);
  console.log(`   Imported (queued): ${imported}`);
  console.log(`   Duplicates (skipped): ${duplicates}`);
  console.log(`   Skipped (small/no project): ${skipped}`);
  console.log(`   Errors: ${errors}`);
  if (DRY_RUN) console.log(`\n⚠️  DRY RUN — nothing was actually sent`);
  if (imported > 0 && !DRY_RUN) {
    const estMinutes = Math.ceil(imported * 3.5); // ~3.5 min per session
    console.log(`\n⏳ Server will process ${imported} sessions in background`);
    console.log(`   Estimated time: ~${estMinutes} minutes (${(estMinutes / 60).toFixed(1)} hours)`);
  }
}

// === Parse JSONL ===
function parseSessionFile(filePath) {
  const data = fs.readFileSync(filePath, 'utf8');
  const lines = data.split('\n').filter(Boolean);
  const messages = [];

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    if (!obj.message?.content) continue;

    const content = obj.message.content;
    let textContent = '';
    const toolNames = [];

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) textContent += block.text + '\n';
        else if (block.type === 'tool_use' && block.name) toolNames.push(block.name);
      }
    } else if (typeof content === 'string') {
      textContent = content;
    }

    textContent = textContent.trim();
    if (!textContent) continue;

    // Skip system/service messages with no useful content
    if (/^<local-command-(caveat|stdout|stderr)>/.test(textContent)) continue;
    if (/^<command-name>/.test(textContent) && textContent.length < 200) continue;
    if (/^<(environment_details|system-reminder|ide_|user-prompt)/.test(textContent)) continue;

    if (textContent.length > 10000) {
      textContent = textContent.substring(0, 10000) + '... [truncated]';
    }

    messages.push({
      role: obj.type === 'user' ? 'user' : 'assistant',
      content: textContent,
      timestamp: obj.timestamp,
      tool_names: toolNames,
    });
  }

  return messages;
}

// === Resolve project ID from .mcp.json ===
function resolveProjectId(cwd) {
  if (!cwd) return null;
  let dir = cwd;
  for (let i = 0; i < 10; i++) {
    try {
      const mcpFile = path.join(dir, '.mcp.json');
      if (fs.existsSync(mcpFile)) {
        const config = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
        const tm = config?.mcpServers?.['team-memory'];
        const projectId = tm?.headers?.['X-Project-Id'];
        if (projectId) return projectId;
      }
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// === Detect git branch ===
function detectGitBranch(cwd) {
  if (!cwd) return null;
  try {
    const headFile = path.join(cwd, '.git', 'HEAD');
    if (fs.existsSync(headFile)) {
      const head = fs.readFileSync(headFile, 'utf8').trim();
      if (head.startsWith('ref: refs/heads/')) return head.replace('ref: refs/heads/', '');
    }
  } catch {}
  return null;
}

// === MCP Import ===
let mcpSessionId = null;
let currentProjectId = null;

function mcpRequest(body) {
  const url = new URL(SERVER_URL + '/mcp');
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': 'Bearer ' + TOKEN,
      'Content-Length': Buffer.byteLength(payload),
    };
    if (currentProjectId) headers['X-Project-Id'] = currentProjectId;
    if (mcpSessionId) headers['Mcp-Session-Id'] = mcpSessionId;

    const req = transport.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers,
    }, (res) => {
      const sid = res.headers['mcp-session-id'];
      if (sid) mcpSessionId = sid;
      let result = '';
      res.on('data', chunk => result += chunk);
      res.on('end', () => {
        const m = result.match(/data: (.+)/);
        if (m) { try { resolve(JSON.parse(m[1])); } catch { resolve(result); } }
        else { try { resolve(JSON.parse(result)); } catch { resolve(result); } }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

async function importSession(data) {
  currentProjectId = data.projectId;

  // Init MCP session if needed (reuse across imports)
  if (!mcpSessionId) {
    await mcpRequest({
      jsonrpc: '2.0', id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mass-import', version: '1.0.0' } },
    });
    await mcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  return mcpRequest({
    jsonrpc: '2.0', id: Date.now(),
    method: 'tools/call',
    params: {
      name: 'session_import',
      arguments: {
        external_id: data.externalId,
        name: data.name,
        project_id: data.projectId,
        working_directory: data.workingDirectory,
        git_branch: data.gitBranch,
        started_at: data.startedAt,
        ended_at: data.endedAt,
        tags: ['mass-import'],
        messages: data.messages.map(m => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          tool_names: m.tool_names,
        })),
      },
    },
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
