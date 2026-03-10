import { readFile, writeFile, mkdir, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import lockfile from 'proper-lockfile';
import type { MemoryStore, LegacyMemoryEntry } from '../memory/types.js';

const STORAGE_VERSION = '1.0.0';

export class JsonStorage {
  private filePath: string;
  private backupDir: string;
  private data: MemoryStore | null = null;

  constructor(dataPath: string) {
    this.filePath = path.resolve(dataPath, 'memory.json');
    this.backupDir = path.resolve(dataPath, 'backups');
  }

  async initialize(): Promise<void> {
    const dataDir = path.dirname(this.filePath);

    // Создаём директории если не существуют
    if (!existsSync(dataDir)) {
      await mkdir(dataDir, { recursive: true });
    }
    if (!existsSync(this.backupDir)) {
      await mkdir(this.backupDir, { recursive: true });
    }

    // Создаём начальный файл если не существует
    if (!existsSync(this.filePath)) {
      const initialData: MemoryStore = {
        version: STORAGE_VERSION,
        lastUpdated: new Date().toISOString(),
        entries: [],
        metadata: {
          projectName: 'Team Project',
          team: [],
          createdAt: new Date().toISOString()
        }
      };
      await this.write(initialData);
    }

    // Загружаем данные в память
    this.data = await this.read();
  }

  async read(): Promise<MemoryStore> {
    try {
      const content = await readFile(this.filePath, 'utf-8');
      return JSON.parse(content) as MemoryStore;
    } catch (error) {
      console.error('Error reading storage file:', error);
      throw new Error('Failed to read memory storage');
    }
  }

  async write(data: MemoryStore): Promise<void> {
    let release: (() => Promise<void>) | null = null;

    try {
      // Создаём файл если не существует для lockfile
      if (!existsSync(this.filePath)) {
        await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
        this.data = data;
        return;
      }

      // Захватываем блокировку
      release = await lockfile.lock(this.filePath, {
        retries: {
          retries: 5,
          factor: 2,
          minTimeout: 100,
          maxTimeout: 1000
        }
      });

      // Записываем данные
      data.lastUpdated = new Date().toISOString();
      await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
      this.data = data;
    } catch (error) {
      console.error('Error writing to storage:', error);
      throw new Error('Failed to write to memory storage');
    } finally {
      // Освобождаем блокировку
      if (release) {
        await release();
      }
    }
  }

  async createBackup(): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(this.backupDir, `memory-${timestamp}.json`);

    await copyFile(this.filePath, backupPath);
    console.log(`Backup created: ${backupPath}`);

    return backupPath;
  }

  // CRUD операции для записей

  async getAll(): Promise<LegacyMemoryEntry[]> {
    const data = await this.read();
    return data.entries;
  }

  async getById(id: string): Promise<LegacyMemoryEntry | undefined> {
    const data = await this.read();
    return data.entries.find(e => e.id === id);
  }

  async getByCategory(category: string): Promise<LegacyMemoryEntry[]> {
    const data = await this.read();
    return data.entries.filter(e => e.category === category);
  }

  async search(query: string, limit = 50): Promise<LegacyMemoryEntry[]> {
    const data = await this.read();
    const lowerQuery = query.toLowerCase();

    const results = data.entries.filter(e =>
      (e.title && e.title.toLowerCase().includes(lowerQuery)) ||
      (e.content && e.content.toLowerCase().includes(lowerQuery)) ||
      (e.tags && e.tags.some(t => t.toLowerCase().includes(lowerQuery)))
    );

    return results.slice(0, limit);
  }

  async add(entry: LegacyMemoryEntry): Promise<LegacyMemoryEntry> {
    const data = await this.read();
    data.entries.push(entry);
    await this.write(data);
    return entry;
  }

  async update(id: string, updates: Partial<LegacyMemoryEntry>): Promise<LegacyMemoryEntry | undefined> {
    const data = await this.read();
    const index = data.entries.findIndex(e => e.id === id);

    if (index === -1) {
      return undefined;
    }

    // Фильтруем undefined значения чтобы не перезаписывать существующие поля
    const filteredUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, value]) => value !== undefined)
    );

    const updated = {
      ...data.entries[index],
      ...filteredUpdates,
      updatedAt: new Date().toISOString()
    };

    data.entries[index] = updated;
    await this.write(data);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const data = await this.read();
    const index = data.entries.findIndex(e => e.id === id);

    if (index === -1) {
      return false;
    }

    data.entries.splice(index, 1);
    await this.write(data);
    return true;
  }

  async archive(id: string): Promise<LegacyMemoryEntry | undefined> {
    return this.update(id, { status: 'archived' });
  }

  async getChangesSince(since: string): Promise<LegacyMemoryEntry[]> {
    const data = await this.read();
    const sinceDate = new Date(since);

    return data.entries.filter(e => {
      const updatedAt = new Date(e.updatedAt);
      return updatedAt > sinceDate;
    });
  }

  async getMetadata(): Promise<MemoryStore['metadata']> {
    const data = await this.read();
    return data.metadata;
  }

  async updateMetadata(metadata: Partial<MemoryStore['metadata']>): Promise<void> {
    const data = await this.read();
    data.metadata = { ...data.metadata, ...metadata };
    await this.write(data);
  }

  getLastUpdated(): string {
    return this.data?.lastUpdated || new Date().toISOString();
  }
}
