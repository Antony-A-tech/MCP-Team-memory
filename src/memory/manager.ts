import { v4 as uuidv4 } from 'uuid';
import { JsonStorage } from '../storage/json-storage.js';
import type {
  MemoryEntry,
  Category,
  ReadParams,
  WriteParams,
  UpdateParams,
  DeleteParams,
  SyncParams,
  SyncResult,
  MemoryStats,
  WSEvent,
  WSEventType
} from './types.js';

type EventListener = (event: WSEvent) => void;

export class MemoryManager {
  private storage: JsonStorage;
  private listeners: Set<EventListener> = new Set();
  private backupInterval: NodeJS.Timeout | null = null;

  constructor(dataPath: string) {
    this.storage = new JsonStorage(dataPath);
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();
    console.log('Memory Manager initialized');
  }

  // Подписка на события (для WebSocket)
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(type: WSEventType, payload: unknown): void {
    const event: WSEvent = {
      type,
      payload,
      timestamp: new Date().toISOString()
    };
    this.listeners.forEach(listener => listener(event));
  }

  // Чтение памяти
  async read(params: ReadParams): Promise<MemoryEntry[]> {
    const { category = 'all', search, limit = 50, status, tags } = params;

    let entries: MemoryEntry[];

    if (search) {
      entries = await this.storage.search(search, limit);
    } else if (category === 'all') {
      entries = await this.storage.getAll();
    } else {
      entries = await this.storage.getByCategory(category);
    }

    // Фильтрация по статусу
    if (status) {
      entries = entries.filter(e => e.status === status);
    }

    // Фильтрация по тегам
    if (tags && tags.length > 0) {
      entries = entries.filter(e =>
        tags.some(tag => e.tags.includes(tag))
      );
    }

    // Сортировка по дате обновления (новые первыми)
    entries.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    return entries.slice(0, limit);
  }

  // Запись в память
  async write(params: WriteParams): Promise<MemoryEntry> {
    const now = new Date().toISOString();

    const entry: MemoryEntry = {
      id: uuidv4(),
      category: params.category,
      title: params.title,
      content: params.content,
      author: params.author || 'unknown',
      tags: params.tags || [],
      priority: params.priority || 'medium',
      status: 'active',
      pinned: params.pinned || false,
      createdAt: now,
      updatedAt: now,
      relatedIds: params.relatedIds || []
    };

    await this.storage.add(entry);
    this.emit('memory:created', entry);

    return entry;
  }

  // Обновление записи
  async update(params: UpdateParams): Promise<MemoryEntry | null> {
    const { id, ...updates } = params;

    const updated = await this.storage.update(id, updates);

    if (updated) {
      this.emit('memory:updated', updated);
      return updated;
    }

    return null;
  }

  // Удаление/архивация записи
  async delete(params: DeleteParams): Promise<boolean> {
    const { id, archive = true } = params;

    if (archive) {
      const archived = await this.storage.archive(id);
      if (archived) {
        this.emit('memory:updated', archived);
        return true;
      }
      return false;
    }

    const deleted = await this.storage.delete(id);
    if (deleted) {
      this.emit('memory:deleted', { id });
      return true;
    }

    return false;
  }

  // Синхронизация (получение изменений)
  async sync(params: SyncParams): Promise<SyncResult> {
    const since = params.since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const entries = await this.storage.getChangesSince(since);

    return {
      entries,
      lastUpdated: this.storage.getLastUpdated(),
      totalChanges: entries.length
    };
  }

  // Получение обзора (для MCP resource)
  async getOverview(): Promise<string> {
    const entries = await this.storage.getAll();
    const metadata = await this.storage.getMetadata();

    const activeEntries = entries.filter(e => e.status === 'active');

    const byCategory: Record<Category, MemoryEntry[]> = {
      architecture: [],
      tasks: [],
      decisions: [],
      issues: [],
      progress: []
    };

    activeEntries.forEach(e => {
      byCategory[e.category].push(e);
    });

    let overview = `# Обзор проекта: ${metadata.projectName}\n\n`;
    overview += `Последнее обновление: ${this.storage.getLastUpdated()}\n\n`;

    // Архитектура
    if (byCategory.architecture.length > 0) {
      overview += `## 🏗️ Архитектура (${byCategory.architecture.length})\n`;
      byCategory.architecture.slice(0, 5).forEach(e => {
        overview += `- **${e.title}**: ${e.content.substring(0, 100)}...\n`;
      });
      overview += '\n';
    }

    // Задачи
    if (byCategory.tasks.length > 0) {
      overview += `## 📋 Активные задачи (${byCategory.tasks.length})\n`;
      byCategory.tasks.slice(0, 10).forEach(e => {
        const priority = e.priority === 'critical' ? '🔴' :
          e.priority === 'high' ? '🟠' :
            e.priority === 'medium' ? '🟡' : '🟢';
        overview += `- ${priority} **${e.title}** [${e.author}]\n`;
      });
      overview += '\n';
    }

    // Проблемы
    if (byCategory.issues.length > 0) {
      overview += `## 🐛 Известные проблемы (${byCategory.issues.length})\n`;
      byCategory.issues.slice(0, 5).forEach(e => {
        overview += `- **${e.title}**: ${e.content.substring(0, 80)}...\n`;
      });
      overview += '\n';
    }

    // Прогресс
    if (byCategory.progress.length > 0) {
      overview += `## 📈 Последний прогресс\n`;
      byCategory.progress.slice(0, 3).forEach(e => {
        overview += `- ${e.title} (${new Date(e.updatedAt).toLocaleDateString()})\n`;
      });
      overview += '\n';
    }

    // Решения
    if (byCategory.decisions.length > 0) {
      overview += `## ✅ Ключевые решения (${byCategory.decisions.length})\n`;
      byCategory.decisions.slice(0, 5).forEach(e => {
        overview += `- **${e.title}**\n`;
      });
    }

    return overview;
  }

  // Получение статистики для UI
  async getStats(): Promise<MemoryStats> {
    const entries = await this.storage.getAll();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const stats: MemoryStats = {
      totalEntries: entries.length,
      byCategory: {
        architecture: 0,
        tasks: 0,
        decisions: 0,
        issues: 0,
        progress: 0
      },
      byStatus: {
        active: 0,
        completed: 0,
        archived: 0
      },
      byPriority: {
        low: 0,
        medium: 0,
        high: 0,
        critical: 0
      },
      recentActivity: {
        last24h: 0,
        last7d: 0
      },
      connectedAgents: this.listeners.size
    };

    entries.forEach(e => {
      stats.byCategory[e.category]++;
      stats.byStatus[e.status]++;
      stats.byPriority[e.priority]++;

      const updatedAt = new Date(e.updatedAt).getTime();
      if (now - updatedAt < day) {
        stats.recentActivity.last24h++;
      }
      if (now - updatedAt < 7 * day) {
        stats.recentActivity.last7d++;
      }
    });

    return stats;
  }

  // Получение последних записей (для MCP resource)
  async getRecent(hours = 24): Promise<MemoryEntry[]> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    return this.storage.getChangesSince(since);
  }

  // Создание бэкапа
  async createBackup(): Promise<string> {
    return this.storage.createBackup();
  }

  // Запуск автоматического бэкапа
  startAutoBackup(intervalMs: number): void {
    if (this.backupInterval) {
      clearInterval(this.backupInterval);
    }

    this.backupInterval = setInterval(async () => {
      try {
        await this.createBackup();
      } catch (error) {
        console.error('Auto backup failed:', error);
      }
    }, intervalMs);

    console.log(`Auto backup enabled: every ${intervalMs / 1000}s`);
  }

  // Остановка автоматического бэкапа
  stopAutoBackup(): void {
    if (this.backupInterval) {
      clearInterval(this.backupInterval);
      this.backupInterval = null;
    }
  }

  // Автоархивация старых записей (кроме закреплённых)
  async autoArchiveOldEntries(days: number = 14): Promise<{ archived: number; backupPath: string | null }> {
    const entries = await this.storage.getAll();
    const now = Date.now();
    const threshold = days * 24 * 60 * 60 * 1000;

    // Находим записи для архивации: старше N дней, активные, не закреплённые
    const toArchive = entries.filter(e => {
      if (e.status !== 'active') return false;
      if (e.pinned) return false;

      const age = now - new Date(e.updatedAt).getTime();
      return age > threshold;
    });

    if (toArchive.length === 0) {
      return { archived: 0, backupPath: null };
    }

    // Создаём бэкап перед архивацией
    const backupPath = await this.createBackup();
    console.log(`Backup created before auto-archive: ${backupPath}`);

    // Архивируем записи
    for (const entry of toArchive) {
      await this.storage.archive(entry.id);
      this.emit('memory:updated', { ...entry, status: 'archived' });
    }

    console.log(`Auto-archived ${toArchive.length} entries older than ${days} days`);

    return { archived: toArchive.length, backupPath };
  }

  // Закрепление/открепление записи
  async pin(id: string, pinned: boolean = true): Promise<MemoryEntry | null> {
    const updated = await this.storage.update(id, { pinned });

    if (updated) {
      this.emit('memory:updated', updated);
      return updated;
    }

    return null;
  }

  // Запуск периодической автоархивации
  private autoArchiveInterval: NodeJS.Timeout | null = null;

  startAutoArchive(days: number = 14, checkIntervalMs: number = 24 * 60 * 60 * 1000): void {
    if (this.autoArchiveInterval) {
      clearInterval(this.autoArchiveInterval);
    }

    // Запускаем проверку сразу при старте
    this.autoArchiveOldEntries(days).catch(err =>
      console.error('Initial auto-archive failed:', err)
    );

    // Затем периодически (по умолчанию раз в сутки)
    this.autoArchiveInterval = setInterval(async () => {
      try {
        await this.autoArchiveOldEntries(days);
      } catch (error) {
        console.error('Auto archive failed:', error);
      }
    }, checkIntervalMs);

    console.log(`Auto-archive enabled: entries older than ${days} days, check every ${checkIntervalMs / 1000 / 60 / 60}h`);
  }

  stopAutoArchive(): void {
    if (this.autoArchiveInterval) {
      clearInterval(this.autoArchiveInterval);
      this.autoArchiveInterval = null;
    }
  }
}
