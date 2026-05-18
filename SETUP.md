# Team Memory MCP — быстрое подключение

Единая инструкция для участника команды: как подключить **Team Memory MCP**,
установить **skill** и настроить **хук автоотправки сессий**.

> Канонический источник. Внутренняя копия с конкретными адресами сервера —
> `TEAM-MEMORY-SETUP-GUIDE.md`. При изменениях правьте оба файла.

Что подключаем (три независимых компонента):

| Компонент | Зачем | Обязателен |
|---|---|---|
| **MCP-подключение** | Агент читает/пишет командную память (`memory_*`, `note_*`, `session_*`) | да |
| **Skill** `using-team-memory` | Обучает Claude обязательному жизненному циклу: читать память в начале, публиковать результат в конце | рекомендуется (только Claude Code) |
| **Хук** `session-sync.cjs` | Автоматически отправляет сессии на сервер (Stop + SessionEnd), откуда работает авто-экстракция фактов | рекомендуется (только Claude Code) |

---

## 0. Что понадобится

1. **Персональный токен** — формат `tm_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`.
   Запросите у администратора Team Memory.
2. **UUID проекта** — формат `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.
   Найдите свой проект в Web UI сервера и скопируйте UUID.
3. **URL сервера** — например `http://localhost:3846` (локальный запуск) или
   адрес командного сервера. Web UI открывается по тому же адресу.
4. **Node.js ≥ 20** — нужен для хука (`session-sync.cjs`).

---

## 1. Подключение MCP

MCP-сервер работает в режиме **Streamable HTTP**. Создайте/дополните `.mcp.json`
в корне вашего проекта.

### Claude Code — `.mcp.json`

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

Готовый шаблон лежит в репозитории: `.mcp.example.json`.

### Roo Code — `.roo/mcp.json`

```json
{
  "mcpServers": {
    "team-memory": {
      "type": "streamable-http",
      "url": "http://localhost:3846/mcp",
      "headers": {
        "Authorization": "Bearer <ВАШ_ТОКЕН>",
        "X-Project-Id": "<UUID_ПРОЕКТА>"
      },
      "disabled": false,
      "alwaysAllow": []
    }
  }
}
```

### Cline — `cline_mcp_settings.json`

```json
{
  "mcpServers": {
    "team-memory": {
      "type": "streamableHttp",
      "url": "http://localhost:3846/mcp",
      "headers": {
        "Authorization": "Bearer <ВАШ_ТОКЕН>",
        "X-Project-Id": "<UUID_ПРОЕКТА>"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Отличия формата по клиентам

| Параметр | Claude Code | Roo Code | Cline |
|---|---|---|---|
| Файл конфигурации | `.mcp.json` | `.roo/mcp.json` | `cline_mcp_settings.json` |
| Значение `type` | `"http"` | `"streamable-http"` | `"streamableHttp"` |
| Авто-одобрение | — | `"alwaysAllow": []` | `"autoApprove": []` |

> Замените `<ВАШ_ТОКЕН>` и `<UUID_ПРОЕКТА>` на реальные значения.
> Если файл MCP уже есть — добавьте только секцию `"team-memory"` внутрь `"mcpServers"`.

После правки **перезапустите AI-ассистент**. В новой сессии попросите:
«Прочитай командную память проекта» — ассистент должен вызвать `memory_onboard()`.

---

## 2. Установка skill (только Claude Code)

Skill `using-team-memory` обучает Claude обязательному жизненному циклу работы
с памятью: онбординг в начале сессии и публикация результатов перед завершением.

### Вариант A — через Marketplace (рекомендуется)

1. В Claude Code выполните `/plugins`.
2. Вкладка **Marketplaces** → добавьте marketplace:

   ```
   https://github.com/Antony-A-tech/MCP-Team-memory.git
   ```

3. Вкладка **Plugins** → найдите **team-memory** → установите.
4. Перезапустите Claude Code.

После установки skill `team-memory:using-team-memory` активируется автоматически.

### Вариант B — Roo Code / Cline (вручную)

1. Склонируйте репозиторий или скачайте файл скилла:
   `skills/using-team-memory/SKILL.md`
2. Скопируйте его содержимое в системный промпт (Custom Instructions)
   вашего ассистента.

---

## 3. Хук автоотправки сессий (только Claude Code)

Хук `scripts/session-sync.cjs` отправляет сессии Claude Code на сервер через
`session_import`. На сервере импортированная сессия проходит фоновую
обработку: LLM-summary → эмбеддинг → авто-экстракция атомарных фактов.

**Два триггера:**

| Событие | Когда срабатывает | Поведение |
|---|---|---|
| `Stop` | После каждого ответа Claude | Debounce 1 час на сессию — синхронизирует, только если прошёл час с прошлой отправки |
| `SessionEnd` | При завершении сессии | Синхронизирует всегда, без debounce |

Длинные сессии (1–3 дня) синхронизируются ежечасно; завершённые — сразу.

### Шаг 3.1 — переменные окружения

В `~/.claude/settings.json` (Windows: `C:\Users\<user>\.claude\settings.json`)
добавьте секцию `env`:

```json
{
  "env": {
    "TM_SERVER_URL": "http://localhost:3846",
    "TM_TOKEN": "tm_ВАШ_ТОКЕН"
  }
}
```

| Переменная | Обязательна | Описание |
|---|---|---|
| `TM_SERVER_URL` | да | URL сервера Team Memory (по умолчанию `http://localhost:3846`) |
| `TM_TOKEN` | да | Персональный токен агента (`tm_...`) |

> **Project ID не указывается в env.** Хук определяет проект автоматически —
> читает `mcpServers["team-memory"].headers["X-Project-Id"]` из `.mcp.json`,
> поднимаясь вверх по дереву каталогов от рабочей папки. Если `.mcp.json` не
> найден или в нём нет `X-Project-Id` — хук завершается с ошибкой и сессия
> **не** отправляется (защита от записи в чужой проект).

### Шаг 3.2 — регистрация хуков

В том же `~/.claude/settings.json` добавьте секцию `hooks`. Укажите
**абсолютный путь** к `session-sync.cjs` на вашей машине:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node D:/MCP/team-memory-mcp/scripts/session-sync.cjs",
            "timeout": 30
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node D:/MCP/team-memory-mcp/scripts/session-sync.cjs",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Полный `~/.claude/settings.json` с обеими секциями:

```json
{
  "env": {
    "TM_SERVER_URL": "http://localhost:3846",
    "TM_TOKEN": "tm_ВАШ_ТОКЕН"
  },
  "hooks": {
    "Stop": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "node D:/MCP/team-memory-mcp/scripts/session-sync.cjs", "timeout": 30 }
      ]}
    ],
    "SessionEnd": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "node D:/MCP/team-memory-mcp/scripts/session-sync.cjs", "timeout": 30 }
      ]}
    ]
  }
}
```

### Шаг 3.3 — перезапуск и проверка

1. Перезапустите Claude Code (в VSCode: `Ctrl+Shift+P` → «Reload Window»).
2. Поработайте в сессии (нужно ≥ 3 сообщений) либо завершите её.
3. Проверьте, что сессия появилась: Web UI сервера или MCP-инструмент
   `session_list`.

### Как это работает

```
Claude отвечает (Stop)  ──► debounce: прошёл 1 час? ──нет──► выход
                                       │ да
Сессия завершается (SessionEnd) ───────┤ (всегда, без debounce)
                                       ▼
                  Парсинг JSONL → user/assistant сообщения
                                       ▼
                       POST session_import на сервер
                                       ▼
        Сервер: мгновенное сохранение → очередь → фоновый воркер
        ├─ LLM-summary (~55 сек)
        ├─ Эмбеддинг → Qdrant (~3 мин)
        └─ Авто-экстракция фактов + дедупликация
```

Состояние debounce хранится в `~/.claude/.session-sync/{session_id}.json` —
у каждого пользователя своя каденция синхронизации, без «штормов» по часам.

> **Roo Code / Cline:** скрипт рассчитан на формат JSONL Claude Code. Для
> других клиентов запускайте `session-sync.cjs` через cron/файл-вотчер,
> адаптировав парсинг под их формат сессий.

---

## 4. Быстрая проверка

| Что проверяем | Как |
|---|---|
| MCP подключён | Ассистент видит инструменты `memory_read`, `memory_onboard`, `note_write` и др. |
| Проект найден | `memory_onboard()` возвращает сводку проекта |
| Skill активен | В начале сессии Claude сам читает память |
| Хук работает | После часа работы / завершения сессия видна в `session_list` или Web UI |

---

## 5. Устранение проблем

| Проблема | Решение |
|---|---|
| Ассистент не видит инструменты Team Memory | Проверьте `url`, токен, UUID и **значение `type`** для вашего клиента |
| `Invalid MCP settings schema` (Roo Code) | `type` должен быть `"streamable-http"` (kebab-case) |
| `Invalid MCP settings schema` (Cline) | `type` должен быть `"streamableHttp"` (camelCase) |
| `SSE error: Non-200 status code (400)` | Не указан/неверный `type` — сервер использует Streamable HTTP, не SSE |
| Ошибка авторизации (401/403) | Токен неактуален — запросите новый у администратора |
| Проект не найден | Проверьте UUID проекта в Web UI |
| Skill не активируется | Плагин не установлен или Claude Code не перезапущен |
| Сессии не появляются на сервере | См. вывод хука: `TM-SYNC: ...` в логах. Частые причины ниже |
| `TM-SYNC: MEMORY_API_TOKEN env var not set` | Не задан `TM_TOKEN` в `env` секции `settings.json` |
| `TM-SYNC: project_id not resolved from .mcp.json` | В `.mcp.json` нет `headers["X-Project-Id"]` у сервера `team-memory` |
| `TM-SYNC: session file ... not found` | Сессия ещё не записана на диск или нестандартный путь — обычно проходит к следующему триггеру |
| Сессия не отправляется (<3 сообщений) | Это норма: хук пропускает сессии короче 3 сообщений |
| Сервер недоступен | Проверьте доступность `TM_SERVER_URL` из вашей сети |

---

## Приложение: запуск собственного сервера

Если вы поднимаете сервер Team Memory сами (а не подключаетесь к командному):

```bash
# 1. PostgreSQL
docker compose up -d postgres

# 2. Сборка
npm install
npm run build

# 3. Запуск в HTTP-режиме
DATABASE_URL="postgresql://memory:memory@localhost:5432/team_memory" \
MEMORY_TRANSPORT=http \
MEMORY_API_TOKEN="ваш-master-токен" \
node dist/index.js
```

Или полный стек одной командой: `docker compose up -d`.
Web UI и токены агентов — `http://localhost:3846`.
Полный список переменных окружения — в `README.md`.
