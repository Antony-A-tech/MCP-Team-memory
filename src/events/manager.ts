import { EventsStorage } from './storage.js';
import { EVENT_TYPES } from './types.js';
import type { InsertEventParams, ProjectEvent, ListEventOptions, EventType } from './types.js';

export class EventsManager {
  constructor(private storage: EventsStorage) {}

  async add(params: InsertEventParams): Promise<ProjectEvent> {
    if (!params.title || !params.title.trim()) {
      throw new Error('event title must be non-empty');
    }
    if (!EVENT_TYPES.includes(params.eventType as EventType)) {
      throw new Error(
        `event_type must be one of: ${EVENT_TYPES.join(', ')} (got "${params.eventType}")`,
      );
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

  async hasEventForSession(projectId: string, sessionId: string): Promise<boolean> {
    return this.storage.hasEventForSession(projectId, sessionId);
  }
}
