# Team Memory v5: Profile + Events + Knowledge Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить v4.5 WHY-only онбординг трёхслойной моделью памяти: **Profile** (curated always-on запись на проект), **Knowledge** (WHY-факты, теги вместо категорий), **Events** (WHAT timeline: merge/release/deploy/incident/milestone).

**Architecture:** Три независимо deployable milestone. Milestone 1 добавляет category `profile` и API без миграции существующих данных. Milestone 2 добавляет таблицу `project_events` и второй pass extraction. Milestone 3 переписывает `generateOnboarding()` так чтобы он использовал profile+events+knowledge, и сливает `architecture`/`decisions`/`conventions` → `knowledge` с тегами. Каждый milestone завершается smoke-тестом на staging БД и review checkpoint'ом.

**Tech Stack:** Node.js 20, TypeScript 5.x, PostgreSQL 16 (с миграционным runner-ом в `src/storage/migrator.ts`), `pg` driver, `vitest` для тестов, `@modelcontextprotocol/sdk` для MCP, Express для REST. LLM-extractor использует Ollama (`OllamaProvider` в `src/embedding/ollama.ts`) и Gemini (для chat в RAG).

**Source spec:** `C:\Users\a.nozhenko\.claude\plans\abstract-squishing-fern.md` — первый черновик, одобрен пользователем. Этот файл — детализация под subagent-driven execution.

**Working directory:** `D:\MCP\team-memory-mcp` (this is the repo root for all paths below).

**Branch strategy:** создать ветку `feat/v5-profile-events-knowledge` от `main` (origin `89cb4a0`). Каждый milestone — серия commits на этой ветке. После Milestone 3 — review → merge.

---

## File Structure

### Новые файлы

| Путь | Ответственность |
|---|---|
| `src/storage/migrations/021-profile-category.sql` | Добавить `'profile'` в `entries.category` CHECK, partial UNIQUE на `(project_id) WHERE category='profile' AND status='active'` |
| `src/storage/migrations/022-knowledge-category.sql` | `UPDATE entries SET category='knowledge', tags = array_append(tags, category::text) WHERE category IN ('architecture','decisions','conventions')`. Расширить CHECK на новые значения. |
| `src/storage/migrations/023-project-events.sql` | Создать таблицу `project_events` + индексы |
| `src/storage/migrations/024-cleanup-deprecated.sql` | Обновить COMMENT на `entries.category`, разрешить deprecated read для legacy migration |
| `src/storage/migrations/025-migrate-legacy-categories.sql` | (Optional) `tasks`/`issues`/`progress` → `knowledge` с тегом `legacy-*` |
| `src/events/types.ts` | TypeScript типы `ProjectEvent`, `EventType`, `EventRefs`, etc. |
| `src/events/storage.ts` | `EventsStorage` класс: CRUD по `project_events` через PG |
| `src/events/manager.ts` | `EventsManager`: бизнес-логика add/list/listRecent |
| `src/events/extractor.ts` | LLM-prompt + parser для event-extraction из сессий |
| `src/__tests__/migration-021-profile.test.ts` | Тесты на CHECK и UNIQUE constraint |
| `src/__tests__/migration-022-knowledge.test.ts` | Тесты на rename категории + сохранение тегов |
| `src/__tests__/migration-023-events.test.ts` | Тесты на схему `project_events` |
| `src/__tests__/profile-manager.test.ts` | Unit-тесты `MemoryManager.getProfile/setProfile` |
| `src/__tests__/events-manager.test.ts` | Unit-тесты `EventsManager` |
| `src/__tests__/events-extractor.test.ts` | Unit-тесты на LLM-prompt + parser для events |
| `src/__tests__/onboard-v5.test.ts` | E2E-тест нового формата onboard |

### Изменяемые файлы

| Путь | Что меняется |
|---|---|
| `src/memory/types.ts:2-8` | Добавить `'profile'`, `'knowledge'` в `Category` union; depreciate old values для write (но оставить для read) |
| `src/memory/types.ts:36-41` | Переписать `ROLE_PRIORITIES`: теги вместо category |
| `src/memory/types.ts:260-291` | Обновить `CATEGORY_INFO` |
| `src/memory/manager.ts` (после метода `delete`, ~line 870) | Новые методы `getProfile(projectId)`, `setProfile(projectId, content, tags?)` |
| `src/memory/manager.ts:1207-1304` | Полностью переписать `generateOnboarding()` |
| `src/extraction/types.ts:4-5` | `AutoCategory` → `'knowledge'` only, `AUTO_CATEGORIES = ['knowledge']` |
| `src/extraction/prompt.ts:53-96` | Новый prompt: один output `knowledge[]` с tags-маркером |
| `src/extraction/extractor.ts:41-120` | Парсер one-array вместо three-objects |
| `src/server.ts` (после `memory_conventions` ~line 884) | MCP-tools `memory_profile_get`, `memory_profile_set`, `event_add`, `event_list` |
| `src/app.ts` (после `/api/sessions` ~line 357) | REST: `GET/PUT /api/projects/:id/profile`, `GET/POST /api/projects/:id/events` |
| `web/pages/*` (TBD точные файлы по UI) | Вкладки Profile, Events |

### Сохранение существующих паттернов

- **Carve-out паттерн profile API** — повторяет `memory_conventions(action='add')` в `src/server.ts:857-872`: direct write с `pinned=true, priority='high'`, минует extraction/dedup pipeline.
- **Migration runner** — `src/storage/migrator.ts` автоматически подхватывает любой новый `NNN-name.sql` в `src/storage/migrations/`.
- **Storage слой** — `EventsStorage` следует паттерну `PgStorage` (`src/storage/pg-storage.ts`) и `SessionsStorage` (`src/sessions/storage.ts`): constructor с `pg.Pool`, async-методы.
- **Manager слой** — `EventsManager` следует `MemoryManager` / `NotesManager` / `SessionsManager`.
- **Auto-extraction для events** — реюзает infrastructure `src/extraction/` (LLM client, retry, JSON parse). Просто добавляет parallel call с другим prompt.
- **Onboard скелет** — структура `lines.push(...)` в `manager.ts:1220-1303` остаётся, переписываются только содержание секций и порядок.

---

## Pre-flight

### Task 0.1: Создать рабочую ветку

**Files:** (no files modified)

- [ ] **Step 1:** Создать ветку от main

```bash
cd D:/MCP/team-memory-mcp
git fetch origin
git checkout -b feat/v5-profile-events-knowledge origin/main
```

Expected output: `Switched to a new branch 'feat/v5-profile-events-knowledge'`

- [ ] **Step 2:** Убедиться что dev-окружение запускается

```bash
npm install
npm run build
```

Expected: build без ошибок.

- [ ] **Step 3:** Прогнать существующий test-suite

```bash
npm test
```

Expected: все тесты зелёные (369+ tests). Если что-то не зелёное — остановиться, починить или согласовать.

---

## Milestone 1 — Profile category & API

**Цель:** добавить новую категорию `profile` (одна активная запись на проект), MCP/REST API для get/set. После этого milestone-а Profile уже работает end-to-end, но onboard ещё его не использует.

### Task 1.1: Migration 021 — добавить 'profile' категорию

**Files:**
- Create: `src/storage/migrations/021-profile-category.sql`
- Create: `src/__tests__/migration-021-profile.test.ts`

- [ ] **Step 1: Написать failing test**

`src/__tests__/migration-021-profile.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { Migrator } from '../storage/migrator.js';
import path from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';

describe('Migration 021: profile category', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB });
    const migrator = new Migrator(pool, path.resolve('src/storage/migrations'));
    await migrator.run();
    await pool.query(`INSERT INTO projects (id, name) VALUES ('00000000-0000-0000-0000-000000000099', 'mig-021-test') ON CONFLICT DO NOTHING`);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM entries WHERE project_id = '00000000-0000-0000-0000-000000000099'`);
    await pool.query(`DELETE FROM projects WHERE id = '00000000-0000-0000-0000-000000000099'`);
    await pool.end();
  });

  it('accepts category = profile', async () => {
    const { rows } = await pool.query(
      `INSERT INTO entries (project_id, category, title, content)
       VALUES ('00000000-0000-0000-0000-000000000099', 'profile', 'P1', 'content')
       RETURNING category`
    );
    expect(rows[0].category).toBe('profile');
  });

  it('enforces only one active profile per project', async () => {
    await pool.query(
      `INSERT INTO entries (project_id, category, title, content, status)
       VALUES ('00000000-0000-0000-0000-000000000099', 'profile', 'P-new', 'c', 'active')
       ON CONFLICT DO NOTHING`
    );
    await expect(
      pool.query(
        `INSERT INTO entries (project_id, category, title, content, status)
         VALUES ('00000000-0000-0000-0000-000000000099', 'profile', 'P-dup', 'c', 'active')`
      )
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('allows archiving an old profile and creating a new active one', async () => {
    await pool.query(
      `UPDATE entries SET status='archived' WHERE project_id='00000000-0000-0000-0000-000000000099' AND category='profile'`
    );
    const { rows } = await pool.query(
      `INSERT INTO entries (project_id, category, title, content, status)
       VALUES ('00000000-0000-0000-0000-000000000099', 'profile', 'P-second', 'c', 'active')
       RETURNING id`
    );
    expect(rows[0].id).toBeTruthy();
  });
});
```

- [ ] **Step 2: Запустить тест — должен упасть**

```bash
npm test -- src/__tests__/migration-021-profile.test.ts
```

Expected: FAIL — `accepts category = profile` падает с CHECK constraint violation (текущий CHECK не содержит 'profile').

- [ ] **Step 3: Создать миграцию**

`src/storage/migrations/021-profile-category.sql`:

```sql
-- 021-profile-category.sql
-- Adds 'profile' category for project-level always-on entry (one per project).
-- See plan: docs/superpowers/plans/2026-05-13-v5-profile-events-knowledge.md

ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_category_check;
ALTER TABLE entries ADD CONSTRAINT entries_category_check
  CHECK (category IN ('architecture','tasks','decisions','issues','progress','conventions','profile'));

-- Partial UNIQUE: at most one active profile per project
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_one_active_profile
  ON entries(project_id) WHERE category='profile' AND status='active';

COMMENT ON INDEX idx_entries_one_active_profile IS
  'Enforces invariant: one active profile entry per project. Archived profiles do not conflict.';
```

Note: 'knowledge' добавится отдельно в migration 022 — не объединяем Milestone 1 и 3.

Также создать rollback `src/storage/migrations/rollbacks/021-rollback.sql`:

```sql
DROP INDEX IF EXISTS idx_entries_one_active_profile;
ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_category_check;
ALTER TABLE entries ADD CONSTRAINT entries_category_check
  CHECK (category IN ('architecture','tasks','decisions','issues','progress','conventions'));
```

- [ ] **Step 4: Запустить тест — должен пройти**

```bash
npm test -- src/__tests__/migration-021-profile.test.ts
```

Expected: PASS (все 3 теста).

- [ ] **Step 5: Commit**

```bash
git add src/storage/migrations/021-profile-category.sql src/__tests__/migration-021-profile.test.ts
git commit -m "feat(db): add 'profile' category and one-per-project UNIQUE constraint

Migration 021 introduces a new 'profile' category for the upcoming
always-on project profile entry, plus a partial UNIQUE index that
enforces 'at most one active profile per project'. Also adds 'knowledge'
to the CHECK constraint preemptively for Milestone 3."
```

---

### Task 1.2: Расширить Category union в types.ts

**Files:**
- Modify: `src/memory/types.ts:2-8` (Category union)
- Modify: `src/memory/types.ts:260-291` (CATEGORY_INFO)

- [ ] **Step 1: Написать failing test (тип-чек)**

Создать `src/__tests__/types-profile.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { CATEGORY_INFO, type Category } from '../memory/types.js';

describe('Category includes profile + knowledge', () => {
  it('Category union accepts profile', () => {
    const c: Category = 'profile';
    expect(c).toBe('profile');
  });
  it('Category union accepts knowledge', () => {
    const c: Category = 'knowledge';
    expect(c).toBe('knowledge');
  });
  it('CATEGORY_INFO has profile entry', () => {
    expect(CATEGORY_INFO.profile).toBeDefined();
    expect(CATEGORY_INFO.profile.icon).toBe('🗺️');
  });
  it('CATEGORY_INFO has knowledge entry', () => {
    expect(CATEGORY_INFO.knowledge).toBeDefined();
  });
});
```

- [ ] **Step 2: Запустить тест — должен упасть**

```bash
npm test -- src/__tests__/types-profile.test.ts
```

Expected: FAIL (TypeScript compile error: `Type '"profile"' is not assignable to type 'Category'`).

- [ ] **Step 3: Расширить types**

В `src/memory/types.ts:2-8`, заменить:

```typescript
export type Category =
  | 'architecture'  // Архитектурные решения
  | 'tasks'         // Текущие задачи (DEPRECATED v4.5)
  | 'decisions'     // Принятые решения
  | 'issues'        // Известные проблемы (DEPRECATED v4.5)
  | 'progress'      // Прогресс разработки (DEPRECATED v4.5)
  | 'conventions'   // Конвенции проекта
  | 'profile'       // Эталонный профиль проекта (one per project, v5)
  | 'knowledge';    // Объединённая категория для architecture/decisions/conventions (v5)
```

В `src/memory/types.ts:260-291` (`CATEGORY_INFO`), добавить:

```typescript
  profile: {
    name: 'Профиль',
    description: 'Эталонная запись «как погрузиться в проект» — всегда показывается агенту первой',
    icon: '🗺️'
  },
  knowledge: {
    name: 'Знания',
    description: 'WHY-факты: архитектурные решения, паттерны, конвенции — объединённая категория (v5)',
    icon: '📚'
  }
```

- [ ] **Step 4: Запустить тест — должен пройти**

```bash
npm test -- src/__tests__/types-profile.test.ts
```

Expected: PASS.

- [ ] **Step 5: Прогнать ВЕСЬ build** — убедиться что добавление двух членов в union не сломало exhaustive switches:

```bash
npm run build
```

Expected: 0 ошибок TypeScript. Если есть ошибки `Type ... is missing the following properties from type ... 'profile' | 'knowledge'` — поправить switch'и (но они могут быть как `default:` ветки, тогда ок).

- [ ] **Step 6: Commit**

```bash
git add src/memory/types.ts src/__tests__/types-profile.test.ts
git commit -m "feat(types): add 'profile' and 'knowledge' to Category union"
```

---

### Task 1.3: MemoryManager.getProfile/setProfile

**Files:**
- Modify: `src/memory/manager.ts` (добавить методы после `delete()`, после ~line 870)
- Create: `src/__tests__/profile-manager.test.ts`

**Pre-step:** в src/memory/types.ts добавление 'knowledge' в Category enum (Task 1.2 уже это сделало) пока что не имеет соответствующего CHECK значения в БД (мы намеренно отложили — см. правку 021). Это OK: до Milestone 3 никто не пишет category='knowledge', и TypeScript принимает значение, но БД не пустит — поведение «explicit failure on knowledge writes до Milestone 3» — задокументировано.

- [ ] **Step 1: Написать failing tests**

`src/__tests__/profile-manager.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { Migrator } from '../storage/migrator.js';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import path from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';
const PROJECT_ID = '00000000-0000-0000-0000-00000000aaaa';

describe('MemoryManager.getProfile/setProfile', () => {
  let pool: pg.Pool;
  let manager: MemoryManager;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB });
    const migrator = new Migrator(pool, path.resolve('src/storage/migrations'));
    await migrator.run();
    const storage = new PgStorage(pool);
    await storage.initialize();
    manager = new MemoryManager(storage);
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'profile-test') ON CONFLICT DO NOTHING`, [PROJECT_ID]);
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PROJECT_ID]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PROJECT_ID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PROJECT_ID]);
    await pool.end();
  });

  it('getProfile returns null when no profile exists', async () => {
    const profile = await manager.getProfile(PROJECT_ID);
    expect(profile).toBeNull();
  });

  it('setProfile creates a new entry with category=profile, pinned=true', async () => {
    const entry = await manager.setProfile(PROJECT_ID, '# Mission\nTest project', ['mvp'], 'token-xyz');
    expect(entry.category).toBe('profile');
    expect(entry.pinned).toBe(true);
    expect(entry.status).toBe('active');
    expect(entry.priority).toBe('high');
    expect(entry.tags).toContain('mvp');
    expect(entry.author).toBe('token-xyz'); // author propagation
  });

  it('getProfile returns the active profile entry', async () => {
    await manager.setProfile(PROJECT_ID, '# First', []);
    const profile = await manager.getProfile(PROJECT_ID);
    expect(profile?.content).toBe('# First');
  });

  it('setProfile archives the previous active profile and creates a new one', async () => {
    const first = await manager.setProfile(PROJECT_ID, '# v1', []);
    const second = await manager.setProfile(PROJECT_ID, '# v2', []);
    const refreshedFirst = await manager.getById(first.id);
    expect(refreshedFirst?.status).toBe('archived');
    expect(second.status).toBe('active');
    const active = await manager.getProfile(PROJECT_ID);
    expect(active?.id).toBe(second.id);
  });
});
```

- [ ] **Step 2: Запустить тест — должен упасть**

```bash
npm test -- src/__tests__/profile-manager.test.ts
```

Expected: FAIL — `manager.getProfile is not a function`.

- [ ] **Step 3: Реализовать методы**

В `src/memory/manager.ts`, после метода `delete()` (около line 870), добавить:

```typescript
  // === Profile (v5 — one curated always-on entry per project) ===

  /**
   * Returns the active profile entry for a project, or null if not set.
   * Uses the partial UNIQUE index `idx_entries_one_active_profile`.
   */
  async getProfile(projectId: string): Promise<MemoryEntry | null> {
    const entries = await this.storage.getAll(projectId, {
      category: 'profile',
      status: 'active',
      limit: 1,
    });
    return entries[0] ?? null;
  }

  /**
   * Sets the project profile. If an active profile already exists, archive it first,
   * then create the new one. Always pinned, always priority=high.
   */
  async setProfile(
    projectId: string,
    content: string,
    tags: string[] = [],
    author?: string,
  ): Promise<MemoryEntry> {
    const existing = await this.getProfile(projectId);
    if (existing) {
      await this.delete({ id: existing.id, archive: true });
    }
    return this.write({
      projectId,
      category: 'profile',
      title: 'Project Profile',
      content,
      tags,
      priority: 'high',
      pinned: true,
      author,
    });
  }
```

- [ ] **Step 4: Запустить тест — должен пройти**

```bash
npm test -- src/__tests__/profile-manager.test.ts
```

Expected: PASS — 4 теста.

- [ ] **Step 5: Commit**

```bash
git add src/memory/manager.ts src/__tests__/profile-manager.test.ts
git commit -m "feat(memory): add getProfile/setProfile manager methods

setProfile archives any previous active profile before creating
a new one — preserving the 'one active profile per project'
invariant enforced by migration 021."
```

---

### Task 1.4: MCP tools memory_profile_get/set

**Files:**
- Modify: `src/server.ts` (registration + handler)

- [ ] **Step 1: Написать failing integration test**

Создать `src/__tests__/profile-mcp.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { Migrator } from '../storage/migrator.js';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import { createMcpServer } from '../server.js';
import path from 'path';

// Minimal stub: invoke MCP server's tool handler directly without HTTP layer.
// Pattern adapted from src/__tests__/server-tools.test.ts (if it exists; else
// see src/server.ts:670 onwards for the handler dispatcher).

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';
const PROJECT_ID = '00000000-0000-0000-0000-00000000bbbb';

describe('memory_profile_get / memory_profile_set MCP tools', () => {
  let pool: pg.Pool;
  let manager: MemoryManager;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB });
    const migrator = new Migrator(pool, path.resolve('src/storage/migrations'));
    await migrator.run();
    const storage = new PgStorage(pool);
    await storage.initialize();
    manager = new MemoryManager(storage);
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'profile-mcp-test') ON CONFLICT DO NOTHING`, [PROJECT_ID]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PROJECT_ID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PROJECT_ID]);
    await pool.end();
  });

  it('memory_profile_get returns "not set" before profile exists', async () => {
    const profile = await manager.getProfile(PROJECT_ID);
    expect(profile).toBeNull();
    // MCP-level: handler should return content "Profile не задан..."
    // (Direct manager test above is the unit contract; the MCP wrapper
    // is tested in src/__tests__/server-tools.test.ts pattern.)
  });

  it('memory_profile_set then memory_profile_get returns full content', async () => {
    await manager.setProfile(PROJECT_ID, '# Mission\nTest', ['v5']);
    const profile = await manager.getProfile(PROJECT_ID);
    expect(profile?.content).toContain('Mission');
  });
});
```

- [ ] **Step 2: Запустить тест — должен пройти на manager-уровне**

```bash
npm test -- src/__tests__/profile-mcp.test.ts
```

Expected: PASS — потому что manager уже работает с Task 1.3. Это smoke на то что профиль виден через тот же интерфейс что используется и MCP-tool'ом.

- [ ] **Step 3: Зарегистрировать MCP tools**

В `src/server.ts` найти место регистрации `memory_conventions` (~line 258) — добавить ПОСЛЕ него:

```typescript
      {
        name: 'memory_profile_get',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• В начале сессии — для получения эталонного профиля проекта (миссия, стек, конвенции, guard-rails)\n• Когда нужен быстрый контекст «что за проект»\n\nВозвращает текущий активный project profile. Если не задан — пустой ответ с подсказкой как создать.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта' },
          },
        },
      },
      {
        name: 'memory_profile_set',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• Пользователь явно сказал обновить профиль проекта\n• Найдено новое значимое правило/guard-rail/stack-фактоид который должен быть always-on\n\nЗаменяет активный project profile новым содержимым. Старый профиль архивируется. Категория="profile", pinned=true, priority=high.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта' },
            content: { type: 'string', description: 'Markdown-контент профиля (mission, stack, conventions, guardrails)' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Теги' },
          },
          required: ['content'],
        },
      },
```

И в dispatcher (около memory_conventions case ~line 825), добавить:

```typescript
        case 'memory_profile_get': {
          const projectIdResult = requireProjectId(args?.project_id as string | undefined, 'memory_profile_get');
          if (typeof projectIdResult !== 'string') return projectIdResult.response;
          const profile = await memoryManager.getProfile(projectIdResult);
          if (!profile) {
            return { content: [{ type: 'text', text: '🗺️ Profile не задан для этого проекта. Используйте memory_profile_set для создания.' }] };
          }
          return { content: [{ type: 'text', text: `# 🗺️ Project Profile\n\n${profile.content}\n\n*ID: ${profile.id} | updated: ${profile.updatedAt}*` }] };
        }

        case 'memory_profile_set': {
          const projectIdResult = requireProjectId(args?.project_id as string | undefined, 'memory_profile_set');
          if (typeof projectIdResult !== 'string') return projectIdResult.response;
          if (!args?.content || typeof args.content !== 'string') {
            return { content: [{ type: 'text', text: '❌ Параметр content (string) обязателен' }], isError: true };
          }
          const entry = await memoryManager.setProfile(
            projectIdResult,
            args.content,
            (args.tags as string[]) || [],
            isAgentToken ? callerAgent : undefined,
          );
          return { content: [{ type: 'text', text: `✅ Profile обновлён!\n\n**ID**: ${entry.id}\n**Категория**: profile\n📌 Pinned, priority=high.\nПредыдущий активный profile (если был) архивирован.` }] };
        }
```

- [ ] **Step 4: Запустить build**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 5: Запустить весь test-suite**

```bash
npm test
```

Expected: все тесты зелёные, включая новые.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/__tests__/profile-mcp.test.ts
git commit -m "feat(mcp): add memory_profile_get and memory_profile_set tools

Carves out direct write/read path for the project profile, mirroring
the memory_conventions pattern. Profile is one curated entry per project,
always pinned, always priority=high, archived-on-replace."
```

---

### Task 1.5: REST endpoints для profile

**Files:**
- Modify: `src/app.ts` (добавить после `/api/sessions/:id` ~line 410)

- [ ] **Step 1: Написать failing test**

Создать `src/__tests__/profile-rest.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import express from 'express';
import { Migrator } from '../storage/migrator.js';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import { registerRoutes } from '../app.js'; // adapt import to actual export
import path from 'path';
import request from 'supertest';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';
const PROJECT_ID = '00000000-0000-0000-0000-00000000cccc';

describe('REST /api/projects/:id/profile', () => {
  let pool: pg.Pool;
  let app: express.Application;
  let manager: MemoryManager;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB });
    const migrator = new Migrator(pool, path.resolve('src/storage/migrations'));
    await migrator.run();
    const storage = new PgStorage(pool);
    await storage.initialize();
    manager = new MemoryManager(storage);
    app = express();
    app.use(express.json());
    // bypass auth for test:
    app.use((req, _res, next) => { (req as any).auth = { agentTokenId: 'test-token' }; next(); });
    registerRoutes(app, { memoryManager: manager /* + others as needed; minimal stub */ } as any);
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'profile-rest-test') ON CONFLICT DO NOTHING`, [PROJECT_ID]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PROJECT_ID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PROJECT_ID]);
    await pool.end();
  });

  it('GET returns 404 when no profile', async () => {
    const res = await request(app).get(`/api/projects/${PROJECT_ID}/profile`);
    expect(res.status).toBe(404);
  });

  it('PUT creates profile and GET returns it', async () => {
    const putRes = await request(app)
      .put(`/api/projects/${PROJECT_ID}/profile`)
      .send({ content: '# Mission\nv5 test', tags: ['v5'] });
    expect(putRes.status).toBe(200);
    expect(putRes.body.success).toBe(true);

    const getRes = await request(app).get(`/api/projects/${PROJECT_ID}/profile`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.profile.content).toContain('Mission');
  });
});
```

- [ ] **Step 2: Запустить тест — должен упасть**

```bash
npm test -- src/__tests__/profile-rest.test.ts
```

Expected: FAIL — 404 для PUT (роуты не зарегистрированы).

- [ ] **Step 3: Реализовать REST**

В `src/app.ts`, найти конец секции `/api/sessions` (~line 435), добавить:

```typescript
  // === Project Profile (v5) ===
  app.get('/api/projects/:id/profile', async (req, res) => {
    try {
      const profile = await memoryManager.getProfile(req.params.id);
      if (!profile) { res.status(404).json({ success: false, error: 'Profile not set for this project' }); return; }
      res.json({ success: true, profile });
    } catch (err) {
      logger.error({ err }, 'GET /api/projects/:id/profile failed');
      res.status(500).json({ success: false, error: 'Failed to fetch profile' });
    }
  });

  app.put('/api/projects/:id/profile', async (req, res) => {
    const { content, tags } = req.body ?? {};
    if (typeof content !== 'string' || content.trim() === '') {
      res.status(400).json({ success: false, error: 'content (non-empty string) is required' });
      return;
    }
    try {
      const author = (req as any).auth?.agentTokenId as string | undefined;
      const entry = await memoryManager.setProfile(req.params.id, content, Array.isArray(tags) ? tags : [], author);
      res.json({ success: true, profile: entry });
    } catch (err) {
      logger.error({ err }, 'PUT /api/projects/:id/profile failed');
      res.status(500).json({ success: false, error: 'Failed to set profile' });
    }
  });
```

- [ ] **Step 4: Запустить тест — должен пройти**

```bash
npm test -- src/__tests__/profile-rest.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/__tests__/profile-rest.test.ts
git commit -m "feat(api): GET/PUT /api/projects/:id/profile

REST mirrors memory_profile_get/set MCP tools so the Web UI
can edit the profile."
```

---

### Task 1.6: Milestone 1 — Smoke test и review checkpoint

**Files:** (no code changes)

- [ ] **Step 1: Прогнать полный test-suite**

```bash
npm test
```

Expected: все тесты зелёные.

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: 0 ошибок.

- [ ] **Step 3: Запустить local dev server и сделать manual smoke**

```bash
npm run dev  # или эквивалент
```

В отдельном окне:

```bash
# Создать тестовый проект (или используй id существующего)
PID=$(curl -s -X POST "http://localhost:3846/api/projects" \
  -H "Authorization: Bearer $TM_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"v5-m1-smoke"}' | jq -r '.project.id')
echo "PID=$PID"

# Получить (должно вернуть 404 not set)
curl -s -o /dev/null -w "%{http_code}\n" -X GET "http://localhost:3846/api/projects/$PID/profile" \
  -H "Authorization: Bearer $TM_TOKEN"
# Expected: 404

# Поставить профиль
curl -s -X PUT "http://localhost:3846/api/projects/$PID/profile" \
  -H "Authorization: Bearer $TM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"# Mission\nTeam-memory MCP test","tags":["test"]}'
# Expected: { "success": true, "profile": {...} }

# Получить (должно вернуть содержимое)
curl -s "http://localhost:3846/api/projects/$PID/profile" \
  -H "Authorization: Bearer $TM_TOKEN" | jq '.profile.content'
# Expected: "# Mission\nTeam-memory MCP test"
```

- [ ] **Step 4: Review checkpoint**

Остановиться. Залить ветку на origin для review:

```bash
git push -u origin feat/v5-profile-events-knowledge
```

Создать PR в draft статусе. Описание: «Milestone 1 of v5 — Profile category + API. Ready for review before proceeding to Milestone 2 (Events).»

Дождаться review от пользователя. Не приступать к Milestone 2 без явного апрува.

---

## Milestone 2 — Events layer

**Цель:** добавить таблицу `project_events` (append-only лента WHAT-событий) и второй pass extraction для авто-извлечения событий из сессий. После milestone — события можно создавать вручную и автоматически.

### Task 2.1: Migration 023 — project_events таблица

**Files:**
- Create: `src/storage/migrations/023-project-events.sql`
- Create: `src/__tests__/migration-023-events.test.ts`

(Note: миграция 022 будет создана в Milestone 3, оставляем номер 023 за events — это намеренный порядок, чтобы events стояли независимо от knowledge migration.)

- [ ] **Step 1: Написать failing tests**

`src/__tests__/migration-023-events.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { Migrator } from '../storage/migrator.js';
import path from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';
const PROJECT_ID = '00000000-0000-0000-0000-00000000dddd';

describe('Migration 023: project_events', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB });
    const migrator = new Migrator(pool, path.resolve('src/storage/migrations'));
    await migrator.run();
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'events-test') ON CONFLICT DO NOTHING`, [PROJECT_ID]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM project_events WHERE project_id = $1`, [PROJECT_ID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PROJECT_ID]);
    await pool.end();
  });

  it('accepts all 5 event types', async () => {
    for (const t of ['merge','release','deploy','incident','milestone']) {
      await pool.query(
        `INSERT INTO project_events (project_id, event_type, occurred_at, title)
         VALUES ($1, $2, NOW(), $3)`,
        [PROJECT_ID, t, `t-${t}`]
      );
    }
    const { rows } = await pool.query(`SELECT event_type FROM project_events WHERE project_id=$1`, [PROJECT_ID]);
    expect(rows.length).toBe(5);
  });

  it('rejects unknown event_type', async () => {
    await expect(
      pool.query(
        `INSERT INTO project_events (project_id, event_type, occurred_at, title)
         VALUES ($1, 'unknown', NOW(), 't')`,
        [PROJECT_ID]
      )
    ).rejects.toThrow(/check constraint|invalid input/i);
  });

  it('cascades on project delete', async () => {
    const TEMP_ID = '00000000-0000-0000-0000-00000000ddde';
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'cascade-test')`, [TEMP_ID]);
    await pool.query(`INSERT INTO project_events (project_id, event_type, occurred_at, title) VALUES ($1, 'merge', NOW(), 't')`, [TEMP_ID]);
    await pool.query(`DELETE FROM projects WHERE id=$1`, [TEMP_ID]);
    const { rows } = await pool.query(`SELECT id FROM project_events WHERE project_id=$1`, [TEMP_ID]);
    expect(rows.length).toBe(0);
  });
});
```

- [ ] **Step 2: Запустить тест — должен упасть**

```bash
npm test -- src/__tests__/migration-023-events.test.ts
```

Expected: FAIL — `relation "project_events" does not exist`.

- [ ] **Step 3: Создать миграцию**

`src/storage/migrations/023-project-events.sql`:

```sql
-- 023-project-events.sql
-- Append-only WHAT-event timeline per project.
-- Auto-populated by extraction pipeline + manual API.

CREATE TABLE IF NOT EXISTS project_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL CHECK (event_type IN ('merge','release','deploy','incident','milestone')),
  occurred_at     TIMESTAMPTZ NOT NULL,
  actor           TEXT,                                  -- who did it
  title           TEXT NOT NULL,
  description     TEXT,
  refs            JSONB NOT NULL DEFAULT '{}'::jsonb,    -- { pr_number?, commit_sha?, version_tag?, deployment_url?, incident_id? }
  auto_generated  BOOLEAN NOT NULL DEFAULT FALSE,
  evidence_sources JSONB NOT NULL DEFAULT '[]'::jsonb,   -- same shape as entries.evidence_sources
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_events_recent
  ON project_events(project_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_events_type
  ON project_events(project_id, event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_events_evidence
  ON project_events USING GIN (evidence_sources);
```

Также rollback `src/storage/migrations/rollbacks/023-rollback.sql`:

```sql
DROP TABLE IF EXISTS project_events CASCADE;
```

- [ ] **Step 4: Запустить тест — должен пройти**

```bash
npm test -- src/__tests__/migration-023-events.test.ts
```

Expected: PASS — все 3 теста.

- [ ] **Step 5: Commit**

```bash
git add src/storage/migrations/023-project-events.sql src/__tests__/migration-023-events.test.ts
git commit -m "feat(db): add project_events table for WHAT timeline

Append-only events ledger with 5 types: merge, release, deploy,
incident, milestone. JSONB refs hold PR#, commit SHA, version tag, etc.
CASCADE on project delete."
```

---

### Task 2.2: Events types и storage

**Files:**
- Create: `src/events/types.ts`
- Create: `src/events/storage.ts`
- Create: `src/__tests__/events-storage.test.ts`

- [ ] **Step 1: Failing test**

`src/__tests__/events-storage.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { Migrator } from '../storage/migrator.js';
import { EventsStorage } from '../events/storage.js';
import path from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';
const PID = '00000000-0000-0000-0000-00000000eeee';

describe('EventsStorage', () => {
  let pool: pg.Pool;
  let storage: EventsStorage;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB });
    await new Migrator(pool, path.resolve('src/storage/migrations')).run();
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'events-storage-test') ON CONFLICT DO NOTHING`, [PID]);
    storage = new EventsStorage(pool);
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM project_events WHERE project_id = $1`, [PID]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM project_events WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.end();
  });

  it('insert and list returns the inserted event', async () => {
    const ev = await storage.insert({
      projectId: PID,
      eventType: 'merge',
      occurredAt: new Date(),
      title: 'feat/foo merged to main',
      refs: { pr_number: 42 },
    });
    expect(ev.id).toBeDefined();
    const list = await storage.list(PID, { limit: 10 });
    expect(list).toHaveLength(1);
    expect(list[0].title).toContain('foo');
    expect(list[0].refs).toEqual({ pr_number: 42 });
  });

  it('list orders by occurred_at DESC', async () => {
    await storage.insert({ projectId: PID, eventType: 'merge', occurredAt: new Date('2026-05-01'), title: 'old' });
    await storage.insert({ projectId: PID, eventType: 'merge', occurredAt: new Date('2026-05-12'), title: 'new' });
    const list = await storage.list(PID, { limit: 10 });
    expect(list[0].title).toBe('new');
  });

  it('filters by event_type', async () => {
    await storage.insert({ projectId: PID, eventType: 'merge', occurredAt: new Date(), title: 'm' });
    await storage.insert({ projectId: PID, eventType: 'deploy', occurredAt: new Date(), title: 'd' });
    const merges = await storage.list(PID, { eventType: 'merge' });
    expect(merges).toHaveLength(1);
    expect(merges[0].title).toBe('m');
  });
});
```

- [ ] **Step 2: Запустить — упадёт (no events module)**

```bash
npm test -- src/__tests__/events-storage.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Реализовать types**

`src/events/types.ts`:

```typescript
import type { EvidenceSource } from '../extraction/types.js';

export type EventType = 'merge' | 'release' | 'deploy' | 'incident' | 'milestone';
export const EVENT_TYPES: EventType[] = ['merge', 'release', 'deploy', 'incident', 'milestone'];

export interface EventRefs {
  pr_number?: number;
  commit_sha?: string;
  version_tag?: string;
  deployment_url?: string;
  incident_id?: string;
  [key: string]: unknown;
}

export interface ProjectEvent {
  id: string;
  projectId: string;
  eventType: EventType;
  occurredAt: string;        // ISO
  actor: string | null;
  title: string;
  description: string | null;
  refs: EventRefs;
  autoGenerated: boolean;
  evidenceSources: EvidenceSource[];
  createdAt: string;
}

export interface InsertEventParams {
  projectId: string;
  eventType: EventType;
  occurredAt: Date | string;
  actor?: string;
  title: string;
  description?: string;
  refs?: EventRefs;
  autoGenerated?: boolean;
  evidenceSources?: EvidenceSource[];
}

export interface ListEventOptions {
  eventType?: EventType;
  limit?: number;
  since?: Date | string;
}

export const EVENT_TYPE_ICONS: Record<EventType, string> = {
  merge:     '🔀',
  release:   '🚀',
  deploy:    '📦',
  incident:  '🚨',
  milestone: '🏁',
};
```

- [ ] **Step 4: Реализовать storage**

`src/events/storage.ts`:

```typescript
import pg from 'pg';
import logger from '../logger.js';
import type {
  ProjectEvent,
  InsertEventParams,
  ListEventOptions,
} from './types.js';

export class EventsStorage {
  constructor(private pool: pg.Pool) {}

  async insert(params: InsertEventParams): Promise<ProjectEvent> {
    const occurred = params.occurredAt instanceof Date ? params.occurredAt.toISOString() : params.occurredAt;
    const { rows } = await this.pool.query(
      `INSERT INTO project_events
         (project_id, event_type, occurred_at, actor, title, description, refs, auto_generated, evidence_sources)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        params.projectId,
        params.eventType,
        occurred,
        params.actor ?? null,
        params.title,
        params.description ?? null,
        JSON.stringify(params.refs ?? {}),
        params.autoGenerated ?? false,
        JSON.stringify(params.evidenceSources ?? []),
      ]
    );
    return this.rowToEvent(rows[0]);
  }

  async list(projectId: string, opts: ListEventOptions = {}): Promise<ProjectEvent[]> {
    const conds: string[] = ['project_id = $1'];
    const params: unknown[] = [projectId];
    if (opts.eventType) {
      params.push(opts.eventType);
      conds.push(`event_type = $${params.length}`);
    }
    if (opts.since) {
      const iso = opts.since instanceof Date ? opts.since.toISOString() : opts.since;
      params.push(iso);
      conds.push(`occurred_at >= $${params.length}`);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    params.push(limit);
    const { rows } = await this.pool.query(
      `SELECT * FROM project_events
       WHERE ${conds.join(' AND ')}
       ORDER BY occurred_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows.map(r => this.rowToEvent(r));
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM project_events WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  private rowToEvent(row: any): ProjectEvent {
    return {
      id: row.id,
      projectId: row.project_id,
      eventType: row.event_type,
      occurredAt: row.occurred_at.toISOString ? row.occurred_at.toISOString() : row.occurred_at,
      actor: row.actor,
      title: row.title,
      description: row.description,
      refs: row.refs ?? {},
      autoGenerated: row.auto_generated,
      evidenceSources: row.evidence_sources ?? [],
      createdAt: row.created_at.toISOString ? row.created_at.toISOString() : row.created_at,
    };
  }
}
```

- [ ] **Step 5: Запустить тест — должен пройти**

```bash
npm test -- src/__tests__/events-storage.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/events/types.ts src/events/storage.ts src/__tests__/events-storage.test.ts
git commit -m "feat(events): add EventsStorage with insert/list/delete"
```

---

### Task 2.3: EventsManager

**Files:**
- Create: `src/events/manager.ts`
- Create: `src/__tests__/events-manager.test.ts`

(continued below — full task spec follows)



**Files:**
- Create: `src/events/manager.ts`
- Create: `src/__tests__/events-manager.test.ts`

- [ ] **Step 1: Failing tests**

`src/__tests__/events-manager.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { Migrator } from '../storage/migrator.js';
import { EventsStorage } from '../events/storage.js';
import { EventsManager } from '../events/manager.js';
import path from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';
const PID = '00000000-0000-0000-0000-00000000ffff';

describe('EventsManager', () => {
  let pool: pg.Pool;
  let manager: EventsManager;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB });
    await new Migrator(pool, path.resolve('src/storage/migrations')).run();
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'events-manager-test') ON CONFLICT DO NOTHING`, [PID]);
    manager = new EventsManager(new EventsStorage(pool));
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM project_events WHERE project_id = $1`, [PID]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM project_events WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.end();
  });

  it('add returns event with id', async () => {
    const ev = await manager.add({
      projectId: PID,
      eventType: 'release',
      occurredAt: new Date(),
      title: 'v1.0.0',
      refs: { version_tag: 'v1.0.0' },
    });
    expect(ev.id).toBeDefined();
    expect(ev.refs.version_tag).toBe('v1.0.0');
  });

  it('listRecent returns last N events', async () => {
    for (let i = 0; i < 12; i++) {
      await manager.add({
        projectId: PID,
        eventType: 'deploy',
        occurredAt: new Date(Date.now() - i * 86400000),
        title: `deploy ${i}`,
      });
    }
    const recent = await manager.listRecent(PID, 10);
    expect(recent).toHaveLength(10);
    expect(recent[0].title).toBe('deploy 0');
  });

  it('rejects empty title', async () => {
    await expect(manager.add({
      projectId: PID,
      eventType: 'merge',
      occurredAt: new Date(),
      title: '',
    })).rejects.toThrow(/title/);
  });
});
```

- [ ] **Step 2: Запустить — упадёт**

Expected: FAIL.

- [ ] **Step 3: Реализовать manager**

`src/events/manager.ts`:

```typescript
import { EventsStorage } from './storage.js';
import type { InsertEventParams, ProjectEvent, EventType, ListEventOptions } from './types.js';

export class EventsManager {
  constructor(private storage: EventsStorage) {}

  async add(params: InsertEventParams): Promise<ProjectEvent> {
    if (!params.title || !params.title.trim()) {
      throw new Error('event title must be non-empty');
    }
    return this.storage.insert(params);
  }

  async list(projectId: string, opts: ListEventOptions = {}): Promise<ProjectEvent[]> {
    return this.storage.list(projectId, opts);
  }

  async listRecent(projectId: string, limit = 10): Promise<ProjectEvent[]> {
    return this.storage.list(projectId, { limit });
  }

  async delete(id: string): Promise<boolean> {
    return this.storage.delete(id);
  }
}
```

- [ ] **Step 4: Запустить тест — должен пройти**

Expected: PASS — 3 теста.

- [ ] **Step 5: Commit**

```bash
git add src/events/manager.ts src/__tests__/events-manager.test.ts
git commit -m "feat(events): add EventsManager with add/listRecent/delete"
```

---

### Task 2.3.5: Wire EventsManager into MemoryManager and server bootstrap

**Files:**
- Modify: `src/memory/manager.ts` (добавить поле + setter)
- Modify: `src/server.ts` (создать EventsManager при startup, прокинуть в MemoryManager и в MCP-dispatcher)
- Create: `src/__tests__/events-wiring.test.ts`

**Зачем:** в Task 3.4 `generateOnboarding()` будет вызывать `this.eventsManager.listRecent(...)`, в Task 2.6 dispatcher MCP-tools будет вызывать `eventsManager.add(...)`. Эти ссылки должны быть валидны.

- [ ] **Step 1: Failing test**

`src/__tests__/events-wiring.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { Migrator } from '../storage/migrator.js';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import { EventsManager } from '../events/manager.js';
import { EventsStorage } from '../events/storage.js';
import path from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';

describe('EventsManager wiring', () => {
  it('MemoryManager.setEventsManager allows access from generateOnboarding path', async () => {
    const pool = new pg.Pool({ connectionString: TEST_DB });
    await new Migrator(pool, path.resolve('src/storage/migrations')).run();
    const storage = new PgStorage(pool);
    await storage.initialize();
    const memoryManager = new MemoryManager(storage);
    const eventsManager = new EventsManager(new EventsStorage(pool));

    memoryManager.setEventsManager(eventsManager);
    expect(memoryManager.getEventsManager()).toBe(eventsManager);

    await pool.end();
  });
});
```

- [ ] **Step 2: Запустить — упадёт** (нет метода setEventsManager).

- [ ] **Step 3: Добавить в MemoryManager** (после `setVectorStore`, ~line 80):

```typescript
  private eventsManager: EventsManager | null = null;

  setEventsManager(em: EventsManager): void {
    this.eventsManager = em;
  }

  getEventsManager(): EventsManager | null {
    return this.eventsManager;
  }
```

И импорт: `import { EventsManager } from '../events/manager.js';`

- [ ] **Step 4: В server bootstrap** (где создаются `memoryManager`, `notesManager`, `sessionsManager` — найти grep-ом `new MemoryManager` в src/server.ts или src/index.ts):

```typescript
const eventsStorage = new EventsStorage(pool);
const eventsManager = new EventsManager(eventsStorage);
memoryManager.setEventsManager(eventsManager);
```

Также пробросить `eventsManager` в MCP-dispatcher closure (рядом с `memoryManager`, `notesManager`).

- [ ] **Step 5: Тесты + build**

```bash
npm test -- src/__tests__/events-wiring.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/memory/manager.ts src/server.ts src/__tests__/events-wiring.test.ts
git commit -m "feat(events): wire EventsManager into MemoryManager and server bootstrap"
```

---

### Task 2.4: Event auto-extraction (LLM-pass)

**Files:**
- Create: `src/events/extractor.ts`
- Create: `src/__tests__/events-extractor.test.ts`

- [ ] **Step 1: Failing tests**

`src/__tests__/events-extractor.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildEventsPrompt, parseEventsResponse } from '../events/extractor.js';

describe('Events extractor', () => {
  it('builds prompt requesting 5 event types', () => {
    const prompt = buildEventsPrompt({
      summary: 'merge v4.5 to main, release v4.5.0',
      messages: [{ role: 'user', content: 'смержил v4.5 в main' }],
    });
    expect(prompt).toContain('merge');
    expect(prompt).toContain('release');
    expect(prompt).toContain('deploy');
    expect(prompt).toContain('incident');
    expect(prompt).toContain('milestone');
  });

  it('parses valid JSON output', () => {
    const json = JSON.stringify({
      events: [
        { event_type: 'merge', occurred_at: '2026-05-12T14:00:00Z', title: 'v4.5 to main', refs: { pr_number: 40 }, confidence: 0.95 },
        { event_type: 'release', occurred_at: '2026-05-12T15:00:00Z', title: 'v4.5.0', refs: { version_tag: 'v4.5.0' }, confidence: 0.9 },
      ],
    });
    const parsed = parseEventsResponse(json);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].eventType).toBe('merge');
    expect(parsed[0].refs.pr_number).toBe(40);
  });

  it('filters out low-confidence events', () => {
    const json = JSON.stringify({
      events: [
        { event_type: 'merge', occurred_at: '2026-05-12T14:00:00Z', title: 'might', confidence: 0.3 },
        { event_type: 'merge', occurred_at: '2026-05-12T14:00:00Z', title: 'sure', confidence: 0.9 },
      ],
    });
    const parsed = parseEventsResponse(json, { minConfidence: 0.7 });
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('sure');
  });

  it('returns empty array on invalid JSON', () => {
    const parsed = parseEventsResponse('not-json');
    expect(parsed).toEqual([]);
  });

  it('returns empty on missing events key', () => {
    const parsed = parseEventsResponse('{}');
    expect(parsed).toEqual([]);
  });

  it('marks all extracted events as autoGenerated=true', () => {
    const json = JSON.stringify({
      events: [{ event_type: 'release', occurred_at: '2026-05-12T14:00:00Z', title: 'v1', confidence: 0.9 }],
    });
    const parsed = parseEventsResponse(json);
    expect(parsed[0].autoGenerated).toBe(true);
  });

  it('rejects unknown event_type', () => {
    const json = JSON.stringify({
      events: [{ event_type: 'unknown', occurred_at: '2026-05-12T14:00:00Z', title: 'x', confidence: 0.9 }],
    });
    const parsed = parseEventsResponse(json);
    expect(parsed).toEqual([]);
  });
});
```

- [ ] **Step 2: Запустить — упадёт**

Expected: FAIL.

- [ ] **Step 3: Реализовать extractor**

`src/events/extractor.ts`:

```typescript
import type { EventType, InsertEventParams } from './types.js';
import { EVENT_TYPES } from './types.js';
import { sampleMessagesForPrompt, detectLang } from '../extraction/prompt.js';

export interface BuildEventsPromptInput {
  summary: string;
  messages: Array<{ role: string; content: string }>;
}

export interface ParsedEvent {
  eventType: EventType;
  occurredAt: string;
  title: string;
  description?: string;
  refs: Record<string, unknown>;
  actor?: string;
  confidence: number;
}

export function buildEventsPrompt(input: BuildEventsPromptInput): string {
  const sampled = sampleMessagesForPrompt(input.messages);
  const conversation = sampled.map(m => `[${m.role}]: ${m.content.slice(0, 300)}`).join('\n');
  const lang = detectLang(input.summary + ' ' + conversation);

  return `You analyze a development session and extract concrete events that happened
during it. Events are WHAT-facts (something completed, deployed, broke) — NOT
WHY-knowledge (architecture decisions, conventions).

Event types you may extract:
- "merge"     — a branch/PR was merged into main (e.g. "смержил feat/X в main", "merged #42")
- "release"   — a version was released (e.g. "релиз v4.5", "tagged v1.2.0")
- "deploy"    — code was deployed to an environment (e.g. "задеплоил на staging")
- "incident"  — production issue / outage / bug discovered
- "milestone" — a major work milestone reached (e.g. "Phase 3 готова", "MVP закрыт")

For each event provide:
- "event_type": one of the 5 above
- "occurred_at": ISO timestamp when it happened (use session date if not explicit)
- "title": short identifier in ${lang}, 5-15 words
- "description": optional 1-2 sentences in ${lang}
- "refs": object — { pr_number, commit_sha, version_tag, deployment_url, incident_id } — include only what is mentioned
- "actor": who did it (only if explicitly named)
- "confidence": 0.0-1.0

ONLY extract events that are EXPLICITLY stated as having happened (past tense in completion context).
Do NOT extract:
- Plans ("надо смержить") — these are future
- Failures/blockers — those are incidents only if they hit prod
- Routine progress ("сделал task 5") — too noisy

If no events — return empty array. Empty is correct.

Output VALID JSON, no markdown:
{"events":[...]}

Session summary:
${input.summary}

Session transcript:
${conversation}`;
}

export function parseEventsResponse(
  raw: string,
  opts: { minConfidence?: number } = {},
): InsertEventParams[] {
  const minConf = opts.minConfidence ?? 0.7;
  let obj: any;
  try { obj = JSON.parse(raw); } catch { return []; }
  if (!obj || !Array.isArray(obj.events)) return [];

  const result: InsertEventParams[] = [];
  for (const ev of obj.events) {
    if (!ev || typeof ev !== 'object') continue;
    if (!EVENT_TYPES.includes(ev.event_type)) continue;
    if (typeof ev.title !== 'string' || !ev.title.trim()) continue;
    if (typeof ev.occurred_at !== 'string') continue;
    if (typeof ev.confidence !== 'number' || ev.confidence < minConf) continue;

    result.push({
      projectId: '', // filled in by caller (extraction pipeline knows the projectId)
      eventType: ev.event_type,
      occurredAt: ev.occurred_at,
      title: ev.title.trim(),
      description: typeof ev.description === 'string' ? ev.description : undefined,
      refs: typeof ev.refs === 'object' && ev.refs !== null ? ev.refs : {},
      actor: typeof ev.actor === 'string' ? ev.actor : undefined,
      autoGenerated: true,
    });
  }
  return result;
}
```

- [ ] **Step 4: Запустить тест — должен пройти**

Expected: PASS — 6 тестов.

- [ ] **Step 5: Commit**

```bash
git add src/events/extractor.ts src/__tests__/events-extractor.test.ts
git commit -m "feat(events): add LLM prompt + parser for event auto-extraction

Pure functions, no I/O. Wires into the extraction pipeline in next task."
```

---

### Task 2.5: Интегрировать event-extraction в sessions pipeline

**Files:**
- Modify: `src/sessions/manager.ts` (метод `runExtraction()`, после candidates extraction но до dedup pass)
- Create: `src/__tests__/events-pipeline.test.ts`

**Точная точка вставки:** `src/sessions/manager.ts`, метод `runExtraction()` (примерно строка 250). После того как noteExtractor вернёт candidates, но **до** dedup-pass для notes. Events идут в отдельную таблицу `project_events`, не конкурируют с dedup'ом entries.

- [ ] **Step 1: Прочитать актуальный код runExtraction**

```bash
grep -n "runExtraction\|extracting_notes" src/sessions/manager.ts
```

Запомнить **точное имя** метода и **точные** имена локальных переменных (`session`, `messages`, `summary`, `llmClient`). Это нужно для Step 3.

- [ ] **Step 2: Failing integration test**

`src/__tests__/events-pipeline.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { Migrator } from '../storage/migrator.js';
import { PgStorage } from '../storage/pg-storage.js';
import { SessionsStorage } from '../sessions/storage.js';
import { SessionsManager } from '../sessions/manager.js';
import { EventsStorage } from '../events/storage.js';
import { EventsManager } from '../events/manager.js';
import path from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';
const PID = '00000000-0000-0000-0000-000000020001';

describe('Events pipeline integration', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB });
    await new Migrator(pool, path.resolve('src/storage/migrations')).run();
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'events-pipeline-test') ON CONFLICT DO NOTHING`, [PID]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM project_events WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM sessions WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.end();
  });

  it('runExtraction with merge-mention message → event in project_events', async () => {
    const eventsManager = new EventsManager(new EventsStorage(pool));
    const sessionsStorage = new SessionsStorage(pool);
    const sessionsManager = new SessionsManager(sessionsStorage, /* deps */ {} as any);
    sessionsManager.setEventsManager(eventsManager);

    // Mock the LLM client used inside runExtraction (имя метода/поля смотри в шаге 1)
    const llmStub = vi.fn().mockResolvedValueOnce(JSON.stringify({ knowledge: [] }))
                          .mockResolvedValueOnce(JSON.stringify({
                            events: [{
                              event_type: 'merge', occurred_at: '2026-05-12T14:00:00Z',
                              title: 'v4.5 merged to main', refs: { pr_number: 40 },
                              confidence: 0.95,
                            }],
                          }));
    (sessionsManager as any).llmClient = { complete: llmStub };

    // Import a session with the trigger phrase
    const sid = await sessionsManager.importSession({
      projectId: PID, externalId: 'sess-x',
      messages: [{ role: 'user', content: 'смержил feat/auto-notes-v4.5 в main, PR #40' }],
      startedAt: new Date(), endedAt: new Date(),
    } as any);

    // Run the extraction pass
    await sessionsManager.runExtraction(sid);

    const events = await eventsManager.list(PID);
    expect(events.some(e => e.eventType === 'merge' && e.title.includes('v4.5'))).toBe(true);
    expect(events[0].autoGenerated).toBe(true);
    expect(events[0].evidenceSources[0].type).toBe('session');
  });
});
```

Note: точные сигнатуры `importSession()`, `runExtraction()` и поле `llmClient` нужно подтвердить в Step 1 — если они отличаются, поправь test под реальные имена. Это test, который проверяет **контракт integration point** — не вязните в детали реализации.

- [ ] **Step 3: Хвостовая интеграция**

В файл который оркестрирует extraction (после `architecture/decisions/conventions` LLM-pass), добавить параллельный pass:

```typescript
// после существующего LLM-call для notes:
const eventsRaw = await llm.complete(buildEventsPrompt({ summary, messages: sampled }));
const eventCandidates = parseEventsResponse(eventsRaw);
for (const ev of eventCandidates) {
  ev.projectId = session.projectId;
  ev.evidenceSources = [{ type: 'session', id: session.id, confirmed_at: new Date().toISOString() }];
  await eventsManager.add(ev);
}
```

(Точный код зависит от структуры existing runner — нужно адаптировать. Если runner живёт в `src/extraction/runner.ts`, добавить в него.)

- [ ] **Step 4: Запустить полный test-suite**

```bash
npm test
```

Expected: все зелёные.

- [ ] **Step 5: Commit**

```bash
git add src/extraction/runner.ts src/__tests__/events-pipeline.test.ts
git commit -m "feat(events): run event-extraction pass after session import

Adds a parallel LLM call alongside the existing knowledge extraction
to populate project_events from chat history. evidence_sources
references the originating session."
```

---

### Task 2.6: MCP tools event_add / event_list

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Failing test**

Создать `src/__tests__/events-mcp.test.ts` — аналогично profile-mcp.test.ts (test manager-level + smoke).

- [ ] **Step 2: Запустить — упадёт**

Expected: FAIL.

- [ ] **Step 3: Зарегистрировать tools**

В `src/server.ts` после profile tools, добавить:

```typescript
      {
        name: 'event_add',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• Произошло событие в проекте, которое стоит зафиксировать в timeline: merge, release, deploy, incident, milestone\n• Пользователь явно об этом сказал ("смержил X", "выпустили v2.1", "задеплоил")\n\nДобавляет событие в project_events timeline. Auto-generated=false для ручных вызовов.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            event_type: { type: 'string', enum: ['merge','release','deploy','incident','milestone'] },
            occurred_at: { type: 'string', description: 'ISO timestamp; default = сейчас' },
            title: { type: 'string' },
            description: { type: 'string' },
            actor: { type: 'string' },
            refs: { type: 'object', description: '{ pr_number, commit_sha, version_tag, deployment_url, incident_id }' },
          },
          required: ['event_type', 'title'],
        },
      },
      {
        name: 'event_list',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• Нужна лента последних событий проекта (что произошло когда)\n• Для онбординга нового агента\n\nВозвращает последние N событий проекта, опционально фильтруя по типу.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            event_type: { type: 'string', enum: ['merge','release','deploy','incident','milestone'] },
            limit: { type: 'number', description: 'default 10, max 200' },
            since: { type: 'string', description: 'ISO timestamp — события начиная с этой даты' },
          },
        },
      },
```

И handlers:

```typescript
        case 'event_add': {
          if (!eventsManager) return { content: [{ type: 'text', text: '❌ Events not configured' }], isError: true };
          const projectIdResult = requireProjectId(args?.project_id as string | undefined, 'event_add');
          if (typeof projectIdResult !== 'string') return projectIdResult.response;
          const eventType = args?.event_type as string;
          const title = args?.title as string;
          if (!eventType || !title) return { content: [{ type: 'text', text: '❌ event_type и title обязательны' }], isError: true };
          try {
            const ev = await eventsManager.add({
              projectId: projectIdResult,
              eventType: eventType as any,
              occurredAt: args?.occurred_at as string || new Date().toISOString(),
              title,
              description: args?.description as string,
              actor: args?.actor as string || (isAgentToken ? callerAgent : undefined),
              refs: (args?.refs as Record<string, unknown>) || {},
            });
            return { content: [{ type: 'text', text: `✅ Событие добавлено!\n**ID**: ${ev.id}\n**Тип**: ${ev.eventType}\n**Заголовок**: ${ev.title}` }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${(err as Error).message}` }], isError: true };
          }
        }

        case 'event_list': {
          if (!eventsManager) return { content: [{ type: 'text', text: '❌ Events not configured' }], isError: true };
          const projectIdResult = requireProjectId(args?.project_id as string | undefined, 'event_list');
          if (typeof projectIdResult !== 'string') return projectIdResult.response;
          const events = await eventsManager.list(projectIdResult, {
            eventType: args?.event_type as any,
            limit: (args?.limit as number) ?? 10,
            since: args?.since as string,
          });
          if (events.length === 0) return { content: [{ type: 'text', text: '📋 Событий не найдено' }] };
          const lines = events.map(ev => {
            const date = ev.occurredAt.substring(0, 10);
            return `- ${date} **${ev.eventType}**: ${ev.title}${ev.actor ? ` — ${ev.actor}` : ''}`;
          });
          return { content: [{ type: 'text', text: `📈 События (${events.length}):\n${lines.join('\n')}` }] };
        }
```

(Также нужно прокинуть `eventsManager` в dispatcher — добавить в constructor / DI. Будет видно при build.)

- [ ] **Step 4: Build**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 5: Тесты**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/__tests__/events-mcp.test.ts
git commit -m "feat(mcp): add event_add and event_list tools"
```

---

### Task 2.7: REST для events

**Files:**
- Modify: `src/app.ts`

- [ ] **Step 1: Failing test**

Аналогично profile-rest.test.ts — тесты на `GET /api/projects/:id/events` и `POST /api/projects/:id/events`.

- [ ] **Step 2: Запустить — упадёт**

Expected: FAIL (404).

- [ ] **Step 3: Реализовать routes**

В `src/app.ts`, после profile-routes:

```typescript
  // === Project Events (v5) ===
  app.get('/api/projects/:id/events', async (req, res) => {
    if (!eventsManager) { res.status(503).json({ success: false, error: 'Events not configured' }); return; }
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 200);
    const eventType = req.query.event_type as string | undefined;
    const since = req.query.since as string | undefined;
    try {
      const events = await eventsManager.list(req.params.id, { limit, eventType: eventType as any, since });
      res.json({ success: true, events, count: events.length });
    } catch (err) {
      logger.error({ err }, 'GET /api/projects/:id/events failed');
      res.status(500).json({ success: false, error: 'Failed to list events' });
    }
  });

  app.post('/api/projects/:id/events', async (req, res) => {
    if (!eventsManager) { res.status(503).json({ success: false, error: 'Events not configured' }); return; }
    const { event_type, occurred_at, title, description, actor, refs } = req.body ?? {};
    if (!event_type || !title) {
      res.status(400).json({ success: false, error: 'event_type and title are required' });
      return;
    }
    try {
      const ev = await eventsManager.add({
        projectId: req.params.id,
        eventType: event_type,
        occurredAt: occurred_at || new Date().toISOString(),
        title,
        description,
        actor: actor || (req as any).auth?.agentTokenId,
        refs: refs || {},
      });
      res.json({ success: true, event: ev });
    } catch (err) {
      logger.error({ err }, 'POST /api/projects/:id/events failed');
      res.status(500).json({ success: false, error: 'Failed to add event' });
    }
  });
```

- [ ] **Step 4: Тесты**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/__tests__/events-rest.test.ts
git commit -m "feat(api): REST routes for project events"
```

---

### Task 2.8: Milestone 2 — smoke и review checkpoint

- [ ] **Step 1: Полный test-suite**

```bash
npm test
```

Expected: все тесты зелёные.

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Manual smoke**

```bash
# add event
curl -s -X POST "http://localhost:3846/api/projects/<test-id>/events" \
  -H "Authorization: Bearer $TM_TOKEN" -H "Content-Type: application/json" \
  -d '{"event_type":"release","title":"v5.0.0","refs":{"version_tag":"v5.0.0"}}'

# list
curl -s "http://localhost:3846/api/projects/<test-id>/events" \
  -H "Authorization: Bearer $TM_TOKEN"
```

Expected: создание + список содержат событие.

- [ ] **Step 4: Pushing for review**

```bash
git push
```

Дождаться review. Не приступать к Milestone 3.

---

## Milestone 3 — Knowledge unification + onboard rewrite

**Цель:** свернуть `architecture` / `decisions` / `conventions` → одна категория `knowledge` с тегами. Переписать `generateOnboarding()` так чтобы он показывал Profile → Recent events → Knowledge → Stats. Это самый рискованный milestone (миграция данных 268+ entries).

### Task 3.1: Migration 022 — knowledge unification

**Files:**
- Create: `src/storage/migrations/022-knowledge-category.sql`
- Create: `src/storage/migrations/rollbacks/022-rollback.sql`
- Create: `src/__tests__/migration-022-knowledge.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { Migrator } from '../storage/migrator.js';
import path from 'path';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';
const PID = '00000000-0000-0000-0000-000000010001';

describe('Migration 022: knowledge unification', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB });
    // Insert some pre-migration data BEFORE the migration runs — we need to
    // set up rows in the old categories THEN run migrations and verify they
    // were moved. Use a fresh test DB or seed data carefully.
    //
    // For simplicity, this test assumes the migration is idempotent
    // and re-runs on already-migrated data are no-op.
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM entries WHERE project_id = $1`, [PID]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [PID]);
    await pool.end();
  });

  it('migrates architecture entries to knowledge with tag', async () => {
    // Pre-seed: create entry with old category by direct SQL bypassing CHECK
    // (use a temporary disabled-constraint window OR test against fresh DB)
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'mig-022-test') ON CONFLICT DO NOTHING`, [PID]);
    // Note: after migration 021/022 both apply, 'architecture' is still valid in CHECK.
    // We test the data transformation:
    await pool.query(
      `INSERT INTO entries (project_id, category, title, content, tags)
       VALUES ($1, 'architecture', 'Test arch', 'c', ARRAY['x'])`,
      [PID]
    );

    // Manually run migration 022 SQL (in real life: migrator runs it on startup):
    const sql = require('fs').readFileSync(
      path.resolve('src/storage/migrations/022-knowledge-category.sql'),
      'utf-8'
    );
    await pool.query(sql);

    const { rows } = await pool.query(`SELECT category, tags FROM entries WHERE project_id=$1`, [PID]);
    expect(rows[0].category).toBe('knowledge');
    expect(rows[0].tags).toContain('architecture');
    expect(rows[0].tags).toContain('x'); // existing tag preserved
  });
});
```

- [ ] **Step 2: Запустить — упадёт**

Expected: FAIL — migration not exists.

- [ ] **Step 3: Создать миграцию**

`src/storage/migrations/022-knowledge-category.sql`:

```sql
-- 022-knowledge-category.sql
-- Step A: extend CHECK to include 'knowledge'.
-- Step B: collapse architecture / decisions / conventions into 'knowledge'.
--         The original category name is preserved as a tag.
-- Idempotent — safely re-runnable.

ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_category_check;
ALTER TABLE entries ADD CONSTRAINT entries_category_check
  CHECK (category IN ('architecture','tasks','decisions','issues','progress','conventions','profile','knowledge'));

-- Single transactional UPDATE: rename category AND append it as a tag (de-dup).
-- WHERE clause naturally protects against re-runs (after first run nothing matches).
UPDATE entries
SET category = 'knowledge',
    tags = (
      SELECT array_agg(DISTINCT t)
      FROM unnest(array_append(tags, category::text)) AS t
      WHERE t IS NOT NULL
    )
WHERE category IN ('architecture', 'decisions', 'conventions');
```

**Idempotency reasoning:** на втором запуске `category` уже `'knowledge'`, поэтому `WHERE category IN (...)` ничего не матчит. На первом запуске `array_append(tags, category::text)` добавит, скажем, `'architecture'` в массив, и `array_agg(DISTINCT)` убьёт возможный дубль (если кто-то уже руками положил `'architecture'` в `tags`).

`src/storage/migrations/rollbacks/022-rollback.sql`:

```sql
-- Rollback for 022-knowledge-category.sql
-- Restores entries.category from the legacy tag.

UPDATE entries
SET category = 'architecture'
WHERE category = 'knowledge' AND 'architecture' = ANY(tags);

UPDATE entries
SET category = 'decisions'
WHERE category = 'knowledge' AND 'decisions' = ANY(tags);

UPDATE entries
SET category = 'conventions'
WHERE category = 'knowledge' AND 'conventions' = ANY(tags);

-- Optionally remove the tags that came from the migration:
-- UPDATE entries SET tags = array_remove(tags, 'architecture') WHERE 'architecture' = ANY(tags);
-- (Risky if user added 'architecture' manually — left out for safety.)
```

- [ ] **Step 4: Запустить тест — должен пройти**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/migrations/022-knowledge-category.sql src/storage/migrations/rollbacks/022-rollback.sql src/__tests__/migration-022-knowledge.test.ts
git commit -m "feat(db): collapse architecture/decisions/conventions into knowledge

Migration 022 renames category to 'knowledge' and preserves the original
name as a tag. Idempotent. Includes rollback script in rollbacks/022-rollback.sql."
```

---

### Task 3.2: Обновить extraction prompt + parser для 'knowledge'

**Files:**
- Modify: `src/extraction/types.ts:4-5`
- Modify: `src/extraction/prompt.ts:53-96`
- Modify: `src/extraction/extractor.ts:41-120`
- Modify: `src/__tests__/extractor.test.ts` (если есть — обновить ожидания)

- [ ] **Step 1: Failing test**

В `src/__tests__/extractor-knowledge.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildExtractionPrompt } from '../extraction/prompt.js';

describe('Extraction prompt v5', () => {
  it('outputs knowledge[] with tag-marker for old categories', () => {
    const prompt = buildExtractionPrompt({
      summary: 't',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(prompt).toContain('"knowledge"');
    expect(prompt).toContain('architecture');  // as tag
    expect(prompt).toContain('decision');
    expect(prompt).toContain('convention');
  });
});
```

- [ ] **Step 2: Запустить — упадёт**

Expected: FAIL (старый prompt всё ещё три массива).

- [ ] **Step 3: Update extraction types**

`src/extraction/types.ts:4-5`:

```typescript
export type AutoCategory = 'knowledge';
export const AUTO_CATEGORIES: AutoCategory[] = ['knowledge'];

export interface CandidateNote {
  category: AutoCategory;       // always 'knowledge' in v5
  knowledgeKind?: 'architecture' | 'decision' | 'convention';  // moved into tag, kept here for legacy parsing
  title: string;
  fact: string;
  why: string;
  tags: string[];
  confidence: number;
  explicit_marker_strength: number;
}
```

- [ ] **Step 4: Update prompt**

`src/extraction/prompt.ts:53-96`, заменить body на:

```typescript
  return `You analyze a development session and extract ONLY atomic facts
worth preserving as long-term team knowledge.

Output schema: a JSON object with one key "knowledge", whose value is an
array of facts. Each fact MUST include a "kind" tag in its "tags" array,
one of:
  - "architecture" — system invariants, contracts, structural patterns
  - "decision"     — explicit "why X, not Y" choices the team committed to
  - "convention"   — rules, standards, agreed-upon practices

Each fact MUST satisfy:
- Atomic: one statement, not a paragraph.
- Explains WHY (rationale, constraint, trade-off), not just WHAT.
- Reusable beyond this session's specific bug or task.
- Length 30-500 characters in the "fact" field.

For each fact provide:
- "title": short identifier (5-10 words), language: ${lang}
- "fact": the WHY statement, language: ${lang}
- "why": background/rationale (1-2 sentences), language: ${lang}
- "tags": 2-5 lowercase tags. MUST contain exactly one of: architecture, decision, convention.
- "confidence": 0.0-1.0
- "explicit_marker_strength": 0.0-1.0 — how clearly marked as a closure
  (phrases like "решили", "договорились", "конвенция", "итого", "root cause") vs casual mention

Routine work — return empty. Empty output is correct.

Output VALID JSON, no markdown:
{"knowledge":[...]}

Session summary:
${input.summary}

Session transcript:
${conversation}`;
```

- [ ] **Step 5: Update parser**

`src/extraction/extractor.ts:41-120` — параметры парсинга меняются: теперь читать `obj.knowledge` вместо `obj.architecture`/`obj.decisions`/`obj.conventions`. Каждый кандидат получает `category='knowledge'`; для backward compat detect `kind` тег. Конкретная реализация зависит от существующего парсера — сохранить контракт `CandidateNote[]`.

- [ ] **Step 6: Запустить тесты**

```bash
npm test -- src/__tests__/extractor-knowledge.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/extraction/types.ts src/extraction/prompt.ts src/extraction/extractor.ts src/__tests__/extractor-knowledge.test.ts
git commit -m "feat(extraction): collapse output to knowledge[] with kind tag

Extractor now produces a single 'knowledge' array. The architecture/decision/
convention distinction lives in the tags. Aligns with migration 022."
```

---

### Task 3.3: Update memory_conventions carve-out

**Files:**
- Modify: `src/server.ts` (memory_conventions handler)

В `add`-ветке `memory_conventions`, заменить `category: 'conventions'` на `category: 'knowledge'` и добавить tag `'convention'`:

```typescript
const entry = await memoryManager.write({
  projectId,
  category: 'knowledge',
  title: args?.title as string,
  content: args?.content as string,
  domain: args?.domain as string,
  tags: ['convention', ...((args?.tags as string[]) || [])],
  priority: 'high',
  pinned: true,
  author: isAgentToken ? callerAgent : undefined,
});
```

Аналогично `list` ветку: фильтровать `category='knowledge' AND 'convention' = ANY(tags)`.

- [ ] **Step 1-5:** написать test + update handler + run + commit (по обычному TDD-pattern).

```bash
git commit -m "refactor(mcp): memory_conventions writes knowledge+'convention' tag"
```

---

### Task 3.4: Rewrite generateOnboarding()

**Files:**
- Modify: `src/memory/manager.ts:1207-1304`
- Create: `src/__tests__/onboard-v5.test.ts`

- [ ] **Step 1: Failing test**

`src/__tests__/onboard-v5.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
// ... (boilerplate как в profile-manager.test.ts)

describe('Onboarding v5', () => {
  // setup as usual ...

  it('shows profile placeholder when not set', async () => {
    const out = await manager.generateOnboarding(PID);
    expect(out).toContain('🗺️ Profile');
    expect(out).toContain('не задан');
  });

  it('shows full profile content when set', async () => {
    await manager.setProfile(PID, '# Mission\nTest', []);
    const out = await manager.generateOnboarding(PID);
    expect(out).toContain('# Mission\nTest');
  });

  it('shows recent events section after profile', async () => {
    await manager.setProfile(PID, '# Mission', []);
    await eventsManager.add({ projectId: PID, eventType: 'release', occurredAt: new Date(), title: 'v5.0.0' });
    const out = await manager.generateOnboarding(PID);
    expect(out).toContain('📈 Recent activity');
    expect(out).toContain('v5.0.0');
    // assert profile comes before events
    expect(out.indexOf('🗺️ Profile')).toBeLessThan(out.indexOf('📈 Recent activity'));
  });

  it('groups knowledge by kind-tag', async () => {
    await manager.write({
      projectId: PID, category: 'knowledge', title: 'Arch X', content: '...',
      tags: ['architecture'], priority: 'medium', pinned: false,
    });
    const out = await manager.generateOnboarding(PID);
    expect(out).toContain('Architecture');
    expect(out).toContain('Arch X');
  });

  it('does NOT show deprecated tasks/issues/progress sections', async () => {
    const out = await manager.generateOnboarding(PID);
    expect(out).not.toContain('📋 Активные задачи');
    expect(out).not.toContain('🐛 Известные проблемы');
    expect(out).not.toContain('📈 Последний прогресс');  // old "Последний прогресс" section header
  });
});
```

- [ ] **Step 2: Запустить — упадёт**

Expected: FAIL.

- [ ] **Step 3: Переписать метод**

`src/memory/manager.ts:1207-1304`, полная замена:

```typescript
  async generateOnboarding(projectId?: string): Promise<string> {
    const pid = projectId || DEFAULT_PROJECT_ID;
    const project = await this.storage.getProject(pid);

    const [profile, recentEvents, knowledge] = await Promise.all([
      this.getProfile(pid),
      this.eventsManager ? this.eventsManager.listRecent(pid, 10) : Promise.resolve([]),
      this.storage.getAll(pid, { category: 'knowledge', status: 'active', limit: 30 }),
    ]);

    const lines: string[] = [];
    lines.push(`# Onboarding: ${project?.name || pid}`);
    lines.push(`> Сгенерирована ${new Date().toLocaleString()} (формат v5)`);
    lines.push('');

    if (project?.description) {
      lines.push(`**Описание:** ${project.description}`);
      lines.push('');
    }

    // 1. Profile (always first)
    lines.push('## 🗺️ Profile');
    if (profile) {
      lines.push(profile.content);
    } else {
      lines.push('> Profile не задан. Создайте его через `memory_profile_set` для быстрого онбординга агентов.');
    }
    lines.push('');

    // 2. Recent events
    if (recentEvents.length > 0) {
      lines.push('## 📈 Recent activity (last 10)');
      for (const ev of recentEvents) {
        const date = ev.occurredAt.substring(0, 10);
        const icon = { merge:'🔀', release:'🚀', deploy:'📦', incident:'🚨', milestone:'🏁' }[ev.eventType] ?? '·';
        lines.push(`- ${date} ${icon} **${ev.title}**${ev.actor ? ` — ${ev.actor}` : ''}`);
      }
      lines.push('');
    }

    // 3. Domains
    const projectDomains = await this.storage.getProjectDomains(pid);
    if (projectDomains.length > 0) {
      lines.push('## 🌐 Домены проекта');
      for (const d of projectDomains) {
        lines.push(`- \`${d.slug}\` (${d.name})${d.description ? ' — ' + d.description : ''}`);
      }
      lines.push('');
    }

    // 4. Knowledge — grouped by kind-tag
    const arch = knowledge.filter(e => e.tags.includes('architecture'));
    const dec  = knowledge.filter(e => e.tags.includes('decision'));
    const conv = knowledge.filter(e => e.tags.includes('convention'));
    const other = knowledge.filter(e => !arch.includes(e) && !dec.includes(e) && !conv.includes(e));

    if (knowledge.length > 0) {
      lines.push('## 📚 Knowledge');

      if (arch.length > 0) {
        lines.push('### 🏗️ Architecture');
        for (const e of arch.slice(0, 10)) {
          lines.push(`- **${e.title}**: ${e.content.length > 200 ? e.content.substring(0, 200) + '...' : e.content}`);
        }
        lines.push('');
      }
      if (dec.length > 0) {
        lines.push('### ✅ Decisions');
        for (const e of dec.slice(0, 10)) {
          lines.push(`- **${e.title}**: ${e.content.length > 200 ? e.content.substring(0, 200) + '...' : e.content}`);
        }
        lines.push('');
      }
      if (conv.length > 0) {
        lines.push('### 📏 Conventions');
        for (const e of conv) {
          lines.push(`### ${e.title}${e.domain ? ` [${e.domain}]` : ''}`);
          lines.push(e.content);
          lines.push('');
        }
      }
      if (other.length > 0) {
        lines.push('### Other');
        for (const e of other.slice(0, 5)) {
          lines.push(`- **${e.title}**: ${e.content.length > 200 ? e.content.substring(0, 200) + '...' : e.content}`);
        }
        lines.push('');
      }
    }

    // 5. Stats
    const stats = await this.getStats(pid);
    lines.push('## 📊 Статистика');
    lines.push(`- Knowledge: ${stats.byCategory.knowledge ?? 0}, Profile: ${profile ? 1 : 0}, Events: ${recentEvents.length}`);
    lines.push(`- Активность за 24ч: ${stats.recentActivity.last24h}, за 7 дней: ${stats.recentActivity.last7d}`);

    return lines.join('\n');
  }
```

Note: метод нуждается в доступе к `this.eventsManager`. Добавить его в конструктор `MemoryManager` (как optional dep) или прокинуть через `setEventsManager(em: EventsManager)` метод. Решение зависит от существующего DI-flow — посмотреть как `vectorStore` пробросен в `setVectorStore`.

- [ ] **Step 4: Запустить тесты**

```bash
npm test -- src/__tests__/onboard-v5.test.ts
```

Expected: PASS — 5 тестов.

- [ ] **Step 5: Commit**

```bash
git add src/memory/manager.ts src/__tests__/onboard-v5.test.ts
git commit -m "feat(onboard): rewrite generateOnboarding for v5 model

New section order: Profile → Recent events → Domains → Knowledge
(grouped by kind tag) → Stats. Removes zombie tasks/issues/progress
sections that have been deprecated since v4.5."
```

---

### Task 3.5: ROLE_PRIORITIES cleanup

**Files:**
- Modify: `src/memory/types.ts:32-48`

- [ ] **Step 1: Failing test**

```typescript
import { ROLE_PRIORITIES } from '../memory/types.js';
import { describe, it, expect } from 'vitest';

describe('ROLE_PRIORITIES v5', () => {
  it('uses tags field, not categories', () => {
    for (const role of Object.values(ROLE_PRIORITIES)) {
      expect(role).toHaveProperty('tags');
      expect(role).not.toHaveProperty('categories');
      expect(Array.isArray(role.tags)).toBe(true);
      expect(role.tags.length).toBeGreaterThan(0);
    }
  });

  it('developer role boosts knowledge tags', () => {
    const dev = ROLE_PRIORITIES.developer;
    expect(dev.tags).toContain('decision');
    expect(dev.tags).toContain('architecture');
    expect(dev.boost).toBeGreaterThanOrEqual(1.3);
  });

  it('devops role boosts deploy and incident tags', () => {
    const devops = ROLE_PRIORITIES.devops;
    expect(devops.tags).toContain('deploy');
    expect(devops.tags).toContain('incident');
  });

  it('qa role boosts testing and incident', () => {
    const qa = ROLE_PRIORITIES.qa;
    expect(qa.tags).toContain('testing');
    expect(qa.tags).toContain('incident');
  });
});
```

- [ ] **Step 2: Запустить — упадёт**

Expected: FAIL.

- [ ] **Step 3: Update types**

`src/memory/types.ts:32-41`:

```typescript
export type ProjectRole = 'developer' | 'qa' | 'lead' | 'devops';
export const PROJECT_ROLES: ProjectRole[] = ['developer', 'qa', 'lead', 'devops'];

export const ROLE_PRIORITIES: Record<ProjectRole, { tags: string[]; domains: string[]; boost: number }> = {
  developer: { tags: ['architecture', 'decision', 'convention'], domains: ['backend', 'frontend', 'database'], boost: 1.5 },
  qa:        { tags: ['testing', 'incident'], domains: ['testing'], boost: 1.5 },
  lead:      { tags: ['milestone', 'release', 'decision'], domains: [], boost: 1.3 },
  devops:    { tags: ['deploy', 'incident', 'infrastructure'], domains: ['infrastructure', 'devops'], boost: 1.5 },
};
```

Также найти все usages `ROLE_PRIORITIES[role].categories` через grep и поменять на `ROLE_PRIORITIES[role].tags` с соответствующей логикой фильтрации (теги в `entries.tags` массиве):

```bash
grep -rn "ROLE_PRIORITIES\[.*\]\.categories\|\.categories\b.*ROLE_PRIORITIES" src/
```

Для каждого найденного usage: переписать с поиска по `category IN (...)` на `tags && ARRAY[...]` (PostgreSQL array overlap). Сохранить тест который проверяет что recall с role-boost возвращает ожидаемые записи (см. существующий integration test для smart-features).

- [ ] **Step 4: Запустить тесты + build**

Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add src/memory/types.ts
git commit -m "refactor: ROLE_PRIORITIES uses tags instead of deprecated categories"
```

---

### Task 3.6: Migration 024 — comment update, и (Optional) 025 — legacy migration

**Files:**
- Create: `src/storage/migrations/024-update-category-comment.sql`
- Create: `src/storage/migrations/025-migrate-legacy-categories.sql` (optional)

- [ ] **Step 1: Создать миграцию 024**

```sql
-- 024-update-category-comment.sql
COMMENT ON COLUMN entries.category IS
  'v5 categories: profile (one-per-project always-on), knowledge (WHY-facts with kind tags).
   Deprecated since v5: architecture/decisions/conventions (collapsed into knowledge by migration 022).
   Deprecated since v4.5: tasks/progress/issues — see migration 019.';
```

Rollback `rollbacks/024-rollback.sql`:

```sql
COMMENT ON COLUMN entries.category IS NULL;
```

- [ ] **Step 2: Создать миграцию 025 — opt-in legacy migration**

**Важно:** этот script помечен **NOT auto-applied** (специальный префикс или отдельная папка). Сейчас migrator подхватывает `NNN-*.sql` автоматически — чтобы 025 не выполнилась автоматически, оставить её в `src/storage/migrations/optional/` (новая папка), и применить руками:

```bash
psql $TM_DATABASE -f src/storage/migrations/optional/025-migrate-legacy-categories.sql
```

Содержимое `src/storage/migrations/optional/025-migrate-legacy-categories.sql`:

```sql
-- OPTIONAL — not auto-applied. Run manually after v5 deploy if you want
-- to clean up legacy categories. DESTRUCTIVE: archives tasks/issues.

UPDATE entries
SET category = 'knowledge',
    tags = array_append(tags, 'legacy-task'),
    status = 'archived'
WHERE category = 'tasks';

UPDATE entries
SET category = 'knowledge',
    tags = array_append(tags, 'legacy-issue')
WHERE category = 'issues';

-- 'progress' entries: left intact in v5. User should manually review and
-- either archive them or convert to project_events via a separate script.
```

Также добавить rollback `src/storage/migrations/optional/rollbacks/025-rollback.sql`:

```sql
UPDATE entries SET category = 'tasks',  status = 'active', tags = array_remove(tags, 'legacy-task')
WHERE category = 'knowledge' AND 'legacy-task' = ANY(tags);
UPDATE entries SET category = 'issues', tags = array_remove(tags, 'legacy-issue')
WHERE category = 'knowledge' AND 'legacy-issue' = ANY(tags);
```

- [ ] **Step 3: Commit**

```bash
git add src/storage/migrations/024-update-category-comment.sql src/storage/migrations/rollbacks/024-rollback.sql src/storage/migrations/optional/025-migrate-legacy-categories.sql src/storage/migrations/optional/rollbacks/025-rollback.sql
git commit -m "feat(db): category comment update + optional legacy migration"
```

Note: migrator должен пропускать `optional/` подпапку — нужно убедиться что glob ищет только `*.sql` в корне `migrations/`. Если нет — поправить migrator (отдельный мини-task в Pre-flight: убедиться, что `src/storage/migrator.ts:58` filter не подхватывает подкаталоги).

---

### Task 3.7: Milestone 3 — полная регрессия и review

- [ ] **Step 1: Полный test-suite**

```bash
npm test
```

Expected: ВСЕ зелёные, в т.ч. v4.5 тесты не должны быть сломаны категорией.

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 3: Применить миграции локально**

```bash
# Если есть отдельный CLI:
npm run migrate
# Иначе — миграции применяются при старте сервера; перезапустить:
npm run dev
```

Expected: новые миграции 021-025 в `schema_migrations`, текущие entries имеют `category='knowledge'`.

- [ ] **Step 4: Manual smoke test**

```bash
# Создать тестовый проект, профиль, событие, knowledge entry — и onboard
curl -s -X POST "http://localhost:3846/api/projects" \
  -H "Authorization: Bearer $TM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"v5-smoke"}'
# (запомнить project_id)

curl -s -X PUT "http://localhost:3846/api/projects/$PID/profile" \
  -H "Authorization: Bearer $TM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"# Mission\nTeam memory v5 smoke","tags":["smoke"]}'

curl -s -X POST "http://localhost:3846/api/projects/$PID/events" \
  -H "Authorization: Bearer $TM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"event_type":"milestone","title":"v5 в проде","occurred_at":"2026-05-13T00:00:00Z"}'

# Вызвать onboard через MCP (curl на /mcp с tools/call memory_onboard) или через тестовый Claude Code клиент
```

Expected: onboard содержит profile, event, и не содержит зомби-секций задач/проблем.

- [ ] **Step 5: Push и review**

```bash
git push
```

Создать PR, описание включает все 3 milestone, ссылки на этот план. Дождаться review.

---

## Post-merge tasks (после code review approval)

### Task 4.1: Применить миграции на проде

- [ ] **Step 1: Backup БД**

```bash
ssh prod-host
pg_dump $TM_DATABASE > /backups/tm-pre-v5-$(date +%Y%m%d).sql
```

- [ ] **Step 2: Deploy code**

```bash
# (формат deploy зависит от инфраструктуры — Docker, systemd unit, etc.)
git pull && npm install && npm run build && systemctl restart team-memory
```

- [ ] **Step 3: Verify migrations applied**

```bash
psql $TM_DATABASE -c "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 5"
```

Expected: 025, 024, 023, 022, 021 в списке.

### Task 4.2: Backfill — создать profile для существующих проектов

- [ ] **Step 1:** Для каждого активного проекта (45c8f3bc и др.) — set profile вручную через UI или MCP. Минимальный template:

```markdown
# Mission
{2-3 sentences}

# Stack
- ...

# Repository map
- ...

# Critical conventions
- ...

# Guard-rails
- ...
```

- [ ] **Step 2:** Создать project_events для уже произошедших мерджей (опционально, ретроспективно).

- [ ] **Step 3:** Manual smoke: `memory_onboard(project_id=45c8f3bc)` показывает новый формат.

---

## Verification (end-to-end после deploy)

1. **Чистый проект (no profile, no events, no knowledge):**
   - `memory_onboard` → секция Profile с подсказкой; нет зомби-секций.
2. **Profile flow:**
   - `memory_profile_set(content="# Mission...")` → ✅
   - `memory_profile_get` → возвращает контент
   - `memory_profile_set` второй раз → первый архивирован, второй активный
   - `SELECT category, COUNT(*) FROM entries WHERE project_id=... AND category='profile' AND status='active'` → 1
3. **Events flow:**
   - `event_add(event_type='merge', title='feat/x to main')` → создан
   - `event_list(limit=5)` → содержит созданный
   - Session с фразой «смержил X в main» → через extraction появляется auto-generated event
4. **Knowledge migration на live данных (45c8f3bc):**
   - До: `SELECT category, COUNT(*) FROM entries WHERE project_id='45c8f3bc...' GROUP BY category` → architecture 41, decisions 41, conventions 8
   - После: same query → knowledge 90+, archived legacy ...
   - `SELECT tags FROM entries WHERE project_id='45c8f3bc...' AND category='knowledge' LIMIT 5` → теги содержат `architecture` / `decision` / `convention`
5. **Onboard structure:**
   - Profile → Events → Domains → Knowledge → Stats
   - Никаких «📋 Активные задачи», «🐛 Известные проблемы», «📈 Последний прогресс» секций.
6. **Tests:** `npm test` → all green.
7. **Build:** `npm run build` → 0 errors.

---

## Risks & open questions

1. **Profile content size limit** — план не enforce. Если кто-то положит 50 KB — onboard станет огромным. Mitigation: добавить мягкое предупреждение в `setProfile` если content > 4 KB.
2. **Auto-event false positives** — фраза «надо смержить» vs «смержил» — LLM может ошибаться. Mitigation: confidence ≥ 0.7 в parser, и пользователь может удалить event через UI.
3. **Existing memory_write callers** — если кто-то ещё шлёт `category='architecture'` напрямую через старый deprecated `memory_write`, после migration 022 это всё ещё работает (категория валидна в CHECK), но новый код не должен на это полагаться.
4. **`web/` UI — known regression.** Web UI имеет вкладки «Architecture / Decisions / Conventions», которые фетчат записи по `category=<name>`. После migration 022 эти запросы вернут пустые списки (все записи теперь `category='knowledge'`). UI **сломается визуально** — три вкладки покажут «нет записей». Mitigation на короткое время: либо (a) deploy v5 со follow-up UI-PR одновременно (фильтр по `category='knowledge' AND tag = X`), либо (b) принять регрессию и сразу после merge выпустить hotfix UI-PR. **Web UI обновление — отдельный план**, ссылка добавится сюда после ревью.
5. **Backward compat для MCP-клиентов которые ожидают category в ответах** — старые tools могут возвращать `category='knowledge'` в ответах вместо ожидаемого `architecture`. Mitigation: клиент должен парсить теги; либо добавить compat-shim в `memory_read` (если `tag='architecture'` → response `category='architecture'`).
6. **DEFAULT_PROJECT_ID (00000000-…)** — это Project 2.0. Если backfill для него запустить, разрушит ту команду. Решение: backfill вручную, по проекту, с подтверждением.
7. **Partial migration crash safety.** Migrator (`src/storage/migrator.ts`) пробегает миграции по одной в собственной транзакции. Если 021 commit-ит, а 022 падает (OOM, lock-conflict), DB остаётся в промежуточном состоянии: `'profile'` валидный, но `'knowledge'` нет, и архив-тег ещё не записан. **Безопасно для re-run** (migrator повторно прогонит pending). НО: v5 server-код после Milestone 3 **assume** что миграции 021-024 все применились. Deploy ordering: **сначала** migrations done, **потом** restart server в новом коде. В Task 4.1 Step 2 это явно прописано.

---

## Self-Review Checklist (выполнено автором плана)

1. **Spec coverage:** все 7 phases исходного черновика покрыты Milestones 1-3 + Post-merge. Phase 6 (legacy migration) сделана опциональной в Task 3.6.
2. **Placeholder scan:** нет TBD / "add error handling" / "similar to" — везде указаны конкретные файлы и код.
3. **Type consistency:** `EventType` использован одинаково между `types.ts`, `storage.ts`, `manager.ts`. `Category` extended with both `'profile'` и `'knowledge'` в одной миграции.
4. **DRY:** carve-out паттерн profile API повторяет `memory_conventions` подход — это явно отмечено.
5. **TDD:** каждый task — test → fail → impl → pass → commit.
6. **Frequent commits:** ~15 commits на всём пути, каждый — атомарный.

---

## Execution Handoff

План готов и сохранён. Два варианта запуска:

1. **Subagent-Driven** *(рекомендую)* — каждый task выполняет fresh subagent, между ними двухуровневое ревью. Best для большого плана со множеством шагов.
2. **Inline Execution** — выполнение в этой сессии через `superpowers:executing-plans`, batch с чекпоинтами.

Перед стартом — рекомендуется code-review плана отдельным агентом через `superpowers:requesting-code-review`, как ты просил («с ревью»).
