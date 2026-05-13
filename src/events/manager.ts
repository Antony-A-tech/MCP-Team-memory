import { EventsStorage } from './storage.js';
import type { InsertEventParams, ProjectEvent, ListEventOptions } from './types.js';

export class EventsManager {
  constructor(private storage: EventsStorage) {}

  async add(params: InsertEventParams): Promise<ProjectEvent> {
    if (!params.title || !params.title.trim()) {
      throw new Error('event title must be non-empty');
    }
    return this.storage.insert(params);
  }

  async list(projectId: string, opts: ListEventOptions = {}): Promise<ProjectEvent[]> {
    return this.storage.list(projectId, opts);
  }

  async listRecent(projectId: string, limit = 10): Promise<ProjectEvent[]> {
    return this.storage.list(projectId, { limit });
  }

  async delete(id: string): Promise<boolean> {
    return this.storage.delete(id);
  }
}
