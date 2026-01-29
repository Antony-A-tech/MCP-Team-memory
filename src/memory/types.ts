// Категории памяти
export type Category =
  | 'architecture'  // Архитектурные решения
  | 'tasks'         // Текущие задачи
  | 'decisions'     // Принятые решения
  | 'issues'        // Известные проблемы
  | 'progress';     // Прогресс разработки

// Приоритеты
export type Priority = 'low' | 'medium' | 'high' | 'critical';

// Статусы записей
export type Status = 'active' | 'completed' | 'archived';

// Режимы синхронизации
export type SyncMode = 'auto' | 'manual' | 'both';

// Запись в памяти
export interface MemoryEntry {
  id: string;
  category: Category;
  title: string;
  content: string;
  author: string;
  tags: string[];
  priority: Priority;
  status: Status;
  pinned: boolean;        // Закреплённые записи не архивируются автоматически
  createdAt: string;
  updatedAt: string;
  relatedIds: string[];
}

// Хранилище памяти
export interface MemoryStore {
  version: string;
  lastUpdated: string;
  entries: MemoryEntry[];
  metadata: {
    projectName: string;
    team: string[];
    createdAt: string;
  };
}

// Конфигурация сервера
export interface ServerConfig {
  dataPath: string;
  webPort: number;
  wsPort: number;
  syncMode: SyncMode;
  backupEnabled: boolean;
  backupInterval: number;       // в миллисекундах
  autoArchiveEnabled: boolean;  // Включить автоархивацию старых записей
  autoArchiveDays: number;      // Записи старше N дней архивируются (по умолчанию 14)
}

// Параметры для чтения памяти
export interface ReadParams {
  category?: Category | 'all';
  search?: string;
  limit?: number;
  status?: Status;
  tags?: string[];
}

// Параметры для записи в память
export interface WriteParams {
  category: Category;
  title: string;
  content: string;
  author?: string;
  tags?: string[];
  priority?: Priority;
  pinned?: boolean;       // Закрепить запись (не будет автоархивирована)
  relatedIds?: string[];
}

// Параметры для обновления записи
export interface UpdateParams {
  id: string;
  title?: string;
  content?: string;
  status?: Status;
  tags?: string[];
  priority?: Priority;
  pinned?: boolean;       // Изменить статус закрепления
  relatedIds?: string[];
}

// Параметры для удаления/архивации
export interface DeleteParams {
  id: string;
  archive?: boolean;
}

// Параметры синхронизации
export interface SyncParams {
  since?: string; // ISO date string
}

// Результат синхронизации
export interface SyncResult {
  entries: MemoryEntry[];
  lastUpdated: string;
  totalChanges: number;
}

// События WebSocket
export type WSEventType =
  | 'memory:created'
  | 'memory:updated'
  | 'memory:deleted'
  | 'memory:sync'
  | 'agent:connected'
  | 'agent:disconnected';

export interface WSEvent {
  type: WSEventType;
  payload: unknown;
  timestamp: string;
}

// Статистика для UI
export interface MemoryStats {
  totalEntries: number;
  byCategory: Record<Category, number>;
  byStatus: Record<Status, number>;
  byPriority: Record<Priority, number>;
  recentActivity: {
    last24h: number;
    last7d: number;
  };
  connectedAgents: number;
}

// Описания категорий для UI
export const CATEGORY_INFO: Record<Category, { name: string; description: string; icon: string }> = {
  architecture: {
    name: 'Архитектура',
    description: 'Архитектурные решения, выбор стека, структура проекта',
    icon: '🏗️'
  },
  tasks: {
    name: 'Задачи',
    description: 'Текущие задачи, в работе, запланированные',
    icon: '📋'
  },
  decisions: {
    name: 'Решения',
    description: 'Принятые решения и их обоснование',
    icon: '✅'
  },
  issues: {
    name: 'Проблемы',
    description: 'Известные проблемы, баги, технический долг',
    icon: '🐛'
  },
  progress: {
    name: 'Прогресс',
    description: 'Прогресс разработки, завершённые этапы',
    icon: '📈'
  }
};

// Цвета приоритетов для UI
export const PRIORITY_COLORS: Record<Priority, string> = {
  low: '#6b7280',      // gray
  medium: '#3b82f6',   // blue
  high: '#f59e0b',     // amber
  critical: '#ef4444'  // red
};

// Цвета статусов для UI
export const STATUS_COLORS: Record<Status, string> = {
  active: '#22c55e',    // green
  completed: '#6b7280', // gray
  archived: '#9ca3af'   // light gray
};
