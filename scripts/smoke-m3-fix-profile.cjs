#!/usr/bin/env node
// Re-write the 45c8f3bc profile via REST so Cyrillic survives the JSON layer
// (avoiding the Win-curl-charset issue).
const http = require('http');

const TOKEN = process.env.TM_TOKEN;
const PID = process.env.TM_PROJECT_ID || '45c8f3bc-af69-404a-8fa2-897b53748e12';

if (!TOKEN) {
  console.error('TM_TOKEN env var is required');
  process.exit(1);
}

const content = `# Mission
Team Memory MCP — knowledge base для AI-агентов (Claude Code, Cursor, Continue.dev и т.д.).
Хранит командные знания на уровне проекта с двумя транспортами: stdio для Claude Code CLI и HTTP+WebSocket+Web UI для удалённого доступа.

## Stack
- TypeScript, Node 20, PostgreSQL 16 (pgvector в legacy режиме), Qdrant (vector storage)
- MCP SDK, Express, WebSocket
- LLM: Ollama (embeddings + summarization), Gemini 2.5 Flash (RAG-чат)
- Тесты: vitest

## Repository map
- \`src/memory/\` — менеджер записей, типы (Category, MemoryEntry, ROLE_PRIORITIES)
- \`src/events/\` — v5: project_events timeline (merge/release/deploy/incident/milestone)
- \`src/sessions/\` — импорт Claude Code сессий, hierarchical retrieval, auto-notes extraction
- \`src/extraction/\` — LLM-pass для извлечения knowledge-фактов
- \`src/storage/migrations/\` — DB schema (NNN-name.sql, rollback в rollbacks/)
- \`src/server.ts\` — MCP tools registration + dispatcher
- \`src/app.ts\` — Express bootstrap, REST routes
- \`scripts/session-sync.cjs\` — Claude Code Stop/SessionEnd hook
- \`docs/superpowers/plans/\` — implementation plans (writing-plans skill)

## Critical conventions
- Commits: \`feat|fix|docs|refactor(scope): subject\` + опциональное body + Co-Authored-By строка
- Тесты идут до кода (TDD): test → run/fail → implement → run/pass → commit
- Только что добавленные миграции получают rollback в \`rollbacks/NNN-rollback.sql\`
- main защищён, all changes via PR

## Guard-rails (Do NOT)
- NO force-push к main
- НЕ менять уже применённые миграции; всегда добавлять новую следующего номера
- НЕ удалять \`rollbacks/\` скрипты
- НЕ коммитить \`.env\` и токены (\`.gitignore\` блокирует)
- НЕ скипать pre-commit hooks (\`--no-verify\`)

## Where to look for X
- Хочешь добавить миграцию → \`src/storage/migrations/NNN-name.sql\` + rollback
- Хочешь поправить онбординг → \`src/memory/manager.ts:generateOnboarding\`
- LLM-prompt для extraction → \`src/extraction/prompt.ts\`
- Hook для session sync → \`scripts/session-sync.cjs\`
- MCP-tool регистрация → \`src/server.ts\` (поиск \`name:\`)
- REST routes → \`src/app.ts\`

## Current focus
v5 (Profile + Events + Knowledge) — релиз 13.05.2026, миграции 021-024 применены.
`;

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
  const r = await call('PUT', `/api/projects/${PID}/profile`, { content, tags: ['v5', 'mission', 'stack', 'conventions', 'guard-rails'] });
  console.log('PUT profile:', r.status);
  const j = JSON.parse(r.body);
  console.log('profile id:', j.profile?.id);
  console.log('content snippet:', j.profile?.content?.slice(0, 100));
})().catch(e => { console.error(e); process.exit(1); });
