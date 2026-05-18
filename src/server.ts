import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type Tool,
  type Resource
} from '@modelcontextprotocol/sdk/types.js';
import { MemoryManager } from './memory/manager.js';
import { buildAutoContext } from './recall.js';
import logger from './logger.js';
import type {
  Category,
  Priority,
  Status,
  ReadParams,
  UpdateParams,
  DeleteParams,
  SyncParams,
  ConflictError,
  MemoryEntry,
  CompactMemoryEntry
} from './memory/types.js';
import {
  ReadParamsSchema,
  UpdateParamsSchema,
  DeleteParamsSchema,
  SyncParamsSchema,
  PinParamsSchema,
  ProjectActionSchema,
  AuditParamsSchema,
  HistoryParamsSchema,
  ExportParamsSchema,
  CrossSearchParamsSchema,
  formatZodError,
} from './memory/validation.js';
import { exportEntries, type ExportFormat } from './export/exporter.js';
import { EVENT_TYPES, EVENT_TYPE_ICONS, type EventType } from './events/types.js';
import type { AgentTokenStore } from './auth/agent-tokens.js';
import type { NotesManager } from './notes/manager.js';
import type { SessionManager } from './sessions/manager.js';
import { NoteWriteSchema, NoteReadSchema, NoteUpdateSchema, NoteDeleteSchema, NoteSearchSchema, NoteShareSchema } from './notes/validation.js';
import { SessionImportSchema, SessionListSchema, SessionSearchSchema, SessionReadSchema, SessionMessageSearchSchema, SessionDeleteSchema } from './sessions/validation.js';
import type { DedupResolver } from './extraction/dedup.js';
import type { NoteMerger } from './extraction/merger.js';

export interface ExtractionDeps {
  dedupResolver?: DedupResolver;
  merger?: NoteMerger;
}

export function buildMcpServer(
  memoryManager: MemoryManager,
  agentTokenStore?: AgentTokenStore,
  notesManager?: NotesManager,
  sessionManager?: SessionManager,
  extraction: ExtractionDeps = {},
): Server {
  const server = new Server(
    { name: 'team-memory', version: '3.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  setupHandlers(server, memoryManager, agentTokenStore, notesManager, sessionManager, extraction);
  return server;
}

function setupHandlers(
  server: Server,
  memoryManager: MemoryManager,
  agentTokenStore?: AgentTokenStore,
  notesManager?: NotesManager,
  sessionManager?: SessionManager,
  extraction: ExtractionDeps = {},
): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [
      {
        name: 'memory_read',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• В НАЧАЛЕ сессии — проверь память проекта (memory_read() или memory_onboard).\n• ПЕРЕД началом новой задачи — поищи существующие решения (memory_read(search="...")).\n• Когда нужны детали записи — получи полное содержимое по ID.\n\nЧитает командную память. По умолчанию возвращает компактный список (без content). Два сценария получения полного содержимого:\n1. Обзор → детали: memory_read() → получить ID → memory_read(ids=[...])\n2. Поиск: memory_read(search="ключевые слова") → memory_read(ids=[...])\nДля малых выборок: memory_read(search="...", mode="full", limit=5)\n\n⚠️ Когда передан `ids`, все остальные фильтры (category, domain, search, status, tags) ИГНОРИРУЮТСЯ — учитывается только project_id. Это batch-режим: «дай мне эти конкретные записи».',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта. Если не указан — берётся из заголовка X-Project-Id.' },
            category: {
              type: 'string',
              enum: ['profile', 'knowledge', 'tasks', 'issues', 'progress', 'all'],
              description: 'Категория памяти для чтения'
            },
            domain: { type: 'string', description: 'Фильтр по домену (backend, frontend, infrastructure, и т.д.)' },
            search: { type: 'string', description: 'Поиск по ключевым словам' },
            limit: { type: 'number', default: 50, description: 'Максимальное количество записей' },
            offset: { type: 'number', default: 0, description: 'Смещение для пагинации' },
            status: {
              type: 'string',
              enum: ['active', 'completed', 'archived'],
              description: 'Фильтр по статусу'
            },
            ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Список UUID записей для получения полного содержимого (batch). Игнорирует другие фильтры кроме project_id. Макс 100.'
            },
            mode: {
              type: 'string',
              enum: ['compact', 'full'],
              description: 'Режим вывода: compact (по умолчанию) — только метаданные без content; full — полные записи с content'
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Фильтр по тегам (пересечение — запись должна содержать хотя бы один из указанных тегов)'
            }
          }
        }
      },
      {
        name: 'memory_update',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• Задача завершена → memory_update(id="...", status="completed")\n• Проблема решена → обнови content с описанием решения и status="completed"\n• Решение пересмотрено или уточнено → обнови content\n• Изменился приоритет или статус работы\nОБЯЗАТЕЛЬНО обновляй статус задач и проблем, когда их состояние меняется.\n\nОбновляет существующую запись в памяти. Обязательное поле: id. Остальные поля — только те, которые нужно изменить. Пример: memory_update(id="...", status="completed", content="Новый текст")',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'ID записи для обновления' },
            expected_version: { type: 'number', description: 'Ожидаемая версия для optimistic locking. Если текущая версия не совпадает, вернётся ошибка конфликта.' },
            title: { type: 'string', description: 'Новый заголовок' },
            content: { type: 'string', description: 'Новое содержимое' },
            domain: { type: 'string', description: 'Домен проекта. Получите актуальный список через memory_onboard. Стандартные: backend, frontend, infrastructure, devops, database, testing. Проект может содержать дополнительные кастомные домены.' },
            status: { type: 'string', enum: ['active', 'completed', 'archived'], description: 'Новый статус' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Новые теги' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Новый приоритет' },
            pinned: { type: 'boolean', description: 'Закрепить/открепить' },
            relatedIds: { type: 'array', items: { type: 'string' }, description: 'UUID связанных записей для построения графа знаний' }
          },
          required: ['id']
        }
      },
      {
        name: 'memory_delete',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• Когда запись устарела и больше не актуальна.\n• Предпочитай архивацию (по умолчанию) полному удалению.\n\nУдаляет или архивирует запись из памяти. По умолчанию архивирует (archive=true). Для полного удаления: memory_delete(id="...", archive=false)',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'ID записи' },
            archive: { type: 'boolean', default: true, description: 'Архивировать вместо удаления' }
          },
          required: ['id']
        }
      },
      {
        name: 'memory_sync',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• В длительной сессии — проверяй изменения других агентов каждые 30+ минут.\n• После паузы — узнай, что изменилось, пока ты не работал.\n\nПолучает последние изменения в памяти. Без параметров — изменения за 24 часа. Пример: memory_sync(since="2026-03-24T00:00:00Z")',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта' },
            since: { type: 'string', format: 'date-time', description: 'Получить изменения начиная с даты' }
          }
        }
      },
      {
        name: 'memory_unarchive',
        description: 'Разархивирует запись, возвращая в активный статус. Используй, когда архивированная запись снова стала актуальной.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'ID записи' } },
          required: ['id']
        }
      },
      {
        name: 'memory_pin',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• Когда запись критически важна и ДОЛЖНА быть видна всем агентам при каждом входе.\n• Закреплённые записи автоматически попадают в auto-context при старте сессии.\n\nЗакрепляет или открепляет запись. Закреплённые записи НЕ архивируются автоматически.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'ID записи' },
            pinned: { type: 'boolean', default: true, description: 'true - закрепить, false - открепить' }
          },
          required: ['id']
        }
      },
      {
        name: 'memory_projects',
        description: 'Управление проектами. ОБЯЗАТЕЛЬНЫЙ параметр: action.\n- action="list" — список всех проектов (без доп. параметров)\n- action="create" — создать проект (name обязателен, description и domains опционально)\n- action="update" — обновить проект (id обязателен, name/description/domains опционально)\n- action="delete" — удалить проект (id обязателен)',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], description: 'Действие (ОБЯЗАТЕЛЬНО)' },
            id: { type: 'string', description: 'ID проекта (обязателен для update и delete)' },
            name: { type: 'string', description: 'Название проекта (обязательно для create)' },
            description: { type: 'string', description: 'Описание проекта' },
            domains: { type: 'array', items: { type: 'string' }, description: 'Домены проекта (backend, frontend, и т.д.)' }
          },
          required: ['action']
        }
      },
      {
        name: 'memory_audit',
        description: 'Просмотр истории изменений записи или проекта (аудит-лог). Используй для диагностики: кто и когда менял запись.',
        inputSchema: {
          type: 'object',
          properties: {
            entry_id: { type: 'string', description: 'ID записи для просмотра истории' },
            project_id: { type: 'string', description: 'ID проекта для просмотра истории' },
            limit: { type: 'number', default: 20, description: 'Макс. записей' },
          },
        },
      },
      {
        name: 'memory_history',
        description: 'Показывает историю версий записи. Используй для сравнения изменений или отката к предыдущей версии.',
        inputSchema: {
          type: 'object',
          properties: {
            entry_id: { type: 'string', description: 'ID записи' },
            version: { type: 'number', description: 'Конкретная версия (опционально)' },
          },
          required: ['entry_id'],
        },
      },
      {
        name: 'memory_export',
        description: 'Экспортирует записи в формат Markdown или JSON. Используй, когда пользователь просит отчёт или выгрузку данных.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта' },
            format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown', description: 'Формат экспорта' },
            category: { type: 'string', enum: ['profile', 'knowledge', 'tasks', 'issues', 'progress', 'all'], description: 'Категория' },
          },
        },
      },
      {
        name: 'memory_conventions',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• Обнаружил повторяющийся паттерн, который должна соблюдать команда → action="add"\n• Пользователь просит зафиксировать правило или стандарт → action="add"\n• Перед code review — проверь конвенции → action="list"\n\nУправление конвенциями проекта (стиль кода, паттерны, правила). ОБЯЗАТЕЛЬНЫЙ параметр: action.\n- action="list" — показать все конвенции\n- action="add" — добавить (title и content обязательны)\n- action="remove" — удалить (id обязателен)',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'add', 'remove'],
              description: 'Действие (ОБЯЗАТЕЛЬНО): list, add или remove'
            },
            project_id: { type: 'string', description: 'ID проекта' },
            title: { type: 'string', description: 'Название конвенции (обязательно для add)' },
            content: { type: 'string', description: 'Описание конвенции (обязательно для add)' },
            domain: { type: 'string', description: 'Домен конвенции (для add)' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Теги (для add)' },
            id: { type: 'string', description: 'ID конвенции (обязателен для remove)' },
          },
          required: ['action']
        }
      },
      {
        name: 'memory_profile_get',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• В начале сессии для получения эталонного профиля проекта (миссия, стек, конвенции, guard-rails)\n• Когда нужен быстрый контекст «что за проект»\n\nВозвращает текущий активный project profile. Если не задан — пустой ответ с подсказкой как создать.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта' },
          },
        }
      },
      {
        name: 'memory_profile_set',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• Пользователь явно просит обновить профиль проекта\n• Найдено новое значимое правило/guard-rail/stack-факт, который должен быть always-on\n\nЗаменяет активный project profile новым содержимым. Старый профиль архивируется. Категория="profile", pinned=true, priority=high.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта' },
            content: { type: 'string', description: 'Markdown-контент профиля (mission, stack, conventions, guardrails)' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Теги' },
          },
          required: ['content']
        }
      },
      {
        name: 'event_add',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• Произошло событие в проекте, достойное timeline: merge, release, deploy, incident, milestone\n• Пользователь явно сказал об этом ("смержил X", "выпустили v2.1", "задеплоил", "milestone закрыт")\n\nДобавляет событие в project_events timeline. Ручные вызовы помечаются auto_generated=false автоматически (флаг не настраивается извне — авто-экстрактор управляет им сам).',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта' },
            event_type: { type: 'string', enum: ['merge', 'release', 'deploy', 'incident', 'milestone'], description: 'Тип события' },
            occurred_at: { type: 'string', description: 'ISO timestamp; default = сейчас' },
            title: { type: 'string', description: 'Короткий заголовок' },
            description: { type: 'string', description: 'Опциональное описание' },
            actor: { type: 'string', description: 'Кто сделал' },
            refs: { type: 'object', description: '{ pr_number, commit_sha, version_tag, deployment_url, incident_id }' },
          },
          required: ['event_type', 'title']
        }
      },
      {
        name: 'event_list',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• Нужна лента последних событий проекта (что произошло когда)\n• Для онбординга нового агента\n\nВозвращает последние N событий проекта, опционально фильтруя по типу или дате.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта' },
            event_type: { type: 'string', enum: ['merge', 'release', 'deploy', 'incident', 'milestone'], description: 'Фильтр по типу' },
            limit: { type: 'number', description: 'default 10, max 200' },
            since: { type: 'string', description: 'ISO timestamp — события от этой даты' },
          },
        }
      },
      {
        name: 'memory_cross_search',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• Перед реализацией нового паттерна — проверь, решалась ли задача в других проектах.\n• Когда ищешь best practices или примеры решений.\n\nПоиск паттернов и решений МЕЖДУ проектами. ОБЯЗАТЕЛЬНЫЙ параметр: query. Пример: memory_cross_search(query="аутентификация JWT", category="decisions")',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поисковый запрос' },
            category: {
              type: 'string',
              enum: ['profile', 'knowledge', 'tasks', 'issues', 'progress', 'all'],
              description: 'Фильтр по категории'
            },
            domain: { type: 'string', description: 'Фильтр по домену' },
            exclude_project_id: { type: 'string', description: 'Исключить этот проект из поиска (обычно текущий)' },
            limit: { type: 'number', default: 20, description: 'Макс. результатов' },
          },
          required: ['query']
        }
      },
      {
        name: 'memory_onboard',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• В НАЧАЛЕ КАЖДОЙ новой сессии — вызови ПЕРВЫМ ДЕЛОМ для загрузки контекста проекта.\n• При переключении на другой проект.\nОдин вызов вместо десяти memory_read — получишь конвенции, архитектуру, решения, задачи, проблемы, стек.\n\nГенерирует полную сводку проекта для нового агента/члена команды.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта. Если не указан — берётся из заголовка X-Project-Id.' },
          },
        }
      },
      // === Personal Notes tools ===
      {
        name: 'note_write',
        description: 'Создать личную заметку. Привязана к вашему токену — другие агенты не видят. Можно привязать к проекту или сессии.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Заголовок заметки' },
            content: { type: 'string', description: 'Содержимое заметки' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Теги' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            project_id: { type: 'string', description: 'ID проекта (опционально)' },
            session_id: { type: 'string', description: 'ID импортированной сессии (опционально)' },
          },
          required: ['title', 'content'],
        },
      },
      {
        name: 'note_read',
        description: 'Читать свои личные заметки. Фильтрация по тегам, проекту, сессии, статусу.',
        inputSchema: {
          type: 'object',
          properties: {
            search: { type: 'string', description: 'Поиск по ключевым словам' },
            tags: { type: 'array', items: { type: 'string' } },
            project_id: { type: 'string' },
            session_id: { type: 'string' },
            status: { type: 'string', enum: ['active', 'archived'] },
            mode: { type: 'string', enum: ['compact', 'full'], default: 'compact' },
            limit: { type: 'number', default: 50 },
            offset: { type: 'number', default: 0 },
          },
        },
      },
      {
        name: 'note_update',
        description: 'Обновить свою личную заметку.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'UUID заметки' },
            title: { type: 'string' },
            content: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            status: { type: 'string', enum: ['active', 'archived'] },
            project_id: { type: ['string', 'null'] },
            session_id: { type: ['string', 'null'] },
          },
          required: ['id'],
        },
      },
      {
        name: 'note_delete',
        description: 'Удалить или архивировать свою личную заметку.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'UUID заметки' },
            archive: { type: 'boolean', default: true, description: 'Архивировать вместо удаления' },
          },
          required: ['id'],
        },
      },
      {
        name: 'note_search',
        description: 'Семантический поиск по личным заметкам через Qdrant.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поисковый запрос' },
            project_id: { type: 'string' },
            session_id: { type: 'string' },
            limit: { type: 'number', default: 10 },
          },
          required: ['query'],
        },
      },
      {
        name: 'note_share',
        description:
          'Опубликовать личную заметку как запись командной памяти (architecture/decisions/conventions). Выполняет dedup; если найдена похожая запись, возвращает её или подтверждает/мёрджит согласно on_match. Заметка помечается как pinned (не подвержена auto-decay).',
        inputSchema: {
          type: 'object',
          properties: {
            note_id: { type: 'string', description: 'UUID заметки' },
            category: {
              type: 'string',
              // v5 only writes knowledge; legacy values accepted by NotesManager.share
              // for backward compat are auto-translated to knowledge + kind tag.
              enum: ['knowledge', 'architecture', 'decisions', 'conventions'],
              description: 'Категория командной записи (legacy значения автоматически переводятся в knowledge + kind tag)',
            },
            override: {
              type: 'object',
              description: 'Опциональные переопределения title/content/tags/external_refs',
              properties: {
                title: { type: 'string' },
                content: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } },
                external_refs: { type: 'object' },
              },
            },
            on_match: {
              type: 'string',
              enum: ['prompt', 'confirm_existing', 'create_new', 'merge'],
              description:
                'Что делать при найденном совпадении: prompt (по умолчанию — вернуть найденную запись без записи), confirm_existing (++count), merge (объединить), create_new (игнорировать совпадение).',
            },
          },
          required: ['note_id', 'category'],
        },
      },
      // === Session Import tools ===
      {
        name: 'session_import',
        description: 'Импортировать сессию Claude Code с сообщениями. Summary генерируется автоматически через LLM если не указан.',
        inputSchema: {
          type: 'object',
          properties: {
            external_id: { type: 'string', description: 'ID сессии из Claude Code' },
            name: { type: 'string', description: 'Название сессии' },
            summary: { type: 'string', description: 'Summary сессии (опционально — сервер сгенерирует через LLM)' },
            project_id: { type: 'string', description: 'ID проекта (опционально)' },
            working_directory: { type: 'string' },
            git_branch: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            started_at: { type: 'string', description: 'ISO timestamp' },
            ended_at: { type: 'string', description: 'ISO timestamp' },
            messages: { type: 'array', items: { type: 'object', properties: { role: { type: 'string', enum: ['user', 'assistant', 'system'] }, content: { type: 'string' }, timestamp: { type: 'string' }, tool_names: { type: 'array', items: { type: 'string' } } }, required: ['role', 'content'] } },
          },
          required: ['messages'],
        },
      },
      {
        name: 'session_list',
        description: 'Список импортированных сессий. Фильтрация по проекту, тегам, датам.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            date_from: { type: 'string' },
            date_to: { type: 'string' },
            search: { type: 'string' },
            limit: { type: 'number', default: 20 },
            offset: { type: 'number', default: 0 },
          },
        },
      },
      {
        name: 'session_search',
        description: 'Семантический поиск по summary сессий через Qdrant. Найдёт сессию по смыслу.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поисковый запрос' },
            project_id: { type: 'string' },
            limit: { type: 'number', default: 10 },
          },
          required: ['query'],
        },
      },
      {
        name: 'session_read',
        description: 'Прочитать сессию с сообщениями. Пагинация по индексам сообщений.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'UUID сессии' },
            message_from: { type: 'number', default: 0 },
            message_to: { type: 'number' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'session_message_search',
        description: 'Семантический поиск внутри сессии или по всем сообщениям. Находит конкретные сообщения.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поисковый запрос' },
            session_id: { type: 'string', description: 'UUID сессии (опционально — если не указан, ищет по всем)' },
            limit: { type: 'number', default: 10 },
          },
          required: ['query'],
        },
      },
      {
        name: 'session_delete',
        description: 'Удалить импортированную сессию со всеми сообщениями.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'UUID сессии' },
          },
          required: ['session_id'],
        },
      },
    ];
    return { tools };
  });

  // Some MCP clients serialize arrays as JSON strings — parse them back
  function coerceArrayFields(obj: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!obj) return obj;
    const result = { ...obj };
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'string' && value.startsWith('[')) {
        try { result[key] = JSON.parse(value); } catch { /* keep as string */ }
      }
    }
    return result;
  }

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: rawArgs } = request.params;
    const args = coerceArrayFields(rawArgs);

    // Extract agent identity and default project from auth context (HTTP transport)
    const callerAgent = (extra as any)?.authInfo?.clientId as string | undefined;
    const callerScopes = (extra as any)?.authInfo?.scopes as string[] | undefined;
    const isAgentToken = callerAgent && callerAgent !== 'master';
    const headerProjectId = (extra as any)?.authInfo?.projectId as string | undefined;

    // Master tokens (scopes includes 'admin') have full cross-project
    // access by design — same contract as the REST `enforceProjectScope`
    // middleware. Agent tokens are pinned to a project in their
    // X-Project-Id header, but the read/write contract differs:
    //
    //   - READS (memory_read, memory_audit, memory_history, memory_export,
    //     memory_onboard, memory_cross_search) — open across projects.
    //     Agents can look into other teams' projects to find existing
    //     solutions to problems they hit. Per user intent.
    //   - WRITES (memory_write, memory_update, memory_delete, memory_pin,
    //     memory_profile_set, memory_conventions add, event_add,
    //     session_import, note_share) — RBAC enforced. An agent can only
    //     write into projects in its token_project_access allowlist.
    //
    // This is why `requireProjectId` no longer rejects param != header
    // (the old "M1" check) — that broke legit cross-project reads.
    // Write tools enforce via `enforceWriteAccess` below.
    const isMasterToken = Array.isArray(callerScopes) && callerScopes.includes('admin');
    const callerAgentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;

    // Resolve project_id: explicit param > X-Project-Id header. No fallback to default.
    const resolveProjectId = (paramProjectId: string | undefined): string | undefined => {
      return paramProjectId || headerProjectId;
    };
    // Tools that require project context must have a project_id from any source
    const requireProjectId = (paramProjectId: string | undefined, _toolName: string): string | { error: true; response: any } => {
      const resolved = resolveProjectId(paramProjectId);
      if (!resolved) {
        return {
          error: true,
          response: {
            content: [{ type: 'text', text: `❌ project_id обязателен. Укажите project_id в параметрах или настройте заголовок X-Project-Id в конфигурации MCP клиента.\n\nПример конфигурации:\n"headers": { "X-Project-Id": "<uuid проекта>" }` }],
            isError: true,
          },
        };
      }
      return resolved;
    };

    /**
     * Write-side RBAC gate. Call at the top of every write/mutate tool
     * before the storage op. Master tokens bypass; agent tokens must
     * have an active row in `token_project_access` for the target
     * projectId. Returns true to proceed, or an error response to
     * return to the caller verbatim.
     */
    const enforceWriteAccess = (
      projectId: string,
    ): true | { error: true; response: any } => {
      if (isMasterToken) return true;
      if (!callerAgentTokenId) {
        // No agent token AND no master scope — this shouldn't happen
        // (auth middleware rejects unauthenticated MCP requests) but
        // fail-closed defensively.
        return {
          error: true,
          response: {
            content: [{ type: 'text', text: '❌ Запись запрещена: токен не идентифицирован.' }],
            isError: true,
          },
        };
      }
      if (!agentTokenStore || !agentTokenStore.hasProjectAccess(callerAgentTokenId, projectId)) {
        return {
          error: true,
          response: {
            content: [{ type: 'text', text: `❌ Запись запрещена: токен не имеет доступа на изменение проекта ${projectId}. Запросите доступ у администратора через страницу /agents.` }],
            isError: true,
          },
        };
      }
      return true;
    };

    // (Legacy enforceEntryScope removed: previously rejected read access
    // to entries whose projectId differed from header X-Project-Id. Reads
    // are now open across projects per the user's design — agents can
    // look at audit/history from other teams to find solutions.)

    /**
     * Resolve an entry to its project, then gate by write access. Used
     * by entry-based writes (memory_update / memory_delete / memory_pin)
     * where the project comes from the existing entry, not from args.
     */
    const enforceEntryWriteAccess = async (
      entryId: string,
    ): Promise<true | { error: true; response: any }> => {
      if (isMasterToken) return true;
      const entry = await memoryManager.getById(entryId);
      if (!entry) {
        return {
          error: true,
          response: {
            content: [{ type: 'text', text: `❌ Запись ${entryId} не найдена.` }],
            isError: true,
          },
        };
      }
      return enforceWriteAccess(entry.projectId);
    };

    try {
      switch (name) {
        case 'memory_read': {
          const parsed = ReadParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const readProjectId = requireProjectId(parsed.data.project_id, 'memory_read');
          if (typeof readProjectId !== 'string') return readProjectId.response;
          // Detect silent cap: ReadParamsSchema transforms limit via
          // Math.min(v, 500). Clients asking for 10000 get 500 with no
          // indication they were truncated. We compare requested vs
          // resolved and surface a hint in the response so paging is
          // possible.
          const requestedLimit = typeof (args as { limit?: unknown })?.limit === 'number'
            ? (args as { limit: number }).limit
            : undefined;
          const limitWasCapped = requestedLimit !== undefined && requestedLimit > parsed.data.limit;
          const params: ReadParams = {
            projectId: readProjectId,
            category: parsed.data.category,
            domain: parsed.data.domain,
            search: parsed.data.search,
            limit: parsed.data.limit,
            offset: parsed.data.offset,
            status: parsed.data.status,
            ids: parsed.data.ids,
            mode: parsed.data.mode,
            tags: parsed.data.tags,
          };
          const entries = await memoryManager.read(params);
          if (entries.length === 0) {
            return { content: [{ type: 'text', text: 'Записи не найдены по заданным критериям.' }] };
          }
          const capWarning = limitWasCapped
            ? `\n\n⚠️ Запрошенный limit=${requestedLimit} был ограничен до ${parsed.data.limit}. Для пагинации используйте offset.`
            : '';

          const isCompact = !params.ids && params.mode !== 'full';

          if (isCompact) {
            const formatted = (entries as CompactMemoryEntry[]).map(e => {
              const pi = e.priority === 'critical' ? '🔴' : e.priority === 'high' ? '🟠' : e.priority === 'medium' ? '🟡' : '🟢';
              const pin = e.pinned ? '📌 ' : '';
              const dom = e.domain ? ` | ${e.domain}` : '';
              const tags = e.tags.length > 0 ? ` | 🏷️ ${e.tags.join(', ')}` : '';
              return `${pin}${pi} **${e.title}**\n  ID: ${e.id} | ${e.category}${dom} | ${e.status}${tags} | 🕐 ${new Date(e.updatedAt).toLocaleDateString()}`;
            }).join('\n\n');
            return { content: [{ type: 'text', text: `# Командная память (${entries.length} записей, compact)\n\n${formatted}${capWarning}` }] };
          }

          const formatted = (entries as MemoryEntry[]).map(e => {
            const pi = e.priority === 'critical' ? '🔴' : e.priority === 'high' ? '🟠' : e.priority === 'medium' ? '🟡' : '🟢';
            const pin = e.pinned ? '📌 ' : '';
            const dom = e.domain ? ` | **Домен**: ${e.domain}` : '';
            const rel = e.relatedIds && e.relatedIds.length > 0 ? `\n**Связи**: ${e.relatedIds.join(', ')}` : '';
            return `## ${pin}${pi} ${e.title}\n**ID**: ${e.id}\n**Категория**: ${e.category}${dom} | **Статус**: ${e.status} | **Автор**: ${e.author}${e.pinned ? ' | 📌' : ''}\n**Теги**: ${e.tags.join(', ') || 'нет'}${rel}\n**Обновлено**: ${new Date(e.updatedAt).toLocaleString()}\n\n${e.content}\n\n---`;
          }).join('\n\n');
          return { content: [{ type: 'text', text: `# Командная память (${entries.length} записей)\n\n${formatted}${capWarning}` }] };
        }

        case 'memory_update': {
          const parsed = UpdateParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const writeGate = await enforceEntryWriteAccess(parsed.data.id);
          if (writeGate !== true) return writeGate.response;
          const { expected_version, ...rest } = parsed.data;
          const params: UpdateParams = { ...rest, expectedVersion: expected_version };
          const result = await memoryManager.update(params);

          // Check for conflict
          if (result && 'conflict' in result) {
            const conflict = result as ConflictError;
            return {
              content: [{
                type: 'text',
                text: `⚠️ Конфликт версий!\n\n${conflict.message}\n\n**Текущая версия**: ${conflict.currentVersion}\n**Текущий заголовок**: ${conflict.currentEntry.title}\n\nПрочитайте запись заново и повторите обновление с актуальной версией.`
              }],
              isError: true,
            };
          }

          if (!result) return { content: [{ type: 'text', text: `❌ Запись с ID "${parsed.data.id}" не найдена.` }] };
          const entry = result as MemoryEntry;
          const versionInfo = entry.currentVersion !== undefined ? `\n**Версия**: ${entry.currentVersion}` : '';
          return { content: [{ type: 'text', text: `✅ Запись обновлена!\n\n**ID**: ${entry.id}\n**Заголовок**: ${entry.title}\n**Статус**: ${entry.status}${versionInfo}` }] };
        }

        case 'memory_delete': {
          const parsed = DeleteParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const writeGate = await enforceEntryWriteAccess(parsed.data.id);
          if (writeGate !== true) return writeGate.response;
          const params = parsed.data;
          const deleteResult = await memoryManager.delete(params);
          if (typeof deleteResult === 'object' && deleteResult && 'conflict' in deleteResult) {
            return { content: [{ type: 'text', text: `⚠️ Конфликт версий: ${deleteResult.message}. Перечитайте запись и повторите.` }], isError: true };
          }
          if (!deleteResult) return { content: [{ type: 'text', text: `❌ Запись с ID "${params.id}" не найдена.` }] };
          return { content: [{ type: 'text', text: params.archive ? `📦 Запись архивирована (ID: ${params.id})` : `🗑️ Запись удалена (ID: ${params.id})` }] };
        }

        case 'memory_sync': {
          const parsed = SyncParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const syncProjectId = requireProjectId(parsed.data.project_id, 'memory_sync');
          if (typeof syncProjectId !== 'string') return syncProjectId.response;
          const params: SyncParams = { projectId: syncProjectId, since: parsed.data.since };
          const result = await memoryManager.sync(params);
          if (result.entries.length === 0) {
            return { content: [{ type: 'text', text: `✅ Синхронизировано. Новых изменений нет.\nПоследнее обновление: ${result.lastUpdated}` }] };
          }
          const changes = result.entries.map(e => `- [${e.category}]${e.domain ? `[${e.domain}]` : ''} **${e.title}** (${e.status})`).join('\n');
          return { content: [{ type: 'text', text: `🔄 Синхронизация\n\n**Изменений**: ${result.totalChanges}\n\n${changes}` }] };
        }

        case 'memory_unarchive': {
          const id = args?.id as string;
          if (!id) return { content: [{ type: 'text', text: '❌ Укажите ID записи.' }], isError: true };
          const writeGate = await enforceEntryWriteAccess(id);
          if (writeGate !== true) return writeGate.response;
          const unarchiveResult = await memoryManager.update({ id, status: 'active' });
          if (!unarchiveResult || ('conflict' in unarchiveResult)) return { content: [{ type: 'text', text: `❌ Запись "${id}" не найдена.` }] };
          return { content: [{ type: 'text', text: `📤 Разархивировано!\n\n**ID**: ${unarchiveResult.id}\n**Заголовок**: ${unarchiveResult.title}` }] };
        }

        case 'memory_pin': {
          const parsed = PinParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const writeGate = await enforceEntryWriteAccess(parsed.data.id);
          if (writeGate !== true) return writeGate.response;
          const { id, pinned } = parsed.data;
          const updated = await memoryManager.pin(id, pinned);
          if (!updated) return { content: [{ type: 'text', text: `❌ Запись "${id}" не найдена.` }] };
          return { content: [{ type: 'text', text: `${pinned ? '📌' : '📍'} Запись ${pinned ? 'закреплена' : 'откреплена'}!\n\n**ID**: ${updated.id}\n**Заголовок**: ${updated.title}` }] };
        }

        case 'memory_projects': {
          const parsed = ProjectActionSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const projectAction = parsed.data;
          switch (projectAction.action) {
            case 'list': {
              const projects = await memoryManager.listProjects();
              if (projects.length === 0) return { content: [{ type: 'text', text: 'Проектов не найдено.' }] };
              const list = projects.map(p => `- **${p.name}** (ID: ${p.id})\n  ${p.description}\n  Домены: ${p.domains.join(', ')}`).join('\n\n');
              return { content: [{ type: 'text', text: `# Проекты (${projects.length})\n\n${list}` }] };
            }
            case 'create': {
              const p = await memoryManager.createProject({ name: projectAction.name, description: projectAction.description, domains: projectAction.domains });
              return { content: [{ type: 'text', text: `✅ Проект создан!\n\n**ID**: ${p.id}\n**Название**: ${p.name}\n**Домены**: ${p.domains.join(', ')}` }] };
            }
            case 'update': {
              const u = await memoryManager.updateProject(projectAction.id, { name: projectAction.name, description: projectAction.description, domains: projectAction.domains });
              if (!u) return { content: [{ type: 'text', text: `❌ Проект "${projectAction.id}" не найден.` }] };
              return { content: [{ type: 'text', text: `✅ Проект обновлён!\n\n**ID**: ${u.id}\n**Название**: ${u.name}` }] };
            }
            case 'delete': {
              const d = await memoryManager.deleteProject(projectAction.id);
              return { content: [{ type: 'text', text: d ? `🗑️ Проект удалён (${projectAction.id})` : `❌ Не найден или default.` }] };
            }
          }
          // All cases return above; this is a safety break
          break;
        }

        case 'memory_audit': {
          const auditLogger = memoryManager.getAuditLogger();
          if (!auditLogger) {
            return { content: [{ type: 'text', text: '❌ Аудит-лог не подключён.' }], isError: true };
          }
          const parsed = AuditParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const { entry_id: auditEntryId, project_id: auditProjectId, limit: auditLimit } = parsed.data;
          const resolvedAuditProjectId = resolveProjectId(auditProjectId);

          let auditEntries;
          if (auditEntryId) {
            // Reads are open across projects by design (see read/write
            // split docs at top of CallToolRequest handler). The entry's
            // audit log is metadata — same trust level as memory_read.
            auditEntries = await auditLogger.getByEntry(auditEntryId, auditLimit);
          } else if (resolvedAuditProjectId) {
            auditEntries = await auditLogger.getByProject(resolvedAuditProjectId, auditLimit);
          } else {
            return { content: [{ type: 'text', text: '❌ Укажите `project_id` (или передайте `X-Project-Id` header) либо `entry_id`. Глобальный аудит-лог не возвращается из соображений изоляции проектов.' }], isError: true };
          }

          if (auditEntries.length === 0) {
            return { content: [{ type: 'text', text: 'История изменений пуста.' }] };
          }

          const auditFormatted = auditEntries.map(a =>
            `- **${a.action}** [${new Date(a.createdAt).toLocaleString()}] by ${a.actor}` +
            (a.entryId ? ` (entry: ${a.entryId})` : '') +
            (Object.keys(a.changes).length > 0 ? `\n  Изменения: ${JSON.stringify(a.changes)}` : '')
          ).join('\n');

          return { content: [{ type: 'text', text: `# Аудит-лог (${auditEntries.length} записей)\n\n${auditFormatted}` }] };
        }

        case 'memory_history': {
          const vm = memoryManager.getVersionManager();
          if (!vm) {
            return { content: [{ type: 'text', text: '❌ Версионирование не подключено.' }], isError: true };
          }
          const parsed = HistoryParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const { entry_id: histEntryId, version: histVersion } = parsed.data;
          // Reads are open across projects by design — history is the
          // entry's metadata, same trust level as memory_read content.

          if (histVersion !== undefined) {
            const v = await vm.getVersion(histEntryId, histVersion);
            if (!v) return { content: [{ type: 'text', text: `❌ Версия ${histVersion} не найдена.` }] };
            return { content: [{ type: 'text', text: `# Версия ${v.version}\n\n**Заголовок**: ${v.title}\n**Категория**: ${v.category}\n**Статус**: ${v.status}\n**Автор**: ${v.author}\n**Дата**: ${new Date(v.createdAt).toLocaleString()}\n\n${v.content}` }] };
          }

          const versions = await vm.getVersions(histEntryId);
          if (versions.length === 0) {
            return { content: [{ type: 'text', text: 'История версий пуста (запись ещё не обновлялась).' }] };
          }

          const vFormatted = versions.map(v =>
            `- **v${v.version}** [${new Date(v.createdAt).toLocaleString()}] — ${v.title} (${v.status})`
          ).join('\n');

          return { content: [{ type: 'text', text: `# История версий (${versions.length})\n\n${vFormatted}` }] };
        }

        case 'memory_export': {
          const parsed = ExportParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const { project_id: expProjectId, format: expFormat, category: expCategory } = parsed.data;
          const resolvedExpProjectId = requireProjectId(expProjectId, 'memory_export');
          if (typeof resolvedExpProjectId !== 'string') return resolvedExpProjectId.response;

          const expEntries = await memoryManager.read({
            projectId: resolvedExpProjectId,
            category: expCategory as any,
            limit: 500,
            status: 'active',
            mode: 'full',
          });

          const exported = exportEntries(expEntries as MemoryEntry[], expFormat);
          return { content: [{ type: 'text', text: exported }] };
        }

        case 'memory_cross_search': {
          const parsed = CrossSearchParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const { query: csQuery, category: csCat, domain: csDom, exclude_project_id: csExclude, limit: csLimit } = parsed.data;

          const results = await memoryManager.crossSearch(csQuery, {
            category: csCat === 'all' ? undefined : csCat,
            domain: csDom,
            excludeProjectId: csExclude,
            limit: csLimit,
          });

          if (results.length === 0) {
            return { content: [{ type: 'text', text: `Ничего не найдено по запросу "${csQuery}" во всех проектах.` }] };
          }

          const formatted = results.map(e => {
            const pi = e.priority === 'critical' ? '🔴' : e.priority === 'high' ? '🟠' : e.priority === 'medium' ? '🟡' : '🟢';
            return `## ${pi} ${e.title}\n**Проект**: ${e.projectName} | **Категория**: ${e.category}${e.domain ? ` | **Домен**: ${e.domain}` : ''}\n**Обновлено**: ${new Date(e.updatedAt).toLocaleString()}\n\n${e.content.length > 300 ? e.content.substring(0, 300) + '...' : e.content}\n\n---`;
          }).join('\n\n');

          return { content: [{ type: 'text', text: `# Cross-Project Search: "${csQuery}" (${results.length} результатов)\n\n${formatted}` }] };
        }

        case 'memory_conventions': {
          const action = args?.action as string;
          const convProjectId = requireProjectId(args?.project_id as string | undefined, 'memory_conventions');
          if (typeof convProjectId !== 'string') return convProjectId.response;
          const projectId: string | undefined = convProjectId;

          if (action === 'list') {
            // v5: conventions live in 'knowledge' with kind tag 'convention'.
            // Read includes legacy 'conventions' category entries via a separate
            // call for projects that haven't been migrated yet.
            const knowledgeConv = await memoryManager.read({
              projectId,
              category: 'knowledge',
              tags: ['convention'],
              status: 'active',
              limit: 100,
              mode: 'full',
            });
            const legacyConv = await memoryManager.read({
              projectId,
              category: 'conventions',
              status: 'active',
              limit: 100,
              mode: 'full',
            });
            const entries = [...(knowledgeConv as MemoryEntry[]), ...(legacyConv as MemoryEntry[])];
            if (entries.length === 0) {
              return { content: [{ type: 'text', text: 'Конвенции не заданы. Используйте action: "add" для добавления.' }] };
            }
            const formatted = entries.map(e => {
              const dom = e.domain ? ` [${e.domain}]` : '';
              const tags = e.tags.length > 0 ? ` (${e.tags.join(', ')})` : '';
              return `### 📏 ${e.title}${dom}${tags}\n${e.content}\n`;
            }).join('\n---\n\n');
            return { content: [{ type: 'text', text: `# Конвенции проекта (${entries.length})\n\n${formatted}` }] };
          }

          if (action === 'add') {
            if (!args?.title || !args?.content) {
              return { content: [{ type: 'text', text: '❌ Для добавления конвенции укажите title и content.' }], isError: true };
            }
            const writeGate = enforceWriteAccess(projectId);
            if (writeGate !== true) return writeGate.response;
            // v5: write as category='knowledge' with kind tag 'convention'.
            const callerTags = (args?.tags as string[]) || [];
            const tags = callerTags.includes('convention') ? callerTags : ['convention', ...callerTags];
            const entry = await memoryManager.write({
              projectId,
              category: 'knowledge',
              title: args?.title as string,
              content: args?.content as string,
              domain: args?.domain as string,
              tags,
              priority: 'high',
              pinned: true,
              author: isAgentToken ? callerAgent : undefined,
            });
            return { content: [{ type: 'text', text: `✅ Конвенция добавлена!\n\n**ID**: ${entry.id}\n**Заголовок**: ${entry.title}\n📌 Автоматически закреплена` }] };
          }

          if (action === 'remove') {
            if (!args?.id) {
              return { content: [{ type: 'text', text: '❌ Для удаления конвенции укажите id.' }], isError: true };
            }
            const convResult = await memoryManager.delete({ id: args.id as string, archive: true });
            // memory_conventions never passes expectedVersion, but narrow for type safety.
            if (typeof convResult === 'object' && convResult && 'conflict' in convResult) {
              return { content: [{ type: 'text', text: `⚠️ Конфликт версий при архивации конвенции.` }], isError: true };
            }
            return { content: [{ type: 'text', text: convResult ? `📦 Конвенция архивирована` : `❌ Не найдена` }] };
          }

          return { content: [{ type: 'text', text: '❌ Неизвестное действие. Используйте: list, add, remove' }], isError: true };
        }

        case 'memory_profile_get': {
          const profileProjectId = requireProjectId(args?.project_id as string | undefined, 'memory_profile_get');
          if (typeof profileProjectId !== 'string') return profileProjectId.response;
          const profile = await memoryManager.getProfile(profileProjectId);
          if (!profile) {
            return { content: [{ type: 'text', text: '🗺️ Profile не задан для этого проекта. Используйте memory_profile_set(content="...") для создания эталонного профиля проекта.' }] };
          }
          return { content: [{ type: 'text', text: `# 🗺️ Project Profile\n\n${profile.content}\n\n*ID: ${profile.id} | updated: ${profile.updatedAt}*` }] };
        }

        case 'memory_profile_set': {
          const profileSetProjectId = requireProjectId(args?.project_id as string | undefined, 'memory_profile_set');
          if (typeof profileSetProjectId !== 'string') return profileSetProjectId.response;
          const writeGate = enforceWriteAccess(profileSetProjectId);
          if (writeGate !== true) return writeGate.response;
          if (!args?.content || typeof args.content !== 'string') {
            return { content: [{ type: 'text', text: '❌ Параметр content (string) обязателен' }], isError: true };
          }
          const profileEntry = await memoryManager.setProfile(
            profileSetProjectId,
            args.content,
            (args.tags as string[]) || [],
            isAgentToken ? callerAgent : undefined,
          );
          return { content: [{ type: 'text', text: `✅ Profile обновлён!\n\n**ID**: ${profileEntry.id}\n**Категория**: profile\n📌 Pinned, priority=high.\nПредыдущий активный profile (если был) архивирован.` }] };
        }

        case 'event_add': {
          const eventsManager = memoryManager.getEventsManager();
          if (!eventsManager) return { content: [{ type: 'text', text: '❌ Events not configured' }], isError: true };
          const eventAddProjectId = requireProjectId(args?.project_id as string | undefined, 'event_add');
          if (typeof eventAddProjectId !== 'string') return eventAddProjectId.response;
          const writeGate = enforceWriteAccess(eventAddProjectId);
          if (writeGate !== true) return writeGate.response;
          const eventType = args?.event_type as string;
          const eventTitle = args?.title as string;
          if (!eventType || !eventTitle) {
            return { content: [{ type: 'text', text: '❌ event_type и title обязательны' }], isError: true };
          }
          if (!EVENT_TYPES.includes(eventType as EventType)) {
            return { content: [{ type: 'text', text: `❌ event_type должен быть одним из: ${EVENT_TYPES.join(', ')}` }], isError: true };
          }
          try {
            const ev = await eventsManager.add({
              projectId: eventAddProjectId,
              eventType: eventType as EventType,
              occurredAt: (args?.occurred_at as string) || new Date().toISOString(),
              title: eventTitle,
              description: args?.description as string | undefined,
              actor: (args?.actor as string) || (isAgentToken ? callerAgent : undefined),
              refs: (args?.refs as Record<string, unknown>) || {},
            });
            const icon = EVENT_TYPE_ICONS[ev.eventType] ?? '·';
            return { content: [{ type: 'text', text: `✅ Событие добавлено!\n${icon} **${ev.eventType}**: ${ev.title}\n**ID**: ${ev.id}` }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `❌ ${(err as Error).message}` }], isError: true };
          }
        }

        case 'event_list': {
          const eventsManager = memoryManager.getEventsManager();
          if (!eventsManager) return { content: [{ type: 'text', text: '❌ Events not configured' }], isError: true };
          const eventListProjectId = requireProjectId(args?.project_id as string | undefined, 'event_list');
          if (typeof eventListProjectId !== 'string') return eventListProjectId.response;
          const filterType = args?.event_type as string | undefined;
          if (filterType && !EVENT_TYPES.includes(filterType as EventType)) {
            return { content: [{ type: 'text', text: `❌ event_type должен быть одним из: ${EVENT_TYPES.join(', ')}` }], isError: true };
          }
          const events = await eventsManager.list(eventListProjectId, {
            eventType: filterType as EventType | undefined,
            limit: (args?.limit as number) ?? 10,
            since: args?.since as string | undefined,
          });
          if (events.length === 0) return { content: [{ type: 'text', text: '📋 Событий не найдено' }] };
          const lines = events.map(ev => {
            const date = ev.occurredAt.substring(0, 10);
            const icon = EVENT_TYPE_ICONS[ev.eventType] ?? '·';
            return `- ${date} ${icon} **${ev.eventType}**: ${ev.title}${ev.actor ? ` — ${ev.actor}` : ''}${ev.autoGenerated ? ' _(auto)_' : ''}`;
          });
          return { content: [{ type: 'text', text: `📈 События (${events.length}):\n${lines.join('\n')}` }] };
        }

        case 'memory_onboard': {
          const onboardProjectId = requireProjectId(args?.project_id as string | undefined, 'memory_onboard');
          if (typeof onboardProjectId !== 'string') return onboardProjectId.response;
          const summary = await memoryManager.generateOnboarding(onboardProjectId);
          return { content: [{ type: 'text', text: summary }] };
        }

        // === Personal Notes handlers ===

        case 'note_write': {
          if (!notesManager) return { content: [{ type: 'text', text: '❌ Notes not configured' }], isError: true };
          const parsed = NoteWriteSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          // note_write requires agent token — master cannot create personal notes (no owner)
          const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
          if (!agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required to create personal notes' }], isError: true };
          // v5 invariant: every personal_note MUST be bound to a project.
          // Enforced at the schema level too (migration 025: NOT NULL constraint).
          // Reject the call early with a helpful message instead of a DB error.
          const noteProjectIdResult = requireProjectId(parsed.data.project_id ?? undefined, 'note_write');
          if (typeof noteProjectIdResult !== 'string') return noteProjectIdResult.response;
          const note = await notesManager.write(agentTokenId, {
            title: parsed.data.title,
            content: parsed.data.content,
            tags: parsed.data.tags,
            priority: parsed.data.priority,
            projectId: noteProjectIdResult,
            sessionId: parsed.data.session_id ?? null,
          });
          return { content: [{ type: 'text', text: `📝 Заметка создана: ${note.id}\n**${note.title}**` }] };
        }

        case 'note_read': {
          if (!notesManager) return { content: [{ type: 'text', text: '❌ Notes not configured' }], isError: true };
          const parsed = NoteReadSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const isMaster = callerAgent === 'master';
          const agentTokenId: string | null = isMaster ? null : ((extra as any)?.authInfo?.agentTokenId as string | undefined) ?? null;
          if (!isMaster && !agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required' }], isError: true };
          const notes = await notesManager.read(agentTokenId, {
            search: parsed.data.search,
            tags: parsed.data.tags,
            projectId: parsed.data.project_id,
            sessionId: parsed.data.session_id,
            status: parsed.data.status,
            mode: parsed.data.mode,
            limit: parsed.data.limit,
            offset: parsed.data.offset,
          });
          if (notes.length === 0) return { content: [{ type: 'text', text: '📝 Заметок не найдено.' }] };
          const lines = notes.map((n: any) => `- **${n.title}** (id: ${n.id}, ${n.status}${n.tags?.length ? ', tags: ' + n.tags.join(', ') : ''})`);
          return { content: [{ type: 'text', text: `📝 Найдено ${notes.length} заметок:\n${lines.join('\n')}` }] };
        }

        case 'note_update': {
          if (!notesManager) return { content: [{ type: 'text', text: '❌ Notes not configured' }], isError: true };
          const parsed = NoteUpdateSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const isMaster = callerAgent === 'master';
          const agentTokenId: string | null = isMaster ? null : ((extra as any)?.authInfo?.agentTokenId as string | undefined) ?? null;
          if (!isMaster && !agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required' }], isError: true };
          const updated = await notesManager.update(parsed.data.id, agentTokenId, {
            title: parsed.data.title,
            content: parsed.data.content,
            tags: parsed.data.tags,
            priority: parsed.data.priority,
            status: parsed.data.status,
            projectId: parsed.data.project_id,
            sessionId: parsed.data.session_id,
          });
          return { content: [{ type: 'text', text: `✅ Заметка обновлена: **${updated.title}**` }] };
        }

        case 'note_delete': {
          if (!notesManager) return { content: [{ type: 'text', text: '❌ Notes not configured' }], isError: true };
          const parsed = NoteDeleteSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const isMaster = callerAgent === 'master';
          const agentTokenId: string | null = isMaster ? null : ((extra as any)?.authInfo?.agentTokenId as string | undefined) ?? null;
          if (!isMaster && !agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required' }], isError: true };
          const deleted = await notesManager.delete(parsed.data.id, agentTokenId, parsed.data.archive);
          return { content: [{ type: 'text', text: deleted ? `✅ Заметка ${parsed.data.archive ? 'архивирована' : 'удалена'}` : '❌ Заметка не найдена' }] };
        }

        case 'note_search': {
          if (!notesManager) return { content: [{ type: 'text', text: '❌ Notes not configured' }], isError: true };
          const parsed = NoteSearchSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
          if (!agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required for semantic search' }], isError: true };
          const results = await notesManager.semanticSearch(agentTokenId, parsed.data.query, {
            projectId: parsed.data.project_id,
            sessionId: parsed.data.session_id,
            limit: parsed.data.limit,
          });
          if (results.length === 0) return { content: [{ type: 'text', text: '🔍 Ничего не найдено.' }] };
          const lines = results.map(n => `- [${n.score.toFixed(2)}] **${n.title}** (id: ${n.id})`);
          return { content: [{ type: 'text', text: `🔍 Найдено ${results.length} заметок:\n${lines.join('\n')}` }] };
        }

        case 'note_share': {
          if (!notesManager) {
            return { content: [{ type: 'text', text: '❌ Notes not configured' }], isError: true };
          }
          const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
          if (!agentTokenId) {
            return { content: [{ type: 'text', text: '❌ Agent token required for share' }], isError: true };
          }
          const parsed = NoteShareSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          // on_match values that depend on dedup (confirm_existing, merge)
          // can't be honoured if no resolver/merger is wired. Fail loud
          // instead of silently falling through to create — this preserves
          // intent across the MCP and REST surfaces.
          const onMatch = parsed.data.on_match;
          if (
            (onMatch === 'confirm_existing' || onMatch === 'merge') &&
            !extraction.dedupResolver
          ) {
            return {
              content: [
                {
                  type: 'text',
                  text: '❌ on_match=' + onMatch + ' requires a dedup resolver, which is not wired in this deployment.',
                },
              ],
              isError: true,
            };
          }
          try {
            // Write-side RBAC: shared entries land in the note's project.
            // Look up the note first so we can gate against its projectId
            // instead of trusting the caller's header (an agent reading
            // their own notes can also try to share into projects they
            // don't have write rights on).
            const noteForScope = await notesManager.getById(parsed.data.note_id, agentTokenId);
            if (!noteForScope) {
              return { content: [{ type: 'text', text: '❌ Note not found or not yours' }], isError: true };
            }
            if (noteForScope.projectId) {
              const shareWriteGate = enforceWriteAccess(noteForScope.projectId);
              if (shareWriteGate !== true) return shareWriteGate.response;
            }
            // authInfo.clientId is set to agentInfo.agentName by the auth
            // middleware for agent-token requests, so it doubles as the
            // human-readable author for shared entries.
            const agentName = (extra as any)?.authInfo?.clientId as string | undefined;
            const result = await notesManager.share({
              noteId: parsed.data.note_id,
              agentTokenId,
              agentName,
              category: parsed.data.category,
              override: parsed.data.override
                ? {
                    title: parsed.data.override.title,
                    content: parsed.data.override.content,
                    tags: parsed.data.override.tags,
                    externalRefs: parsed.data.override.external_refs,
                  }
                : undefined,
              onMatch,
              memoryManager,
              dedupResolver: extraction.dedupResolver,
              merger: extraction.merger,
            });
            const lines: string[] = [`Action: ${result.action}`];
            if (result.entryId) lines.push(`Entry ID: ${result.entryId}`);
            if (result.existingEntry) {
              lines.push(
                `Existing: ${result.existingEntry.title} (id: ${result.existingEntry.id}, score: ${result.existingEntry.score.toFixed(2)})`,
              );
            }
            return { content: [{ type: 'text', text: lines.join('\n') }] };
          } catch (err) {
            const message = (err as Error).message ?? '';
            // Whitelist known business errors; mask everything else so
            // unexpected internals (DB messages, stack-derived strings)
            // don't leak to MCP clients. Mirrors the REST endpoint contract.
            if (message === 'Note not found or not yours') {
              return { content: [{ type: 'text', text: '❌ Not found: note does not exist or you are not the owner' }], isError: true };
            }
            if (message === 'Note already shared') {
              return { content: [{ type: 'text', text: '❌ Already shared: note is already linked to a memory entry' }], isError: true };
            }
            logger.error({ err, agentTokenId, noteId: parsed.data.note_id }, 'note_share failed');
            return { content: [{ type: 'text', text: '❌ Share failed (see server logs)' }], isError: true };
          }
        }

        // === Session Import handlers ===

        case 'session_import': {
          if (!sessionManager) return { content: [{ type: 'text', text: '❌ Sessions not configured' }], isError: true };
          const parsed = SessionImportSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
          if (!agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required for session import' }], isError: true };
          // v5 invariant: every imported session MUST be bound to a project.
          // Same rationale as note_write — orphaned rows are invisible in the UI.
          const sessionProjectIdResult = requireProjectId(parsed.data.project_id ?? undefined, 'session_import');
          if (typeof sessionProjectIdResult !== 'string') return sessionProjectIdResult.response;
          const sessionWriteGate = enforceWriteAccess(sessionProjectIdResult);
          if (sessionWriteGate !== true) return sessionWriteGate.response;
          const session = await sessionManager.importSession(agentTokenId, {
            externalId: parsed.data.external_id ?? undefined,
            name: parsed.data.name ?? undefined,
            summary: parsed.data.summary ?? undefined,
            projectId: sessionProjectIdResult,
            workingDirectory: parsed.data.working_directory ?? undefined,
            gitBranch: parsed.data.git_branch ?? undefined,
            tags: parsed.data.tags,
            startedAt: parsed.data.started_at,
            endedAt: parsed.data.ended_at,
            messages: parsed.data.messages.map(m => ({
              role: m.role,
              content: m.content,
              timestamp: m.timestamp,
              toolNames: m.tool_names,
            })),
          });
          return { content: [{ type: 'text', text: `📥 Сессия импортирована: ${session.id}\nСообщений: ${session.messageCount}\nСтатус: в очереди на обработку (LLM summary + embedding)` }] };
        }

        case 'session_list': {
          if (!sessionManager) return { content: [{ type: 'text', text: '❌ Sessions not configured' }], isError: true };
          const parsed = SessionListSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
          if (!agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required' }], isError: true };
          const sessions = await sessionManager.listSessions(agentTokenId, {
            projectId: resolveProjectId(parsed.data.project_id),
            tags: parsed.data.tags,
            dateFrom: parsed.data.date_from,
            dateTo: parsed.data.date_to,
            search: parsed.data.search,
            limit: parsed.data.limit,
            offset: parsed.data.offset,
          });
          if (sessions.length === 0) return { content: [{ type: 'text', text: '📋 Сессий не найдено.' }] };
          const lines = sessions.map(s => `- **${s.name || 'Без названия'}** (${s.messageCount} сообщ., ${s.startedAt?.slice(0, 10) ?? '?'}) id: ${s.id}`);
          return { content: [{ type: 'text', text: `📋 Найдено ${sessions.length} сессий:\n${lines.join('\n')}` }] };
        }

        case 'session_search': {
          if (!sessionManager) return { content: [{ type: 'text', text: '❌ Sessions not configured' }], isError: true };
          const parsed = SessionSearchSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
          if (!agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required' }], isError: true };
          const results = await sessionManager.searchSessions(agentTokenId, parsed.data.query, {
            projectId: resolveProjectId(parsed.data.project_id),
            limit: parsed.data.limit,
          });
          if (results.length === 0) return { content: [{ type: 'text', text: '🔍 Сессий не найдено.' }] };
          const lines = results.map(s => `- [${s.score.toFixed(2)}] **${s.name || s.summary.slice(0, 60)}** (${s.messageCount} сообщ.) id: ${s.id}`);
          return { content: [{ type: 'text', text: `🔍 Найдено ${results.length} сессий:\n${lines.join('\n')}` }] };
        }

        case 'session_read': {
          if (!sessionManager) return { content: [{ type: 'text', text: '❌ Sessions not configured' }], isError: true };
          const parsed = SessionReadSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
          if (!agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required' }], isError: true };
          const result = await sessionManager.readSession(parsed.data.session_id, agentTokenId, parsed.data.message_from, parsed.data.message_to);
          if (!result) return { content: [{ type: 'text', text: '❌ Сессия не найдена' }], isError: true };
          const header = `📖 **${result.session.name || 'Сессия'}** (${result.session.messageCount} сообщений)\n\n`;
          const msgs = result.messages.map(m => `**[${m.role}]** ${m.content.slice(0, 500)}${m.content.length > 500 ? '...' : ''}`);
          return { content: [{ type: 'text', text: header + msgs.join('\n\n---\n\n') }] };
        }

        case 'session_message_search': {
          if (!sessionManager) return { content: [{ type: 'text', text: '❌ Sessions not configured' }], isError: true };
          const parsed = SessionMessageSearchSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
          if (!agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required' }], isError: true };
          const results = await sessionManager.searchMessages(agentTokenId, parsed.data.query, {
            sessionId: parsed.data.session_id,
            limit: parsed.data.limit,
          });
          if (results.length === 0) return { content: [{ type: 'text', text: '🔍 Сообщений не найдено.' }] };
          const lines = results.map(r => `- [${r.score.toFixed(2)}] **${r.role}** (сессия: ${r.sessionId}, msg #${r.messageIndex})`);
          return { content: [{ type: 'text', text: `🔍 Найдено ${results.length} сообщений:\n${lines.join('\n')}` }] };
        }

        case 'session_delete': {
          if (!sessionManager) return { content: [{ type: 'text', text: '❌ Sessions not configured' }], isError: true };
          const parsed = SessionDeleteSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
          if (!agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required' }], isError: true };
          const deleted = await sessionManager.deleteSession(parsed.data.session_id, agentTokenId);
          return { content: [{ type: 'text', text: deleted ? '✅ Сессия удалена' : '❌ Сессия не найдена' }] };
        }

        default:
          return { content: [{ type: 'text', text: `❌ Неизвестный инструмент: ${name}` }], isError: true };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `❌ Ошибка: ${message}` }], isError: true };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources: Resource[] = [
      { uri: 'memory://overview', name: 'Обзор проекта', description: 'Общий обзор', mimeType: 'text/markdown' },
      { uri: 'memory://recent', name: 'Последние изменения', description: 'За 24 часа', mimeType: 'text/markdown' },
      { uri: 'memory://architecture', name: 'Архитектура', description: 'Архитектурные решения', mimeType: 'text/markdown' },
      { uri: 'memory://tasks', name: 'Задачи', description: 'Текущие задачи', mimeType: 'text/markdown' },
      { uri: 'memory://issues', name: 'Проблемы', description: 'Известные проблемы', mimeType: 'text/markdown' },
      { uri: 'memory://conventions', name: 'Конвенции', description: 'Конвенции и правила проекта', mimeType: 'text/markdown' }
    ];
    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === 'memory://overview') {
      return { contents: [{ uri, mimeType: 'text/markdown', text: await memoryManager.getOverview() }] };
    }
    if (uri === 'memory://recent') {
      const recent = await memoryManager.getRecent();
      const text = recent.length > 0
        ? recent.map(e => `- [${e.category}]${e.domain ? `[${e.domain}]` : ''} **${e.title}** - ${e.author}`).join('\n')
        : 'Нет изменений за 24 часа.';
      return { contents: [{ uri, mimeType: 'text/markdown', text: `# Последние изменения\n\n${text}` }] };
    }
    const VALID_CATEGORIES = ['profile', 'knowledge', 'tasks', 'issues', 'progress'];
    const m = uri.match(/^memory:\/\/(\w+)$/);
    if (m && VALID_CATEGORIES.includes(m[1])) {
      const category = m[1] as Category;
      const entries = await memoryManager.read({ category, status: 'active', mode: 'full' });
      const text = entries.length > 0 ? (entries as MemoryEntry[]).map(e => `## ${e.title}\n${e.content}\n\n---`).join('\n\n') : `Нет записей.`;
      return { contents: [{ uri, mimeType: 'text/markdown', text }] };
    }
    throw new Error(`Unknown resource: ${uri}`);
  });

  // === Prompts ===

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [{
        name: 'auto-context',
        description: 'Returns relevant team memory entries for the current session. Use at session start for automatic context.',
        arguments: [
          { name: 'project_id', description: 'Project ID', required: false },
          { name: 'context', description: 'Current task description for semantic matching', required: false },
          { name: 'limit', description: 'Max entries to return (default 10)', required: false },
        ],
      }],
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
    const { name, arguments: promptArgs } = request.params;

    if (name !== 'auto-context') {
      throw new Error(`Unknown prompt: ${name}`);
    }

    try {
      const promptHeaderProjectId = (extra as any)?.authInfo?.projectId as string | undefined;
      const projectId = promptArgs?.project_id || promptHeaderProjectId;
      const context = promptArgs?.context;
      const parsed = promptArgs?.limit ? parseInt(promptArgs.limit, 10) : 10;
      const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
      const callerRole = (extra as any)?.authInfo?.scopes?.[0] as string | undefined;

      const result = await buildAutoContext(memoryManager, {
        projectId,
        context,
        limit,
        agentRole: callerRole,
      });

      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: result.formatted },
        }],
      };
    } catch (err) {
      logger.error({ err }, 'Auto-context prompt failed');
      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: 'Failed to load team memory context.' },
        }],
      };
    }
  });
}

export class TeamMemoryMCPServer {
  private server: Server;
  private memoryManager: MemoryManager;

  constructor(
    memoryManager: MemoryManager,
    agentTokenStore?: AgentTokenStore,
    notesManager?: NotesManager,
    sessionManager?: SessionManager,
    extraction: ExtractionDeps = {},
  ) {
    this.memoryManager = memoryManager;
    this.server = buildMcpServer(memoryManager, agentTokenStore, notesManager, sessionManager, extraction);
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('Team Memory MCP Server started (stdio)');
  }

  getMemoryManager(): MemoryManager {
    return this.memoryManager;
  }
}
