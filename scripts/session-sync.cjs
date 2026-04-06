#!/usr/bin/env node

/**
 * Session Sync Hook for Claude Code
 *
 * Works with TWO events:
 *   - Stop: fires after every Claude response. Uses 1-hour debounce —
 *     only syncs if ≥1 hour passed since last sync of this session.
 *   - SessionEnd: fires when session terminates. Always syncs (no debounce).
 *
 * This gives natural per-user randomization: each person's first sync
 * happens 1 hour after they started working, not at a fixed clock time.
 *
 * Configuration: ~/.claude/settings.json
 * {
 *   "hooks": {
 *     "Stop": [{
 *       "matcher": "",
 *       "hooks": [{
 *         "type": "command",
 *         "command": "node /path/to/session-sync.cjs",
 *         "timeout": 30
 *       }]
 *     }],
 *     "SessionEnd": [{
 *       "matcher": "",
 *       "hooks": [{
 *         "type": "command",
 *         "command": "node /path/to/session-sync.cjs",
 *         "timeout": 30
 *       }]
 *     }]
 *   },
 *   "env": {
 *     "TM_SERVER_URL": "http://10.61.11.54:3846",
 *     "TM_TOKEN": "tm_your_agent_token",
 *     "TM_PROJECT_ID": "your-project-uuid"
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// === Config ===
const SERVER_URL = process.env.TM_SERVER_URL || 'http://10.61.11.54:3846';
const TOKEN = process.env.TM_TOKEN;
const PROJECT_ID = process.env.TM_PROJECT_ID || undefined;
const MIN_MESSAGES = 3;
const DEBOUNCE_MS = 60 * 60 * 1000; // 1 hour

// Debounce state file directory
const SYNC_STATE_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.claude', '.session-sync',
);

// === Main ===
async function main() {
  const input = await readStdin();
  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const { session_id, cwd, hook_event_name } = hookData;
  if (!session_id || !TOKEN) process.exit(0);

  const isSessionEnd = hook_event_name === 'SessionEnd';

  // Debounce check for Stop events (skip if synced within last hour)
  if (!isSessionEnd && !shouldSync(session_id)) {
    process.exit(0);
  }

  // Find and parse session file
  const sessionFile = findSessionFile(session_id, cwd);
  if (!sessionFile) process.exit(0);

  const messages = parseSessionFile(sessionFile);
  if (messages.length < MIN_MESSAGES) process.exit(0);

  const gitBranch = detectGitBranch(cwd);

  try {
    await importSession({
      externalId: session_id,
      name: `Session ${session_id.substring(0, 8)}`,
      projectId: PROJECT_ID,
      workingDirectory: cwd,
      gitBranch: gitBranch || '',
      startedAt: messages[0]?.timestamp,
      endedAt: messages[messages.length - 1]?.timestamp,
      messages,
    });
    // Record successful sync timestamp
    markSynced(session_id);
    // Silent success — don't pollute Claude's output
  } catch (err) {
    // Silent failure — don't block Claude Code
    process.exit(0);
  }
}

// === Debounce ===
function shouldSync(sessionId) {
  try {
    const stateFile = path.join(SYNC_STATE_DIR, sessionId + '.json');
    if (!fs.existsSync(stateFile)) return true;
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return Date.now() - state.lastSync >= DEBOUNCE_MS;
  } catch {
    return true; // On error, sync anyway
  }
}

function markSynced(sessionId) {
  try {
    if (!fs.existsSync(SYNC_STATE_DIR)) {
      fs.mkdirSync(SYNC_STATE_DIR, { recursive: true });
    }
    const stateFile = path.join(SYNC_STATE_DIR, sessionId + '.json');
    fs.writeFileSync(stateFile, JSON.stringify({ lastSync: Date.now() }));
  } catch {
    // Non-critical — worst case we sync again sooner
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

// === Find session file ===
function findSessionFile(sessionId, cwd) {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const projectsDir = path.join(homeDir, '.claude', 'projects');

  if (!fs.existsSync(projectsDir)) return null;

  // Try direct path based on cwd slug
  if (cwd) {
    const slug = cwd.replace(/[/\\]/g, '-').replace(/^-/, '').replace(/:/g, '-');
    for (const s of [slug, slug.toLowerCase(), slug.replace(/--+/g, '-')]) {
      const candidate = path.join(projectsDir, s, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Fallback: scan all project directories
  try {
    const dirs = fs.readdirSync(projectsDir);
    for (const dir of dirs) {
      const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* ignore */ }

  return null;
}

// === Detect git branch ===
function detectGitBranch(cwd) {
  if (!cwd) return null;
  try {
    const headFile = path.join(cwd, '.git', 'HEAD');
    if (fs.existsSync(headFile)) {
      const head = fs.readFileSync(headFile, 'utf8').trim();
      if (head.startsWith('ref: refs/heads/')) {
        return head.replace('ref: refs/heads/', '');
      }
    }
  } catch { /* ignore */ }
  return null;
}

// === MCP Import ===
let mcpSessionId = null;

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
    if (PROJECT_ID) headers['X-Project-Id'] = PROJECT_ID;
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
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(payload);
    req.end();
  });
}

async function importSession(data) {
  await mcpRequest({
    jsonrpc: '2.0', id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'session-sync-hook', version: '2.0.0' } },
  });
  await mcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const result = await mcpRequest({
    jsonrpc: '2.0', id: 2,
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
        tags: ['auto-sync'],
        messages: data.messages.map(m => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          tool_names: m.tool_names,
        })),
      },
    },
  });

  if (result?.error) {
    throw new Error(result.error.message || JSON.stringify(result.error));
  }

  return result;
}

// === Helpers ===
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data || '{}'), 1000);
  });
}

main().catch(() => process.exit(0));
