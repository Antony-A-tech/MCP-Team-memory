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

export class TeamMemoryMCPServer {
  private server: Server;
  private memoryManager: MemoryManager;

  constructor(dataPath: string) {
    this.memoryManager = new MemoryManager(dataPath);

    this.server = new Server(
      {
        name: 'team-memory',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {},
          resources: {}
        }
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Список инструментов
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [
        {
          name: 'memory_read',
          description: 'Читает командную память. Используйте для получения информации о текущем состоянии проекта, архитектурных решениях, задачах и проблемах.',
          inputSchema: {
            type: 'object',
            properties: {
              category: {
                type: 'string',
                enum: ['architecture', 'tasks', 'decisions', 'issues', 'progress', 'all'],
                description: 'Категория памяти для чтения'
              },
              search: {
                type: 'string',
                description: 'Поиск по ключевым словам'
              },
              limit: {
                type: 'number',
                default: 50,
                description: 'Максимальное количество записей'
              },
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
              category: {
                type: 'string',
                enum: ['architecture', 'tasks', 'decisions', 'issues', 'progress'],
                description: 'Категория записи'
              },
              title: {
                type: 'string',
                description: 'Заголовок записи'
              },
              content: {
                type: 'string',
                description: 'Содержимое записи'
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Теги для категоризации'
              },
              priority: {
                type: 'string',
                enum: ['low', 'medium', 'high', 'critical'],
                description: 'Приоритет записи'
              },
              author: {
                type: 'string',
                description: 'Автор записи (имя агента или разработчика)'
              },
              pinned: {
                type: 'boolean',
                default: false,
                description: 'Закрепить запись (не будет автоархивирована). Используйте для важной информации.'
              }
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
              id: {
                type: 'string',
                description: 'ID записи для обновления'
              },
              title: {
                type: 'string',
                description: 'Новый заголовок'
              },
              content: {
                type: 'string',
                description: 'Новое содержимое'
              },
              status: {
                type: 'string',
                enum: ['active', 'completed', 'archived'],
                description: 'Новый статус'
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Новые теги'
              },
              priority: {
                type: 'string',
                enum: ['low', 'medium', 'high', 'critical'],
                description: 'Новый приоритет'
              },
              pinned: {
                type: 'boolean',
                description: 'Закрепить/открепить запись'
              }
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
              id: {
                type: 'string',
                description: 'ID записи для удаления'
              },
              archive: {
                type: 'boolean',
                default: true,
                description: 'Архивировать вместо удаления (рекомендуется)'
              }
            },
            required: ['id']
          }
        },
        {
          name: 'memory_sync',
          description: 'Получает последние изменения в памяти. Используйте для синхронизации с другими агентами.',
          inputSchema: {
            type: 'object',
            properties: {
              since: {
                type: 'string',
                format: 'date-time',
                description: 'Получить изменения начиная с этой даты (ISO формат)'
              }
            }
          }
        },
        {
          name: 'memory_unarchive',
          description: 'Разархивирует запись, возвращая её в активный статус. Используйте для восстановления случайно архивированных записей.',
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'ID записи для разархивации'
              }
            },
            required: ['id']
          }
        },
        {
          name: 'memory_pin',
          description: 'Закрепляет или открепляет запись. Закреплённые записи НЕ архивируются автоматически. Используйте для важной информации: стек технологий, ключевые решения.',
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'ID записи'
              },
              pinned: {
                type: 'boolean',
                default: true,
                description: 'true - закрепить, false - открепить'
              }
            },
            required: ['id']
          }
        }
      ];

      return { tools };
    });

    // Вызов инструмента
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'memory_read': {
            const params: ReadParams = {
              category: (args?.category as Category | 'all') || 'all',
              search: args?.search as string | undefined,
              limit: (args?.limit as number) || 50,
              status: args?.status as Status | undefined
            };

            const entries = await this.memoryManager.read(params);

            if (entries.length === 0) {
              return {
                content: [{
                  type: 'text',
                  text: 'Записи не найдены по заданным критериям.'
                }]
              };
            }

            const formatted = entries.map(e => {
              const priorityIcon = e.priority === 'critical' ? '🔴' :
                e.priority === 'high' ? '🟠' :
                  e.priority === 'medium' ? '🟡' : '🟢';
              const pinnedIcon = e.pinned ? '📌 ' : '';

              return `## ${pinnedIcon}${priorityIcon} ${e.title}\n` +
                `**ID**: ${e.id}\n` +
                `**Категория**: ${e.category} | **Статус**: ${e.status} | **Автор**: ${e.author}${e.pinned ? ' | 📌 Закреплено' : ''}\n` +
                `**Теги**: ${e.tags.join(', ') || 'нет'}\n` +
                `**Обновлено**: ${new Date(e.updatedAt).toLocaleString()}\n\n` +
                `${e.content}\n\n---`;
            }).join('\n\n');

            return {
              content: [{
                type: 'text',
                text: `# Командная память (${entries.length} записей)\n\n${formatted}`
              }]
            };
          }

          case 'memory_write': {
            const params: WriteParams = {
              category: args?.category as Category,
              title: args?.title as string,
              content: args?.content as string,
              tags: (args?.tags as string[]) || [],
              priority: (args?.priority as Priority) || 'medium',
              author: (args?.author as string) || 'claude-agent',
              pinned: (args?.pinned as boolean) || false
            };

            const entry = await this.memoryManager.write(params);
            const pinnedText = entry.pinned ? '\n📌 **Закреплена** (не будет автоархивирована)' : '';

            return {
              content: [{
                type: 'text',
                text: `✅ Запись успешно добавлена!\n\n` +
                  `**ID**: ${entry.id}\n` +
                  `**Заголовок**: ${entry.title}\n` +
                  `**Категория**: ${entry.category}\n` +
                  `**Приоритет**: ${entry.priority}\n` +
                  `**Создано**: ${new Date(entry.createdAt).toLocaleString()}${pinnedText}`
              }]
            };
          }

          case 'memory_update': {
            const params: UpdateParams = {
              id: args?.id as string,
              title: args?.title as string | undefined,
              content: args?.content as string | undefined,
              status: args?.status as Status | undefined,
              tags: args?.tags as string[] | undefined,
              priority: args?.priority as Priority | undefined,
              pinned: args?.pinned as boolean | undefined
            };

            const updated = await this.memoryManager.update(params);

            if (!updated) {
              return {
                content: [{
                  type: 'text',
                  text: `❌ Запись с ID "${params.id}" не найдена.`
                }]
              };
            }

            return {
              content: [{
                type: 'text',
                text: `✅ Запись обновлена!\n\n` +
                  `**ID**: ${updated.id}\n` +
                  `**Заголовок**: ${updated.title}\n` +
                  `**Статус**: ${updated.status}\n` +
                  `**Обновлено**: ${new Date(updated.updatedAt).toLocaleString()}`
              }]
            };
          }

          case 'memory_delete': {
            const params: DeleteParams = {
              id: args?.id as string,
              archive: args?.archive !== false
            };

            const success = await this.memoryManager.delete(params);

            if (!success) {
              return {
                content: [{
                  type: 'text',
                  text: `❌ Запись с ID "${params.id}" не найдена.`
                }]
              };
            }

            return {
              content: [{
                type: 'text',
                text: params.archive
                  ? `📦 Запись архивирована (ID: ${params.id})`
                  : `🗑️ Запись удалена (ID: ${params.id})`
              }]
            };
          }

          case 'memory_sync': {
            const params: SyncParams = {
              since: args?.since as string | undefined
            };

            const result = await this.memoryManager.sync(params);

            if (result.entries.length === 0) {
              return {
                content: [{
                  type: 'text',
                  text: `✅ Память синхронизирована. Новых изменений нет.\n` +
                    `Последнее обновление: ${result.lastUpdated}`
                }]
              };
            }

            const changes = result.entries.map(e =>
              `- [${e.category}] **${e.title}** (${e.status})`
            ).join('\n');

            return {
              content: [{
                type: 'text',
                text: `🔄 Синхронизация памяти\n\n` +
                  `**Изменений**: ${result.totalChanges}\n` +
                  `**Последнее обновление**: ${result.lastUpdated}\n\n` +
                  `## Изменённые записи:\n${changes}`
              }]
            };
          }

          case 'memory_unarchive': {
            const id = args?.id as string;

            if (!id) {
              return {
                content: [{
                  type: 'text',
                  text: `❌ Необходимо указать ID записи для разархивации.`
                }],
                isError: true
              };
            }

            const updated = await this.memoryManager.update({
              id,
              status: 'active'
            });

            if (!updated) {
              return {
                content: [{
                  type: 'text',
                  text: `❌ Запись с ID "${id}" не найдена.`
                }]
              };
            }

            return {
              content: [{
                type: 'text',
                text: `📤 Запись разархивирована!\n\n` +
                  `**ID**: ${updated.id}\n` +
                  `**Заголовок**: ${updated.title}\n` +
                  `**Категория**: ${updated.category}\n` +
                  `**Статус**: ${updated.status}\n` +
                  `**Обновлено**: ${new Date(updated.updatedAt).toLocaleString()}`
              }]
            };
          }

          case 'memory_pin': {
            const id = args?.id as string;
            const pinned = args?.pinned !== false;

            if (!id) {
              return {
                content: [{
                  type: 'text',
                  text: `❌ Необходимо указать ID записи.`
                }],
                isError: true
              };
            }

            const updated = await this.memoryManager.pin(id, pinned);

            if (!updated) {
              return {
                content: [{
                  type: 'text',
                  text: `❌ Запись с ID "${id}" не найдена.`
                }]
              };
            }

            const action = pinned ? 'закреплена' : 'откреплена';
            const icon = pinned ? '📌' : '📍';

            return {
              content: [{
                type: 'text',
                text: `${icon} Запись ${action}!\n\n` +
                  `**ID**: ${updated.id}\n` +
                  `**Заголовок**: ${updated.title}\n` +
                  `**Закреплена**: ${updated.pinned ? 'Да' : 'Нет'}\n` +
                  `**Обновлено**: ${new Date(updated.updatedAt).toLocaleString()}\n\n` +
                  (pinned ? '⚠️ Эта запись НЕ будет автоматически архивирована.' : '⚠️ Эта запись может быть автоматически архивирована через 14 дней.')
              }]
            };
          }

          default:
            return {
              content: [{
                type: 'text',
                text: `❌ Неизвестный инструмент: ${name}`
              }],
              isError: true
            };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return {
          content: [{
            type: 'text',
            text: `❌ Ошибка: ${message}`
          }],
          isError: true
        };
      }
    });

    // Список ресурсов
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources: Resource[] = [
        {
          uri: 'memory://overview',
          name: 'Обзор проекта',
          description: 'Общий обзор состояния проекта с активными задачами и проблемами',
          mimeType: 'text/markdown'
        },
        {
          uri: 'memory://recent',
          name: 'Последние изменения',
          description: 'Изменения в памяти за последние 24 часа',
          mimeType: 'text/markdown'
        },
        {
          uri: 'memory://architecture',
          name: 'Архитектура',
          description: 'Архитектурные решения проекта',
          mimeType: 'text/markdown'
        },
        {
          uri: 'memory://tasks',
          name: 'Задачи',
          description: 'Текущие задачи команды',
          mimeType: 'text/markdown'
        },
        {
          uri: 'memory://issues',
          name: 'Проблемы',
          description: 'Известные проблемы и баги',
          mimeType: 'text/markdown'
        }
      ];

      return { resources };
    });

    // Чтение ресурса
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      try {
        if (uri === 'memory://overview') {
          const overview = await this.memoryManager.getOverview();
          return {
            contents: [{
              uri,
              mimeType: 'text/markdown',
              text: overview
            }]
          };
        }

        if (uri === 'memory://recent') {
          const recent = await this.memoryManager.getRecent(24);
          const text = recent.length > 0
            ? recent.map(e => `- [${e.category}] **${e.title}** - ${e.author} (${new Date(e.updatedAt).toLocaleString()})`).join('\n')
            : 'Нет изменений за последние 24 часа.';

          return {
            contents: [{
              uri,
              mimeType: 'text/markdown',
              text: `# Последние изменения (24ч)\n\n${text}`
            }]
          };
        }

        // Ресурсы категорий
        const categoryMatch = uri.match(/^memory:\/\/(\w+)$/);
        if (categoryMatch) {
          const category = categoryMatch[1] as Category;
          const entries = await this.memoryManager.read({ category, status: 'active' });

          const text = entries.length > 0
            ? entries.map(e => `## ${e.title}\n${e.content}\n\n---`).join('\n\n')
            : `Нет записей в категории "${category}".`;

          return {
            contents: [{
              uri,
              mimeType: 'text/markdown',
              text: `# ${category.charAt(0).toUpperCase() + category.slice(1)}\n\n${text}`
            }]
          };
        }

        throw new Error(`Unknown resource: ${uri}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Failed to read resource: ${message}`);
      }
    });
  }

  async start(): Promise<void> {
    await this.memoryManager.initialize();

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error('Team Memory MCP Server started');
  }

  getMemoryManager(): MemoryManager {
    return this.memoryManager;
  }
}
