# Team Memory v5 — Postwork: полный аудит-фикс перед Azure integration

**Дата:** 2026-05-15
**Источник:** scope-note `c56ffeb9` + read-only аудит 5 параллельными explore-агентами (frontend, REST API, storage, sessions/extraction, MCP server) от 2026-05-15
**Working directory:** `D:\MCP\team-memory-mcp`
**Базовая ветка:** `main` (HEAD = `5d0985d`)
**Целевая ветка:** `feat/v5-postwork-bugfixes` (создаётся в Phase 0)

## Контекст

V5 (Profile + Events + Knowledge unification) уже смерджен в main и задеплоен. Перед Azure DevOps integration нужно:
1. Закрыть UX-баги, которые блокируют демо
2. Закрыть data-integrity / security issues, которые усугубятся под нагрузкой webhook-импорта
3. Снять architecturalые риски, которые сделают Azure phase болезненной

Azure-specific подготовки (PAT encryption, webhook auth, dedup keys для project_events) **НЕ** в этом плане — они в отдельном Azure phase.

## Скоуп: всего **42 находки**

| Severity | Кол-во | Применимо к Azure prep |
|---|---|---|
| BLOCKER | 11 | Все обязательно до Azure |
| MAJOR | 19 | Желательно до Azure |
| MINOR | 12 | Можно параллельно |

## File Structure

### Новые файлы

| Путь | Ответственность |
|---|---|
| `src/storage/migrations/026-postwork-integrity.sql` | personal_notes FK CASCADE + add CHECK на event_type в app-validation + comments на enum drift |
| `src/storage/migrations/026-postwork-integrity.rollback.sql` | Rollback миграции 026 |
| `src/web/public/components/modal.js` | Единый компонент `showConfirmModal(title, message, opts)` + focus trap + ESC handler |
| `src/web/public/styles-modal.css` | Стили для custom confirm/prompt modal (или внутри styles.css секция) |
| `src/__tests__/migration-026-postwork-integrity.test.ts` | Тесты на FK CASCADE и enum validation |
| `src/__tests__/audit-projectid-required.test.ts` | Тест что memory_audit БЕЗ project_id отдаёт пусто/403, а не global leak |
| `src/__tests__/setProfile-transaction.test.ts` | Concurrent setProfile race test |
| `src/__tests__/pagination-offset-cap.test.ts` | Тесты что offset=999999999 не вешает DB |

### Изменяемые файлы

| Путь | Что меняется |
|---|---|
| `src/server.ts:737-768` (memory_audit) | requireProjectId для memory_audit; отказать или вернуть пусто если project_id отсутствует |
| `src/middleware/auth.ts:29-50` | UUID-валидация X-Project-Id header |
| `src/app.ts:371-572` (все pagination) | Math.min(offset, 10000) на всех `parseInt`-путях, единая helper-функция |
| `src/app.ts:619-641` (POST /api/notes) | Применить Zod-схему для priority/session_id/title/content |
| `src/web/server.ts:482-535` (backup) | pg_dump через PGPASSWORD env var, не CLI args |
| `src/memory/manager.ts:899-925` (setProfile) | Обернуть archive+write в одну транзакцию через `pg-storage.withTransaction()` |
| `src/storage/pg-storage.ts:698-702` (archive) | Поддержка `expectedVersion`, не игнорировать конфликт |
| `src/sync/websocket.ts:119-189` | Per-project фильтрация broadcast (`agent:connected`, `entry:updated`, etc.) |
| `src/sync/websocket.ts:174-189` | Validation `client.name` по whitelist `/^[a-zA-Z0-9 ._-]{1,64}$/` вместо replace |
| `src/middleware/rate-limit.ts:43-46` | LRU eviction вместо FIFO |
| `src/notes/manager.ts:327-336` (share race cleanup) | propagate error if rollback delete fails |
| `src/extraction/merger.ts:99-114` | НЕ fallback к raw candidate; throw → caller считает CREATE_NEW |
| `src/embedding/ollama.ts:135-172` | Убрать zero-vector fallback; throw на error, помечать candidate как `embedding_failed` |
| `src/events/extractor.ts:57` | Default `minConfidence` 0.55, configurable через env |
| `src/sessions/manager.ts:145-150` | Переписать LLM summary parser на split+find+validate, не regex |
| `scripts/session-sync.cjs:72-83` | `console.error` + `process.exit(1)` при отсутствии project_id |
| `src/web/public/app.js` (12 точек: `671, 1394, 1421, 1653, 1676, 1743, 1853, 2195, 2226, 2628, 2977, 3153`) | Заменить `confirm()/prompt()/alert()` на `showConfirmModal()` |
| `src/web/public/app.js` (Profile tab) | `loadProfile()` функция + nav item handler |
| `src/web/public/app.js:3141` | `await loadNotes()` + optimistic insert в `notesData` перед await |
| `src/web/public/app.js:2884, 2896` | Заменить native `<select>` на `.custom-select` в share modal |
| `src/web/public/app.js:436-452` (switchProject) | Sequential WS-close → projectId update → API + WS reconnect |
| `src/web/public/app.js:841` + switchProject | Re-load events если активен events tab при смене проекта |
| `src/web/public/app.js:1752-1788` (WS) | Debounce re-render 100ms + applyWSUpdate в `entries[]` |
| `src/web/public/app.js:1087-1126` (markdown) | DOMPurify.sanitize() с whitelist tags перед `innerHTML` |
| `src/web/public/index.html` | Удалить inline `style="..."`, ввести классы `.hidden`, добавить ARIA labels |
| `src/web/public/index.html` (CDN scripts) | Подключить DOMPurify CDN (или npm bundle) |
| `src/web/public/chat.js:629` (ESC handler) | Вынести в общий modal-helper |
| `src/storage/pg-storage.ts:718-778` (getStats) | Single query с GROUPING SETS |
| `src/storage/pg-storage.ts:978-984` (trackReads) | Promise.race с 1s timeout, лог при таймауте |
| `src/sessions/storage.ts:42-62` (batch insert) | Track inserted batches + assertion после commit |

### Сохранение существующих паттернов
- Миграции автоматически подхватываются `migrator.ts` — просто положить `026-*.sql` + rollback
- Modal-компонент следует паттернам `chat.js:629` (ESC handler уже там)
- Транзакция в `setProfile` через `pg-storage.withTransaction(client => ...)` (паттерн уже используется в `notes/storage.ts`)
- Rate limiter — заменить in-memory Map на встроенный LRU (можно `lru-cache` npm), либо ручной LRU
- pg-storage `archive()` — расширить signature как у `update()`

---

## Pre-flight

### Task 0.1: Создать рабочую ветку

- [ ] **Step 1:** Создать ветку
```bash
cd D:/MCP/team-memory-mcp
git fetch origin
git checkout -b feat/v5-postwork-bugfixes origin/main
```

- [ ] **Step 2:** Поднять dev-окружение
```bash
docker compose up -d
npm install
npm run build
npm test  # baseline зелёный
```

- [ ] **Step 3:** Подтвердить что main = `5d0985d`
```bash
git rev-parse origin/main  # должно быть 5d0985d или новее
```

---

## Phase 0 — Critical Security & Data Leak (HIGHEST priority)

**Goal:** закрыть утечки данных и DoS-векторы. Без этого нельзя выкатывать.

### Task 0.A — memory_audit утекает global audit log [BLOCKER, MCP B3]

**Где:** `src/server.ts:737-768`

Сейчас при отсутствии `project_id` (ни в args, ни в header) и без `entry_id` тулза вызывает `auditLogger.getRecent(auditLimit)` — возвращает audit ВСЕХ проектов. Это утечка cross-project metadata.

- [ ] **Step 1:** Изменить логику в `case 'memory_audit'`:
  - если `auditEntryId` есть → как сейчас, но дополнительно проверить что entry принадлежит проекту вызывающего токена (если `resolvedAuditProjectId` есть — entry.projectId должно совпадать)
  - если `resolvedAuditProjectId` есть → `getByProject(resolvedAuditProjectId, auditLimit)`
  - иначе → вернуть `{ content: [...], isError: true }` с текстом "project_id обязателен"

- [ ] **Step 2:** Тест `audit-projectid-required.test.ts`:
  - вызов без project_id + без entry_id → isError
  - вызов с project_id A токеном с scope projectA → 200, только записи A
  - вызов с project_id B токеном с scope projectA → если есть RBAC, 403; иначе 200 пока

- [ ] **Step 3:** Smoke через MCP

### Task 0.B — Pagination offset DoS [BLOCKER, REST B2]

**Где:** `src/app.ts` все pagination endpoints (371, 405, 428, 572 и др.)

`parseInt(offset)` без cap → `OFFSET 999999999` стопорит DB.

- [ ] **Step 1:** В `src/middleware/` создать `parsePagination(req)` helper, возвращает `{ limit: 1..500, offset: 0..10000 }`. Все endpoints используют его.

- [ ] **Step 2:** Тест `pagination-offset-cap.test.ts`:
  - offset=999999999 → ответ за < 100ms, OFFSET 10000 на SQL уровне

### Task 0.C — pg_dump password в process args [BLOCKER, REST M5]

**Где:** `src/web/server.ts:505`

`execFileSync('pg_dump', [dbUrl])` — пароль из DATABASE_URL виден в `ps` / docker inspect.

- [ ] **Step 1:** Разобрать URL → `{ user, host, port, database, password }`
- [ ] **Step 2:** Запустить `execFileSync('pg_dump', ['-h', host, '-p', port, '-U', user, '-d', database], { env: { ...process.env, PGPASSWORD: password }, stdio: ['pipe', fd, 'pipe'] })`
- [ ] **Step 3:** Verify в `ps aux | grep pg_dump` — нет пароля

### Task 0.D — X-Project-Id header без UUID validation [BLOCKER, MCP M3]

**Где:** `src/middleware/auth.ts:29-50`

Header копируется в `req.auth.projectId` без проверки формата. SQL injection защищён parametrized queries, но нужна defence-in-depth.

- [ ] **Step 1:** В auth middleware: после `headerProjectId = req.headers['x-project-id']`, если есть — `if (!isValidUUID(headerProjectId)) return res.status(400)`
- [ ] **Step 2:** Тест с заголовком `X-Project-Id: '; DROP TABLE entries; --` → 400

### Task 0.E — Project scope enforcement [BLOCKER, REST B1]

**Где:** все `/api/...` endpoints (sessions, notes, profile, events, memory)

Auth middleware ставит `req.auth.projectId` (scope токена), но handlers не сравнивают его с `projectId` из query/body. Токен с scope projectA может читать projectB.

- [ ] **Step 1:** В `middleware/auth.ts` добавить `enforceProjectScope(targetProjectId, req)` — если `req.auth.projectId` ≠ targetProjectId и не master-токен, 403.
- [ ] **Step 2:** Применить в handler'ах: после resolve target projectId — `enforceProjectScope(targetProjectId, req)`.
- [ ] **Step 3:** Тест: токен scope=A, запрос GET /api/memory?project_id=B → 403

> Примечание: пересекается с future-RBAC (note `30bb4de4`). Это базовый enforcement, RBAC будет надстройкой.

---

## Phase 1 — Data integrity (миграции + транзакции)

### Task 1.A — Миграция 026: postwork integrity [BLOCKER, Storage B2 + M1]

**Файл:** `src/storage/migrations/026-postwork-integrity.sql`

```sql
-- 1. personal_notes — добавить ON DELETE CASCADE на project_id
ALTER TABLE personal_notes DROP CONSTRAINT IF EXISTS fk_personal_notes_project;
ALTER TABLE personal_notes
  ADD CONSTRAINT fk_personal_notes_project
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

-- 2. Документировать enum drift
COMMENT ON COLUMN sessions.embedding_status IS
  'Pipeline lifecycle: queued → summarizing → extracting_notes → complete | failed. Separate from entries.status.';
COMMENT ON COLUMN entries.status IS 'Entry lifecycle: active | completed | archived.';
COMMENT ON COLUMN personal_notes.status IS 'Note lifecycle: active | archived.';

-- 3. event_type CHECK уже есть в 023, но добавить comment с canonical list
COMMENT ON COLUMN project_events.event_type IS
  'Canonical: merge | release | deploy | incident | milestone. App-level validator enforced in src/events/storage.ts.';
```

Rollback: убрать FK CASCADE (вернуть SET NULL), удалить comments.

- [ ] **Step 1:** Написать миграцию + rollback
- [ ] **Step 2:** Тест `migration-026-postwork-integrity.test.ts` — DELETE project → personal_notes того проекта удалены каскадно
- [ ] **Step 3:** Применить локально, прогнать `npm test`

### Task 1.B — setProfile race condition [BLOCKER, scope-note B6 + Storage B1]

**Где:** `src/memory/manager.ts:899-925`

Сейчас `getProfile() → archive() → write()` без транзакции → два параллельных setProfile нарушают partial UNIQUE.

- [ ] **Step 1:** Добавить `pg-storage.withTransaction<T>(fn: (client) => Promise<T>)` если ещё нет
- [ ] **Step 2:** Переписать `setProfile`:
```typescript
return this.storage.withTransaction(async (client) => {
  await client.query(`SELECT id FROM entries WHERE project_id=$1 AND category='profile' AND status='active' FOR UPDATE`, [projectId]);
  await client.query(`UPDATE entries SET status='archived' WHERE project_id=$1 AND category='profile' AND status='active'`, [projectId]);
  const newEntry = await client.query(`INSERT INTO entries (...) VALUES (...) RETURNING *`, [...]);
  return newEntry.rows[0];
});
```
- [ ] **Step 3:** Тест `setProfile-transaction.test.ts` — 10 concurrent setProfile → ровно 1 active profile, нет conflict 23505 наружу
- [ ] **Step 4:** Запустить против стейджа

### Task 1.C — archive() поддерживает expectedVersion [BLOCKER, Storage B3]

**Где:** `src/storage/pg-storage.ts:698-702`

- [ ] **Step 1:** Расширить signature `archive(id, expectedVersion?)` → возвращает `MemoryEntry | ConflictError | undefined`
- [ ] **Step 2:** `memory_delete` с `archive=true` корректно обрабатывает conflict — возвращает 409
- [ ] **Step 3:** Тест

### Task 1.D — external_refs / evidence_sources JSONB validation [BLOCKER, Storage B4]

**Где:** `src/notes/validation.ts:61` + `src/events/storage.ts` + commented schema

- [ ] **Step 1:** Zod-схема `ExternalRefsSchema` (whitelist полей: pr_number, commit_sha, version_tag, deployment_url, incident_id), `EvidenceSourcesSchema` (session, message_id)
- [ ] **Step 2:** Применить при insert/update notes и events
- [ ] **Step 3:** В миграции 026 добавить `COMMENT` с canonical schema

### Task 1.E — Session batch insert assertion [MAJOR, Storage M3]

**Где:** `src/sessions/storage.ts:42-62`

После цикла batch insert проверить что `messageCount === Σ batches`.

- [ ] **Step 1:** Counter + assert + rollback при mismatch

### Task 1.F — getStats() N+1 → GROUPING SETS [MAJOR, Storage M2]

**Где:** `src/storage/pg-storage.ts:718-778`

- [ ] **Step 1:** Один query с `GROUP BY GROUPING SETS ((category), (domain), (status), (priority))`
- [ ] **Step 2:** Benchmark: до/после на 10k entries
- [ ] **Step 3:** Тест что результат идентичен старому

### Task 1.G — Cascade inconsistency: project_events vs sessions [MAJOR, Storage B5]

Решение: оставить `ON DELETE SET NULL` для sessions/chat_sessions (так как они — независимые артефакты), и `ON DELETE CASCADE` для project_events (это часть жизненного цикла проекта). Документировать в COMMENT в миграции 026.

- [ ] **Step 1:** Добавить COMMENT в миграции 026 с rationale (см. выше)
- [ ] **Step 2:** Уточнить policy в docs/architecture/ если есть

---

## Phase 2 — UX BLOCKER (модалки, Profile, optimistic update)

### Task 2.A — Единый confirm-modal компонент [BLOCKER, scope-note B2]

**Файл:** `src/web/public/components/modal.js` (новый)

```javascript
// Глобальный API:
window.showConfirmModal({ title, message, confirmText, cancelText, onConfirm, onCancel });
window.showPromptModal({ title, message, defaultValue, onSubmit });
window.showAlertModal({ title, message, onClose });

// Под капотом — один <div class="app-modal" role="dialog" aria-modal="true"> в DOM,
// focus trap, ESC handler, Tab cycle, restore focus on close.
```

- [ ] **Step 1:** Реализовать компонент (~150 LoC)
- [ ] **Step 2:** Подключить в `index.html` (`<script src="/components/modal.js"></script>`)
- [ ] **Step 3:** Стили в `styles.css` или новый `modal.css`
- [ ] **Step 4:** Заменить все 12 native dialogs:
  - app.js:671 (logout)
  - app.js:1394 (revoke token confirmation)
  - app.js:1421 (delete project)
  - app.js:1653 (clear session)
  - app.js:1676 (delete session)
  - app.js:1743 (archive entry)
  - app.js:1853 (delete entry)
  - app.js:2195, 2226 (note operations)
  - app.js:2628 (chat clear)
  - app.js:2977 (note delete from list)
  - app.js:3153 (deleteNote)
- [ ] **Step 5:** E2E через Playwright: открыть модалку, ESC закрывает, Tab трапится

### Task 2.B — Profile tab loadProfile() [BLOCKER, scope-note B3]

**Где:** `src/web/public/app.js` + `index.html`

- [ ] **Step 1:** Добавить `case 'profile'` в `categoryConfig` (single-card view, не grid)
- [ ] **Step 2:** Реализовать `loadProfile()` — GET `/api/projects/:id/profile`, render single markdown card
- [ ] **Step 3:** Кнопка редактирования → `setProfile` через UI (textarea + save)
- [ ] **Step 4:** При смене проекта re-load profile (см. Task 3.B)

### Task 2.C — Optimistic update при create note [BLOCKER, scope-note B1 + Frontend B1]

**Где:** `app.js:3141`

Сейчас: `closeNoteModal()` → `loadNotes();` (fire-and-forget). Юзер видит закрытие модалки, но список не обновляется до следующего render.

- [ ] **Step 1:** Перед POST — `closeNoteModal()` НЕ закрывать сразу
- [ ] **Step 2:** После 200 OK — добавить новую заметку в `notesData[]` сверху и вызвать `renderNotes()` синхронно
- [ ] **Step 3:** `await loadNotes()` после для consistency
- [ ] **Step 4:** Тест: создать заметку → видна в списке без reload

### Task 2.D — Share modal: native select → custom-select [BLOCKER promotion — UX, scope-note M2]

**Где:** `app.js:2884, 2896`

- [ ] **Step 1:** В `openShareNoteModal()` заменить `<select>` на `.custom-select` div structure
- [ ] **Step 2:** `initFormSelect('share-note-category-select', [...])`
- [ ] **Step 3:** Smoke

---

## Phase 3 — UX MAJOR

### Task 3.A — Project switch race [MAJOR, scope-note M1]

**Где:** `app.js:436-452` (switchProject)

- [ ] **Step 1:** Sequence: close WS → update `currentProjectId` → await all loads + initWebSocket
- [ ] **Step 2:** Loading state блокирует UI до готовности
- [ ] **Step 3:** Тест: спам-клики по project-selector не вызывают stale data

### Task 3.B — Events tab refresh при смене проекта [MAJOR, scope-note M3]

**Где:** `app.js` (switchProject)

- [ ] **Step 1:** В switchProject после reload domains/entries/stats: `if (currentCategory === 'events') loadEvents();`
- [ ] **Step 2:** Аналогично для profile/knowledge

### Task 3.C — Modal a11y: ESC, focus trap, restore focus [MAJOR, scope-note M4 + M5]

**Где:** все модалки в `app.js` + `chat.js:629`

Реализуется через Task 2.A компонент `showConfirmModal`. Существующие модалки (entry-modal, read-modal, etc.) — обернуть в helper `openModalWithA11y(modal)` / `closeModalWithA11y(modal)`.

- [ ] **Step 1:** Helper в `components/modal.js`
- [ ] **Step 2:** Применить ко всем существующим модалкам (entry, read, note, share, chat-config, etc.)
- [ ] **Step 3:** Тест: открыть → focus на первом input, ESC закрывает, Tab трапится, focus возвращается на trigger button

### Task 3.D — XSS в renderMarkdown [MAJOR, scope-note M10 + Frontend M10]

**Где:** `app.js:1087-1126`

- [ ] **Step 1:** Подключить DOMPurify (CDN или npm bundle)
- [ ] **Step 2:** В `renderMarkdown(text)` финальный шаг: `DOMPurify.sanitize(html, { ALLOWED_TAGS: ['strong','em','u','code','h2','h3','h4','ul','ol','li','br','p','a'], ALLOWED_ATTR: ['href'] })`
- [ ] **Step 3:** Тест: `<img src=x onerror=alert(1)>` в content → не выполняется

### Task 3.E — WebSocket re-render и debounce [MAJOR, scope-note M8 + Frontend M8 + m18]

**Где:** `app.js:1752-1788`

- [ ] **Step 1:** `applyWSUpdate(msg)` обновляет `entries[]`/`notesData[]` per project filter
- [ ] **Step 2:** Debounce 100ms перед `renderEntries()` / `renderNotes()`
- [ ] **Step 3:** Tests: 100 ws events за 200ms → ≤ 2 рендера

### Task 3.F — WebSocket broadcast per-project filter [MAJOR, REST M1]

**Где:** `src/sync/websocket.ts:119-189`

- [ ] **Step 1:** В `broadcastExcept`/`broadcast` фильтровать по `client.projectId === sourceProjectId || !client.projectId(readonly)`
- [ ] **Step 2:** Для `agent:connected` события — readonly клиенты получают только `agentName` (без `clientId`/`projectId`)
- [ ] **Step 3:** Validate `client.name` через whitelist `/^[a-zA-Z0-9 ._-]{1,64}$/`, не replace

### Task 3.G — external_refs schema validation в UI [MAJOR, scope-note M6 + Frontend M5]

**Где:** `app.js:3119, 3127` + render места

- [ ] **Step 1:** `validateExternalRefs(refs)` filter по whitelist
- [ ] **Step 2:** Применить при отображении и сохранении

---

## Phase 4 — API MAJOR

### Task 4.A — POST /api/notes Zod validation [MAJOR, REST B3]

**Где:** `app.ts:619-641`

- [ ] **Step 1:** `NotesCreateSchema` (title, content, priority enum, session_id uuid, tags array)
- [ ] **Step 2:** `.safeParse(req.body)`, 400 при ошибке

### Task 4.B — Note share idempotency [MAJOR, REST M3 + MCP M5]

**Где:** `app.ts:686-801` + `src/notes/manager.ts:327-336`

- [ ] **Step 1:** Поддержка header `Idempotency-Key` (опционально)
- [ ] **Step 2:** Pessimistic lock `SELECT ... FOR UPDATE` на dedup-кандидате
- [ ] **Step 3:** Если cleanup-delete после race-loss падает — propagate error

### Task 4.C — Audit logging для auth failures [MAJOR, REST m7 + m9]

**Где:** `src/middleware/auth.ts:53, 59, 86` + `agent-tokens.ts:63-90`

- [ ] **Step 1:** На каждый reject (401/403) — `logger.warn({ ip, authHeader: redact(...), reason })`
- [ ] **Step 2:** На create/revoke/remove token — `logger.info({ action, tokenId, actor })`

### Task 4.D — Rate limiter: LRU eviction + token-based [MAJOR, REST B4 + M7]

**Где:** `src/middleware/rate-limit.ts:43-46`

- [ ] **Step 1:** Заменить FIFO на LRU (либо `lru-cache` либо ручной Map с touch on access)
- [ ] **Step 2:** Tokenized limiter: per `(req.auth?.clientId, req.ip)` tuple
- [ ] **Step 3:** Stricter limit для master-token (50 req/min)

### Task 4.E — Express JSON body size cap [MAJOR, REST m2]

**Где:** `app.ts:66`

- [ ] **Step 1:** Снизить с `'50mb'` до `'10mb'` глобально
- [ ] **Step 2:** На endpoint `session_import` оставить `'50mb'` (большие JSONL)

### Task 4.F — session_import dedup [MAJOR, MCP M6]

**Где:** `src/server.ts:1174-1201` + sessions/manager.ts

- [ ] **Step 1:** Если `external_id` есть → UPSERT
- [ ] **Step 2:** Если нет → check `(name, project_id, started_at)` tuple, warn в response про возможный duplicate

### Task 4.G — fail-fast на DATABASE_URL [MAJOR, MCP M7]

**Где:** `src/app.ts` startup

- [ ] **Step 1:** После `loadConfig` — `await storage.getPool().query('SELECT 1')` с timeout 5s
- [ ] **Step 2:** При ошибке — `logger.fatal()`, `process.exit(1)`

### Task 4.H — Tool descriptions cleanup [MAJOR, MCP B1 + B2 + M4 + M8]

- [ ] **Step 1:** `memory_read` description: добавить про `ids` ignore filters
- [ ] **Step 2:** `session_read` schema: cross-field validation `message_from <= message_to` (Zod refine)
- [ ] **Step 3:** `memory_update` description: упомянуть semantics pinned+completed
- [ ] **Step 4:** `event_add`: либо добавить `auto_generated` в inputSchema, либо убрать из description

### Task 4.I — Readonly: убрать readCount/lastReadAt из ответа [MAJOR, REST m10]

**Где:** `app.ts` GET /api/memory + pg-storage `read()` маппинг

- [ ] **Step 1:** Если `req.readOnly === true` — strip `readCount`, `lastReadAt` из result

### Task 4.J — WS auth unification [MAJOR, REST M2]

**Где:** `src/sync/websocket.ts:54-86`

- [ ] **Step 1:** Если auth required → WS handshake rejects без `Authorization: Bearer`
- [ ] **Step 2:** Query-param `?token=...` deprecated, warn в логе
- [ ] **Step 3:** Документировать

---

## Phase 5 — Sessions / Extraction / Pipeline

### Task 5.A — Events extractor confidence threshold [BLOCKER PIPELINE, scope-note 0593646d + Sessions B1]

**Где:** `src/events/extractor.ts:57`

- [ ] **Step 1:** Default `minConfidence` 0.55, env override `TM_EVENTS_MIN_CONFIDENCE`
- [ ] **Step 2:** Re-run backfill на staging, измерить precision/recall на seed dataset из 50 сессий

### Task 5.B — LLM summary parser rewrite [BLOCKER PIPELINE, Sessions B2]

**Где:** `src/sessions/manager.ts:145-150`

- [ ] **Step 1:** Заменить regex на `split('\n') + find(startsWith) + trim + validate`
- [ ] **Step 2:** Validate: title length 3..120, summary length ≥ 20. Иначе → fallback `'Pending summarization...'`
- [ ] **Step 3:** Unit тест с разными форматами LLM-output (с Tags / без / пустой / только Title)

### Task 5.C — Zero-vector embedding removal [MAJOR, Sessions M2]

**Где:** `src/embedding/ollama.ts:135-172`

- [ ] **Step 1:** При single-embed fail — НЕ push zero-vector
- [ ] **Step 2:** Mark candidate с `embedding_failed: true`, skip из dedup
- [ ] **Step 3:** Логирование с reason

### Task 5.D — NoteMerger fallback to CREATE_NEW [MAJOR, Sessions M4]

**Где:** `src/extraction/merger.ts:99-114`

- [ ] **Step 1:** При parse fail — НЕ fallback к raw candidate
- [ ] **Step 2:** Throw → caller обрабатывает как CREATE_NEW (новая запись), а не silent duplicate

### Task 5.E — Events extraction retry [MAJOR, Sessions M3]

**Где:** `src/sessions/manager.ts:278-299`

- [ ] **Step 1:** 1 retry с backoff 2s при malformed JSON или transient error
- [ ] **Step 2:** Если 2 попытки fail — log error с session_id и продолжить (не блокировать notes extraction)

### Task 5.F — session-sync.cjs explicit failure [MAJOR, Sessions M1]

**Где:** `scripts/session-sync.cjs:72-83`

- [ ] **Step 1:** При отсутствии project_id или token — `console.error('TM-SYNC: missing X-Project-Id or token, skipping')` + `process.exit(1)`
- [ ] **Step 2:** При HTTP error — `console.error`, не silent `exit(0)`

### Task 5.G — Note share dedup cleanup error propagate [MINOR, Sessions m2]

**Где:** `src/notes/manager.ts:327-336`

- [ ] **Step 1:** При неудачном rollback-delete — log error + throw distinct error

### Task 5.H — Empty LLM summary validation [MINOR, Sessions m1]

**Где:** `src/sessions/manager.ts:150` (см. также Task 5.B — частично уже там)

---

## Phase 6 — MINOR cleanup

### Frontend MINOR
- [ ] **6.1** `m1`: Notes count badge update после share/delete (`updateSessionNotesCounts()` после операций)
- [ ] **6.2** `m2`: loadStats — diff-update, не replace
- [ ] **6.3** `m3`: Toast icons (✓/✕/ℹ)
- [ ] **6.4** `m4`: Sidebar collapse — per-tab key
- [ ] **6.5** `m5`: DocumentFragment вместо innerHTML на append
- [ ] **6.6** `m6`: addEventListener cleanup на re-render
- [ ] **6.7** `m7`: inline `style="..."` → классы `.hidden`/`.invisible`
- [ ] **6.8** `SEC1` (graph.js:440, 452): `textContent` вместо `innerHTML` или DOMPurify
- [ ] **6.9** `SEC2` (app.js:1467): URLSearchParams (уже escapes — verify)
- [ ] **6.10** `A1`: ARIA labels на icon buttons (logout, etc.)
- [ ] **6.11** `A2`: WCAG AA contrast для disabled states

### Storage MINOR
- [ ] **6.12** `m1` (Storage): `trackReads()` — Promise.race с 1s timeout
- [ ] **6.13** Index verification: `EXPLAIN ANALYZE` для всех частых queries, добавить indexes если seq-scan

### MCP / API MINOR
- [ ] **6.14** Error message language uniformity — выбрать ru или en, не mix
- [ ] **6.15** memory_read: warning в response если `limit` был capped
- [ ] **6.16** Graceful shutdown timeout 30s + configurable `TM_SHUTDOWN_GRACE_SEC`
- [ ] **6.17** DB error code redaction в API responses (m1 REST)
- [ ] **6.18** Chat session lock TTL cleanup (m4 REST)
- [ ] **6.19** Export endpoint streaming (m5 REST)

---

## Phase 7 — Validation & merge

### Task 7.A — Полная регрессия

- [ ] `npm test` — все зелёные (369 + новые ~12)
- [ ] `npm run build` — TS clean
- [ ] Manual smoke в UI: создать заметку → видна, открыть Profile tab → загружается, ESC закрывает все модалки, поменять проект → нет flash
- [ ] E2E через Playwright: 5 happy paths
- [ ] Load test: 1000 concurrent reads + 10 setProfile → нет 23505 наружу

### Task 7.B — Self-review

- [ ] Прочитать diff: нет console.log, нет TODO, нет debug-кода
- [ ] Все commits — small, atomic, с осмысленными сообщениями
- [ ] Plan checkbox-и обновлены

### Task 7.C — Merge

- [ ] PR на main
- [ ] Code review (или ultrareview)
- [ ] Merge → деплой → smoke на проде

---

## Estimates

- Phase 0: 4-6h (security critical)
- Phase 1: 6-8h (migrations + tests)
- Phase 2: 8-10h (modal component самый затратный)
- Phase 3: 6-8h
- Phase 4: 8-10h
- Phase 5: 6-8h
- Phase 6: 4-6h (cleanup)
- Phase 7: 3-4h

**Total: ~45-60h работы.**

Реалистично разнести на 4-6 сессий. В этой сессии — Phase 0 + начало Phase 1.

---

## Что НЕ в этом плане

- **Azure DevOps integration** (B4, B5, B7, B8 из scope-note + M7, M9, m11-m16): отдельная phase после merge этого плана
- **RBAC** (note `30bb4de4`): зависит от Azure phase, parked
- **Auto-bootstrap profile из репо** (note `7e448e67`): требует Azure access, parked
- **CSRF** (REST M6): preventive, нужно только если введём cookie auth
