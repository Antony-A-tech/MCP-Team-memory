import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
  type Resource
} from '@modelcontextprotocol/sdk/types.js';
import { MemoryManager } from './memory/manager.js';
import type {
  Category,
  Priority,
  Status,
  ReadParams,
  WriteParams,
  UpdateParams,
  DeleteParams,
  SyncParams
} from './memory/types.js';

export function buildMcpServer(memoryManager: MemoryManager): Server {
  const server = new Server(
    { name: 'team-memory', version: '2.0.0' },
    { capabilities: { tools: {}, resources: {} } }
  );

  setupHandlers(server, memoryManager);
  return server;
}

function setupHandlers(server: Server, memoryManager: MemoryManager): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [
      {
        name: 'memory_read',
        description: 'Читает командную память. Используйте для получения информации о текущем состоянии проекта, архитектурных решениях, задачах и проблемах.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта (по умолчанию "default")' },
            category: {
              type: 'string',
              enum: ['architecture', 'tasks', 'decisions', 'issues', 'progress', 'all'],
              description: 'Категория памяти для чтения'
            },
            domain: { type: 'string', description: 'Фильтр по домену (backend, frontend, infrastructure, и т.д.)' },
            search: { type: 'string', description: 'Поиск по ключевым словам' },
            limit: { type: 'number', default: 50, description: 'Максимальное количество записей' },
            status: {
              type: 'string',
              enum: ['active', 'completed', 'archived'],
              description: 'Фильтр по статусу'
            }
          }
        }
      },
      {
        name: 'memory_write',
        description: 'Добавляет новую запись в командную память. Используйте для документирования решений, задач, проблем и прогресса.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта (по умолчанию "default")' },
            category: {
              type: 'string',
              enum: ['architecture', 'tasks', 'decisions', 'issues', 'progress'],
              description: 'Категория записи'
            },
            domain: { type: 'string', description: 'Домен: backend, frontend, infrastructure, devops, database, testing' },
            title: { type: 'string', description: 'Заголовок записи' },
            content: { type: 'string', description: 'Содержимое записи' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Теги для категоризации' },
            priority: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'critical'],
              description: 'Приоритет записи'
            },
            author: { type: 'string', description: 'Автор записи' },
            pinned: { type: 'boolean', default: false, description: 'Закрепить запись' }
          },
          required: ['category', 'title', 'content']
        }
      },
      {
        name: 'memory_update',
        description: 'Обновляет существующую запись в памяти.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'ID записи для обновления' },
            title: { type: 'string', description: 'Новый заголовок' },
            content: { type: 'string', description: 'Новое содержимое' },
            domain: { type: 'string', description: 'Новый домен' },
            status: { type: 'string', enum: ['active', 'completed', 'archived'], description: 'Новый статус' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Новые теги' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Новый приоритет' },
            pinned: { type: 'boolean', description: 'Закрепить/открепить' }
          },
          required: ['id']
        }
      },
      {
        name: 'memory_delete',
        description: 'Удаляет или архивирует запись из памяти.',
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
        description: 'Получает последние изменения в памяти.',
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
        description: 'Разархивирует запись, возвращая в активный статус.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'ID записи' } },
          required: ['id']
        }
      },
      {
        name: 'memory_pin',
        description: 'Закрепляет или открепляет запись. Закреплённые записи НЕ архивируются автоматически.',
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
        description: 'Управление проектами: список, создание, обновление, удаление.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], description: 'Действие' },
            id: { type: 'string', description: 'ID проекта (для update/delete)' },
            name: { type: 'string', description: 'Название проекта' },
            description: { type: 'string', description: 'Описание проекта' },
            domains: { type: 'array', items: { type: 'string' }, description: 'Домены проекта' }
          },
          required: ['action']
        }
      }
    ];
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'memory_read': {
          const params: ReadParams = {
            projectId: (args?.project_id as string) || undefined,
            category: (args?.category as Category | 'all') || 'all',
            domain: args?.domain as string | undefined,
            search: args?.search as string | undefined,
            limit: (args?.limit as number) || 50,
            status: args?.status as Status | undefined
          };
          const entries = await memoryManager.read(params);
          if (entries.length === 0) {
            return { content: [{ type: 'text', text: 'Записи не найдены по заданным критериям.' }] };
          }
          const formatted = entries.map(e => {
            const pi = e.priority === 'critical' ? '🔴' : e.priority === 'high' ? '🟠' : e.priority === 'medium' ? '🟡' : '🟢';
            const pin = e.pinned ? '📌 ' : '';
            const dom = e.domain ? ` | **Домен**: ${e.domain}` : '';
            return `## ${pin}${pi} ${e.title}\n**ID**: ${e.id}\n**Категория**: ${e.category}${dom} | **Статус**: ${e.status} | **Автор**: ${e.author}${e.pinned ? ' | 📌' : ''}\n**Теги**: ${e.tags.join(', ') || 'нет'}\n**Обновлено**: ${new Date(e.updatedAt).toLocaleString()}\n\n${e.content}\n\n---`;
          }).join('\n\n');
          return { content: [{ type: 'text', text: `# Командная память (${entries.length} записей)\n\n${formatted}` }] };
        }

        case 'memory_write': {
          const params: WriteParams = {
            projectId: (args?.project_id as string) || undefined,
            category: args?.category as Category,
            domain: args?.domain as string | undefined,
            title: args?.title as string,
            content: args?.content as string,
            tags: (args?.tags as string[]) || [],
            priority: (args?.priority as Priority) || 'medium',
            author: (args?.author as string) || 'claude-agent',
            pinned: (args?.pinned as boolean) || false
          };
          const entry = await memoryManager.write(params);
          const domTxt = entry.domain ? `\n**Домен**: ${entry.domain}` : '';
          const pinTxt = entry.pinned ? '\n📌 Закреплена' : '';
          return {
            content: [{ type: 'text', text: `✅ Запись добавлена!\n\n**ID**: ${entry.id}\n**Заголовок**: ${entry.title}\n**Категория**: ${entry.category}${domTxt}\n**Приоритет**: ${entry.priority}${pinTxt}` }]
          };
        }

        case 'memory_update': {
          const params: UpdateParams = {
            id: args?.id as string,
            title: args?.title as string | undefined,
            content: args?.content as string | undefined,
            domain: args?.domain as string | undefined,
            status: args?.status as Status | undefined,
            tags: args?.tags as string[] | undefined,
            priority: args?.priority as Priority | undefined,
            pinned: args?.pinned as boolean | undefined
          };
          const updated = await memoryManager.update(params);
          if (!updated) return { content: [{ type: 'text', text: `❌ Запись с ID "${params.id}" не найдена.` }] };
          return { content: [{ type: 'text', text: `✅ Запись обновлена!\n\n**ID**: ${updated.id}\n**Заголовок**: ${updated.title}\n**Статус**: ${updated.status}` }] };
        }

        case 'memory_delete': {
          const params: DeleteParams = { id: args?.id as string, archive: args?.archive !== false };
          const success = await memoryManager.delete(params);
          if (!success) return { content: [{ type: 'text', text: `❌ Запись с ID "${params.id}" не найдена.` }] };
          return { content: [{ type: 'text', text: params.archive ? `📦 Запись архивирована (ID: ${params.id})` : `🗑️ Запись удалена (ID: ${params.id})` }] };
        }

        case 'memory_sync': {
          const params: SyncParams = { projectId: (args?.project_id as string) || undefined, since: args?.since as string | undefined };
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
          const updated = await memoryManager.update({ id, status: 'active' });
          if (!updated) return { content: [{ type: 'text', text: `❌ Запись "${id}" не найдена.` }] };
          return { content: [{ type: 'text', text: `📤 Разархивировано!\n\n**ID**: ${updated.id}\n**Заголовок**: ${updated.title}` }] };
        }

        case 'memory_pin': {
          const id = args?.id as string;
          const pinned = args?.pinned !== false;
          if (!id) return { content: [{ type: 'text', text: '❌ Укажите ID записи.' }], isError: true };
          const updated = await memoryManager.pin(id, pinned);
          if (!updated) return { content: [{ type: 'text', text: `❌ Запись "${id}" не найдена.` }] };
          return { content: [{ type: 'text', text: `${pinned ? '📌' : '📍'} Запись ${pinned ? 'закреплена' : 'откреплена'}!\n\n**ID**: ${updated.id}\n**Заголовок**: ${updated.title}` }] };
        }

        case 'memory_projects': {
          const action = args?.action as string;
          switch (action) {
            case 'list': {
              const projects = await memoryManager.listProjects();
              if (projects.length === 0) return { content: [{ type: 'text', text: 'Проектов не найдено.' }] };
              const list = projects.map(p => `- **${p.name}** (ID: ${p.id})\n  ${p.description}\n  Домены: ${p.domains.join(', ')}`).join('\n\n');
              return { content: [{ type: 'text', text: `# Проекты (${projects.length})\n\n${list}` }] };
            }
            case 'create': {
              const n = args?.name as string;
              if (!n) return { content: [{ type: 'text', text: '❌ Укажите название проекта.' }], isError: true };
              const p = await memoryManager.createProject({ name: n, description: args?.description as string | undefined, domains: args?.domains as string[] | undefined });
              return { content: [{ type: 'text', text: `✅ Проект создан!\n\n**ID**: ${p.id}\n**Название**: ${p.name}\n**Домены**: ${p.domains.join(', ')}` }] };
            }
            case 'update': {
              const id = args?.id as string;
              if (!id) return { content: [{ type: 'text', text: '❌ Укажите ID проекта.' }], isError: true };
              const u = await memoryManager.updateProject(id, { name: args?.name as string | undefined, description: args?.description as string | undefined, domains: args?.domains as string[] | undefined });
              if (!u) return { content: [{ type: 'text', text: `❌ Проект "${id}" не найден.` }] };
              return { content: [{ type: 'text', text: `✅ Проект обновлён!\n\n**ID**: ${u.id}\n**Название**: ${u.name}` }] };
            }
            case 'delete': {
              const id = args?.id as string;
              if (!id) return { content: [{ type: 'text', text: '❌ Укажите ID проекта.' }], isError: true };
              const d = await memoryManager.deleteProject(id);
              return { content: [{ type: 'text', text: d ? `🗑️ Проект удалён (${id})` : `❌ Не найден или default.` }] };
            }
            default:
              return { content: [{ type: 'text', text: `❌ Неизвестное действие: ${action}` }], isError: true };
          }
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
      { uri: 'memory://issues', name: 'Проблемы', description: 'Известные проблемы', mimeType: 'text/markdown' }
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
    const m = uri.match(/^memory:\/\/(\w+)$/);
    if (m) {
      const category = m[1] as Category;
      const entries = await memoryManager.read({ category, status: 'active' });
      const text = entries.length > 0 ? entries.map(e => `## ${e.title}\n${e.content}\n\n---`).join('\n\n') : `Нет записей.`;
      return { contents: [{ uri, mimeType: 'text/markdown', text }] };
    }
    throw new Error(`Unknown resource: ${uri}`);
  });
}

export class TeamMemoryMCPServer {
  private server: Server;
  private memoryManager: MemoryManager;

  constructor(memoryManager: MemoryManager) {
    this.memoryManager = memoryManager;
    this.server = buildMcpServer(memoryManager);
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Team Memory MCP Server started (stdio)');
  }

  getMemoryManager(): MemoryManager {
    return this.memoryManager;
  }
}
