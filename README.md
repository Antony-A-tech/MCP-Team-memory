# Team Memory MCP Server

[![CI](https://github.com/Antony-A-tech/MCP-Team-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/Antony-A-tech/MCP-Team-memory/actions/workflows/ci.yml)

Shared team memory for AI coding agents. A [Model Context Protocol](https://modelcontextprotocol.io/) server that gives Claude Code (and other MCP clients) persistent, searchable, real-time team knowledge.

> 🇷🇺 **Документация на русском — во второй половине файла.** English section and Russian section mirror each other; update both when changing this file.

## Why

When multiple developers use AI agents on the same codebase, each agent starts with zero context. Team Memory fixes this: every architectural decision, convention, project event, and imported session is stored centrally and surfaced automatically based on the agent's role.

## Memory model (v5)

v5 replaces the flat "6 categories" model with three complementary layers:

| Layer | What it holds | How it's created |
|-------|---------------|------------------|
| **Profile** | One curated, always-on record per project — mission, stack, guard-rails | `memory_profile_set` / Web UI (manual, opinionated) |
| **Knowledge** | Atomic, *why*-bearing facts (architecture, decisions, conventions), classified by **tags** instead of categories | Manual share (`note_share`) or background auto-extraction from sessions |
| **Events** | A *what*-happened timeline: `merge` / `release` / `deploy` / `incident` / `milestone` | `event_add` or auto-extraction from sessions |

`memory_onboard` composes all three into a single project summary for a new agent.

## Features

- **~29 MCP tools** — read/update/sync/pin/export entries, conventions, profile, events, personal notes, session import & search, cross-project search, onboarding
- **PostgreSQL + pgvector + Qdrant** — full-text search with Russian/English stemming, hybrid vector + FTS search
- **Agent identity** — per-agent tokens, unforgeable author attribution, project roles (developer/qa/lead/devops)
- **Role-aware auto-recall** — agents receive context prioritized for their role
- **Auto-notes** — imported sessions are scanned for atomic facts and deduplicated automatically (see [Auto-notes](#auto-notes--sharing))
- **Web UI dashboard** — real-time monitoring, knowledge graph, profile/events tabs, entry management, agent admin panel
- **Real-time sync** — WebSocket-based live updates across all connected agents
- **Smart features** — conflict resolution (optimistic locking), importance scoring, memory decay, auto-archival, version history & audit log

## Quick Start

### 1. Start PostgreSQL

```bash
docker compose up -d postgres
```

### 2. Build and start the server (HTTP mode)

```bash
npm install
npm run build

DATABASE_URL="postgresql://memory:memory@localhost:5432/team_memory" \
MEMORY_TRANSPORT=http \
MEMORY_API_TOKEN="your-master-token" \
node dist/index.js
```

Open `http://localhost:3846` for the dashboard. Create agent tokens and projects in the admin panel.

### 3. Full stack via Docker Compose

```bash
docker compose up -d
```

## Connecting an agent

Connecting a team member is three steps — **MCP connection**, the **`using-team-memory` skill**, and the **session-sync hook**. The full step-by-step guide is in **[SETUP.md](SETUP.md)**.

Minimal `.mcp.json` for Claude Code:

```json
{
  "mcpServers": {
    "team-memory": {
      "type": "http",
      "url": "http://localhost:3846/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_TOKEN>",
        "X-Project-Id": "<PROJECT_UUID>"
      }
    }
  }
}
```

Replace `<YOUR_TOKEN>` with an agent token (`tm_...`) and `<PROJECT_UUID>` with the project UUID from the dashboard. A ready template lives in `.mcp.example.json`.

## MCP Tools

**Memory entries & projects**

| Tool | Description |
|------|-------------|
| `memory_read` | Read entries (compact or full mode) with filters: category, domain, tags, search, status |
| `memory_update` | Update an existing entry (optimistic locking via `expected_version`) |
| `memory_delete` | Archive (default) or permanently delete |
| `memory_unarchive` | Restore an archived entry |
| `memory_sync` | Get entries changed since a timestamp |
| `memory_pin` | Pin/unpin entries (pinned entries skip auto-decay) |
| `memory_export` | Export entries as markdown or JSON |
| `memory_onboard` | Generate a project summary (profile + events + knowledge) |
| `memory_conventions` | Manage project conventions (list/add/remove) |
| `memory_cross_search` | Search patterns/solutions across all projects |
| `memory_history` | Version history of an entry |
| `memory_audit` | Audit log — who changed an entry/project and when |
| `memory_profile_get` / `memory_profile_set` | Read / replace the project profile |
| `memory_projects` | Manage projects (list/create/update/delete) |

**Personal notes** (private to your token until shared)

| Tool | Description |
|------|-------------|
| `note_write` / `note_read` / `note_update` / `note_delete` | CRUD for personal notes |
| `note_search` | Semantic search over your personal notes |
| `note_share` | Publish a personal note as a pinned team entry (runs dedup) |

**Sessions**

| Tool | Description |
|------|-------------|
| `session_import` | Import a Claude Code session with messages (triggers auto-extraction) |
| `session_list` / `session_read` | List / read imported sessions |
| `session_search` | Semantic search over session summaries |
| `session_message_search` | Semantic search within/across session messages |
| `session_delete` | Delete an imported session |

**Events**

| Tool | Description |
|------|-------------|
| `event_add` | Add a timeline event (merge/release/deploy/incident/milestone) |
| `event_list` | List recent project events |

> `memory_write` was removed in v4.5. Create knowledge via `note_write` + `note_share`, or let auto-extraction harvest it from imported sessions.

## Categories

| Category | Status | Purpose |
|----------|--------|---------|
| `profile` | active | Single curated always-on record per project |
| `knowledge` | active | Why-bearing facts — architecture, decisions, conventions (classified by tags) |
| `tasks`, `issues`, `progress` | legacy | Read-only; kept for entries created before v5 |

## Agent Identity & Roles

Each team member gets a personal token (`tm_...`). The author field is set automatically from the token — no spoofing possible.

**System access:**
- Master token (`MEMORY_API_TOKEN` in `.env`) = admin, manages tokens & projects via Web UI
- Agent tokens = user-level access

**Project roles** — a soft bias for auto-recall ordering (developer / qa / lead / devops). v5 prioritization is tag-based: e.g. developers see architecture-tagged knowledge first, QA sees issue-tagged entries first.

## Auto-notes & sharing

Direct writes are gone. Knowledge enters Team Memory through two paths:

**1. Manual share (intentional)**

```
note_write {title, content, tags}  →  note_share {note_id, category, on_match}
                                          ↓
                       team-memory entry (pinned, evidence-tracked)
```

The Web UI also exposes a "Расшарить" button on every personal note. `note_share` runs cosine-similarity dedup; `on_match` decides what happens on a hit — `prompt` (default), `confirm_existing`, `merge`, or `create_new`.

**2. Auto-extraction (background)**

Sessions imported via `session_import` are scanned for atomic, *why*-bearing facts:

```
cosine > 0.85          → CONFIRM existing entry (increment confirmation_count)
0.70 ≤ cosine ≤ 0.85   → MERGE candidate into existing
cosine < 0.70          → CREATE_NEW (auto_generated, pinned to evidence)
```

Routine work that produces no atomic facts yields zero candidates — that's the expected outcome for most sessions. Re-run extraction over past sessions with `scripts/backfill-extract-notes.cjs`.

See [docs/auto-notes-v4.5.md](docs/auto-notes-v4.5.md) and `docs/superpowers/specs/2026-04-28-auto-notes-from-sessions-design.md` for the full design.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `MEMORY_TRANSPORT` | `stdio` | `stdio` (CLI) or `http` (Web UI + remote) |
| `MEMORY_PORT` | `3846` | HTTP server port |
| `MEMORY_API_TOKEN` | — | Master token (enables auth when set) |
| `MEMORY_FTS_LANGUAGE` | `simple` | PostgreSQL FTS config (`russian`, `english`, …) |
| `MEMORY_AUTO_ARCHIVE` | `true` | Enable auto-archival |
| `MEMORY_AUTO_ARCHIVE_DAYS` | `14` | Days before auto-archive |
| `MEMORY_CORS_ORIGIN` | `*` | CORS origin for production |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_EMBEDDING_MODEL` | `nomic-embed-text-v2-moe` | Embedding model name |
| `EXTRACT_NOTES_ENABLED` | `true` | Auto-extract entries from imported sessions |
| `EXTRACT_LLM_PROVIDER` | `gemini` | `gemini` or `ollama` for the extraction LLM |
| `EXTRACT_MIN_CONFIDENCE` | `0.6` | Drop candidates below this LLM confidence |
| `EXTRACT_MIN_MARKER_STRENGTH` | `0.3` | Drop candidates without explicit "decided" markers |
| `DEDUP_CONFIRM_THRESHOLD` | `0.85` | Cosine ≥ → CONFIRM existing entry |
| `DEDUP_MERGE_THRESHOLD` | `0.7` | Cosine in [0.7, 0.85] → MERGE |
| `AUTO_DECAY_DAYS` | `30` | Singleton auto-record archive age |

Qdrant connection and the remaining knobs are documented in **`.env.example`** — copy it to `.env` and adjust.

## Development

```bash
npm install
npm run build
npm test            # full vitest suite
npm run dev         # build + start Web UI
npm run clean       # remove dist/
```

## Security

- `crypto.timingSafeEqual` for all token comparisons
- Parameterized SQL queries (no SQL injection)
- CSP headers, XSS escaping, ILIKE sanitization
- FTS language validated against an allowlist
- Personal-note IDs stripped from read API; session messages are agent-scoped
- For production, terminate TLS with an nginx reverse proxy (see Russian section below)

## License

MIT

---

# Документация на русском

> Зеркало английской секции выше. При изменениях правьте обе части.

## Зачем

Когда несколько разработчиков используют AI-агентов на одной кодовой базе, каждый агент стартует с нулевым контекстом. Team Memory это исправляет: каждое архитектурное решение, конвенция, событие проекта и импортированная сессия хранятся централизованно и подаются агенту автоматически с учётом его роли.

## Модель памяти (v5)

v5 заменяет плоскую модель «6 категорий» тремя взаимодополняющими слоями:

| Слой | Что хранит | Как создаётся |
|------|------------|---------------|
| **Profile** | Одна курируемая always-on запись на проект — миссия, стек, guard-rails | `memory_profile_set` / Web UI (вручную) |
| **Knowledge** | Атомарные факты с обоснованием (*почему*) — архитектура, решения, конвенции; классификация **тегами** вместо категорий | Ручная публикация (`note_share`) или фоновая авто-экстракция из сессий |
| **Events** | Таймлайн *что произошло*: `merge` / `release` / `deploy` / `incident` / `milestone` | `event_add` или авто-экстракция из сессий |

`memory_onboard` собирает все три слоя в единую сводку проекта для нового агента.

## Возможности

- **~29 MCP-инструментов** — чтение/обновление/синхронизация/закрепление/экспорт записей, конвенции, профиль, события, личные заметки, импорт и поиск сессий, кросс-проектный поиск, онбординг
- **PostgreSQL + pgvector + Qdrant** — полнотекстовый поиск со стеммингом (рус./англ.), гибридный vector + FTS поиск
- **Идентификация агентов** — персональные токены, неподделываемый автор, проектные роли (разработчик/тестировщик/руководитель/devops)
- **Ролевой auto-recall** — контекст приоритизируется под роль агента
- **Auto-notes** — импортированные сессии сканируются на атомарные факты с автоматической дедупликацией (см. [Auto-notes](#auto-notes--публикация))
- **Web UI дашборд** — мониторинг в реальном времени, граф знаний, вкладки профиля и событий, управление записями, панель администратора
- **Real-time синхронизация** — WebSocket для live-обновлений между агентами
- **Smart-фичи** — разрешение конфликтов (optimistic locking), importance-скоринг, decay памяти, автоархивация, история версий и аудит-лог

## Быстрый старт

### 1. Запуск PostgreSQL

```bash
docker compose up -d postgres
```

### 2. Сборка и запуск сервера (HTTP-режим)

```bash
npm install
npm run build

DATABASE_URL="postgresql://memory:memory@localhost:5432/team_memory" \
MEMORY_TRANSPORT=http \
MEMORY_API_TOKEN="ваш-master-токен" \
node dist/index.js
```

Дашборд: `http://localhost:3846`. Создайте токены агентов и проекты в панели администратора.

### 3. Полный стек через Docker Compose

```bash
docker compose up -d
```

## Подключение агента

Подключение участника команды — это три шага: **подключение MCP**, **skill `using-team-memory`** и **хук автоотправки сессий**. Полное пошаговое руководство — в **[SETUP.md](SETUP.md)**.

Минимальный `.mcp.json` для Claude Code:

```json
{
  "mcpServers": {
    "team-memory": {
      "type": "http",
      "url": "http://localhost:3846/mcp",
      "headers": {
        "Authorization": "Bearer <ВАШ_ТОКЕН>",
        "X-Project-Id": "<UUID_ПРОЕКТА>"
      }
    }
  }
}
```

Замените `<ВАШ_ТОКЕН>` на токен агента (`tm_...`), а `<UUID_ПРОЕКТА>` — на UUID проекта из дашборда. Готовый шаблон — в `.mcp.example.json`.

## MCP-инструменты

**Записи памяти и проекты**

| Инструмент | Описание |
|------------|----------|
| `memory_read` | Чтение записей (compact/full) с фильтрами: категория, домен, теги, поиск, статус |
| `memory_update` | Обновление записи (optimistic locking через `expected_version`) |
| `memory_delete` | Архивация (по умолчанию) или полное удаление |
| `memory_unarchive` | Восстановление архивированной записи |
| `memory_sync` | Изменения с указанного момента времени |
| `memory_pin` | Закрепление/открепление (закреплённые не подвержены decay) |
| `memory_export` | Экспорт записей в markdown или JSON |
| `memory_onboard` | Сводка проекта (профиль + события + знания) |
| `memory_conventions` | Управление конвенциями проекта (list/add/remove) |
| `memory_cross_search` | Поиск паттернов/решений по всем проектам |
| `memory_history` | История версий записи |
| `memory_audit` | Аудит-лог — кто и когда менял запись/проект |
| `memory_profile_get` / `memory_profile_set` | Чтение / замена профиля проекта |
| `memory_projects` | Управление проектами (list/create/update/delete) |

**Личные заметки** (приватны для вашего токена, пока не расшарены)

| Инструмент | Описание |
|------------|----------|
| `note_write` / `note_read` / `note_update` / `note_delete` | CRUD личных заметок |
| `note_search` | Семантический поиск по личным заметкам |
| `note_share` | Публикация заметки как закреплённой командной записи (с дедупликацией) |

**Сессии**

| Инструмент | Описание |
|------------|----------|
| `session_import` | Импорт сессии Claude Code с сообщениями (запускает авто-экстракцию) |
| `session_list` / `session_read` | Список / чтение импортированных сессий |
| `session_search` | Семантический поиск по summary сессий |
| `session_message_search` | Семантический поиск по сообщениям сессий |
| `session_delete` | Удаление импортированной сессии |

**События**

| Инструмент | Описание |
|------------|----------|
| `event_add` | Добавить событие в таймлайн (merge/release/deploy/incident/milestone) |
| `event_list` | Список последних событий проекта |

> `memory_write` удалён в v4.5. Знания создаются через `note_write` + `note_share` либо собираются авто-экстракцией из импортированных сессий.

## Категории

| Категория | Статус | Назначение |
|-----------|--------|------------|
| `profile` | активна | Одна курируемая always-on запись на проект |
| `knowledge` | активна | Факты с обоснованием — архитектура, решения, конвенции (классификация тегами) |
| `tasks`, `issues`, `progress` | legacy | Только для чтения; сохранены для записей до v5 |

## Идентификация агентов и роли

Каждый член команды получает персональный токен (`tm_...`). Автор записи устанавливается автоматически из токена — подделка невозможна.

**Системный доступ:**
- Master token (`MEMORY_API_TOKEN` в `.env`) = администратор, управляет токенами и проектами через Web UI
- Agent tokens = пользовательский доступ

**Проектные роли** — мягкая приоритизация порядка auto-recall (разработчик / тестировщик / руководитель / devops). В v5 приоритизация основана на тегах: например, разработчики первыми видят знания с тегом архитектуры, тестировщики — записи с тегом проблем.

## Auto-notes / публикация

Прямая запись убрана. Знания попадают в Team Memory двумя путями:

**1. Ручная публикация (осознанная)**

```
note_write {title, content, tags}  →  note_share {note_id, category, on_match}
                                          ↓
                  командная запись (закреплена, с трекингом evidence)
```

В Web UI на каждой карточке личной заметки есть кнопка «Расшарить». `note_share` запускает дедупликацию по косинусной близости; `on_match` определяет поведение при совпадении — `prompt` (по умолчанию), `confirm_existing`, `merge` или `create_new`.

**2. Авто-экстракция (фоновая)**

Сессии, импортированные через `session_import`, сканируются на атомарные факты с обоснованием:

```
cosine > 0.85          → CONFIRM существующей записи (увеличить confirmation_count)
0.70 ≤ cosine ≤ 0.85   → MERGE кандидата в существующую запись
cosine < 0.70          → CREATE_NEW (auto_generated, закреплена к evidence)
```

Рутинная работа без атомарных фактов даёт ноль кандидатов — это ожидаемый результат для большинства сессий. Перезапустить экстракцию по прошлым сессиям: `scripts/backfill-extract-notes.cjs`.

Полное описание дизайна — в [docs/auto-notes-v4.5.md](docs/auto-notes-v4.5.md) и `docs/superpowers/specs/2026-04-28-auto-notes-from-sessions-design.md`.

## Переменные окружения

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `DATABASE_URL` | — | Строка подключения PostgreSQL (обязательно) |
| `MEMORY_TRANSPORT` | `stdio` | `stdio` (CLI) или `http` (Web UI + удалённый доступ) |
| `MEMORY_PORT` | `3846` | Порт HTTP-сервера |
| `MEMORY_API_TOKEN` | — | Master-токен (включает auth при установке) |
| `MEMORY_FTS_LANGUAGE` | `simple` | Конфигурация FTS (`russian`, `english`, …) |
| `MEMORY_AUTO_ARCHIVE` | `true` | Автоархивация |
| `MEMORY_AUTO_ARCHIVE_DAYS` | `14` | Дней до автоархивации |
| `MEMORY_CORS_ORIGIN` | `*` | CORS origin для production |
| `OLLAMA_URL` | `http://localhost:11434` | URL сервера Ollama |
| `OLLAMA_EMBEDDING_MODEL` | `nomic-embed-text-v2-moe` | Модель для эмбеддингов |
| `EXTRACT_NOTES_ENABLED` | `true` | Авто-экстракция записей из импортированных сессий |
| `EXTRACT_LLM_PROVIDER` | `gemini` | `gemini` или `ollama` для LLM экстракции |
| `EXTRACT_MIN_CONFIDENCE` | `0.6` | Отбрасывать кандидатов ниже этой уверенности LLM |
| `EXTRACT_MIN_MARKER_STRENGTH` | `0.3` | Отбрасывать кандидатов без явных маркеров «решили» |
| `DEDUP_CONFIRM_THRESHOLD` | `0.85` | Cosine ≥ → CONFIRM существующей записи |
| `DEDUP_MERGE_THRESHOLD` | `0.7` | Cosine в [0.7, 0.85] → MERGE |
| `AUTO_DECAY_DAYS` | `30` | Возраст архивации singleton auto-записи |

Подключение Qdrant и остальные параметры описаны в **`.env.example`** — скопируйте его в `.env` и настройте.

## Разработка

```bash
npm install
npm run build
npm test            # полный набор vitest
npm run dev         # сборка + запуск Web UI
npm run clean       # очистка dist/
```

## Безопасность

### Credentials

**Не используйте дефолтные пароли в production.** Скопируйте `.env.example` в `.env` и измените пароли:

```bash
cp .env.example .env
```

Защита: `crypto.timingSafeEqual` для сравнения токенов, параметризованные SQL-запросы, CSP-заголовки, XSS-экранирование, санитизация ILIKE, валидация FTS-языка по allowlist. ID личных заметок вырезаются из read API, сообщения сессий доступны только в рамках агента.

### HTTPS (reverse proxy)

Для production рекомендуется nginx reverse proxy с TLS:

```nginx
server {
    listen 443 ssl;
    server_name memory.your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/memory.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/memory.your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3846;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /ws {
        proxy_pass http://127.0.0.1:3846;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

## Лицензия

MIT
