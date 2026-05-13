import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PgStorage } from '../storage/pg-storage.js';
import { MemoryManager } from '../memory/manager.js';
import { EventsManager } from '../events/manager.js';
import { EventsStorage } from '../events/storage.js';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://memory:memory@localhost:5432/team_memory_test';

describe('EventsManager wiring into MemoryManager', () => {
  let storage: PgStorage;
  let pool: pg.Pool;

  beforeAll(async () => {
    storage = new PgStorage(TEST_DB);
    await storage.initialize();
    pool = new pg.Pool({ connectionString: TEST_DB });
  });

  afterAll(async () => {
    await pool.end();
    await storage.close();
  });

  it('returns null before setEventsManager is called', () => {
    const memoryManager = new MemoryManager(storage);
    expect(memoryManager.getEventsManager()).toBeNull();
  });

  it('setEventsManager stores the instance; getEventsManager returns it', () => {
    const memoryManager = new MemoryManager(storage);
    const eventsManager = new EventsManager(new EventsStorage(pool));
    memoryManager.setEventsManager(eventsManager);
    expect(memoryManager.getEventsManager()).toBe(eventsManager);
  });
});
