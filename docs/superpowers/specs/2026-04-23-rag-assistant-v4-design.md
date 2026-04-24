# RAG-ассистент v4.0 — Design Spec

**Дата:** 2026-04-23
**Автор:** Antony Nozhenko (с AI-ассистентом)
**Статус:** Утверждено на уровне дизайна, ожидает план имплементации

## 1. Контекст и цели

### Проблема
Текущий AI-чат в team-memory-mcp работает на локальной LLM `qwen3.5:4b` через Ollama. На CPU-only виртуалке производительность катастрофическая: 3.6 tok/s, ответ в 500 токенов генерируется ~2.5 минуты, длинные ответы падают по 5-минутному таймауту. Добавление оперативки не ускорит инференс — упираемся в memory bandwidth и compute, не в RAM.

### Цель
Перейти на версию **v4.0.0** — полноценный RAG-ассистент, который:
1. Использует **Gemini 2.5 Flash** через облачный API вместо локальной LLM.
2. Умеет **вызывать инструменты MCP** (read-only subset) для получения контекста из памяти проекта.
3. Стримит ответы в реальном времени.
4. **Сохраняет историю чатов** в PostgreSQL, чтобы пользователь мог возвращаться к прошлым беседам.
5. Прозрачно показывает, какие инструменты вызвал агент (thinking-блок).

### Scope
- Только **чат** переводим на Gemini. Саммаризация сессий остаётся на Ollama (для неё 55 секунд в фоне приемлемо).
- Только **read-only инструменты** для первой итерации. Write-доступ (если понадобится) — отдельная версия.
- **Один чат = один проект** для предотвращения путаницы LLM между проектами.

### Out of scope
- Write-tools (memory_write, note_write, memory_update).
- Мульти-провайдерность (Claude, OpenAI и т.д.) — позже, если понадобится.
- UI-переключатель Gemini/Ollama в интерфейсе.
- Сложные паттерны вроде slash-команд `/project` в чате.
- Автоматический fallback на Ollama при отказе Gemini.

## 2. Ключевые решения

| Вопрос | Решение |
|---|---|
| LLM-провайдер чата | Gemini 2.5 Flash (`gemini-2.5-flash`) |
| Saммаризация сессий | Остаётся Ollama (`qwen3.5:4b`), не трогаем |
| Режим ответа | Streaming через SSE |
| Fallback при сбое Gemini | Нет — 503 с понятным сообщением |
| Tool scope | Read-only (12 инструментов) |
| RAG-стратегия | Гибрид: auto-onboard + native function calling, до 5 итераций agent loop |
| Project scoping | Один чат = один проект, выбор в UI, принудительное `project_id` в адаптере |
| Tool visibility UX | Сворачиваемый thinking-блок в UI |
| Персистентность | История чатов в PostgreSQL, per-user через `agent_token_id` |

## 3. Архитектура

### 3.1 Модули

```
src/llm/
  ollama.ts             # existing, unchanged (used by SessionManager)
  chat-provider.ts      # NEW: ChatLlmProvider interface + types
  gemini.ts             # NEW: GeminiChatProvider implementation

src/rag/
  agent.ts              # NEW: RagAgent — orchestrator (onboard + loop + streaming)
  tool-adapter.ts       # NEW: McpToolAdapter — enforces project_id, routes to managers
  tool-registry.ts      # NEW: 12 tool declarations + handlers

src/chat/
  types.ts              # NEW: ChatSession, PersistedMessage, ToolCall
  storage.ts            # NEW: ChatStorage — CRUD on chat_sessions + chat_messages
  manager.ts            # NEW: ChatManager — business logic, scoping, load-on-resume
  title-generator.ts    # NEW: LLM-based title generation after first exchange

src/storage/migrations/
  016-chat-history.sql  # NEW: schema for chat_sessions + chat_messages
```

### 3.2 Dataflow

```
Browser (chat.js)
   │ POST /api/chat/stream  (SSE response)
   ▼
app.ts /api/chat/stream handler
   │ Loads session via ChatManager.load(sessionId, tokenId)
   ▼
RagAgent.run(session, userMessage)
   │  ├─ onboardInjected? → McpToolAdapter.call('memory_onboard', {project_id})
   │  │                     → inject into system prompt (once per chat_session)
   │  │                     → set chat_sessions.onboard_injected = true
   │  │
   │  ▼ agent loop (max ragMaxIterations):
   │      GeminiChatProvider.stream({messages: rolling_window, tools: declarations})
   │        ├─ chunk: text  → forward to SSE as {type:'text', delta}
   │        ├─ chunk: functionCall → emit {type:'tool_start', name, args}
   │        │                      → McpToolAdapter.call(name, args)
   │        │                      → emit {type:'tool_end', name, ok, summary}
   │        │                      → append functionResponse → continue loop
   │        └─ chunk: done → emit {type:'done'}
   │      Persist each message via ChatManager.appendMessage
   ▼
SSE stream → browser (chat.js incrementally renders)
```

### 3.3 Граница ответственности

- `ChatLlmProvider` — знает только про конкретный LLM API (Gemini). Не знает про tools по содержанию, только формат.
- `RagAgent` — знает про agent loop, system prompt, onboard. Не знает ни про Gemini, ни про storage.
- `McpToolAdapter` — знает про MCP managers и scoping. Не знает про LLM.
- `ChatManager` — знает про persistence и пользовательский scope. Не знает про LLM или RAG-logic.

Замена провайдера в будущем = новый класс, реализующий `ChatLlmProvider`. `RagAgent` и всё остальное не трогается.

## 4. Детали компонентов

### 4.1 `ChatLlmProvider` interface

```typescript
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];      // для assistant
  toolCallId?: string;         // для tool
  toolName?: string;           // для tool
}

interface ToolCall { id: string; name: string; args: Record<string, unknown>; }

interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // JSON schema (OpenAPI subset, Gemini-совместимый)
}

// События, которые yield'ит провайдер (низкоуровневые, про LLM)
type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; usage?: { promptTokens: number; completionTokens: number } }
  | { type: 'error'; code: string; message: string };

// События, которые yield'ит RagAgent наружу в SSE (надмножество, включает
// tool_start / tool_end — они генерируются не провайдером, а агентом вокруг
// выполнения tool-вызовов)
type SseEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; summary?: string; error?: string }
  | { type: 'done' }
  | { type: 'error'; code: string; message: string };

interface ChatLlmProvider {
  readonly name: string;          // e.g. 'gemini-2.5-flash'
  isReady(): boolean;
  stream(input: { messages: ChatMessage[]; tools: ToolDeclaration[] }, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
  close(): Promise<void>;
}
```

### 4.2 `GeminiChatProvider`

- Эндпоинт: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse&key={API_KEY}`.
- Request body: `contents` (history), `systemInstruction`, `tools` (массив `functionDeclarations`), `generationConfig`.
- Ответ — SSE-стрим с `data:` JSON-чанками формата `{candidates: [{content: {parts: [{text?}, {functionCall?}]}, finishReason?}], usageMetadata?}`.
- Парсер: читает `ReadableStream`, буферизует по `\n\n`, для каждой `data:` строки парсит JSON, эмитит соответствующие `StreamEvent`.
- Timeout на весь запрос: 60 секунд через `AbortSignal.timeout(60_000)`.
- Ошибки: 401 → `api_key_invalid`, 429 → `rate_limited` (с `retry_after` из header), 5xx/network → `upstream_error`, `finishReason: SAFETY` → `safety_block`.
- API key никогда не попадает в логи (фильтр в pino serializers).

### 4.3 `RagAgent.run`

```typescript
async *run(chatSession: ChatSession, userMessage: string, signal: AbortSignal): AsyncIterable<SseEvent> {
  // 1. Onboard — один раз за жизнь chat-сессии
  if (!chatSession.onboardInjected) {
    const onboard = await this.adapter.call('memory_onboard', { project_id: chatSession.projectId });
    const systemMsg: ChatMessage = {
      role: 'system',
      content: SYSTEM_PROMPT + '\n\nКонтекст проекта:\n' + truncate(onboard, 8_000),
    };
    await this.chatManager.appendMessage(chatSession.id, systemMsg);
    await this.chatManager.markOnboarded(chatSession.id);
    chatSession.onboardInjected = true;
    chatSession.messages.unshift(systemMsg);
  }

  const userMsg: ChatMessage = { role: 'user', content: userMessage };
  await this.chatManager.appendMessage(chatSession.id, userMsg);
  chatSession.messages.push(userMsg);

  // 2. Agent loop
  for (let i = 0; i < this.config.ragMaxIterations; i++) {
    const rollingWindow = this.rollingWindow(chatSession.messages);
    const stream = this.provider.stream({ messages: rollingWindow, tools: this.adapter.declarations }, signal);
    const pendingCalls: ToolCall[] = [];
    let assistantText = '';

    for await (const ev of stream) {
      if (ev.type === 'text') { assistantText += ev.delta; yield ev; }
      else if (ev.type === 'tool_call') pendingCalls.push(ev.call);
      else if (ev.type === 'error') { yield ev; return; }
      else if (ev.type === 'done') break;
    }

    if (pendingCalls.length > 0) {
      const assistantMsg: ChatMessage = { role: 'assistant', content: assistantText, toolCalls: pendingCalls };
      await this.chatManager.appendMessage(chatSession.id, assistantMsg);
      chatSession.messages.push(assistantMsg);

      for (const call of pendingCalls) {
        yield { type: 'tool_start', id: call.id, name: call.name, args: call.args };
        try {
          const result = await this.adapter.call(call.name, call.args);
          const serialized = truncate(JSON.stringify(result), this.config.ragToolResponseMaxChars);
          const toolMsg: ChatMessage = { role: 'tool', content: serialized, toolCallId: call.id, toolName: call.name };
          await this.chatManager.appendMessage(chatSession.id, toolMsg);
          chatSession.messages.push(toolMsg);
          yield { type: 'tool_end', id: call.id, name: call.name, ok: true, summary: summarizeForUi(result) };
        } catch (err) {
          const errorPayload = JSON.stringify({ error: sanitize(err) });
          const toolMsg: ChatMessage = { role: 'tool', content: errorPayload, toolCallId: call.id, toolName: call.name };
          await this.chatManager.appendMessage(chatSession.id, toolMsg);
          chatSession.messages.push(toolMsg);
          yield { type: 'tool_end', id: call.id, name: call.name, ok: false, error: sanitize(err) };
        }
      }
      continue;
    }

    // Финальный ответ без тулов — выходим
    const finalMsg: ChatMessage = { role: 'assistant', content: assistantText };
    await this.chatManager.appendMessage(chatSession.id, finalMsg);
    chatSession.messages.push(finalMsg);
    yield { type: 'done' };
    return;
  }

  yield { type: 'error', code: 'max_iterations', message: 'Agent exceeded max tool-call iterations' };
}
```

**Rolling window:** `system + последние 30 сообщений не-system`. System prompt с onboard сохраняется всегда.

### 4.4 `McpToolAdapter`

Read-only подмножество — 12 инструментов:

| Tool | Маршрут в manager |
|---|---|
| `memory_onboard` | `memoryManager.onboard(projectId)` |
| `memory_read` | `memoryManager.read(params)` |
| `memory_cross_search` | `memoryManager.crossSearch({...params, exclude_project_id: sessionProjectId})` |
| `memory_sync` | `memoryManager.sync(since, projectId)` |
| `memory_audit` | `memoryManager.audit(params)` |
| `memory_history` | `memoryManager.history(entryId)` |
| `note_read` | `notesManager.read(params)` |
| `note_search` | `notesManager.semanticSearch(query, projectId)` |
| `session_list` | `sessionManager.list({...params, project_id: sessionProjectId})` |
| `session_search` | `sessionManager.search(query, sessionProjectId)` |
| `session_message_search` | `sessionManager.messageSearch(query)` |
| `session_read` | `sessionManager.read(id, from, to)` |

**Enforcement кода:**
```typescript
async call(name: string, llmArgs: Record<string, unknown>): Promise<unknown> {
  const handler = TOOL_REGISTRY[name];
  if (!handler) throw new ToolError('unknown_tool', name);
  const enforcedArgs = { ...llmArgs, project_id: this.projectId };
  if (name === 'memory_cross_search') enforcedArgs.exclude_project_id = this.projectId;
  return handler(enforcedArgs, this.managers, this.authContext);
}
```

**`project_id` намеренно отсутствует в function declarations** — LLM его не видит и не может подсунуть чужой. Это ключевая изоляция.

### 4.5 System prompt

```
Ты — RAG-ассистент проекта Team Memory. У тебя есть инструменты для чтения
памяти текущего проекта: решений, задач, проблем, архитектуры, заметок, сессий.

Правила:
1. ПЕРЕД ответом ВСЕГДА проверь память — вызывай инструменты вместо того чтобы
   угадывать или полагаться на общие знания.
2. Цитируй источник: упоминай ID записи/сессии или её заголовок, когда ссылаешься.
3. Если поиск не дал результата — скажи об этом прямо, не выдумывай.
4. Отвечай на языке пользователя.
5. Краткость — до 300 слов, если не просят развёрнуто.

Контекст проекта:
<memory_onboard output, truncated to 8K chars>
```

### 4.6 Persistence — схема БД

Миграция `016-chat-history.sql`:

```sql
CREATE TABLE chat_sessions (
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
CREATE INDEX idx_chat_sessions_token_updated ON chat_sessions(agent_token_id, updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX idx_chat_sessions_project ON chat_sessions(project_id) WHERE archived_at IS NULL;

CREATE TABLE chat_messages (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  tool_calls JSONB,
  tool_call_id TEXT,
  tool_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, id);
```

### 4.7 REST API

Все эндпоинты за bearer-auth. Проверяют `agent_token_id` владельца на каждом вызове.

| Method | Path | Назначение |
|---|---|---|
| `GET` | `/api/chat/sessions?project_id=<uuid>&limit=50&offset=0` | Список чатов текущего юзера (фильтр по проекту опционален) |
| `POST` | `/api/chat/sessions` | Создать: `{project_id, title?}` → `{id, title, ...}` |
| `GET` | `/api/chat/sessions/:id` | Метаданные + все сообщения (для resume) |
| `PATCH` | `/api/chat/sessions/:id` | Переименовать: `{title}` — ставит `title_is_user_set=true` |
| `DELETE` | `/api/chat/sessions/:id` | Soft-delete: `archived_at=NOW()` |
| `POST` | `/api/chat/stream` | SSE-стрим: `{session_id: uuid, message: string}` |
| `GET` | `/api/chat/status` | `{available, provider, model}` — жив ли Gemini-клиент |

### 4.8 SSE протокол `/api/chat/stream`

Request:
```json
{ "message": "string", "session_id": "uuid" }
```

Response `text/event-stream`:

| Event | Data |
|---|---|
| `text` | `{"delta": "..."}` |
| `tool_start` | `{"id": "...", "name": "memory_read", "args": {...}}` |
| `tool_end` | `{"id": "...", "name": "memory_read", "ok": true, "summary": "5 записей", "error": "..."?}` |
| `done` | `{}` |
| `error` | `{"code": "...", "message": "..."}` |

Keep-alive comment `:\n\n` каждые 15 секунд во избежание таймаутов прокси/браузера.

### 4.9 UI-изменения

**index.html:**
- В левой панели вкладки "AI Chat" добавляется sidebar со списком чатов текущего проекта + кнопка «+ Новый чат».
- Над полем ввода — `<select id="chat-project">` с проектами пользователя.

**chat.js:**
- Старая non-streaming логика удаляется.
- Новая: открывает стрим через `fetch('/api/chat/stream', {method: 'POST', ...})`, читает `res.body.getReader()`, парсит SSE, обрабатывает 5 типов событий.
- Рендерит сообщение с thinking-блоком `<details class="tool-trace">` — раскрытым во время выполнения, схлопывающимся после `done`.
- Клик по чату в sidebar → `GET /api/chat/sessions/:id` → полная история + tool-traces из JSONB.
- Контекстное меню чата: «Переименовать», «Удалить».
- Смена проекта в select → сброс текущего активного чата, загрузка списка чатов нового проекта.

**styles.css:**
- Стили для sidebar чатов, для `.tool-trace` (свёрнуто/раскрыто), для тостов ошибок.

### 4.10 Title generation

После первого **успешного** assistant-ответа (event `done`):
- Фоновая задача `titleGenerator.generate(firstUserMessage, firstAssistantReply)`.
- Промпт: `"Придумай заголовок 3-6 слов на языке сообщения, без кавычек. User: ... Assistant: ..."`.
- Gemini-вызов с `maxTokens: 20`, `temperature: 0.3`.
- Обновляет `chat_sessions.title`, если `title_is_user_set = false`.
- При сбое — тихо падает, попытка при следующем turn'е.

### 4.11 Конфигурация

`.env.example`:
```
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
RAG_MAX_ITERATIONS=5
RAG_TOOL_RESPONSE_MAX_CHARS=20000
```

`config.ts` — добавить соответствующие поля с дефолтами.

## 5. Error handling

| HTTP/ситуация | Внутр. код | SSE event | UI поведение |
|---|---|---|---|
| Нет `GEMINI_API_KEY` | `api_key_missing` | 503 при старте стрима | Тост «Gemini не сконфигурирован», input disabled |
| 401 invalid key | `api_key_invalid` | `error` | Тост «Ключ недействителен» |
| 429 rate limit / quota | `rate_limited` | `error` с `retry_after?` | Жёлтый тост |
| 5xx / network / timeout | `upstream_error` | `error` | Красный тост |
| Invalid function-call args | `bad_tool_args` | `tool_end` ok:false | ✗ в блоке, loop продолжается |
| Неизвестный tool name | `unknown_tool` | `tool_end` ok:false | Аналогично |
| Исчерпан лимит итераций | `max_iterations` | `error` | Тост + сохраняем что успели |
| Tool упал внутри | `tool_failure` | `tool_end` ok:false | Sanitized error в блоке |
| Safety block Gemini | `safety_block` | `error` | Нейтральный тост |

**Stream прерван клиентом** — `res.on('close')` → abort provider + tool execution. Незавершённый assistant-ответ не сохраняется. Уже выполненные tool-ответы остаются в БД.

**Sanitization** — stack traces наружу не уходят. В БД и в SSE — только message + код ошибки.

**Orphan tool messages** при load-on-resume — фильтруются: tool-сообщение без предшествующего assistant с соответствующим `tool_call_id` отбрасывается.

## 6. Observability

Pino структурированные логи:

- На каждый agent loop: `{ chatSessionId, projectId, iterations, toolsCalled: string[], totalLatencyMs, promptTokens, completionTokens }`.
- На каждый tool call: `{ tool, argsHash, ok, durationMs, resultBytes }`.

**НЕ логируется**: содержимое user-сообщений, tool-результатов, API-ключ, токены.

## 7. Тестирование

### 7.1 Unit (Vitest)

| Файл | Покрытие |
|---|---|
| `__tests__/gemini.test.ts` | SSE парсер, обработка 401/429/5xx, request payload, secret filtering |
| `__tests__/rag-agent.test.ts` | Agent loop сценарии: no-tools, one-round, multi-tool, max-iterations, onboard-once, rolling-window |
| `__tests__/tool-adapter.test.ts` | project_id enforcement, cross_search exclude, truncation, unknown_tool, schema validity |
| `__tests__/chat-storage.test.ts` | CRUD, soft-delete, order-by, JSONB round-trip, token scoping |
| `__tests__/chat-manager.test.ts` | create/list/rename/delete, rolling window, orphan filter, title protection |
| `__tests__/chat-api.test.ts` | Supertest на 6 REST-эндпоинтов: auth, scoping, 404, 400 |

### 7.2 Integration

| Файл | Сценарий |
|---|---|
| `__tests__/chat-e2e.test.ts` | Реальный Postgres + mocked Gemini. Сценарии: happy path, resume, project switch |

### 7.3 Manual checklist (до релиза)

1. Реальный Gemini API key → вопрос «расскажи о последних багах» → проверить вызовы `memory_read(category:"issues")` + `session_message_search`.
2. Streaming: первый чанк < 500 мс.
3. Thinking-блок: раскрытие, видны args/result.
4. Перезагрузка страницы: чат в списке, открывается с tool-traces.
5. Soft-delete: чат пропадает из UI, `archived_at` установлен в БД.
6. Safety block — нейтральный тост.
7. Отключение сети → `upstream_error` → чат не повреждён.
8. Смена проекта → список чатов перезагружается, новый чат использует новый onboard.

## 8. Риски и митигация

| Риск | Митигация |
|---|---|
| LLM галлюцинирует `project_id` и вытягивает данные чужого проекта | `project_id` форсится адаптером, LLM его не видит в declarations |
| Огромные tool-ответы съедают context window | Жёсткий truncation `ragToolResponseMaxChars=20_000` |
| Агент крутится в бесконечном loop'е | `ragMaxIterations=5` + SSE `error: max_iterations` |
| API key утечка в логи | Фильтр в pino serializers + manual review перед релизом |
| Orphan tool messages при сбое persistence | Load-on-resume filter отбрасывает без assistant-parent |
| Gemini downtime блокирует чат | 503 + понятный тост. Fallback откладываем до реальной необходимости |
| Title generation тратит квоту | `maxTokens: 20` + фоновая задача, не блокирует основной ответ |

## 9. Миграция и rollout

1. Миграция БД `016-chat-history.sql` автоматически применяется при старте (существующая миграционная система в `src/storage/migration.ts`).
2. Старый `/api/chat` endpoint удаляется, заменяется на `/api/chat/stream`. Старые in-memory сессии теряются — это ок, они ephemeral, 30-минутный TTL и так был.
3. В UI добавляется sidebar и project selector. Без переключателя между старым/новым — жёсткий переход.
4. Релиз: `v4.0.0`. Версия в `package.json` бампается с `3.0.0` до `4.0.0` в рамках этого PR (несмотря на то, что в памяти зафиксирован уже v3.4.0 — npm-версия отставала).

## 10. Открытые вопросы (для плана имплементации)

- Существует ли `GET /api/memory/projects` эндпоинт или нужно добавить `GET /api/projects` для sidebar project selector — уточнить при написании плана.
- Точная форма `summarizeForUi(result)` для каждого тула — определить в плане (например, для `memory_read` — «5 записей»; для `memory_onboard` — «контекст загружен»).
- Интерфейсы менеджеров (`memoryManager.onboard`, `crossSearch` etc.) — проверить фактические сигнатуры при имплементации, адаптер должен точно соответствовать.
