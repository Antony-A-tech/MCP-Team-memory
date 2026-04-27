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
    ctx.memoryManager.read({
      projectId: ctx.projectId,
      category: args.category,
      domain: args.domain,
      search: args.search,
      tags: args.tags,
      status: args.status,
      ids: args.ids,
      limit: args.limit,
      mode: args.mode,
    }),

  memory_cross_search: async (args, ctx) =>
    ctx.memoryManager.crossSearch(args.query, {
      category: args.category,
      domain: args.domain,
      excludeProjectId: ctx.projectId,
      limit: args.limit,
    }),

  memory_sync: async (args, ctx) =>
    ctx.memoryManager.sync({ projectId: ctx.projectId, since: args.since }),

  memory_audit: async (args, ctx) => {
    const mgr = ctx.memoryManager as any;
    if (typeof mgr.audit !== 'function') return { error: 'not_available', tool: 'memory_audit' };
    return mgr.audit({ entry_id: args.entry_id, project_id: ctx.projectId, limit: args.limit });
  },

  memory_history: async (args, ctx) => {
    const mgr = ctx.memoryManager as any;
    if (typeof mgr.history !== 'function') return { error: 'not_available', tool: 'memory_history' };
    return mgr.history(args.entry_id, args.version);
  },

  note_read: async (args, ctx) =>
    ctx.notesManager.read(ctx.agentTokenId, {
      search: args.search,
      tags: args.tags,
      status: args.status,
      projectId: ctx.projectId,
      limit: args.limit,
    }),

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
    }),

  session_search: async (args, ctx) =>
    ctx.sessionManager.searchSessions(ctx.agentTokenId, args.query, {
      projectId: ctx.projectId,
      limit: args.limit,
    }),

  session_message_search: async (args, ctx) => {
    // Verify the optional session_id belongs to the current project before
    // exposing its messages. Without this check an LLM-supplied session_id
    // from another project the user owns would leak via SessionManager
    // (which only enforces ownership, not project scope).
    if (args.session_id) {
      const owned = await ctx.sessionManager.readSession(args.session_id, ctx.agentTokenId).catch(() => null);
      if (!owned || owned.session.projectId !== ctx.projectId) {
        return { error: 'session_not_in_current_project', sessionId: args.session_id };
      }
      return ctx.sessionManager.searchMessagesInSession(args.session_id, ctx.agentTokenId, args.query, args.limit ?? 20);
    }
    // No session_id — fan out across the user's sessions, then post-filter
    // to the current project. Cross-project hits are dropped so the agent
    // can't surface other projects' chat content via prompt injection.
    const hits = await ctx.sessionManager.searchMessages(ctx.agentTokenId, args.query, { limit: (args.limit ?? 10) * 3 });
    if (hits.length === 0) return [];
    const sessionIds = Array.from(new Set(hits.map((h: any) => h.sessionId)));
    const projectScoped = new Set<string>();
    await Promise.all(sessionIds.map(async (sid: string) => {
      const r = await ctx.sessionManager.readSession(sid, ctx.agentTokenId).catch(() => null);
      if (r && r.session.projectId === ctx.projectId) projectScoped.add(sid);
    }));
    return hits.filter((h: any) => projectScoped.has(h.sessionId)).slice(0, args.limit ?? 10);
  },

  session_read: async (args, ctx) => {
    const r = await ctx.sessionManager.readSession(args.session_id, ctx.agentTokenId, args.message_from, args.message_to).catch(() => null);
    if (!r) return { error: 'session_not_found', sessionId: args.session_id };
    if (r.session.projectId !== ctx.projectId) {
      return { error: 'session_not_in_current_project', sessionId: args.session_id };
    }
    return r;
  },
};

export function getDeclaration(name: string): ToolDeclaration | undefined {
  return TOOL_DECLARATIONS.find(d => d.name === name);
}
