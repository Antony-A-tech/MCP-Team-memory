# Auto-Notes from Sessions (v4.5) — Design Spec

**Дата:** 2026-04-28
**Автор:** Antony Nozhenko (с AI-ассистентом)
**Статус:** Утверждено на уровне дизайна, ожидает план имплементации

## 1. Контекст и цели

### Проблема

Текущая модель ввода командной памяти не работает:

- За время использования системы в проекте Moorinet 2.0 накопилось 282 записи в `entries`. По факту это шум: задачи (`tasks`), отчёты прогресса (`progress`), эпизодические баги (`issues`) — то, что нативно живёт в Azure DevOps work items, в git/PR-истории и в импортированных сессиях соответственно.
- Записи делаются вручную через `memory_write` агентами — но они игнорируют системные промпты и скиллы, требующие писать. Реально полезные записи единичны.
- Ручной ввод людьми не происходит совсем (за всё время — 0 записей, кроме тестовых).
- Decay по устареванию не помогает — мусор просто архивируется, а новый продолжает поступать.
- Скилл `using-team-memory` навязывает агенту обязанность писать после каждого значимого действия — на практике это проигранная битва, агенты эту нагрузку не выдерживают.

### Цель

Перейти на версию **v4.5** с принципиально иной моделью наполнения `entries`:

1. **Заметки = distilled WHY**, а не журнал работы. Они — единственный слой системы, где живёт «почему так, не иначе» в концентрированном виде.
2. **Источник наполнения — импортированные сессии команды**, обработанные LLM-extractor'ом с жёсткими фильтрами качества.
3. **Ручной ввод — только через personal notes + явный share**. Прямое `memory_write` отключается.
4. **Cross-session подтверждение** заменяет ручную модерацию: важность определяется тем, сколько независимых сессий упомянули один и тот же факт.
5. **Auto-decay одиночных записей**: если факт за 30 дней не подтвердился ни одной новой сессией — архивируется автоматически.

### Целевая аудитория и сценарии использования

- **Разработчик команды**, садящийся за новую задачу: запрашивает `memory_onboard` → получает короткий список реальных WHY-фактов проекта, отсортированных по важности, без шума.
- **RAG-агент дашборда** (v4.0+): использует трёхуровневую иерархию retrieval — сначала L1 (заметки) для каноничных WHY, затем L2/L3 (сессии и сообщения) для глубокого контекста.
- **Lead/архитектор**: хочет зафиксировать архитектурное решение → пишет в personal notes (как черновик) → нажимает «Расшарить» → запись попадает в команду с пометкой `pinned=true`.

### Что НЕ решается этой версией (out of scope для v4.5)

- Любая интеграция с Azure DevOps — отложена на v5.0 (PR, wiki, work items, code review).
- Индексация кодовой базы в Qdrant — v5.0.
- Двунаправленные ссылки заметка ↔ код — v5.0.
- Cleanup существующих 282 шумных записей в Moorinet 2.0 — отдельная задача после прогона нового extractor 1–2 недели на новых сессиях. Старые записи под decay уйдут сами.
- Отдельная UI-вкладка «авто-заметки vs ручные» — фильтр по `auto_generated` достаточно реализовать в существующей вкладке `entries`.
- Сложные multi-source confirmation (автоматическое усиление заметки при упоминании в PR / wiki) — задел в схеме делаем, реализация в v5.0.

### Задел на v5.0 (закладывается в дизайне сейчас)

Чтобы интеграция с Azure не требовала миграций схемы и переписывания extractor'а:

1. `evidence_sources` сразу делается JSONB-массивом с полем `type` — в v5 добавятся `pr` / `wiki` / `code_review` / `work_item` без `ALTER TABLE`.
2. `external_refs` JSONB — место для исходящих ссылок на Azure-сущности (work items, PRs, code paths).
3. Extractor получает абстрактный текстовый вход с метаданными — в v5 будет вызываться не только из session worker, но из webhook'ов Azure.
4. Введение слоя `KnowledgeSource` / `HierarchicalRetrieval` — RAG-агент v4 переключается на эту абстракцию; в v5 регистрируются дополнительные источники (`CodeSource`, `PrSource`, `WikiSource`) без изменений в самом агенте.

## 2. Ключевые решения

| Вопрос | Решение |
|---|---|
| Источник авто-заметок | Импортированные сессии (через session-sync hook + ручной импорт) |
| LLM extractor | Gemini 2.5 Flash (уже подключён, биллинг в `agent_usage`); fallback на Ollama `qwen3.5:4b` если ключ недоступен |
| Категории заметок (вход в `entries`) | Только `architecture`, `decisions`, `conventions`. Категории `tasks`, `progress`, `issues` deprecated — мигрируют наружу в v5 |
| Гранулярность | Атомарная: 1 заметка = 1 факт |
| Дедуп | Embedding-based: cos > 0.85 → подтверждение, 0.7–0.85 → LLM-merge, < 0.7 → новая |
| Pipeline | Новое состояние `extracting_notes` после `embedding`, перед `complete` |
| Ручной ввод | Только через `note_write` + `note_share`. `memory_write` → 410 Gone |
| Importance score | Композитная метрика (confirmation_count, recency, marker_strength, author_diversity) |
| Auto-decay | Одиночные авто-записи архивируются через 30 дней без подтверждений |
| Retrieval | Иерархия L1 (entries) → L2 (sessions) → L3 (session_messages) через `KnowledgeSource` абстракцию; задел на L4+ в v5 |
| Скилл `using-team-memory` | Перепрошивается: убирается обязанность писать, остаётся обязанность читать |

## 3. Архитектура

### 3.1 Новые модули

```
src/extraction/
  types.ts                # CandidateNote, ExtractionResult, MergeDecision
  extractor.ts            # NoteExtractor — LLM-вызов + парсинг + фильтрация
  dedup.ts                # DedupResolver — Qdrant search + decision tree
  merger.ts               # NoteMerger — LLM-merge для cos 0.7–0.85
  prompt.ts               # Prompt template + JSON schema validation

src/retrieval/
  types.ts                # KnowledgeChunk, KnowledgeSource, Filters
  hierarchical.ts         # HierarchicalRetrieval orchestrator
  sources/
    entries-source.ts     # KnowledgeSource over Qdrant 'entries' collection
    sessions-source.ts    # KnowledgeSource over 'sessions' (summaries)
    messages-source.ts    # KnowledgeSource over 'session_messages' (chunks)

src/sessions/
  manager.ts              # MODIFIED: новое состояние extracting_notes,
                          # вызов NoteExtractor после embedding

src/notes/
  manager.ts              # MODIFIED: метод share(noteId, category, override)
  storage.ts              # MODIFIED: shared_to_entry_id поле

src/memory/
  manager.ts              # MODIFIED: importance_score recompute,
                          # write() возвращает 410 для memory_write API,
                          # confirmExisting() / mergeIntoExisting() для extractor
  decay.ts                # MODIFIED: правило для auto_generated одиночек

src/storage/migrations/
  018-auto-notes.sql      # NEW: поля entries + personal_notes
  019-deprecate-categories.sql  # NEW: soft-deprecate (комментарий в schema, без drop)

src/server.ts             # MODIFIED: memory_write → 410, новый note_share tool
```

### 3.2 Pipeline сессии

Текущий: `queued` → `summarizing` → `embedding` → `complete`

Новый:

```
queued → summarizing → embedding → extracting_notes → complete
                                          │
                                          └─ failure → extraction_failed
                                             (recoverable: можно перезапустить)
```

`extracting_notes` отделено от `embedding`: при изменении промпта/модели extractor можно переэкстрагировать без переэмбеддивания всей сессии. `recoverStuckSessions()` обрабатывает `extracting_notes` так же, как `summarizing`/`embedding` — возвращает в очередь.

### 3.3 Поток ручного ввода (notes + share)

```
[мысль]
  │
  ▼
note_write (private, scoped to agent_token_id)
  │
  ▼
[пользователь решает: важно для команды?]
  │
  ▼
note_share(note_id, category, override?)
  │
  ├─ embedding(content) → Qdrant search в entries (project_id + category)
  │
  ├─ cos > 0.85 → return {action: 'existing_match_found', existing_entry, prompt_user_to_confirm_or_create}
  │              ↓ (user choice via UI/explicit param)
  │              confirm: confirmation_count++, evidence_sources.push, return existing
  │              create_new: → flow ниже
  │
  ├─ cos 0.7-0.85 → return {action: 'merge_suggested', existing_entry}
  │                 ↓ (user choice)
  │                 accept_merge: LLM merge → update existing
  │                 create_new: → flow ниже
  │
  └─ cos < 0.7 → создаём новую запись:
      auto_generated     = false
      pinned             = true   (manual share = guaranteed important)
      extraction_confidence = null
      explicit_marker_strength = null
      confirmation_count = 1
      evidence_sources   = [{type:'personal_note', id, agent_token_id, confirmed_at}]
      
  В UI расшаренная personal note получает shared_to_entry_id ссылку.
```

## 4. Извлечение из сессии: промпт, формат, фильтры

### 4.1 Когда вызывается

После успешного `embedding` шага. Получает на вход:
- Сгенерированный summary сессии
- Sampled-транскрипт (та же стратегия выборки, что у `summarizeSession`: первые 10 + step-выборка из середины + последние 10, всего ≤40 сообщений)
- Метаданные: `project_id`, `git_branch`, `working_directory`, `agent_token_id`

### 4.2 Промпт extractor'а

Системный промпт на английском, факты на языке сессии (детектируется тем же кириллица-ratio эвристиком, что у `summarizeSession`).

```
You analyze a development session and extract ONLY atomic facts
worth preserving as long-term team knowledge.

Categories you may extract into (output keys):
- "architecture": system invariants, contracts, structural patterns
- "decisions":    explicit "why X, not Y" choices the team committed to
- "conventions":  rules, standards, agreed-upon practices

Each fact MUST satisfy:
- Atomic: one statement, not a paragraph of multiple ideas.
- Explains WHY (rationale, constraint, trade-off), not just WHAT
  (what's already in code, commits, PRs).
- Reusable beyond this session's specific bug or task.
- Length 30-500 characters in the "fact" field.

For each fact provide:
- "title": short identifier (5-10 words), language: ${lang}
- "fact": the WHY statement, language: ${lang}
- "why": background/rationale (1-2 sentences), language: ${lang}
- "tags": 2-5 lowercase tags
- "confidence": 0.0-1.0 — how confident you are this is a real
  durable fact and not an episode
- "explicit_marker_strength": 0.0-1.0 — how clearly the session
  marks this as a closure (phrases like "решили", "договорились",
  "конвенция", "итого", "root cause", final user "ОК так и делаем")
  vs. casual mention

If the session contains no such facts — return empty arrays.
Empty output is correct and expected for routine work
(bug fixes specific to one task, simple progress, etc.).

Output VALID JSON, no markdown, no commentary:
{
  "architecture": [...],
  "decisions": [...],
  "conventions": [...]
}

Session summary:
${summary}

Session transcript (sample):
${conversation}
```

Парсинг ответа: `JSON.parse` с retry-on-fail (если LLM вернула markdown-обёртку или мусор — один retry с подсказкой «return only JSON»).

### 4.3 Серверные фильтры (после парсинга, до дедупа)

Каждый кандидат проверяется:

```
candidate.confidence >= 0.6
  AND candidate.explicit_marker_strength >= 0.3
  AND 30 <= len(candidate.fact) <= 500
  AND len(candidate.title) >= 5
  AND len(candidate.tags) >= 1
```

Не прошедшие — отбрасываются с логированием (для тюнинга порогов на основе данных).

Пороги конфигурируемые через ENV:
- `EXTRACT_MIN_CONFIDENCE` (default `0.6`)
- `EXTRACT_MIN_MARKER_STRENGTH` (default `0.3`)
- `EXTRACT_MIN_FACT_LEN` / `EXTRACT_MAX_FACT_LEN` (default `30` / `500`)

### 4.4 Лимиты на сессию

- Максимум **5 кандидатов на сессию** (защита от дегенеративных ответов LLM). Если LLM вернула больше — берём top-5 по `confidence * explicit_marker_strength`.
- Максимум **3 LLM-merge вызова на сессию** (защита от деградации содержимого при множественных merge подряд).

## 5. Дедупликация и merge

### 5.1 Алгоритм per-candidate

```
1. embedding = embed(candidate.title + "\n" + candidate.fact + "\n" + candidate.why)
2. matches = qdrant.search('entries', embedding, {
              filter: {project_id, category: candidate.category},
              limit: 3
           })
3. top_match = matches[0]  // или null если пусто

4. switch on top_match.score:
     null or < 0.7  → action = CREATE_NEW
     0.7 - 0.85     → action = MERGE_WITH(top_match)
     > 0.85         → action = CONFIRM(top_match)
```

### 5.2 CONFIRM (cos > 0.85)

Существующая запись обновляется атомарно:

```sql
UPDATE entries SET
  confirmation_count = confirmation_count + 1,
  last_confirmed_at = NOW(),
  evidence_sources = evidence_sources || $new_source_jsonb
WHERE id = $entry_id
```

`new_source_jsonb` для extractor:
```json
{"type":"session", "id":"<session_uuid>", "agent_token_id":"<uuid>", "confirmed_at":"<iso>"}
```

Содержимое (`title`, `content`, `tags`) не трогается. `updated_at` не обновляется (это внутренний confirm, не редактирование).

### 5.3 MERGE_WITH (0.7 ≤ cos ≤ 0.85)

LLM-вызов «сливает» старый и новый факт в одну атомарную формулировку:

```
SYSTEM: Объедини два связанных факта в один атомарный.
Сохрани WHY обоих, не теряй информацию, но не превышай 500 символов.

EXISTING:
title: ...
fact: ...
why: ...

NEW:
title: ...
fact: ...
why: ...

Output JSON: {"title":"...", "fact":"...", "why":"...", "tags":[...]}
```

Затем `UPDATE entries SET title=..., content=fact + "\n\nWhy: " + why, tags=union(old, new), confirmation_count=count+1, last_confirmed_at=NOW(), evidence_sources=...`. Также `updated_at = NOW()` (это содержательное изменение).

Лимит 3 merge на сессию.

### 5.4 CREATE_NEW (cos < 0.7)

Новая запись:

```sql
INSERT INTO entries (
  project_id, category, domain, title, content, tags,
  author, priority, status, pinned,
  auto_generated, extraction_confidence, explicit_marker_strength,
  confirmation_count, last_confirmed_at, evidence_sources,
  external_refs, importance_score
) VALUES (
  $pid, $cat, NULL, $title, $fact + "\n\nWhy: " + $why, $tags,
  'auto-extractor', 'medium', 'active', false,
  true, $confidence, $marker_strength,
  1, NOW(), $evidence_jsonb,
  '{}', /* computed initial score */
);
```

Embedding записи кладётся в Qdrant `entries` коллекцию синхронно (тот же flow, что для ручных записей сейчас).

## 6. Изменения схемы

### 6.1 Миграция `018-auto-notes.sql`

```sql
ALTER TABLE entries
  ADD COLUMN auto_generated BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN extraction_confidence FLOAT,
  ADD COLUMN explicit_marker_strength FLOAT,
  ADD COLUMN confirmation_count INT NOT NULL DEFAULT 1,
  ADD COLUMN last_confirmed_at TIMESTAMPTZ,
  ADD COLUMN evidence_sources JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN external_refs JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN importance_score FLOAT NOT NULL DEFAULT 0.5;

CREATE INDEX idx_entries_importance       ON entries(project_id, importance_score DESC);
CREATE INDEX idx_entries_evidence_sources ON entries USING GIN (evidence_sources);
CREATE INDEX idx_entries_external_refs    ON entries USING GIN (external_refs);
CREATE INDEX idx_entries_auto_generated   ON entries(project_id, auto_generated);

-- Personal notes: ссылка на расшаренную entry (для отображения badge в UI)
ALTER TABLE personal_notes
  ADD COLUMN shared_to_entry_id UUID REFERENCES entries(id) ON DELETE SET NULL;

CREATE INDEX idx_personal_notes_shared ON personal_notes(shared_to_entry_id)
  WHERE shared_to_entry_id IS NOT NULL;

-- Sessions: новое состояние pipeline
-- (CHECK constraint обновляется в миграции, добавляется 'extracting_notes' и 'extraction_failed')
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_embedding_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_embedding_status_check
  CHECK (embedding_status IN (
    'queued', 'queued_embed', 'summarizing', 'embedding',
    'extracting_notes', 'complete', 'failed', 'extraction_failed'
  ));
```

### 6.2 Миграция `019-deprecate-categories.sql`

Не делает `DROP CHECK` или удаления — старые `tasks`/`progress`/`issues` остаются в БД для совместимости. Только комментарий в схеме:

```sql
COMMENT ON COLUMN entries.category IS
  'Categories: architecture, decisions, conventions are active.
   tasks, progress, issues are DEPRECATED since v4.5 (2026-04-28).
   New writes via memory_write API rejected with 410 Gone.
   Auto-extractor never produces these categories.
   Existing entries decay normally.';
```

### 6.3 Формат `evidence_sources` JSONB

Массив объектов:

```json
[
  {
    "type": "session",
    "id": "<session_uuid>",
    "agent_token_id": "<uuid>",
    "confirmed_at": "2026-04-28T10:00:00Z"
  },
  {
    "type": "personal_note",
    "id": "<note_uuid>",                    // приватно: видит только автор
    "shared_by": "<agent_token_id>",        // публично
    "confirmed_at": "..."
  }
]
```

API публичной выдачи (`memory_read`, `memory_onboard`) для типа `personal_note` отдаёт только `{type, shared_by, confirmed_at}` — поле `id` фильтруется на уровне сериализатора. Сам автор расшаренной заметки в её UI видит ссылку на свою note.

### 6.4 Формат `external_refs` JSONB

В v4.5 заполняется только при ручном указании (опционально через `note_share` override). Формат:

```json
{
  "azure_work_items": ["TFS-34042", "TFS-34043"],
  "azure_prs": ["PR-1234"],
  "code_paths": ["src/auth/jwt.ts:42-89"],
  "wiki_urls": ["https://..."]
}
```

В v5 заполняется автоматически при индексации кода и интеграции с Azure.

## 7. Importance score

Композитная метрика 0..1, перерасчитывается:
- При создании, confirm, merge записи (синхронно)
- Раз в сутки batch-job'ом (для recency-decay)

```
score = 0.4 * min(confirmation_count / 5, 1.0)
      + 0.3 * exp(-days_since_last_confirmed / 60)
      + 0.2 * (explicit_marker_strength ?? 0.5)
      + 0.1 * min(unique_authors_in_evidence / 3, 1.0)
```

`unique_authors_in_evidence` — кол-во разных `agent_token_id` в `evidence_sources` (для авто-записей и расшаренных вместе). Чем больше людей независимо подтвердили — тем выше score.

`memory_onboard` и `memory_read` сортируют:
1. `pinned = true` — всегда первыми (ручные расшаренные + manual `pinned`)
2. По `importance_score DESC`
3. По `updated_at DESC` (тай-брейкер)

## 8. Auto-decay

Расширение существующего `decay.ts`:

```sql
UPDATE entries SET status = 'archived' WHERE
  status = 'active'
  AND auto_generated = true
  AND pinned = false
  AND confirmation_count = 1
  AND created_at < NOW() - INTERVAL '30 days'
  AND (last_confirmed_at IS NULL OR last_confirmed_at = created_at);
```

Существующий decay для других условий не трогаем — старые ручные `tasks`/`progress`/`issues` тихо архивируются по своему правилу (без `pinned`, давно не читаются).

Decay-job уже работает по cron в системе — добавляем новый predicate, не меняем расписание.

## 9. Retrieval-абстракция (задел на v5)

### 9.1 Интерфейсы

```typescript
// retrieval/types.ts

export type SourceType =
  | 'entries' | 'sessions' | 'session_messages'
  | 'code' | 'pr' | 'wiki' | 'work_item'   // v5 placeholders
  | 'review';

export interface KnowledgeChunk {
  source_type: SourceType;
  source_id: string;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface RetrievalFilters {
  project_id: string;
  agent_token_id?: string;       // для personal context
  categories?: string[];
  date_from?: string;
  date_to?: string;
}

export interface KnowledgeSource {
  readonly type: SourceType;
  search(query: string, filters: RetrievalFilters, limit: number):
    Promise<KnowledgeChunk[]>;
}
```

### 9.2 HierarchicalRetrieval

```typescript
// retrieval/hierarchical.ts

export class HierarchicalRetrieval {
  constructor(private sources: KnowledgeSource[]) {}
  
  register(source: KnowledgeSource) { this.sources.push(source); }
  
  async retrieve(query: string, filters: RetrievalFilters): Promise<{
    notes: KnowledgeChunk[];      // L1: top-5 from entries, threshold 0.6
    sessions: KnowledgeChunk[];   // L2: top-5 from sessions, threshold 0.55
    snippets: KnowledgeChunk[];   // L3: top-10 from session_messages, 0.5
    // v5 keys: code, prs, wikis (optional)
  }> { ... }
}
```

### 9.3 Регистрация источников

При старте сервера:

```typescript
const retrieval = new HierarchicalRetrieval([
  new EntriesSource(qdrant, embeddingProvider),
  new SessionsSource(qdrant, embeddingProvider),
  new MessagesSource(qdrant, embeddingProvider),
]);

// в v5:
// retrieval.register(new CodeSource(...));
// retrieval.register(new PrSource(...));
// retrieval.register(new WikiSource(...));
```

### 9.4 Использование в RAG-агенте

`RagAgent` (`src/rag/agent.ts`) переключается с прямых вызовов `memoryManager.read()` / `sessionManager.search()` на `retrieval.retrieve(query, filters)`. Это рефакторинг ~30 строк.

## 10. Manual entry path: notes + share

### 10.1 Deprecate `memory_write`

MCP-инструмент `memory_write` возвращает 410 Gone:

```
{
  "isError": true,
  "content": [{
    "type": "text",
    "text": "memory_write deprecated since v4.5. Use note_write to create a personal draft, then note_share to publish it to team memory. Auto-extraction from sessions also creates notes automatically."
  }]
}
```

Скилл `team-memory:using-team-memory` переписывается:
- Удаляется секция «MUST write after each significant action».
- Остаётся «MUST read at session start (memory_onboard or memory_read)».
- Добавляется секция «How to record durable knowledge: write to personal notes (`note_write`) and share via UI when you decide it's team-worthy. Or — let auto-extractor pick it up from your session.»

### 10.2 Новый MCP tool `note_share`

```typescript
{
  name: 'note_share',
  description: 'Share a personal note as a team-memory entry. Performs deduplication: if a similar entry exists, prompts to confirm or merge. Manual shares are pinned (not subject to decay).',
  inputSchema: {
    note_id: { type: 'string', required: true },
    category: { type: 'string', enum: ['architecture','decisions','conventions'], required: true },
    override: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        external_refs: { type: 'object' }   // optional Azure refs
      }
    },
    on_match: {
      type: 'string',
      enum: ['prompt','confirm_existing','create_new','merge'],
      default: 'prompt'
    }
  }
}
```

Возвращает:

```json
{
  "action": "created" | "confirmed_existing" | "merged" | "match_found_pending_user_decision",
  "entry_id": "<uuid|null>",
  "existing_entry": { ... },           // если match_found
  "match_score": 0.87,                 // если match_found
  "personal_note_updated": true        // shared_to_entry_id выставлен
}
```

### 10.3 Web UI flow

Personal note page получает кнопку «Расшарить в команду»:

1. Клик → модалка:
   - Радио-выбор категории (architecture / decisions / conventions)
   - Опциональные поля переопределения title/content/tags
   - (опц.) Azure refs
2. После «Опубликовать» → серверный вызов `noteManager.share(...)`:
   - Если cos > 0.85 → модалка показывает существующую запись + 2 кнопки: «Подтвердить (увеличит счётчик подтверждений)» и «Создать новую всё равно»
   - Если cos 0.7–0.85 → модалка с превью merged-варианта от LLM + 2 кнопки: «Применить merge» и «Создать отдельной записью»
   - Если cos < 0.7 → создаётся сразу, бейдж «Расшарено» + ссылка на entry
3. На странице personal note: бейдж `Расшарено: <link to entry>` (показывается только автору).

## 11. Изменения в API/инструментах MCP

| Tool | Изменение |
|---|---|
| `memory_write` | 410 Gone с подсказкой |
| `memory_read` | Без изменений API; внутри сортировка по `importance_score`, при выдаче `evidence_sources` фильтрует приватные `personal_note.id` |
| `memory_onboard` | Без изменений API; внутри использует новый sort + фильтр шума по importance |
| `memory_update` | Без изменений; ручные правки `auto_generated=true` записей разрешены и снимают `auto_generated` (становится «человеческой») |
| `memory_delete` | Без изменений; удаление расшаренной записи разрешено любому (по существующей политике) |
| `memory_pin` | Без изменений; pin авто-записи защищает её от decay |
| `note_write` / `note_read` / `note_update` / `note_delete` / `note_search` | Без изменений |
| `note_share` | **NEW** — см. 10.2 |
| `memory_history` / `memory_audit` | Без изменений |
| `memory_cross_search` / `memory_export` | Без изменений |

## 12. Миграция и обратная совместимость

### 12.1 Существующие записи

- Все 282 записи Moorinet (и другие проекты) сохраняются. Новые поля заполняются дефолтами:
  - `auto_generated = false`
  - `confirmation_count = 1`
  - `last_confirmed_at = NULL`
  - `evidence_sources = []`
  - `importance_score = 0.5` (далее перерасчитается batch-job'ом)
- Категории `tasks`/`progress`/`issues` остаются валидными для существующих записей. Под decay постепенно уйдут (по существующему правилу + новому правилу одиночек, если pinned=false).

### 12.2 Существующие сессии (ретроспектива)

- Импортированные сессии **не переэкстрагируются автоматически** при деплое v4.5 — это создало бы лавину кандидатов и risk overwhelm Qdrant/LLM.
- Вместо этого: **только новые сессии** (поступающие через session-sync hook или ручной импорт после деплоя) проходят extracting_notes.
- Через 2 недели после деплоя оцениваем качество новых заметок, тогда отдельным CLI-скриптом (`scripts/backfill-extract-notes.cjs`) можно прогнать ретроспективу выборочно (например, top-50 сессий по message_count).

### 12.3 Откат

- Миграция `018` обратима через `018-rollback.sql` (DROP COLUMN — поля nullable/default'ные). Миграция `019` — только COMMENT, откат не требуется.
- Deprecate `memory_write` обратим — возвращаем старый handler.
- Auto-extractor отключается через ENV `EXTRACT_NOTES_ENABLED=false` — pipeline сессии пропускает шаг `extracting_notes` и сразу идёт в `complete`.

## 13. Конфигурация (ENV)

Новые переменные:

| Variable | Default | Назначение |
|---|---|---|
| `EXTRACT_NOTES_ENABLED` | `true` | Master toggle для extractor'а |
| `EXTRACT_LLM_PROVIDER` | `gemini` | `gemini` \| `ollama` |
| `EXTRACT_LLM_MODEL` | `gemini-2.5-flash` | Используемая модель |
| `EXTRACT_MIN_CONFIDENCE` | `0.6` | Порог `confidence` |
| `EXTRACT_MIN_MARKER_STRENGTH` | `0.3` | Порог `explicit_marker_strength` |
| `EXTRACT_MIN_FACT_LEN` | `30` | Min длина `fact` |
| `EXTRACT_MAX_FACT_LEN` | `500` | Max длина `fact` |
| `EXTRACT_MAX_NOTES_PER_SESSION` | `5` | Кап на сессию |
| `EXTRACT_MAX_MERGES_PER_SESSION` | `3` | Кап LLM-merge на сессию |
| `DEDUP_CONFIRM_THRESHOLD` | `0.85` | cos для CONFIRM |
| `DEDUP_MERGE_THRESHOLD` | `0.7` | cos для MERGE |
| `AUTO_DECAY_DAYS` | `30` | Возраст для decay одиночек |
| `IMPORTANCE_RECOMPUTE_INTERVAL_HOURS` | `24` | Частота batch-recompute |

## 14. Тестовое покрытие (что обязательно)

### 14.1 Unit

- `NoteExtractor`:
  - JSON-парсинг с retry на malformed output
  - Все четыре фильтра (confidence, marker, length, tags)
  - Cap 5 кандидатов с правильной сортировкой
  - Detection языка для prompt
- `DedupResolver`:
  - Три ветки (CONFIRM / MERGE / CREATE_NEW) с граничными значениями cos
  - Корректный `evidence_sources` append без дубликатов session_id
- `NoteMerger`:
  - Atomicity сохраняется (длина результата ≤ 500)
  - Tags корректно объединяются
  - Лимит 3 merge на сессию
- `ImportanceScorer`:
  - Все четыре компонента считаются корректно
  - Recency decay через 60 дней
  - `unique_authors` corner cases (1 author, >3 authors)
- `AutoDecay`:
  - Только записи с `auto_generated AND NOT pinned AND confirmation_count=1` через 30 дней
  - Не трогает pinned, multi-confirmed, недавние
- `HierarchicalRetrieval`:
  - Mock-источники → корректное распределение по слоям
  - Регистрация дополнительных источников

### 14.2 Integration

- End-to-end: импорт сессии → summary → embedding → extracting_notes → завершение со статусом `complete`
- Backward extraction отключение через ENV → pipeline идёт в `complete` напрямую
- `note_share` для cos > 0.85 → возвращает existing match, не создаёт дубль
- `note_share` для cos < 0.7 → создаёт запись, `personal_note.shared_to_entry_id` выставлен
- `memory_write` → 410 с правильным сообщением
- `memory_onboard` сортирует по `importance_score`, фильтрует приватные `evidence_sources.id`

### 14.3 Manual smoke (после deploy)

- Прогон 1 реальной сессии Moorinet через ручной reimport → проверка кандидатов в Web UI
- Сравнение `importance_score` для уже существующих vs новых auto-записей

## 15. Метрики успеха (через 2 недели после деплоя)

- **Доля сессий, давших 0 заметок** должна быть ≥ 60% (валидация фильтров: рутинная работа не должна порождать записи).
- **Среднее число новых заметок на сессию** ≤ 2.
- **Доля CONFIRM-операций vs CREATE_NEW** растёт со временем — по мере наполнения базы (ожидаемо ≥ 30% к концу 2 недель).
- **Новые ручные share через UI** — хотя бы 1 за две недели (валидация UX-потока).
- **`memory_onboard`-выдача субъективно качественнее**: команда (Антон + 1-2 ревьюера) подтверждает, что top-10 записей в авто-выдаче — реальные WHY, не шум.

## 16. Связь со скиллами и документацией

После деплоя:

- `team-memory:using-team-memory` — переписать (см. 10.1). **Внимание:** скилл лежит в отдельном репозитории `team-memory-marketplace` — это отдельный PR, не в составе этой имплементации.
- README team-memory-mcp — обновить раздел про категории и notes/share flow.
- `docs/...` — добавить страницу `auto-extraction.md` с описанием алгоритма для команды.
- Roadmap-запись в team-memory (категория `decisions`, проект «Рефакторинг MCP Team Memory») — обновить версию до v4.5 и v5.0 placeholder для Azure DevOps.
