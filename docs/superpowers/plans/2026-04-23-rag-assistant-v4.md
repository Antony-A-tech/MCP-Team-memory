# RAG-ассистент v4.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Переписать AI-чат team-memory-mcp как RAG-ассистента v4.0: Gemini 2.5 Flash как LLM, native function calling по 12 read-only MCP-инструментам, SSE streaming, персистентная история чатов в PostgreSQL.

**Architecture:** Слабо связанные модули: `ChatLlmProvider` (интерфейс провайдера) → `GeminiChatProvider` (реализация); `RagAgent` (оркестратор: onboard + agent loop) поверх `McpToolAdapter` (routing + principal-based project_id enforcement); `ChatManager` + `ChatStorage` (персистентность в Postgres). Ollama остаётся для саммаризации сессий — не трогается.

**Tech Stack:** Node 20, TypeScript 5.6, Express 4.21, pg 8.13, Vitest 4, Supertest 7. Gemini API через `fetch` + SSE-парсер (без `@google/generative-ai` — не хотим тяжёлую зависимость для 2-3 методов).

**Spec:** [docs/superpowers/specs/2026-04-23-rag-assistant-v4-design.md](../specs/2026-04-23-rag-assistant-v4-design.md)

---

## Файловая структура (итоговая)

**Новые файлы:**
- `src/storage/migrations/016-chat-history.sql` — миграция БД
- `src/llm/chat-provider.ts` — `ChatLlmProvider` interface + shared types (`ChatMessage`, `ToolCall`, `ToolDeclaration`, `ProviderEvent`, `SseEvent`)
- `src/llm/gemini.ts` — `GeminiChatProvider` class
- `src/rag/agent.ts` — `RagAgent` class
- `src/rag/tool-adapter.ts` — `McpToolAdapter` class
- `src/rag/tool-registry.ts` — декларации 12 тулзов + handlers map
- `src/rag/title-generator.ts` — `TitleGenerator` class
- `src/chat/types.ts` — `ChatSession`, `PersistedChatMessage`
- `src/chat/storage.ts` — `ChatStorage` class
- `src/chat/manager.ts` — `ChatManager` class
- `src/__tests__/chat-storage.test.ts`
- `src/__tests__/chat-manager.test.ts`
- `src/__tests__/gemini-provider.test.ts`
- `src/__tests__/tool-adapter.test.ts`
- `src/__tests__/tool-registry.test.ts`
- `src/__tests__/rag-agent.test.ts`
- `src/__tests__/title-generator.test.ts`
- `src/__tests__/chat-api.test.ts`
- `src/__tests__/chat-e2e.test.ts` (integration, optional — только если есть тестовый Postgres)

**Модифицируемые:**
- `src/config.ts` — 4 новых env-поля
- `src/app.ts` — убрать старый `/api/chat`, добавить 7 новых эндпоинтов, сконструировать RagAgent/ChatManager/GeminiChatProvider
- `src/web/public/index.html` — sidebar + project select
- `src/web/public/chat.js` — SSE reader + thinking block + sidebar + project switch
- `src/web/public/styles.css` — стили для sidebar и tool-trace
- `.env.example` — новые переменные

**Неизменяемое:**
- `src/llm/ollama.ts` — остаётся целиком для `SessionManager.summarizeSession`
- Все существующие тесты — не трогаются

---

## Phase 0 — Foundation

### Task 1: Env config

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example` (в `src/` его нет — в корне `d:/MCP/team-memory-mcp/.env.example`; если файла нет — создать)
- Test: `src/__tests__/config.test.ts` (существующий)

- [ ] **Step 1: Write failing test**

В [src/__tests__/config.test.ts](../../src/__tests__/config.test.ts) добавить тест-кейсы в существующий `describe`:

```typescript
it('loads Gemini API key from env', () => {
  process.env.GEMINI_API_KEY = 'test-key';
  const config = loadConfig();
  expect(config.geminiApiKey).toBe('test-key');
  delete process.env.GEMINI_API_KEY;
});

it('defaults Gemini model to gemini-2.5-flash', () => {
  delete process.env.GEMINI_MODEL;
  const config = loadConfig();
  expect(config.geminiModel).toBe('gemini-2.5-flash');
});

it('defaults RAG_MAX_ITERATIONS to 5', () => {
  delete process.env.RAG_MAX_ITERATIONS;
  const config = loadConfig();
  expect(config.ragMaxIterations).toBe(5);
});

it('defaults RAG_TOOL_RESPONSE_MAX_CHARS to 20000', () => {
  delete process.env.RAG_TOOL_RESPONSE_MAX_CHARS;
  const config = loadConfig();
  expect(config.ragToolResponseMaxChars).toBe(20_000);
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd d:/MCP/team-memory-mcp && npx vitest run src/__tests__/config.test.ts
```

Expected: FAIL — «Property 'geminiApiKey' does not exist on type 'AppConfig'».

- [ ] **Step 3: Extend AppConfig in config.ts**

В [src/config.ts:28](../../src/config.ts#L28) добавить поля в интерфейс (перед `allowReadonly`):

```typescript
  // RAG chat config
  geminiApiKey: string | undefined;
  geminiModel: string;
  ragMaxIterations: number;
  ragToolResponseMaxChars: number;
```

В `loadConfig()` перед `allowReadonly` добавить:

```typescript
    geminiApiKey: process.env.GEMINI_API_KEY || undefined,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    ragMaxIterations: parseIntSafe(process.env.RAG_MAX_ITERATIONS || '5', 5),
    ragToolResponseMaxChars: parseIntSafe(process.env.RAG_TOOL_RESPONSE_MAX_CHARS || '20000', 20_000),
```

- [ ] **Step 4: Run to confirm pass**

```bash
npx vitest run src/__tests__/config.test.ts
```

Expected: PASS, 4 new tests green.

- [ ] **Step 5: Update .env.example**

Добавить в `d:/MCP/team-memory-mcp/.env.example` (создать если нет):

```
# RAG chat (v4.0) — Gemini 2.5 Flash as chat LLM
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
RAG_MAX_ITERATIONS=5
RAG_TOOL_RESPONSE_MAX_CHARS=20000
```

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts .env.example
git commit -m "feat(config): add Gemini and RAG configuration"
```

---

### Task 2: Migration 016 — chat_sessions and chat_messages

**Files:**
- Create: `src/storage/migrations/016-chat-history.sql`
- Test: `src/__tests__/migrator.test.ts` (существующий — добавить кейс)

- [ ] **Step 1: Write migration SQL**

Создать `src/storage/migrations/016-chat-history.sql`:

```sql
-- Migration 016: chat_sessions + chat_messages (RAG assistant v4.0)

CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_token_id UUID NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'Новый чат',
  title_is_user_set BOOLEAN NOT NULL DEFAULT FALSE,
  onboard_injected BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_token_updated
  ON chat_sessions(agent_token_id, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_project
  ON chat_sessions(project_id)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  tool_calls JSONB,
  tool_call_id TEXT,
  tool_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session
  ON chat_messages(session_id, id);
```

- [ ] **Step 2: Write integration check**

Добавить в `src/__tests__/migrator.test.ts` (в конце существующего describe):

```typescript
it('includes migration 016 chat-history in migration list', () => {
  const migrationsDir = path.resolve(__dirname, '../storage/migrations');
  const files = readdirSync(migrationsDir);
  const chatMigration = files.find(f => f.startsWith('016-') && f.endsWith('.sql'));
  expect(chatMigration).toBeDefined();
  expect(chatMigration).toMatch(/chat-history/);
});
```

Импорт в начало файла (если ещё нет):
```typescript
import { readdirSync } from 'fs';
import path from 'path';
```

- [ ] **Step 3: Run test**

```bash
npx vitest run src/__tests__/migrator.test.ts
```

Expected: PASS.

- [ ] **Step 4: Verify SQL parses (dry-run)**

```bash
cat src/storage/migrations/016-chat-history.sql
```

Визуально убедиться: два CREATE TABLE, три CREATE INDEX, все `IF NOT EXISTS`.

- [ ] **Step 5: Commit**

```bash
git add src/storage/migrations/016-chat-history.sql src/__tests__/migrator.test.ts
git commit -m "feat(db): add migration 016 chat-history"
```

---

## Phase 1 — Chat persistence layer

### Task 3: chat/types.ts — PersistedChatMessage и ChatSession

**Files:**
- Create: `src/chat/types.ts`

- [ ] **Step 1: Write type definitions**

Создать `src/chat/types.ts`:

```typescript
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCalls?: ToolCall[];   // for assistant messages
  toolCallId?: string;      // for tool-result messages
  toolName?: string;        // for tool-result messages
}

export interface PersistedChatMessage extends ChatMessage {
  id: number;
  sessionId: string;
  createdAt: string;
}

export interface ChatSession {
  id: string;
  agentTokenId: string;
  projectId: string | null;
  title: string;
  titleIsUserSet: boolean;
  onboardInjected: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ChatSessionWithMessages extends ChatSession {
  messages: PersistedChatMessage[];
}

export interface ChatSessionFilters {
  projectId?: string;
  limit?: number;
  offset?: number;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd d:/MCP/team-memory-mcp && npx tsc --noEmit
```

Expected: PASS — no TS errors.

- [ ] **Step 3: Commit**

```bash
git add src/chat/types.ts
git commit -m "feat(chat): add types for chat sessions and messages"
```

---

### Task 4: chat/storage.ts — ChatStorage CRUD

**Files:**
- Create: `src/chat/storage.ts`
- Test: `src/__tests__/chat-storage.test.ts`

- [ ] **Step 1: Write failing test (create + get session)**

Создать `src/__tests__/chat-storage.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatStorage } from '../chat/storage.js';

function createMockPool() {
  return { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
}

describe('ChatStorage', () => {
  let storage: ChatStorage;
  let pool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    pool = createMockPool();
    storage = new ChatStorage(pool as any);
  });

  describe('createSession', () => {
    it('inserts row with agent_token_id and project_id', async () => {
      pool.query.mockResolvedValue({
        rows: [{
          id: 'sess-1',
          agent_token_id: 'tok-1',
          project_id: 'proj-1',
          title: 'Новый чат',
          title_is_user_set: false,
          onboard_injected: false,
          created_at: '2026-04-23T00:00:00Z',
          updated_at: '2026-04-23T00:00:00Z',
          archived_at: null,
        }],
        rowCount: 1,
      });

      const result = await storage.createSession({
        agentTokenId: 'tok-1',
        projectId: 'proj-1',
      });

      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('INSERT INTO chat_sessions');
      expect(pool.query.mock.calls[0][1]).toEqual(['tok-1', 'proj-1']);
      expect(result.id).toBe('sess-1');
      expect(result.title).toBe('Новый чат');
    });
  });

  describe('listSessions', () => {
    it('filters by agent_token_id and excludes archived', async () => {
      pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
      await storage.listSessions('tok-1', { limit: 10, offset: 0 });
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('agent_token_id = $1');
      expect(sql).toContain('archived_at IS NULL');
    });

    it('adds project_id filter when provided', async () => {
      pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
      await storage.listSessions('tok-1', { projectId: 'proj-1', limit: 10, offset: 0 });
      const sql = pool.query.mock.calls[0][0] as string;
      expect(sql).toContain('project_id = $2');
    });
  });
});
```

- [ ] **Step 2: Run test to confirm fail**

```bash
npx vitest run src/__tests__/chat-storage.test.ts
```

Expected: FAIL — «Cannot find module '../chat/storage.js'».

- [ ] **Step 3: Implement ChatStorage (createSession + listSessions)**

Создать `src/chat/storage.ts`:

```typescript
import type { Pool } from 'pg';
import type {
  ChatSession,
  PersistedChatMessage,
  ChatSessionFilters,
  ChatRole,
  ToolCall,
} from './types.js';

export class ChatStorage {
  constructor(private pool: Pool) {}

  async createSession(input: {
    agentTokenId: string;
    projectId: string | null;
    title?: string;
  }): Promise<ChatSession> {
    const title = input.title ?? 'Новый чат';
    const titleIsUserSet = input.title !== undefined;
    const { rows } = await this.pool.query(
      `INSERT INTO chat_sessions (agent_token_id, project_id, title, title_is_user_set)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.agentTokenId, input.projectId, title, titleIsUserSet],
    );
    return this.rowToSession(rows[0]);
  }

  async getSession(id: string, agentTokenId: string): Promise<ChatSession | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM chat_sessions WHERE id = $1 AND agent_token_id = $2 AND archived_at IS NULL`,
      [id, agentTokenId],
    );
    return rows[0] ? this.rowToSession(rows[0]) : null;
  }

  async listSessions(agentTokenId: string, filters: ChatSessionFilters): Promise<ChatSession[]> {
    const conditions: string[] = ['agent_token_id = $1', 'archived_at IS NULL'];
    const params: unknown[] = [agentTokenId];
    let idx = 2;

    if (filters.projectId) {
      conditions.push(`project_id = $${idx++}`);
      params.push(filters.projectId);
    }

    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const { rows } = await this.pool.query(
      `SELECT * FROM chat_sessions WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );
    return rows.map(r => this.rowToSession(r));
  }

  private rowToSession(r: any): ChatSession {
    return {
      id: r.id,
      agentTokenId: r.agent_token_id,
      projectId: r.project_id,
      title: r.title,
      titleIsUserSet: r.title_is_user_set,
      onboardInjected: r.onboard_injected,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      archivedAt: r.archived_at,
    };
  }
}
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
npx vitest run src/__tests__/chat-storage.test.ts
```

Expected: PASS — 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/chat/storage.ts src/__tests__/chat-storage.test.ts
git commit -m "feat(chat): add ChatStorage createSession, getSession, listSessions"
```

- [ ] **Step 6: Write failing test for rename / markOnboarded / softDelete / updateTouchedAt**

Добавить в `src/__tests__/chat-storage.test.ts`:

```typescript
describe('renameSession', () => {
  it('updates title and sets title_is_user_set=true', async () => {
    pool.query.mockResolvedValue({ rowCount: 1 });
    await storage.renameSession('sess-1', 'tok-1', 'My chat');
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain('UPDATE chat_sessions');
    expect(sql).toContain('title = $3');
    expect(sql).toContain('title_is_user_set = TRUE');
    expect(pool.query.mock.calls[0][1]).toEqual(['sess-1', 'tok-1', 'My chat']);
  });
});

describe('markOnboarded', () => {
  it('sets onboard_injected=true', async () => {
    pool.query.mockResolvedValue({ rowCount: 1 });
    await storage.markOnboarded('sess-1');
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain('onboard_injected = TRUE');
  });
});

describe('softDeleteSession', () => {
  it('sets archived_at=NOW()', async () => {
    pool.query.mockResolvedValue({ rowCount: 1 });
    await storage.softDeleteSession('sess-1', 'tok-1');
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain('archived_at = NOW()');
    expect(sql).toContain('agent_token_id = $2');
  });
});

describe('touchSession', () => {
  it('updates updated_at=NOW()', async () => {
    pool.query.mockResolvedValue({ rowCount: 1 });
    await storage.touchSession('sess-1');
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain('updated_at = NOW()');
  });
});
```

- [ ] **Step 7: Run to confirm fail**

```bash
npx vitest run src/__tests__/chat-storage.test.ts
```

Expected: FAIL (4 new tests).

- [ ] **Step 8: Implement the 4 methods**

Добавить в `src/chat/storage.ts` (перед `rowToSession`):

```typescript
  async renameSession(id: string, agentTokenId: string, title: string): Promise<void> {
    await this.pool.query(
      `UPDATE chat_sessions
       SET title = $3, title_is_user_set = TRUE, updated_at = NOW()
       WHERE id = $1 AND agent_token_id = $2`,
      [id, agentTokenId, title],
    );
  }

  async updateAutoTitle(id: string, title: string): Promise<void> {
    // Only update if user hasn't manually renamed
    await this.pool.query(
      `UPDATE chat_sessions
       SET title = $2, updated_at = NOW()
       WHERE id = $1 AND title_is_user_set = FALSE`,
      [id, title],
    );
  }

  async markOnboarded(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE chat_sessions SET onboard_injected = TRUE WHERE id = $1`,
      [id],
    );
  }

  async softDeleteSession(id: string, agentTokenId: string): Promise<void> {
    await this.pool.query(
      `UPDATE chat_sessions SET archived_at = NOW()
       WHERE id = $1 AND agent_token_id = $2`,
      [id, agentTokenId],
    );
  }

  async touchSession(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1`,
      [id],
    );
  }
```

- [ ] **Step 9: Run to confirm pass**

```bash
npx vitest run src/__tests__/chat-storage.test.ts
```

Expected: PASS — all 7 tests.

- [ ] **Step 10: Commit**

```bash
git add src/chat/storage.ts src/__tests__/chat-storage.test.ts
git commit -m "feat(chat): add ChatStorage rename/markOnboarded/softDelete/touch"
```

- [ ] **Step 11: Write failing test for appendMessage / listMessages**

Добавить в `src/__tests__/chat-storage.test.ts`:

```typescript
describe('appendMessage', () => {
  it('inserts user message with null tool fields', async () => {
    pool.query.mockResolvedValue({
      rows: [{
        id: 1, session_id: 'sess-1', role: 'user', content: 'Hi',
        tool_calls: null, tool_call_id: null, tool_name: null,
        created_at: '2026-04-23T00:00:00Z',
      }],
    });
    const result = await storage.appendMessage('sess-1', {
      role: 'user',
      content: 'Hi',
    });
    expect(result.id).toBe(1);
    expect(result.role).toBe('user');
    const params = pool.query.mock.calls[0][1];
    expect(params[2]).toBe('user');
    expect(params[4]).toBeNull();
  });

  it('serializes tool_calls JSONB for assistant message', async () => {
    pool.query.mockResolvedValue({
      rows: [{
        id: 2, session_id: 'sess-1', role: 'assistant', content: 'Let me check',
        tool_calls: [{ id: 'c1', name: 'memory_read', args: {} }],
        tool_call_id: null, tool_name: null,
        created_at: '2026-04-23T00:00:00Z',
      }],
    });
    await storage.appendMessage('sess-1', {
      role: 'assistant',
      content: 'Let me check',
      toolCalls: [{ id: 'c1', name: 'memory_read', args: {} }],
    });
    const params = pool.query.mock.calls[0][1];
    expect(params[4]).toEqual([{ id: 'c1', name: 'memory_read', args: {} }]);
  });

  it('stores tool_call_id and tool_name for tool message', async () => {
    pool.query.mockResolvedValue({
      rows: [{
        id: 3, session_id: 'sess-1', role: 'tool', content: '{}',
        tool_calls: null, tool_call_id: 'c1', tool_name: 'memory_read',
        created_at: '2026-04-23T00:00:00Z',
      }],
    });
    await storage.appendMessage('sess-1', {
      role: 'tool',
      content: '{}',
      toolCallId: 'c1',
      toolName: 'memory_read',
    });
    const params = pool.query.mock.calls[0][1];
    expect(params[5]).toBe('c1');
    expect(params[6]).toBe('memory_read');
  });
});

describe('listMessages', () => {
  it('orders by id ascending', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await storage.listMessages('sess-1');
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain('session_id = $1');
    expect(sql).toContain('ORDER BY id ASC');
  });
});
```

- [ ] **Step 12: Run to confirm fail**

```bash
npx vitest run src/__tests__/chat-storage.test.ts
```

Expected: FAIL (4 new tests).

- [ ] **Step 13: Implement appendMessage + listMessages**

Добавить в `src/chat/storage.ts`:

```typescript
  async appendMessage(sessionId: string, msg: {
    role: ChatRole;
    content: string;
    toolCalls?: ToolCall[];
    toolCallId?: string;
    toolName?: string;
  }): Promise<PersistedChatMessage> {
    const { rows } = await this.pool.query(
      `INSERT INTO chat_messages (session_id, role, content, tool_calls, tool_call_id, tool_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        sessionId,
        msg.role,
        msg.content,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        msg.toolCallId ?? null,
        msg.toolName ?? null,
      ],
    );
    return this.rowToMessage(rows[0]);
  }

  async listMessages(sessionId: string): Promise<PersistedChatMessage[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY id ASC`,
      [sessionId],
    );
    return rows.map(r => this.rowToMessage(r));
  }

  private rowToMessage(r: any): PersistedChatMessage {
    return {
      id: Number(r.id),
      sessionId: r.session_id,
      role: r.role as ChatRole,
      content: r.content,
      toolCalls: r.tool_calls ?? undefined,
      toolCallId: r.tool_call_id ?? undefined,
      toolName: r.tool_name ?? undefined,
      createdAt: r.created_at,
    };
  }
```

В тесте `toolCalls JSONB` стоит исправить ожидание — при передаче мы делаем `JSON.stringify`, но мок возвращает уже распарсенный массив. Проверяем, что в первом параметре строкового JSON'а нет — сравниваем с массивом на выходе мока. В тестах выше мы проверяем `params[4]` — PG при реальной вставке принимает строку и парсит в JSONB. В моке мы сравниваем с объектом/массивом напрямую. Подправить ожидание теста на:

```typescript
// было: expect(params[4]).toEqual([{...}]);
// стало:
expect(JSON.parse(params[4] as string)).toEqual([{ id: 'c1', name: 'memory_read', args: {} }]);
```

- [ ] **Step 14: Run to confirm pass**

```bash
npx vitest run src/__tests__/chat-storage.test.ts
```

Expected: PASS — все 11 тестов.

- [ ] **Step 15: Commit**

```bash
git add src/chat/storage.ts src/__tests__/chat-storage.test.ts
git commit -m "feat(chat): add ChatStorage append/list messages"
```

---

### Task 5: chat/manager.ts — ChatManager business logic

**Files:**
- Create: `src/chat/manager.ts`
- Test: `src/__tests__/chat-manager.test.ts`

- [ ] **Step 1: Write failing test**

Создать `src/__tests__/chat-manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatManager } from '../chat/manager.js';
import type { ChatStorage } from '../chat/storage.js';

function createMockStorage(): ChatStorage {
  return {
    createSession: vi.fn(),
    getSession: vi.fn(),
    listSessions: vi.fn(),
    renameSession: vi.fn(),
    updateAutoTitle: vi.fn(),
    markOnboarded: vi.fn(),
    softDeleteSession: vi.fn(),
    touchSession: vi.fn(),
    appendMessage: vi.fn(),
    listMessages: vi.fn(),
  } as any;
}

describe('ChatManager', () => {
  let manager: ChatManager;
  let storage: ChatStorage;

  beforeEach(() => {
    storage = createMockStorage();
    manager = new ChatManager(storage);
  });

  describe('create', () => {
    it('delegates to storage', async () => {
      (storage.createSession as any).mockResolvedValue({ id: 'sess-1' });
      const result = await manager.create({ agentTokenId: 'tok', projectId: 'proj' });
      expect(storage.createSession).toHaveBeenCalledWith({ agentTokenId: 'tok', projectId: 'proj', title: undefined });
      expect(result.id).toBe('sess-1');
    });
  });

  describe('loadSessionWithMessages', () => {
    it('returns null when session not found or not owned by token', async () => {
      (storage.getSession as any).mockResolvedValue(null);
      const result = await manager.loadSessionWithMessages('sess-1', 'tok-1');
      expect(result).toBeNull();
      expect(storage.listMessages).not.toHaveBeenCalled();
    });

    it('returns session with filtered orphan tool messages', async () => {
      (storage.getSession as any).mockResolvedValue({
        id: 'sess-1', agentTokenId: 'tok-1', projectId: null, title: 't',
        titleIsUserSet: false, onboardInjected: false,
        createdAt: '', updatedAt: '', archivedAt: null,
      });
      (storage.listMessages as any).mockResolvedValue([
        { id: 1, role: 'user', content: 'Hi' },
        { id: 2, role: 'tool', content: '{}', toolCallId: 'missing' }, // orphan — no assistant before with this id
        { id: 3, role: 'assistant', content: 'Hey', toolCalls: [{ id: 'c1', name: 'x', args: {} }] },
        { id: 4, role: 'tool', content: '{}', toolCallId: 'c1', toolName: 'x' }, // valid — matches id:3
      ]);
      const result = await manager.loadSessionWithMessages('sess-1', 'tok-1');
      expect(result?.messages.map(m => m.id)).toEqual([1, 3, 4]);
    });
  });

  describe('rollingWindow', () => {
    it('keeps system + last 30 non-system messages', () => {
      const system = { role: 'system', content: 's' };
      const many = Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `msg ${i}`,
      }));
      const all = [system, ...many];
      const window = manager.rollingWindow(all as any);
      expect(window.length).toBe(31);
      expect(window[0].role).toBe('system');
      expect(window[1].content).toBe('msg 10');
      expect(window[30].content).toBe('msg 39');
    });

    it('returns all when under window size', () => {
      const msgs = [
        { role: 'system', content: 's' },
        { role: 'user', content: 'hi' },
      ];
      expect(manager.rollingWindow(msgs as any).length).toBe(2);
    });
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
npx vitest run src/__tests__/chat-manager.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement ChatManager**

Создать `src/chat/manager.ts`:

```typescript
import type { ChatStorage } from './storage.js';
import type {
  ChatSession,
  ChatSessionWithMessages,
  ChatSessionFilters,
  ChatMessage,
  PersistedChatMessage,
  ToolCall,
  ChatRole,
} from './types.js';

const ROLLING_WINDOW_NON_SYSTEM = 30;

export class ChatManager {
  constructor(private storage: ChatStorage) {}

  create(input: {
    agentTokenId: string;
    projectId: string | null;
    title?: string;
  }): Promise<ChatSession> {
    return this.storage.createSession({ ...input, title: input.title });
  }

  list(agentTokenId: string, filters: ChatSessionFilters): Promise<ChatSession[]> {
    return this.storage.listSessions(agentTokenId, filters);
  }

  async loadSessionWithMessages(id: string, agentTokenId: string): Promise<ChatSessionWithMessages | null> {
    const session = await this.storage.getSession(id, agentTokenId);
    if (!session) return null;
    const rawMessages = await this.storage.listMessages(id);
    const messages = this.filterOrphanToolMessages(rawMessages);
    return { ...session, messages };
  }

  rename(id: string, agentTokenId: string, title: string): Promise<void> {
    return this.storage.renameSession(id, agentTokenId, title);
  }

  softDelete(id: string, agentTokenId: string): Promise<void> {
    return this.storage.softDeleteSession(id, agentTokenId);
  }

  appendMessage(sessionId: string, msg: ChatMessage): Promise<PersistedChatMessage> {
    return this.storage.appendMessage(sessionId, msg);
  }

  markOnboarded(id: string): Promise<void> {
    return this.storage.markOnboarded(id);
  }

  updateAutoTitle(id: string, title: string): Promise<void> {
    return this.storage.updateAutoTitle(id, title);
  }

  touch(id: string): Promise<void> {
    return this.storage.touchSession(id);
  }

  /**
   * Keeps system messages + the last N non-system messages.
   * Used to cap LLM context while persisting full history on disk.
   */
  rollingWindow(messages: ChatMessage[]): ChatMessage[] {
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    const tail = nonSystem.slice(-ROLLING_WINDOW_NON_SYSTEM);
    return [...systemMessages, ...tail];
  }

  /**
   * Drops tool messages whose tool_call_id has no matching assistant with that id in preceding messages.
   * Happens when a turn was interrupted mid-execution.
   */
  private filterOrphanToolMessages(messages: PersistedChatMessage[]): PersistedChatMessage[] {
    const knownCallIds = new Set<string>();
    const result: PersistedChatMessage[] = [];
    for (const m of messages) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) knownCallIds.add(tc.id);
      }
      if (m.role === 'tool') {
        if (!m.toolCallId || !knownCallIds.has(m.toolCallId)) continue;
      }
      result.push(m);
    }
    return result;
  }
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
npx vitest run src/__tests__/chat-manager.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/chat/manager.ts src/__tests__/chat-manager.test.ts
git commit -m "feat(chat): add ChatManager with rolling window and orphan filter"
```

---

## Phase 2 — LLM Provider

### Task 6: llm/chat-provider.ts — Interface and shared types

**Files:**
- Create: `src/llm/chat-provider.ts`

- [ ] **Step 1: Write interface**

Создать `src/llm/chat-provider.ts`:

```typescript
import type { ChatMessage, ToolCall } from '../chat/types.js';

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // Gemini-compatible JSON schema subset
}

export type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; usage?: { promptTokens: number; completionTokens: number } }
  | { type: 'error'; code: string; message: string };

export type SseEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; summary?: string; error?: string }
  | { type: 'done' }
  | { type: 'error'; code: string; message: string };

export interface ChatLlmProvider {
  readonly name: string;
  isReady(): boolean;
  stream(
    input: { messages: ChatMessage[]; tools?: ToolDeclaration[]; systemInstruction?: string },
    signal?: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
  /** Non-streaming one-shot. Used for title generation. */
  generate(
    input: { prompt: string; maxTokens?: number; temperature?: number },
    signal?: AbortSignal,
  ): Promise<string>;
  close(): Promise<void>;
}
```

- [ ] **Step 2: Verify TS compiles**

```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/llm/chat-provider.ts
git commit -m "feat(llm): add ChatLlmProvider interface and event types"
```

---

### Task 7: llm/gemini.ts — GeminiChatProvider (generate() only)

**Files:**
- Create: `src/llm/gemini.ts`
- Test: `src/__tests__/gemini-provider.test.ts`

- [ ] **Step 1: Write failing test for generate()**

Создать `src/__tests__/gemini-provider.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiChatProvider } from '../llm/gemini.js';

describe('GeminiChatProvider.generate', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('calls generateContent endpoint and returns text', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      }),
    });

    const provider = new GeminiChatProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    const result = await provider.generate({ prompt: 'Hi', maxTokens: 50 });

    expect(result).toBe('Hello');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('gemini-2.5-flash:generateContent');
    expect(url).toContain('key=k');
    const body = JSON.parse((init as any).body);
    expect(body.contents[0].parts[0].text).toBe('Hi');
    expect(body.generationConfig.maxOutputTokens).toBe(50);
  });

  it('throws api_key_invalid on 401', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' });
    const provider = new GeminiChatProvider({ apiKey: 'bad', model: 'gemini-2.5-flash' });
    await expect(provider.generate({ prompt: 'x' })).rejects.toThrow(/api_key_invalid/);
  });

  it('throws rate_limited on 429', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => 'Quota exceeded' });
    const provider = new GeminiChatProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    await expect(provider.generate({ prompt: 'x' })).rejects.toThrow(/rate_limited/);
  });

  it('throws upstream_error on 500', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'oops' });
    const provider = new GeminiChatProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    await expect(provider.generate({ prompt: 'x' })).rejects.toThrow(/upstream_error/);
  });
});

describe('GeminiChatProvider lifecycle', () => {
  it('isReady returns true when apiKey set', () => {
    const provider = new GeminiChatProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    expect(provider.isReady()).toBe(true);
    expect(provider.name).toBe('gemini-2.5-flash');
  });

  it('isReady returns false when apiKey missing', () => {
    const provider = new GeminiChatProvider({ apiKey: '', model: 'gemini-2.5-flash' });
    expect(provider.isReady()).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
npx vitest run src/__tests__/gemini-provider.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement GeminiChatProvider (generate only, no streaming yet)**

Создать `src/llm/gemini.ts`:

```typescript
import type { ChatLlmProvider, ProviderEvent, ToolDeclaration } from './chat-provider.js';
import type { ChatMessage } from '../chat/types.js';
import logger from '../logger.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 60_000;

export class GeminiChatProvider implements ChatLlmProvider {
  readonly name: string;
  private apiKey: string;
  private model: string;

  constructor(opts: { apiKey: string; model: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.name = opts.model;
  }

  isReady(): boolean {
    return this.apiKey.length > 0;
  }

  async generate(
    input: { prompt: string; maxTokens?: number; temperature?: number },
    signal?: AbortSignal,
  ): Promise<string> {
    const url = `${API_BASE}/${this.model}:generateContent?key=${this.apiKey}`;
    const body = {
      contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
      generationConfig: {
        maxOutputTokens: input.maxTokens ?? 200,
        temperature: input.temperature ?? 0.3,
      },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.warn({ status: res.status, model: this.model }, 'Gemini generate failed');
      throw new Error(`${this.classifyHttpError(res.status)}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json() as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return text.trim();
  }

  // stream() is implemented in Task 8
  async *stream(): AsyncIterable<ProviderEvent> {
    throw new Error('stream() not yet implemented');
  }

  async close(): Promise<void> {
    // no-op
  }

  private classifyHttpError(status: number): string {
    if (status === 401 || status === 403) return 'api_key_invalid';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'upstream_error';
    return 'upstream_error';
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/__tests__/gemini-provider.test.ts
```

Expected: PASS — 6 tests (generate + lifecycle).

- [ ] **Step 5: Commit**

```bash
git add src/llm/gemini.ts src/__tests__/gemini-provider.test.ts
git commit -m "feat(llm): GeminiChatProvider.generate for non-streaming calls"
```

---

### Task 8: Gemini SSE streaming parser

**Files:**
- Modify: `src/llm/gemini.ts`
- Test: `src/__tests__/gemini-provider.test.ts` (добавить)

- [ ] **Step 1: Write failing test for stream()**

Добавить в `src/__tests__/gemini-provider.test.ts`:

```typescript
describe('GeminiChatProvider.stream', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function mockSseResponse(chunks: string[]) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return { ok: true, status: 200, body: stream } as any;
  }

  it('parses text deltas from SSE stream', async () => {
    const chunks = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n',
      'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\n\n',
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(mockSseResponse(chunks)) as any;

    const provider = new GeminiChatProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    const events: any[] = [];
    for await (const ev of provider.stream({ messages: [{ role: 'user', content: 'Hi' }] })) {
      events.push(ev);
    }
    expect(events.filter(e => e.type === 'text').map(e => e.delta).join('')).toBe('Hello');
    expect(events[events.length - 1].type).toBe('done');
  });

  it('parses functionCall events', async () => {
    const chunks = [
      `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"memory_read","args":{"search":"foo"}}}]}}]}\n\n`,
      `data: {"candidates":[{"finishReason":"STOP"}]}\n\n`,
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(mockSseResponse(chunks)) as any;

    const provider = new GeminiChatProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    const events: any[] = [];
    for await (const ev of provider.stream({ messages: [{ role: 'user', content: 'Find foo' }] })) {
      events.push(ev);
    }
    const toolCall = events.find(e => e.type === 'tool_call');
    expect(toolCall).toBeDefined();
    expect(toolCall.call.name).toBe('memory_read');
    expect(toolCall.call.args).toEqual({ search: 'foo' });
    expect(typeof toolCall.call.id).toBe('string');
  });

  it('emits safety_block when finishReason is SAFETY', async () => {
    const chunks = [`data: {"candidates":[{"finishReason":"SAFETY"}]}\n\n`];
    globalThis.fetch = vi.fn().mockResolvedValue(mockSseResponse(chunks)) as any;
    const provider = new GeminiChatProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });
    const events: any[] = [];
    for await (const ev of provider.stream({ messages: [{ role: 'user', content: 'x' }] })) events.push(ev);
    expect(events.some(e => e.type === 'error' && e.code === 'safety_block')).toBe(true);
  });

  it('converts role=tool into functionResponse in request body', async () => {
    const chunks = [`data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}, "finishReason":"STOP"}]}\n\n`];
    const fetchMock = vi.fn().mockResolvedValue(mockSseResponse(chunks));
    globalThis.fetch = fetchMock as any;
    const provider = new GeminiChatProvider({ apiKey: 'k', model: 'gemini-2.5-flash' });

    for await (const _ of provider.stream({
      messages: [
        { role: 'user', content: 'Find' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'memory_read', args: {} }] },
        { role: 'tool', content: '[]', toolCallId: 'c1', toolName: 'memory_read' },
      ],
    })) { /* consume */ }

    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    const lastContent = body.contents[body.contents.length - 1];
    expect(lastContent.role).toBe('user');
    expect(lastContent.parts[0].functionResponse.name).toBe('memory_read');
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
npx vitest run src/__tests__/gemini-provider.test.ts
```

Expected: FAIL — stream() throws "not yet implemented".

- [ ] **Step 3: Implement stream() in src/llm/gemini.ts**

Заменить существующий `stream()` и добавить приватные хелперы:

```typescript
  async *stream(
    input: { messages: ChatMessage[]; tools?: ToolDeclaration[]; systemInstruction?: string },
    signal?: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    const url = `${API_BASE}/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    const body: Record<string, unknown> = {
      contents: this.messagesToContents(input.messages),
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
    };
    if (input.systemInstruction) {
      body.systemInstruction = { parts: [{ text: input.systemInstruction }] };
    }
    if (input.tools && input.tools.length > 0) {
      body.tools = [{ functionDeclarations: input.tools }];
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (err: any) {
      yield { type: 'error', code: 'upstream_error', message: err?.message ?? 'Network error' };
      return;
    }

    if (!res.ok) {
      const errText = await res.text();
      const code = this.classifyHttpError(res.status);
      logger.warn({ status: res.status, model: this.model }, 'Gemini stream failed');
      yield { type: 'error', code, message: errText.slice(0, 200) };
      return;
    }

    if (!res.body) {
      yield { type: 'error', code: 'upstream_error', message: 'No response body' };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let usage: { promptTokens: number; completionTokens: number } | undefined;
    let emittedDone = false;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = event.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          const payload = line.slice(6).trim();
          if (!payload || payload === '[DONE]') continue;

          let parsed: any;
          try { parsed = JSON.parse(payload); } catch { continue; }

          const candidate = parsed.candidates?.[0];
          if (!candidate) continue;

          const finishReason = candidate.finishReason;
          if (finishReason === 'SAFETY') {
            yield { type: 'error', code: 'safety_block', message: 'Response blocked by safety filters' };
            emittedDone = true;
            break;
          }

          for (const part of candidate.content?.parts ?? []) {
            if (typeof part.text === 'string' && part.text.length > 0) {
              yield { type: 'text', delta: part.text };
            }
            if (part.functionCall) {
              yield {
                type: 'tool_call',
                call: {
                  id: this.makeCallId(),
                  name: part.functionCall.name,
                  args: part.functionCall.args ?? {},
                },
              };
            }
          }

          if (parsed.usageMetadata) {
            usage = {
              promptTokens: parsed.usageMetadata.promptTokenCount ?? 0,
              completionTokens: parsed.usageMetadata.candidatesTokenCount ?? 0,
            };
          }

          if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
            // Other terminal reasons: RECITATION, OTHER — treat as done (no error)
          }
        }
      }
    } catch (err: any) {
      yield { type: 'error', code: 'upstream_error', message: err?.message ?? 'Stream error' };
      return;
    }

    if (!emittedDone) yield { type: 'done', usage };
  }

  private messagesToContents(messages: ChatMessage[]): any[] {
    return messages
      .filter(m => m.role !== 'system')  // systemInstruction handled separately
      .map(m => {
        if (m.role === 'user') {
          return { role: 'user', parts: [{ text: m.content }] };
        }
        if (m.role === 'assistant') {
          const parts: any[] = [];
          if (m.content) parts.push({ text: m.content });
          for (const tc of m.toolCalls ?? []) {
            parts.push({ functionCall: { name: tc.name, args: tc.args } });
          }
          return { role: 'model', parts };
        }
        // tool
        return {
          role: 'user',
          parts: [{
            functionResponse: {
              name: m.toolName ?? 'unknown',
              response: this.parseToolResult(m.content),
            },
          }],
        };
      });
  }

  private parseToolResult(content: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(content);
      return typeof parsed === 'object' && parsed !== null ? parsed : { result: parsed };
    } catch {
      return { result: content };
    }
  }

  private makeCallId(): string {
    return 'call_' + Math.random().toString(36).slice(2, 12);
  }
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/__tests__/gemini-provider.test.ts
```

Expected: PASS — 10 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/llm/gemini.ts src/__tests__/gemini-provider.test.ts
git commit -m "feat(llm): GeminiChatProvider SSE streaming with function calling"
```

---

## Phase 3 — RAG layer

### Task 9: rag/tool-registry.ts — 12 tool declarations + handlers

**Files:**
- Create: `src/rag/tool-registry.ts`
- Test: `src/__tests__/tool-registry.test.ts`

- [ ] **Step 1: Write failing test**

Создать `src/__tests__/tool-registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TOOL_DECLARATIONS, TOOL_HANDLERS, getDeclaration } from '../rag/tool-registry.js';

describe('tool-registry', () => {
  const expectedTools = [
    'memory_onboard', 'memory_read', 'memory_cross_search', 'memory_sync',
    'memory_audit', 'memory_history',
    'note_read', 'note_search',
    'session_list', 'session_search', 'session_message_search', 'session_read',
  ];

  it('exports exactly 12 tool declarations', () => {
    expect(TOOL_DECLARATIONS.length).toBe(12);
    expect(TOOL_DECLARATIONS.map(d => d.name).sort()).toEqual([...expectedTools].sort());
  });

  it('every declaration has name, description, parameters object', () => {
    for (const d of TOOL_DECLARATIONS) {
      expect(typeof d.name).toBe('string');
      expect(typeof d.description).toBe('string');
      expect(d.description.length).toBeGreaterThan(10);
      expect(d.parameters.type).toBe('object');
      expect(d.parameters.properties).toBeDefined();
    }
  });

  it('NO declaration exposes project_id parameter (adapter enforces it)', () => {
    for (const d of TOOL_DECLARATIONS) {
      const props = (d.parameters as any).properties ?? {};
      expect(props.project_id, `tool ${d.name} must not declare project_id`).toBeUndefined();
      expect(props.exclude_project_id, `tool ${d.name} must not declare exclude_project_id`).toBeUndefined();
    }
  });

  it('every declaration has a handler', () => {
    for (const d of TOOL_DECLARATIONS) {
      expect(TOOL_HANDLERS[d.name]).toBeTypeOf('function');
    }
  });

  it('getDeclaration returns undefined for unknown', () => {
    expect(getDeclaration('nonexistent')).toBeUndefined();
    expect(getDeclaration('memory_read')?.name).toBe('memory_read');
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
npx vitest run src/__tests__/tool-registry.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement tool-registry**

Создать `src/rag/tool-registry.ts`:

```typescript
import type { ToolDeclaration } from '../llm/chat-provider.js';
import type { MemoryManager } from '../memory/manager.js';
import type { NotesManager } from '../notes/manager.js';
import type { SessionManager } from '../sessions/manager.js';

export interface ToolHandlerContext {
  memoryManager: MemoryManager;
  notesManager: NotesManager;
  sessionManager: SessionManager;
  agentTokenId: string;
  projectId: string;  // always enforced — never from LLM args
}

export type ToolHandler = (
  args: Record<string, any>,
  ctx: ToolHandlerContext,
) => Promise<unknown>;

export const TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: 'memory_onboard',
    description: 'Получить сводку проекта: конвенции, архитектура, ключевые решения, активные задачи и проблемы.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'memory_read',
    description: 'Читает командную память проекта. Используй search для ключевых слов, category для фильтра по типу. По умолчанию возвращает компактный список; для полного содержимого передавай ids=[...].',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['architecture', 'tasks', 'decisions', 'issues', 'progress', 'conventions', 'all'] },
        domain: { type: 'string', description: 'Домен: backend, frontend, infrastructure и т.д.' },
        search: { type: 'string', description: 'Ключевые слова для поиска' },
        tags: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['active', 'completed', 'archived'] },
        ids: { type: 'array', items: { type: 'string' }, description: 'UUID записей для получения полного содержимого' },
        limit: { type: 'number' },
        mode: { type: 'string', enum: ['compact', 'full'] },
      },
    },
  },
  {
    name: 'memory_cross_search',
    description: 'Ищет паттерны в памяти ДРУГИХ проектов (текущий проект автоматически исключён). Используй для поиска best practices.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поисковый запрос' },
        category: { type: 'string', enum: ['architecture', 'tasks', 'decisions', 'issues', 'progress', 'conventions', 'all'] },
        domain: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_sync',
    description: 'Возвращает свежие изменения в памяти проекта за указанное время.',
    parameters: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO 8601 timestamp начала периода' },
      },
    },
  },
  {
    name: 'memory_audit',
    description: 'История изменений записи или проекта (аудит-лог).',
    parameters: {
      type: 'object',
      properties: {
        entry_id: { type: 'string', description: 'UUID записи' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'memory_history',
    description: 'Версии конкретной записи памяти.',
    parameters: {
      type: 'object',
      properties: {
        entry_id: { type: 'string' },
        version: { type: 'number' },
      },
      required: ['entry_id'],
    },
  },
  {
    name: 'note_read',
    description: 'Читает личные заметки пользователя.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: ['active', 'archived'] },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'note_search',
    description: 'Семантический поиск по личным заметкам пользователя.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'session_list',
    description: 'Список прошлых сессий работы (разговоров) с LLM по проекту.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        date_from: { type: 'string', description: 'ISO 8601' },
        date_to: { type: 'string', description: 'ISO 8601' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'session_search',
    description: 'Семантический поиск по summary сессий.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'session_message_search',
    description: 'Поиск по конкретным сообщениям в сессиях (внутри содержимого).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        session_id: { type: 'string', description: 'UUID конкретной сессии (опционально)' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'session_read',
    description: 'Читает сессию с сообщениями. Поддерживает пагинацию.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        message_from: { type: 'number' },
        message_to: { type: 'number' },
      },
      required: ['session_id'],
    },
  },
];

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  memory_onboard: async (_args, ctx) =>
    ctx.memoryManager.generateOnboarding(ctx.projectId),

  memory_read: async (args, ctx) =>
    ctx.memoryManager.read({ ...args, project_id: ctx.projectId } as any),

  memory_cross_search: async (args, ctx) =>
    ctx.memoryManager.crossSearch(args.query, {
      category: args.category,
      domain: args.domain,
      excludeProjectId: ctx.projectId,
      limit: args.limit,
    }),

  memory_sync: async (args, ctx) =>
    ctx.memoryManager.sync({ project_id: ctx.projectId, since: args.since } as any),

  memory_audit: async (args, ctx) => {
    const mgr = ctx.memoryManager as any;
    return mgr.audit
      ? mgr.audit({ entry_id: args.entry_id, project_id: ctx.projectId, limit: args.limit })
      : { error: 'audit not available' };
  },

  memory_history: async (args, ctx) => {
    const mgr = ctx.memoryManager as any;
    return mgr.history
      ? mgr.history(args.entry_id, args.version)
      : { error: 'history not available' };
  },

  note_read: async (args, ctx) =>
    ctx.notesManager.read(ctx.agentTokenId, {
      search: args.search,
      tags: args.tags,
      status: args.status,
      projectId: ctx.projectId,
      limit: args.limit,
    } as any),

  note_search: async (args, ctx) =>
    ctx.notesManager.semanticSearch(ctx.agentTokenId, args.query, {
      projectId: ctx.projectId,
      limit: args.limit,
    }),

  session_list: async (args, ctx) =>
    ctx.sessionManager.listSessions(ctx.agentTokenId, {
      search: args.search,
      tags: args.tags,
      dateFrom: args.date_from,
      dateTo: args.date_to,
      projectId: ctx.projectId,
      limit: args.limit ?? 20,
      offset: 0,
    } as any),

  session_search: async (args, ctx) =>
    ctx.sessionManager.searchSessions(ctx.agentTokenId, args.query, {
      projectId: ctx.projectId,
      limit: args.limit,
    }),

  session_message_search: async (args, ctx) => {
    if (args.session_id) {
      return ctx.sessionManager.searchMessagesInSession(args.session_id, ctx.agentTokenId, args.query, args.limit ?? 20);
    }
    return ctx.sessionManager.searchMessages(ctx.agentTokenId, args.query, { limit: args.limit });
  },

  session_read: async (args, ctx) =>
    ctx.sessionManager.readSession(args.session_id, ctx.agentTokenId, args.message_from, args.message_to),
};

export function getDeclaration(name: string): ToolDeclaration | undefined {
  return TOOL_DECLARATIONS.find(d => d.name === name);
}
```

**Примечание для реализатора:** сигнатуры менеджеров могут отличаться — сверься с [src/memory/manager.ts](../../src/memory/manager.ts), [src/notes/manager.ts](../../src/notes/manager.ts), [src/sessions/manager.ts](../../src/sessions/manager.ts) и адаптируй вызовы handler'ов. Если метод `memoryManager.audit`/`history` отсутствует — используй `_audit`/`_history` через приватное поле или пропусти тот тул и убери декларацию (оставь 10 тулов вместо 12). Обнови тест соответственно.

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/__tests__/tool-registry.test.ts
```

Expected: PASS — 5 tests. TS-ошибки в handler'ах допустимо временно обойти через `as any`, затем уточнить в Task 10.

- [ ] **Step 5: Commit**

```bash
git add src/rag/tool-registry.ts src/__tests__/tool-registry.test.ts
git commit -m "feat(rag): tool-registry with 12 read-only tool declarations"
```

---

### Task 10: rag/tool-adapter.ts — Routing + project_id enforcement

**Files:**
- Create: `src/rag/tool-adapter.ts`
- Test: `src/__tests__/tool-adapter.test.ts`

- [ ] **Step 1: Write failing test**

Создать `src/__tests__/tool-adapter.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpToolAdapter } from '../rag/tool-adapter.js';

function makeManagers() {
  return {
    memoryManager: {
      generateOnboarding: vi.fn().mockResolvedValue('# Onboarding'),
      read: vi.fn().mockResolvedValue([]),
      crossSearch: vi.fn().mockResolvedValue([]),
      sync: vi.fn().mockResolvedValue({ changes: [] }),
    },
    notesManager: {
      read: vi.fn().mockResolvedValue([]),
      semanticSearch: vi.fn().mockResolvedValue([]),
    },
    sessionManager: {
      listSessions: vi.fn().mockResolvedValue([]),
      searchSessions: vi.fn().mockResolvedValue([]),
      searchMessages: vi.fn().mockResolvedValue([]),
      readSession: vi.fn().mockResolvedValue({}),
    },
  } as any;
}

describe('McpToolAdapter', () => {
  let managers: any;
  let adapter: McpToolAdapter;

  beforeEach(() => {
    managers = makeManagers();
    adapter = new McpToolAdapter(managers, { agentTokenId: 'tok-1', projectId: 'proj-1', toolResponseMaxChars: 5000 });
  });

  it('forces project_id from session, ignoring LLM-provided value', async () => {
    await adapter.call('memory_read', { search: 'x', project_id: 'EVIL-OTHER-PROJECT' });
    const [firstCallArgs] = managers.memoryManager.read.mock.calls[0];
    expect(firstCallArgs.project_id).toBe('proj-1');
  });

  it('forces exclude_project_id=session for memory_cross_search', async () => {
    await adapter.call('memory_cross_search', { query: 'foo' });
    const [, filters] = managers.memoryManager.crossSearch.mock.calls[0];
    expect(filters.excludeProjectId).toBe('proj-1');
  });

  it('throws unknown_tool for unknown name', async () => {
    await expect(adapter.call('bogus', {})).rejects.toThrow(/unknown_tool/);
  });

  it('truncates tool response to toolResponseMaxChars', async () => {
    const longArray = Array.from({ length: 100 }, (_, i) => ({ id: i, text: 'x'.repeat(100) }));
    managers.memoryManager.read.mockResolvedValue(longArray);
    const result = await adapter.callAsSerializedString('memory_read', {});
    expect(result.length).toBeLessThanOrEqual(5000 + 50);  // 50 chars slack for truncation marker
    expect(result).toContain('[truncated]');
  });

  it('returns declarations from registry', () => {
    const decls = adapter.declarations;
    expect(decls.length).toBe(12);
    expect(decls.every(d => !('project_id' in (d.parameters as any).properties))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
npx vitest run src/__tests__/tool-adapter.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement McpToolAdapter**

Создать `src/rag/tool-adapter.ts`:

```typescript
import type { ToolDeclaration } from '../llm/chat-provider.js';
import { TOOL_DECLARATIONS, TOOL_HANDLERS, type ToolHandlerContext } from './tool-registry.js';
import logger from '../logger.js';

export class ToolError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface ToolAdapterOptions {
  agentTokenId: string;
  projectId: string;
  toolResponseMaxChars: number;
}

export class McpToolAdapter {
  readonly declarations: ToolDeclaration[] = TOOL_DECLARATIONS;

  constructor(
    private managers: Omit<ToolHandlerContext, 'agentTokenId' | 'projectId'>,
    private options: ToolAdapterOptions,
  ) {}

  async call(name: string, llmArgs: Record<string, unknown>): Promise<unknown> {
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      throw new ToolError('unknown_tool', `Unknown tool: ${name}`);
    }
    const ctx: ToolHandlerContext = {
      ...this.managers,
      agentTokenId: this.options.agentTokenId,
      projectId: this.options.projectId,
    };
    const start = Date.now();
    try {
      const result = await handler(llmArgs, ctx);
      logger.info({
        tool: name,
        durationMs: Date.now() - start,
        ok: true,
      }, 'Tool call succeeded');
      return result;
    } catch (err: any) {
      logger.error({ tool: name, err: err?.message }, 'Tool call failed');
      throw new ToolError('tool_failure', err?.message ?? 'Tool execution error');
    }
  }

  async callAsSerializedString(name: string, llmArgs: Record<string, unknown>): Promise<string> {
    const result = await this.call(name, llmArgs);
    const serialized = JSON.stringify(result);
    const max = this.options.toolResponseMaxChars;
    if (serialized.length <= max) return serialized;
    return serialized.slice(0, max) + '...[truncated]';
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/__tests__/tool-adapter.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/rag/tool-adapter.ts src/__tests__/tool-adapter.test.ts
git commit -m "feat(rag): McpToolAdapter with project_id enforcement and truncation"
```

---

### Task 11: rag/agent.ts — RagAgent orchestrator

**Files:**
- Create: `src/rag/agent.ts`
- Test: `src/__tests__/rag-agent.test.ts`

- [ ] **Step 1: Write failing test (onboard + simple text)**

Создать `src/__tests__/rag-agent.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RagAgent } from '../rag/agent.js';

function makeProvider(eventsByCall: any[][]) {
  let callIdx = 0;
  return {
    name: 'mock',
    isReady: () => true,
    async *stream(_input: any) {
      const events = eventsByCall[callIdx++] ?? [];
      for (const e of events) yield e;
    },
    generate: vi.fn(),
    close: vi.fn(),
  } as any;
}

function makeAdapter(toolResults: Record<string, unknown>) {
  return {
    declarations: [
      { name: 'memory_read', description: 'test', parameters: { type: 'object', properties: {} } },
      { name: 'memory_onboard', description: 'test', parameters: { type: 'object', properties: {} } },
    ],
    call: vi.fn().mockImplementation(async (name: string) => toolResults[name] ?? { ok: true }),
    callAsSerializedString: vi.fn().mockImplementation(async (name: string) => JSON.stringify(toolResults[name] ?? {})),
  } as any;
}

function makeChatManager() {
  return {
    appendMessage: vi.fn().mockResolvedValue({ id: 1 }),
    markOnboarded: vi.fn(),
    touch: vi.fn(),
    rollingWindow: (msgs: any[]) => msgs,
  } as any;
}

describe('RagAgent', () => {
  it('injects onboard into system on first run then marks onboard_injected', async () => {
    const provider = makeProvider([
      [{ type: 'text', delta: 'Hi' }, { type: 'done' }],
    ]);
    const adapter = makeAdapter({ memory_onboard: '# Context' });
    const chatManager = makeChatManager();
    const agent = new RagAgent({ provider, adapter, chatManager, maxIterations: 5 });

    const session = {
      id: 'sess-1', agentTokenId: 'tok', projectId: 'proj', title: 't',
      titleIsUserSet: false, onboardInjected: false,
      createdAt: '', updatedAt: '', archivedAt: null,
      messages: [],
    };

    const events: any[] = [];
    for await (const ev of agent.run(session as any, 'Hi')) events.push(ev);

    expect(adapter.call).toHaveBeenCalledWith('memory_onboard', expect.any(Object));
    expect(chatManager.markOnboarded).toHaveBeenCalledWith('sess-1');
    expect(events.map(e => e.type)).toEqual(['text', 'done']);
  });

  it('skips onboard when session.onboardInjected=true', async () => {
    const provider = makeProvider([
      [{ type: 'text', delta: 'ok' }, { type: 'done' }],
    ]);
    const adapter = makeAdapter({});
    const chatManager = makeChatManager();
    const agent = new RagAgent({ provider, adapter, chatManager, maxIterations: 5 });

    const session = {
      id: 'sess-1', agentTokenId: 'tok', projectId: 'proj', title: 't',
      titleIsUserSet: false, onboardInjected: true,
      createdAt: '', updatedAt: '', archivedAt: null,
      messages: [{ role: 'system', content: 'already-onboarded' }],
    };

    for await (const _ of agent.run(session as any, 'Hi')) { /* drain */ }
    expect(adapter.call).not.toHaveBeenCalledWith('memory_onboard', expect.anything());
  });

  it('executes tool calls and loops back to model', async () => {
    const provider = makeProvider([
      [{ type: 'tool_call', call: { id: 'c1', name: 'memory_read', args: { search: 'foo' } } }, { type: 'done' }],
      [{ type: 'text', delta: 'Found 1 record' }, { type: 'done' }],
    ]);
    const adapter = makeAdapter({ memory_read: [{ id: 'e1', title: 'Foo' }] });
    const chatManager = makeChatManager();
    const agent = new RagAgent({ provider, adapter, chatManager, maxIterations: 5 });

    const session = {
      id: 'sess-1', agentTokenId: 'tok', projectId: 'proj', title: 't',
      titleIsUserSet: false, onboardInjected: true,
      createdAt: '', updatedAt: '', archivedAt: null,
      messages: [{ role: 'system', content: 'sys' }],
    };
    const events: any[] = [];
    for await (const ev of agent.run(session as any, 'Find foo')) events.push(ev);
    expect(events.map(e => e.type)).toEqual(['tool_start', 'tool_end', 'text', 'done']);
    expect((events[0] as any).name).toBe('memory_read');
  });

  it('emits max_iterations error when exceeding limit', async () => {
    const loopingEvents = Array.from({ length: 10 }, () => [
      { type: 'tool_call', call: { id: 'c', name: 'memory_read', args: {} } },
      { type: 'done' },
    ]);
    const provider = makeProvider(loopingEvents);
    const adapter = makeAdapter({ memory_read: [] });
    const chatManager = makeChatManager();
    const agent = new RagAgent({ provider, adapter, chatManager, maxIterations: 3 });

    const session = {
      id: 'sess-1', agentTokenId: 'tok', projectId: 'proj', title: 't',
      titleIsUserSet: false, onboardInjected: true,
      createdAt: '', updatedAt: '', archivedAt: null,
      messages: [{ role: 'system', content: 'sys' }],
    };
    const events: any[] = [];
    for await (const ev of agent.run(session as any, 'Find')) events.push(ev);
    const last = events[events.length - 1];
    expect(last.type).toBe('error');
    expect((last as any).code).toBe('max_iterations');
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
npx vitest run src/__tests__/rag-agent.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement RagAgent**

Создать `src/rag/agent.ts`:

```typescript
import type { ChatLlmProvider, SseEvent } from '../llm/chat-provider.js';
import type { McpToolAdapter } from './tool-adapter.js';
import type { ChatManager } from '../chat/manager.js';
import type { ChatSessionWithMessages, ChatMessage, ToolCall } from '../chat/types.js';
import { ToolError } from './tool-adapter.js';
import logger from '../logger.js';

const SYSTEM_PROMPT = `Ты — RAG-ассистент проекта Team Memory. У тебя есть инструменты для чтения памяти текущего проекта: решений, задач, проблем, архитектуры, заметок, сессий.

Правила:
1. ПЕРЕД ответом ВСЕГДА проверь память — вызывай инструменты вместо того чтобы угадывать или полагаться на общие знания.
2. Цитируй источник: упоминай ID записи/сессии или её заголовок, когда ссылаешься.
3. Если поиск не дал результата — скажи об этом прямо, не выдумывай.
4. Отвечай на языке пользователя.
5. Краткость — до 300 слов, если не просят развёрнуто.`;

const ONBOARD_MAX_CHARS = 8_000;

export interface RagAgentConfig {
  provider: ChatLlmProvider;
  adapter: McpToolAdapter;
  chatManager: ChatManager;
  maxIterations: number;
}

export class RagAgent {
  constructor(private cfg: RagAgentConfig) {}

  async *run(
    session: ChatSessionWithMessages,
    userMessage: string,
    signal?: AbortSignal,
  ): AsyncIterable<SseEvent> {
    const { provider, adapter, chatManager, maxIterations } = this.cfg;

    // 1. Onboard (один раз за жизнь чат-сессии)
    let systemPrompt = SYSTEM_PROMPT;
    if (!session.onboardInjected) {
      try {
        const onboard = await adapter.call('memory_onboard', {}) as string;
        const truncated = typeof onboard === 'string' ? onboard.slice(0, ONBOARD_MAX_CHARS) : '';
        systemPrompt += '\n\nКонтекст проекта:\n' + truncated;
        const sysMsg: ChatMessage = { role: 'system', content: systemPrompt };
        await chatManager.appendMessage(session.id, sysMsg);
        await chatManager.markOnboarded(session.id);
        session.messages.unshift(sysMsg as any);
        session.onboardInjected = true;
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'Onboard failed; continuing without project context');
      }
    } else {
      // системный промпт уже в session.messages (первый system-msg)
      const existingSystem = session.messages.find(m => m.role === 'system');
      if (existingSystem) systemPrompt = existingSystem.content;
    }

    // 2. User message
    const userMsg: ChatMessage = { role: 'user', content: userMessage };
    await chatManager.appendMessage(session.id, userMsg);
    session.messages.push(userMsg as any);
    await chatManager.touch(session.id);

    // 3. Agent loop
    for (let iter = 0; iter < maxIterations; iter++) {
      const windowMessages = chatManager.rollingWindow(session.messages as ChatMessage[]);
      const stream = provider.stream({
        messages: windowMessages,
        tools: adapter.declarations,
        systemInstruction: systemPrompt,
      }, signal);

      const pendingCalls: ToolCall[] = [];
      let assistantText = '';
      let providerError: { code: string; message: string } | null = null;

      for await (const ev of stream) {
        if (ev.type === 'text') {
          assistantText += ev.delta;
          yield ev;
        } else if (ev.type === 'tool_call') {
          pendingCalls.push(ev.call);
        } else if (ev.type === 'error') {
          providerError = { code: ev.code, message: ev.message };
          break;
        } else if (ev.type === 'done') {
          break;
        }
      }

      if (providerError) {
        yield { type: 'error', code: providerError.code, message: providerError.message };
        return;
      }

      if (pendingCalls.length > 0) {
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: assistantText,
          toolCalls: pendingCalls,
        };
        await chatManager.appendMessage(session.id, assistantMsg);
        session.messages.push(assistantMsg as any);

        for (const call of pendingCalls) {
          yield { type: 'tool_start', id: call.id, name: call.name, args: call.args };
          try {
            const serialized = await adapter.callAsSerializedString(call.name, call.args);
            const toolMsg: ChatMessage = {
              role: 'tool',
              content: serialized,
              toolCallId: call.id,
              toolName: call.name,
            };
            await chatManager.appendMessage(session.id, toolMsg);
            session.messages.push(toolMsg as any);
            yield {
              type: 'tool_end',
              id: call.id,
              name: call.name,
              ok: true,
              summary: this.summarizeForUi(call.name, serialized),
            };
          } catch (err: any) {
            const errPayload = err instanceof ToolError
              ? { error: err.message, code: err.code }
              : { error: String(err?.message ?? err) };
            const toolMsg: ChatMessage = {
              role: 'tool',
              content: JSON.stringify(errPayload),
              toolCallId: call.id,
              toolName: call.name,
            };
            await chatManager.appendMessage(session.id, toolMsg);
            session.messages.push(toolMsg as any);
            yield {
              type: 'tool_end',
              id: call.id,
              name: call.name,
              ok: false,
              error: err?.message ?? String(err),
            };
          }
        }
        continue;
      }

      // No tool calls → final answer
      if (assistantText.trim().length > 0) {
        const finalMsg: ChatMessage = { role: 'assistant', content: assistantText };
        await chatManager.appendMessage(session.id, finalMsg);
        session.messages.push(finalMsg as any);
      }
      yield { type: 'done' };
      return;
    }

    yield { type: 'error', code: 'max_iterations', message: `Agent exceeded ${maxIterations} iterations` };
  }

  private summarizeForUi(toolName: string, serialized: string): string {
    try {
      const parsed = JSON.parse(serialized);
      if (Array.isArray(parsed)) return `${parsed.length} записей`;
      if (typeof parsed === 'string') return parsed.length > 60 ? parsed.slice(0, 60) + '…' : parsed;
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray((parsed as any).changes)) return `${(parsed as any).changes.length} изменений`;
        const keys = Object.keys(parsed);
        return keys.length > 0 ? `объект (${keys.length} полей)` : 'пусто';
      }
    } catch { /* fallthrough */ }
    return toolName === 'memory_onboard' ? 'контекст загружен' : 'готово';
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/__tests__/rag-agent.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/rag/agent.ts src/__tests__/rag-agent.test.ts
git commit -m "feat(rag): RagAgent with onboard + agent loop + max_iterations"
```

---

### Task 12: rag/title-generator.ts — Auto title after first turn

**Files:**
- Create: `src/rag/title-generator.ts`
- Test: `src/__tests__/title-generator.test.ts`

- [ ] **Step 1: Write failing test**

Создать `src/__tests__/title-generator.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { TitleGenerator } from '../rag/title-generator.js';

describe('TitleGenerator', () => {
  it('calls provider.generate with truncated prompt and updates title', async () => {
    const provider = {
      generate: vi.fn().mockResolvedValue('Обсуждение фичи X'),
      isReady: () => true,
    } as any;
    const chatManager = { updateAutoTitle: vi.fn() } as any;
    const gen = new TitleGenerator(provider, chatManager);

    await gen.generate('sess-1', 'как работает фича X?', 'Вот как работает фича X…');

    expect(provider.generate).toHaveBeenCalled();
    const promptArg = provider.generate.mock.calls[0][0].prompt;
    expect(promptArg).toContain('User: как работает фича X?');
    expect(promptArg).toContain('Assistant: Вот как работает');
    expect(chatManager.updateAutoTitle).toHaveBeenCalledWith('sess-1', 'Обсуждение фичи X');
  });

  it('strips quotes from generated title', async () => {
    const provider = { generate: vi.fn().mockResolvedValue('"Quoted title"'), isReady: () => true } as any;
    const chatManager = { updateAutoTitle: vi.fn() } as any;
    const gen = new TitleGenerator(provider, chatManager);
    await gen.generate('sess-1', 'q', 'a');
    expect(chatManager.updateAutoTitle).toHaveBeenCalledWith('sess-1', 'Quoted title');
  });

  it('swallows errors silently (logs only)', async () => {
    const provider = { generate: vi.fn().mockRejectedValue(new Error('rate_limited')), isReady: () => true } as any;
    const chatManager = { updateAutoTitle: vi.fn() } as any;
    const gen = new TitleGenerator(provider, chatManager);
    await expect(gen.generate('sess-1', 'q', 'a')).resolves.toBeUndefined();
    expect(chatManager.updateAutoTitle).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
npx vitest run src/__tests__/title-generator.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement TitleGenerator**

Создать `src/rag/title-generator.ts`:

```typescript
import type { ChatLlmProvider } from '../llm/chat-provider.js';
import type { ChatManager } from '../chat/manager.js';
import logger from '../logger.js';

const MAX_INPUT_CHARS = 500;

export class TitleGenerator {
  constructor(private provider: ChatLlmProvider, private chatManager: ChatManager) {}

  async generate(sessionId: string, firstUser: string, firstAssistant: string): Promise<void> {
    const user = firstUser.slice(0, MAX_INPUT_CHARS);
    const assistant = firstAssistant.slice(0, MAX_INPUT_CHARS);
    const prompt = `Придумай заголовок 3-6 слов на языке сообщения, без кавычек.
User: ${user}
Assistant: ${assistant}

Title:`;

    try {
      const raw = await this.provider.generate({ prompt, maxTokens: 20, temperature: 0.3 });
      const cleaned = raw.replace(/^["'«»]+|["'«»]+$/g, '').trim().slice(0, 120);
      if (cleaned.length === 0) return;
      await this.chatManager.updateAutoTitle(sessionId, cleaned);
    } catch (err: any) {
      logger.warn({ sessionId, err: err?.message }, 'Title generation failed; leaving default title');
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/__tests__/title-generator.test.ts
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/rag/title-generator.ts src/__tests__/title-generator.test.ts
git commit -m "feat(rag): TitleGenerator for auto chat titles"
```

---

## Phase 4 — HTTP API

### Task 13: REST endpoints for chat sessions CRUD

**Files:**
- Modify: `src/app.ts`
- Test: `src/__tests__/chat-api.test.ts`

- [ ] **Step 1: Write failing test**

Создать `src/__tests__/chat-api.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { registerChatRoutes } from '../app.js';

// The plan assumes registerChatRoutes is exported separately to allow
// testing without spinning up the full app. If implementation inlines them,
// adapt: import the factory that builds the whole app with a mocked ChatManager.

function buildTestApp(chatManager: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).auth = { agentTokenId: 'tok-1' }; next(); });
  registerChatRoutes(app, { chatManager } as any);
  return app;
}

describe('POST /api/chat/sessions', () => {
  it('creates session', async () => {
    const chatManager = { create: vi.fn().mockResolvedValue({ id: 'sess-1', title: 'Новый чат' }) };
    const res = await request(buildTestApp(chatManager)).post('/api/chat/sessions').send({ project_id: 'proj-1' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('sess-1');
    expect(chatManager.create).toHaveBeenCalledWith({ agentTokenId: 'tok-1', projectId: 'proj-1', title: undefined });
  });

  it('allows null project_id', async () => {
    const chatManager = { create: vi.fn().mockResolvedValue({ id: 'sess-2', title: 'Новый чат' }) };
    const res = await request(buildTestApp(chatManager)).post('/api/chat/sessions').send({});
    expect(res.status).toBe(201);
    expect(chatManager.create).toHaveBeenCalledWith({ agentTokenId: 'tok-1', projectId: null, title: undefined });
  });
});

describe('GET /api/chat/sessions', () => {
  it('returns list filtered by project_id', async () => {
    const chatManager = { list: vi.fn().mockResolvedValue([{ id: 'sess-1' }]) };
    const res = await request(buildTestApp(chatManager)).get('/api/chat/sessions?project_id=proj-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'sess-1' }]);
    expect(chatManager.list).toHaveBeenCalledWith('tok-1', expect.objectContaining({ projectId: 'proj-1' }));
  });
});

describe('GET /api/chat/sessions/:id', () => {
  it('returns 404 for nonexistent', async () => {
    const chatManager = { loadSessionWithMessages: vi.fn().mockResolvedValue(null) };
    const res = await request(buildTestApp(chatManager)).get('/api/chat/sessions/missing');
    expect(res.status).toBe(404);
  });

  it('returns session with messages', async () => {
    const chatManager = {
      loadSessionWithMessages: vi.fn().mockResolvedValue({ id: 'sess-1', messages: [{ id: 1, role: 'user', content: 'hi' }] }),
    };
    const res = await request(buildTestApp(chatManager)).get('/api/chat/sessions/sess-1');
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
  });
});

describe('PATCH /api/chat/sessions/:id', () => {
  it('renames session', async () => {
    const chatManager = { rename: vi.fn().mockResolvedValue(undefined) };
    const res = await request(buildTestApp(chatManager)).patch('/api/chat/sessions/sess-1').send({ title: 'New' });
    expect(res.status).toBe(204);
    expect(chatManager.rename).toHaveBeenCalledWith('sess-1', 'tok-1', 'New');
  });

  it('rejects missing title', async () => {
    const chatManager = {} as any;
    const res = await request(buildTestApp(chatManager)).patch('/api/chat/sessions/sess-1').send({});
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/chat/sessions/:id', () => {
  it('soft deletes', async () => {
    const chatManager = { softDelete: vi.fn().mockResolvedValue(undefined) };
    const res = await request(buildTestApp(chatManager)).delete('/api/chat/sessions/sess-1');
    expect(res.status).toBe(204);
    expect(chatManager.softDelete).toHaveBeenCalledWith('sess-1', 'tok-1');
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
npx vitest run src/__tests__/chat-api.test.ts
```

Expected: FAIL — registerChatRoutes not exported.

- [ ] **Step 3: Add registerChatRoutes export to app.ts**

В [src/app.ts](../../src/app.ts) **перед** существующей функцией `buildApp` добавить (или в конец файла, если `buildApp` экспортируется):

```typescript
export interface ChatRouteDeps {
  chatManager: import('./chat/manager.js').ChatManager;
  // later: ragAgent, titleGenerator — for stream endpoint in Task 14
}

export function registerChatRoutes(app: import('express').Express, deps: ChatRouteDeps): void {
  const { chatManager } = deps;

  app.post('/api/chat/sessions', async (req, res) => {
    const agentTokenId = (req as any).auth?.agentTokenId as string | undefined;
    if (!agentTokenId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    try {
      const session = await chatManager.create({
        agentTokenId,
        projectId: req.body?.project_id ?? null,
        title: req.body?.title,
      });
      res.status(201).json(session);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create chat session' });
    }
  });

  app.get('/api/chat/sessions', async (req, res) => {
    const agentTokenId = (req as any).auth?.agentTokenId as string | undefined;
    if (!agentTokenId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    try {
      const sessions = await chatManager.list(agentTokenId, {
        projectId: req.query.project_id as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : 50,
        offset: req.query.offset ? Number(req.query.offset) : 0,
      });
      res.json(sessions);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list chat sessions' });
    }
  });

  app.get('/api/chat/sessions/:id', async (req, res) => {
    const agentTokenId = (req as any).auth?.agentTokenId as string | undefined;
    if (!agentTokenId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const session = await chatManager.loadSessionWithMessages(req.params.id, agentTokenId);
    if (!session) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(session);
  });

  app.patch('/api/chat/sessions/:id', async (req, res) => {
    const agentTokenId = (req as any).auth?.agentTokenId as string | undefined;
    if (!agentTokenId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const title = req.body?.title;
    if (typeof title !== 'string' || title.trim().length === 0) {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    await chatManager.rename(req.params.id, agentTokenId, title.trim().slice(0, 200));
    res.status(204).end();
  });

  app.delete('/api/chat/sessions/:id', async (req, res) => {
    const agentTokenId = (req as any).auth?.agentTokenId as string | undefined;
    if (!agentTokenId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    await chatManager.softDelete(req.params.id, agentTokenId);
    res.status(204).end();
  });
}
```

Также убедиться, что `src/app.ts` экспортирует `registerChatRoutes`. Если `app.ts` использует default export — добавить `export` перед функцией.

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/__tests__/chat-api.test.ts
```

Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/__tests__/chat-api.test.ts
git commit -m "feat(api): chat session CRUD endpoints (create/list/get/rename/delete)"
```

---

### Task 14: /api/chat/stream SSE endpoint

**Files:**
- Modify: `src/app.ts` (расширяем `registerChatRoutes` и `ChatRouteDeps`)
- Test: добавляем в `src/__tests__/chat-api.test.ts`

- [ ] **Step 1: Write failing test**

Добавить в `src/__tests__/chat-api.test.ts`:

```typescript
describe('POST /api/chat/stream', () => {
  function mockRagAgent() {
    return {
      async *run() {
        yield { type: 'text', delta: 'Hello' };
        yield { type: 'done' };
      },
    };
  }

  it('streams SSE events from RagAgent', async () => {
    const chatManager = {
      loadSessionWithMessages: vi.fn().mockResolvedValue({
        id: 'sess-1', agentTokenId: 'tok-1', projectId: 'proj',
        onboardInjected: true, messages: [{ role: 'system', content: 's' }],
      }),
    };
    const ragAgentFactory = vi.fn(() => mockRagAgent());
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).auth = { agentTokenId: 'tok-1' }; next(); });
    registerChatRoutes(app, { chatManager, ragAgentFactory, titleGenerator: null } as any);

    const res = await request(app)
      .post('/api/chat/stream')
      .send({ session_id: 'sess-1', message: 'Hi' })
      .buffer(true)
      .parse((r, cb) => {
        let data = '';
        r.on('data', (c: any) => { data += c.toString(); });
        r.on('end', () => cb(null, data));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: text');
    expect(res.body).toContain('event: done');
    expect(ragAgentFactory).toHaveBeenCalledWith('proj', 'tok-1');
  });

  it('returns 404 when session not found', async () => {
    const chatManager = { loadSessionWithMessages: vi.fn().mockResolvedValue(null) };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).auth = { agentTokenId: 'tok-1' }; next(); });
    registerChatRoutes(app, { chatManager, ragAgentFactory: () => mockRagAgent(), titleGenerator: null } as any);
    const res = await request(app).post('/api/chat/stream').send({ session_id: 'missing', message: 'hi' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when session has no project_id', async () => {
    const chatManager = {
      loadSessionWithMessages: vi.fn().mockResolvedValue({
        id: 'sess-1', projectId: null, messages: [],
      }),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).auth = { agentTokenId: 'tok-1' }; next(); });
    registerChatRoutes(app, { chatManager, ragAgentFactory: () => mockRagAgent(), titleGenerator: null } as any);
    const res = await request(app).post('/api/chat/stream').send({ session_id: 'sess-1', message: 'hi' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when message missing', async () => {
    const chatManager = { loadSessionWithMessages: vi.fn() };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).auth = { agentTokenId: 'tok-1' }; next(); });
    registerChatRoutes(app, { chatManager, ragAgentFactory: () => mockRagAgent(), titleGenerator: null } as any);
    const res = await request(app).post('/api/chat/stream').send({ session_id: 'sess-1' });
    expect(res.status).toBe(400);
  });

  it('returns 503 when ragAgentFactory is null', async () => {
    const chatManager = { loadSessionWithMessages: vi.fn() };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).auth = { agentTokenId: 'tok-1' }; next(); });
    registerChatRoutes(app, { chatManager, ragAgentFactory: null, titleGenerator: null } as any);
    const res = await request(app).post('/api/chat/stream').send({ session_id: 'sess-1', message: 'hi' });
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

```bash
npx vitest run src/__tests__/chat-api.test.ts
```

Expected: FAIL — 3 new tests.

- [ ] **Step 3: Extend ChatRouteDeps + add stream endpoint**

В [src/app.ts](../../src/app.ts) расширить интерфейс и функцию. `ragAgent` создаётся **per-request** (adapter знает projectId, а он разный на каждый чат), поэтому передаём factory:

```typescript
export interface ChatRouteDeps {
  chatManager: import('./chat/manager.js').ChatManager;
  ragAgentFactory: ((projectId: string, agentTokenId: string) => import('./rag/agent.js').RagAgent) | null;
  titleGenerator: import('./rag/title-generator.js').TitleGenerator | null;
  providerModel?: string | null;  // optional: display name for /api/chat/status
}
```

Добавить в `registerChatRoutes` (в конец функции) эндпоинт:

```typescript
  app.post('/api/chat/stream', async (req, res) => {
    const agentTokenId = (req as any).auth?.agentTokenId as string | undefined;
    if (!agentTokenId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const { session_id, message } = req.body ?? {};
    if (typeof session_id !== 'string' || typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ error: 'session_id and message required' });
      return;
    }
    if (message.length > 10_000) {
      res.status(400).json({ error: 'Message too long (max 10,000 chars)' });
      return;
    }

    if (!deps.ragAgentFactory) {
      res.status(503).json({ error: 'RAG agent not configured (check GEMINI_API_KEY)' });
      return;
    }

    const session = await chatManager.loadSessionWithMessages(session_id, agentTokenId);
    if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
    if (!session.projectId) {
      res.status(400).json({ error: 'Session has no project_id; RAG requires project scope' });
      return;
    }

    const ragAgent = deps.ragAgentFactory(session.projectId, agentTokenId);

    // SSE headers
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const keepAlive = setInterval(() => res.write(':\n\n'), 15_000);

    const emit = (type: string, data: unknown) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const isFirstUserMessage = session.messages.filter(m => m.role === 'user').length === 0;
    let firstAssistantReply = '';

    try {
      for await (const ev of ragAgent.run(session as any, message, controller.signal)) {
        if (ev.type === 'text') firstAssistantReply += ev.delta;
        const { type, ...data } = ev as any;
        emit(type, data);
      }
    } catch (err: any) {
      emit('error', { code: 'internal_error', message: err?.message ?? 'Internal error' });
    } finally {
      clearInterval(keepAlive);
      res.end();
    }

    // Fire-and-forget title generation for the first exchange
    if (isFirstUserMessage && firstAssistantReply.length > 0 && deps.titleGenerator) {
      deps.titleGenerator.generate(session_id, message, firstAssistantReply).catch(() => { /* logged inside */ });
    }
  });

  app.get('/api/chat/status', (_req, res) => {
    res.json({
      available: !!deps.ragAgentFactory,
      provider: deps.ragAgentFactory ? 'gemini' : null,
      model: deps.providerModel ?? null,
    });
  });
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/__tests__/chat-api.test.ts
```

Expected: PASS — all 13 tests (8 CRUD from Task 13 + 5 stream from this task).

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/__tests__/chat-api.test.ts
git commit -m "feat(api): /api/chat/stream SSE endpoint + /api/chat/status"
```

---

## Phase 5 — Wiring

### Task 15: Wire RagAgent, ChatManager, GeminiChatProvider in app.ts buildApp

**Files:**
- Modify: `src/app.ts`

- [ ] **Step 1: Remove old /api/chat in-memory logic**

Удалить из [src/app.ts:190-265](../../src/app.ts#L190-L265) весь блок:
- `MAX_CHAT_SESSIONS`, `CHAT_SESSION_TTL_MS`, `ChatMessage`, `chatSessions: Map`
- `evictStaleSessions()`
- `app.post('/api/chat', ...)`, `app.get('/api/chat/status', ...)`, `app.delete('/api/chat', ...)`

Удалить конструкцию `llmClient` для чата (строки примерно 175-181), ОСТАВИТЬ её только для `SessionManager`. Если `SessionManager` требует `llmClient`, переместить initialization выше и оставить инстанс.

- [ ] **Step 2: Import new modules**

В верхней части `src/app.ts`:

```typescript
import { ChatStorage } from './chat/storage.js';
import { ChatManager } from './chat/manager.js';
import { GeminiChatProvider } from './llm/gemini.js';
import { McpToolAdapter } from './rag/tool-adapter.js';
import { RagAgent } from './rag/agent.js';
import { TitleGenerator } from './rag/title-generator.js';
```

- [ ] **Step 3: Construct dependencies inside buildApp**

После того как созданы `memoryManager`, `notesManager`, `sessionManager`, `pool`, `llmClient` (для Ollama summarization) — добавить:

```typescript
  // Chat persistence (always enabled)
  const chatStorage = new ChatStorage(pool);
  const chatManager = new ChatManager(chatStorage);

  // RAG (optional — requires GEMINI_API_KEY)
  // GeminiChatProvider is lightweight (no persistent connections), so we
  // create a single shared instance and a per-request factory for RagAgent
  // to bind it to the session's projectId.
  let chatProvider: GeminiChatProvider | null = null;
  let ragAgentFactory: ChatRouteDeps['ragAgentFactory'] = null;
  let titleGenerator: TitleGenerator | null = null;
  if (config.geminiApiKey) {
    chatProvider = new GeminiChatProvider({
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
    });
    ragAgentFactory = (projectId, agentTokenId) => {
      const adapter = new McpToolAdapter(
        { memoryManager, notesManager, sessionManager },
        { agentTokenId, projectId, toolResponseMaxChars: config.ragToolResponseMaxChars },
      );
      return new RagAgent({
        provider: chatProvider!,
        adapter,
        chatManager,
        maxIterations: config.ragMaxIterations,
      });
    };
    titleGenerator = new TitleGenerator(chatProvider, chatManager);
  }

  registerChatRoutes(app, {
    chatManager,
    ragAgentFactory,
    titleGenerator,
    providerModel: chatProvider?.name ?? null,
  });
```

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run
```

Expected: PASS — все существующие тесты + новые 13 chat-api.

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app.ts src/__tests__/chat-api.test.ts
git commit -m "feat(app): wire RagAgent factory and ChatManager into buildApp"
```

---

## Phase 6 — UI

### Task 16: index.html — sidebar + project selector markup

**Files:**
- Modify: `src/web/public/index.html`

- [ ] **Step 1: Read existing chat tab structure**

Посмотреть текущую разметку вкладки AI Chat в `src/web/public/index.html`. Найти контейнер чата (вероятно `#chat-container` или `#tab-chat`).

- [ ] **Step 2: Replace/wrap chat tab layout**

Заменить текущую разметку чат-панели двухколоночной:

```html
<div id="chat-panel" class="chat-panel" style="display:none">
  <aside class="chat-sidebar">
    <div class="chat-sidebar-header">
      <select id="chat-project-select" class="chat-project-select">
        <option value="">— Выбери проект —</option>
      </select>
      <button id="chat-new-btn" class="chat-new-btn" disabled>+ Новый чат</button>
    </div>
    <ul id="chat-session-list" class="chat-session-list"></ul>
  </aside>
  <main class="chat-main">
    <div id="chat-messages" class="chat-messages"></div>
    <form id="chat-form" class="chat-form">
      <textarea id="chat-input" placeholder="Спроси что-нибудь о проекте..." rows="2"></textarea>
      <button type="submit" id="chat-send">→</button>
    </form>
  </main>
</div>
```

Если старая разметка чата присутствовала в index.html — удалить.

- [ ] **Step 3: Manual check**

Открыть `index.html` в редакторе, визуально убедиться: sidebar ушёл слева, main справа, чат-инпут внизу main.

- [ ] **Step 4: Commit**

```bash
git add src/web/public/index.html
git commit -m "feat(ui): chat sidebar and project selector markup"
```

---

### Task 17: styles.css — sidebar and tool-trace styles

**Files:**
- Modify: `src/web/public/styles.css`

- [ ] **Step 1: Add CSS**

Дописать в конец `src/web/public/styles.css`:

```css
/* === RAG chat v4.0 === */

.chat-panel {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.chat-sidebar {
  width: 280px;
  border-right: 1px solid var(--border-color, #2a2a2a);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-sidebar-header {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-bottom: 1px solid var(--border-color, #2a2a2a);
}

.chat-project-select,
.chat-new-btn {
  width: 100%;
  padding: 6px 10px;
  background: var(--bg-input, #1a1a1a);
  color: var(--text-color, #e0e0e0);
  border: 1px solid var(--border-color, #2a2a2a);
  border-radius: 4px;
  font-size: 13px;
}

.chat-new-btn {
  cursor: pointer;
}
.chat-new-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.chat-new-btn:not(:disabled):hover {
  background: var(--accent, #3a3a3a);
}

.chat-session-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow-y: auto;
  flex: 1;
}

.chat-session-item {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  border-left: 2px solid transparent;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.chat-session-item:hover { background: rgba(255,255,255,0.03); }
.chat-session-item.active { background: rgba(255,255,255,0.06); border-left-color: var(--accent-strong, #5a8dff); }
.chat-session-item .chat-session-delete {
  margin-left: auto;
  background: none; border: none; color: var(--text-dim, #888); cursor: pointer; padding: 2px 6px;
}
.chat-session-item .chat-session-delete:hover { color: #ff6b6b; }

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.chat-form {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--border-color, #2a2a2a);
}
.chat-form textarea {
  flex: 1;
  padding: 8px;
  background: var(--bg-input, #1a1a1a);
  color: var(--text-color, #e0e0e0);
  border: 1px solid var(--border-color, #2a2a2a);
  border-radius: 4px;
  resize: vertical;
}
.chat-form button {
  padding: 8px 16px;
  background: var(--accent-strong, #5a8dff);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

/* Message bubbles */
.msg {
  margin-bottom: 12px;
  padding: 10px 14px;
  border-radius: 8px;
  max-width: 90%;
}
.msg.user {
  background: var(--accent, #2d3a55);
  margin-left: auto;
}
.msg.assistant {
  background: var(--bg-card, #1e1e1e);
  margin-right: auto;
}

/* Tool trace */
.tool-trace {
  border: 1px dashed var(--border-color, #2a2a2a);
  border-radius: 6px;
  margin-bottom: 8px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-dim, #9a9a9a);
}
.tool-trace > summary { cursor: pointer; user-select: none; list-style: none; }
.tool-trace > summary::before { content: '▸ '; }
.tool-trace[open] > summary::before { content: '▾ '; }
.tool-trace ol { margin: 6px 0 0 0; padding-left: 20px; }
.tool-trace li { margin-bottom: 4px; }
.tool-trace li .tool-status { margin-right: 6px; }
.tool-trace li pre {
  background: rgba(0,0,0,0.3);
  padding: 6px;
  border-radius: 3px;
  font-size: 11px;
  overflow-x: auto;
  margin: 4px 0;
}

.chat-toast {
  position: fixed;
  bottom: 20px;
  right: 20px;
  padding: 10px 16px;
  border-radius: 4px;
  color: white;
  z-index: 1000;
  max-width: 400px;
}
.chat-toast.error { background: #c94a4a; }
.chat-toast.warning { background: #d49a2c; }
```

- [ ] **Step 2: Visual check**

Запустить `npm run dev` и посмотреть, что вёрстка не ломается:

```bash
cd d:/MCP/team-memory-mcp && npm run build && npm run start:web
```

Открыть `http://localhost:3846`, перейти во вкладку AI Chat, убедиться: sidebar слева 280px, main справа, стили применились.

- [ ] **Step 3: Commit**

```bash
git add src/web/public/styles.css
git commit -m "feat(ui): styles for chat sidebar and tool trace"
```

---

### Task 18: chat.js — SSE streaming + thinking block render

**Files:**
- Modify: `src/web/public/chat.js` (полностью переписать — старый non-streaming fetch удаляется)

- [ ] **Step 1: Rewrite chat.js**

Открыть `src/web/public/chat.js`, **полностью заменить содержимое** на:

```javascript
// RAG chat v4.0 — SSE streaming + session history + project selector

(function () {
  const state = {
    projects: [],
    currentProjectId: null,
    sessions: [],
    currentSessionId: null,
    /** Map<sessionId, Array<message>> — мессaging local cache for rendering */
    messagesBySession: {},
    sending: false,
  };

  const $ = (sel) => document.querySelector(sel);

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
      credentials: 'include',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status}: ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // --- Projects ---
  async function loadProjects() {
    // Memory projects endpoint. Check what exists: GET /api/memory/projects (see app.ts)
    const res = await api('/api/memory/projects').catch(() => null);
    // If endpoint differs, adapt. Fallback: try /api/projects.
    const projects = Array.isArray(res) ? res : res?.projects ?? [];
    state.projects = projects;
    const select = $('#chat-project-select');
    select.innerHTML = '<option value="">— Выбери проект —</option>' +
      projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  }

  // --- Sessions list ---
  async function loadSessions() {
    if (!state.currentProjectId) {
      state.sessions = [];
      renderSessionList();
      return;
    }
    const qs = new URLSearchParams({ project_id: state.currentProjectId, limit: '50' });
    const list = await api(`/api/chat/sessions?${qs}`);
    state.sessions = list;
    renderSessionList();
  }

  function renderSessionList() {
    const ul = $('#chat-session-list');
    if (!state.sessions.length) {
      ul.innerHTML = '<li class="chat-session-empty">Нет чатов</li>';
      return;
    }
    ul.innerHTML = state.sessions.map(s => `
      <li class="chat-session-item ${s.id === state.currentSessionId ? 'active' : ''}" data-id="${s.id}">
        <span class="chat-session-title">${escapeHtml(s.title)}</span>
        <button class="chat-session-delete" data-id="${s.id}" title="Удалить">×</button>
      </li>
    `).join('');
  }

  async function createNewChat() {
    if (!state.currentProjectId) return;
    const session = await api('/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ project_id: state.currentProjectId }),
    });
    state.sessions.unshift(session);
    await openChat(session.id);
  }

  async function openChat(sessionId) {
    state.currentSessionId = sessionId;
    renderSessionList();
    const res = await api(`/api/chat/sessions/${sessionId}`);
    state.messagesBySession[sessionId] = res.messages;
    renderChatMessages();
  }

  async function deleteChat(sessionId, ev) {
    ev.stopPropagation();
    if (!confirm('Удалить чат?')) return;
    await api(`/api/chat/sessions/${sessionId}`, { method: 'DELETE' });
    state.sessions = state.sessions.filter(s => s.id !== sessionId);
    if (state.currentSessionId === sessionId) {
      state.currentSessionId = null;
      $('#chat-messages').innerHTML = '';
    }
    renderSessionList();
  }

  // --- Render messages ---
  function renderChatMessages() {
    const container = $('#chat-messages');
    container.innerHTML = '';
    const messages = state.messagesBySession[state.currentSessionId] || [];
    const rendered = groupAssistantWithTools(messages);
    for (const item of rendered) container.appendChild(item);
    container.scrollTop = container.scrollHeight;
  }

  function groupAssistantWithTools(messages) {
    const nodes = [];
    const pendingTools = {};  // tool_call_id → {name, args, result, ok}

    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'user') {
        nodes.push(bubble('user', m.content));
      } else if (m.role === 'assistant') {
        const toolCalls = m.tool_calls || m.toolCalls || [];
        const traceNode = toolCalls.length ? toolTraceNode(toolCalls, pendingTools) : null;
        nodes.push(assistantBubble(m.content, traceNode));
      } else if (m.role === 'tool') {
        const cid = m.tool_call_id || m.toolCallId;
        if (cid) pendingTools[cid] = { name: m.tool_name || m.toolName, result: m.content };
        // Re-wire the last assistant's traceNode with the result
        // (Simple approach: rebuild trace for last assistant if any)
      }
    }
    return nodes;
  }

  function bubble(role, text) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.textContent = text;
    return el;
  }

  function assistantBubble(text, traceNode) {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    if (traceNode) el.appendChild(traceNode);
    const txt = document.createElement('div');
    txt.className = 'msg-text';
    txt.textContent = text;
    el.appendChild(txt);
    return el;
  }

  function toolTraceNode(toolCalls, resultsMap) {
    const details = document.createElement('details');
    details.className = 'tool-trace';
    details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = `🔧 Использовано ${toolCalls.length} инстр.`;
    details.appendChild(summary);
    const ol = document.createElement('ol');
    for (const tc of toolCalls) {
      const li = document.createElement('li');
      const res = resultsMap[tc.id];
      const ok = res ? (res.result.startsWith('{"error"') ? '✗' : '✓') : '…';
      li.innerHTML = `<span class="tool-status">${ok}</span><code>${escapeHtml(tc.name)}</code>`;
      const pre = document.createElement('pre');
      pre.textContent = `args: ${JSON.stringify(tc.args, null, 2)}\n` +
        (res ? `result: ${res.result.slice(0, 500)}` : 'выполняется...');
      li.appendChild(pre);
      ol.appendChild(li);
    }
    details.appendChild(ol);
    return details;
  }

  // --- Streaming send ---
  async function sendMessage(text) {
    if (state.sending || !state.currentSessionId) return;
    state.sending = true;

    const messages = state.messagesBySession[state.currentSessionId] = state.messagesBySession[state.currentSessionId] || [];
    messages.push({ role: 'user', content: text });
    const userNode = bubble('user', text);
    $('#chat-messages').appendChild(userNode);

    const assistantEl = document.createElement('div');
    assistantEl.className = 'msg assistant';
    const toolDetails = document.createElement('details');
    toolDetails.className = 'tool-trace';
    toolDetails.open = true;
    toolDetails.style.display = 'none';
    const toolSummary = document.createElement('summary');
    toolSummary.textContent = '🔧 Использую инструменты…';
    toolDetails.appendChild(toolSummary);
    const toolOl = document.createElement('ol');
    toolDetails.appendChild(toolOl);
    assistantEl.appendChild(toolDetails);
    const textEl = document.createElement('div');
    textEl.className = 'msg-text';
    assistantEl.appendChild(textEl);
    $('#chat-messages').appendChild(assistantEl);
    $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight;

    const toolStartItems = {};  // id → <li>

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ session_id: state.currentSessionId, message: text }),
      });
      if (!res.ok) {
        showToast('error', `Ошибка ${res.status}: ${await res.text()}`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let finalText = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (raw.startsWith(':')) continue; // keep-alive
          const ev = parseSse(raw);
          if (!ev) continue;
          if (ev.type === 'text') {
            finalText += ev.delta;
            textEl.textContent = finalText;
          } else if (ev.type === 'tool_start') {
            toolDetails.style.display = 'block';
            const li = document.createElement('li');
            li.innerHTML = `<span class="tool-status">…</span><code>${escapeHtml(ev.name)}</code>`;
            const pre = document.createElement('pre');
            pre.textContent = `args: ${JSON.stringify(ev.args, null, 2)}`;
            li.appendChild(pre);
            toolOl.appendChild(li);
            toolStartItems[ev.id] = li;
          } else if (ev.type === 'tool_end') {
            const li = toolStartItems[ev.id];
            if (li) {
              li.querySelector('.tool-status').textContent = ev.ok ? '✓' : '✗';
              const pre = li.querySelector('pre');
              pre.textContent += `\nresult: ${ev.summary || (ev.error || 'ok')}`;
            }
          } else if (ev.type === 'done') {
            toolDetails.open = false;
            toolSummary.textContent = toolOl.children.length
              ? `🔧 Использовано ${toolOl.children.length} инстр.`
              : toolSummary.textContent;
          } else if (ev.type === 'error') {
            showToast('error', ev.message || ev.code);
            toolSummary.textContent = `⚠ Ошибка: ${ev.code}`;
          }
          $('#chat-messages').scrollTop = $('#chat-messages').scrollHeight;
        }
      }

      if (finalText) messages.push({ role: 'assistant', content: finalText });
      await loadSessions();  // refresh sidebar (might have auto-title)
    } catch (err) {
      showToast('error', err.message);
    } finally {
      state.sending = false;
    }
  }

  function parseSse(raw) {
    const lines = raw.split('\n');
    let type = null, data = null;
    for (const l of lines) {
      if (l.startsWith('event: ')) type = l.slice(7).trim();
      else if (l.startsWith('data: ')) data = l.slice(6);
    }
    if (!type || !data) return null;
    try { return { type, ...JSON.parse(data) }; } catch { return null; }
  }

  function showToast(level, message) {
    const el = document.createElement('div');
    el.className = `chat-toast ${level}`;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // --- Wire up events ---
  function init() {
    $('#chat-project-select').addEventListener('change', (e) => {
      state.currentProjectId = e.target.value || null;
      $('#chat-new-btn').disabled = !state.currentProjectId;
      state.currentSessionId = null;
      $('#chat-messages').innerHTML = '';
      loadSessions();
    });
    $('#chat-new-btn').addEventListener('click', createNewChat);
    $('#chat-session-list').addEventListener('click', (e) => {
      const delBtn = e.target.closest('.chat-session-delete');
      if (delBtn) return deleteChat(delBtn.dataset.id, e);
      const item = e.target.closest('.chat-session-item');
      if (item) openChat(item.dataset.id);
    });
    $('#chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#chat-input');
      const text = input.value.trim();
      if (!text || !state.currentSessionId) return;
      input.value = '';
      sendMessage(text);
    });

    loadProjects();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
```

- [ ] **Step 2: Smoke check in browser**

```bash
cd d:/MCP/team-memory-mcp && npm run build && npm run start:web
```

Открыть `http://localhost:3846`, залогиниться, перейти в AI Chat. Убедиться:
- Dropdown проектов заполнен.
- Кнопка "+ Новый чат" включается после выбора проекта.
- Создание нового чата: появляется в sidebar.
- Ввод сообщения → стрим идёт, thinking-блок появляется во время tool calls, финальный текст инкрементальный.
- Перезагрузка страницы — чат в списке, клик загружает историю.

Если `/api/memory/projects` возвращает не то, что ожидает `loadProjects()`, адаптировать под реальный формат (проверить в `app.ts`).

- [ ] **Step 3: Commit**

```bash
git add src/web/public/chat.js
git commit -m "feat(ui): SSE-streaming chat with thinking block and session history"
```

---

## Phase 7 — Release prep

### Task 19: Bump package.json to 4.0.0 + release note

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update version**

В [package.json:4](../../package.json#L4) изменить:

```json
"version": "4.0.0",
```

- [ ] **Step 2: Verify npm does not choke**

```bash
cd d:/MCP/team-memory-mcp && npm install --package-lock-only
```

Expected: `package-lock.json` updates cleanly.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: bump version to 4.0.0 for RAG assistant release"
```

---

### Task 20: Manual end-to-end smoke check

**Files:**
- None (manual)

- [ ] **Step 1: Run full test suite**

```bash
cd d:/MCP/team-memory-mcp && npx vitest run
```

Expected: ALL PASS. If red — triage and fix before proceeding.

- [ ] **Step 2: TypeScript strict check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: `dist/` updates without errors.

- [ ] **Step 4: Start server with real GEMINI_API_KEY**

Поставить в `.env`:
```
GEMINI_API_KEY=<real-key>
DATABASE_URL=postgresql://memory:memory@localhost:5432/team_memory
```

Запустить:
```bash
npm run start:web
```

- [ ] **Step 5: Manual checklist**

1. Открыть `http://localhost:3846/api/chat/status` — должно вернуться `{available: true, provider: "gemini", model: "gemini-2.5-flash"}`.
2. Открыть UI, залогиниться, перейти в AI Chat, выбрать проект `Рефакторинг MCP Team Memory`.
3. Создать новый чат, задать вопрос: «Какие последние баги были в проекте?». Убедиться:
   - Первый text-chunk появляется < 500 мс.
   - В thinking-блоке виден `memory_read(category:"issues")` или `session_message_search`.
   - Финальный ответ упоминает конкретные записи по ID или заголовку.
4. Перезагрузить страницу. Чат должен быть в sidebar. Клик → загружается история + thinking-блок сохранён.
5. Переименовать чат → название обновилось.
6. Удалить чат → пропал из sidebar. Проверить в psql: `SELECT archived_at FROM chat_sessions WHERE id='...'` — поле заполнено.
7. Положить `GEMINI_API_KEY=invalid`, перезапустить. Запрос чата → красный тост «api_key_invalid». История не повреждена.
8. Переключить проект → список чатов перезагружен.

- [ ] **Step 6: Document any bugs found, fix, commit**

Каждый баг = новый commit: `fix(chat): <describe>`.

- [ ] **Step 7: Final commit on version note**

Если всё зелёное, написать memory entry через team-memory MCP:

```
category: progress
title: RAG-ассистент v4.0 задеплоен
content: Gemini 2.5 Flash, 12 read-only MCP-тулов, streaming SSE, история чатов в Postgres. Релиз v4.0.0.
tags: [v4, rag, gemini, release]
```

---

## Self-review checklist для исполнителя

Перед финальным merge пройтись по файлу и убедиться:

- [ ] Все 20 task-секций отмечены checkmark'ами.
- [ ] `npx vitest run` — зелёный.
- [ ] `npx tsc --noEmit` — зелёный.
- [ ] `npm run build` — зелёный.
- [ ] Manual checklist в Task 20 полностью прошёл.
- [ ] Старый `/api/chat` эндпоинт удалён из `app.ts` (`grep -n 'chatSessions: Map' src/app.ts` должен вернуть пусто).
- [ ] Ollama LLM клиент остался для `SessionManager.summarizeSession` (`grep -n 'llmClient' src/app.ts` должен показывать только саммаризатор).
- [ ] `memory_write` после релиза с итогом работы.
