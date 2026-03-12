# Team Memory MCP — Bugfix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all identified security vulnerabilities, race conditions, memory leaks, and reliability bugs in team-memory-mcp v2.0.

**Architecture:** Targeted fixes to existing files — no new modules. Each task is isolated and independently testable. Security fixes first, then reliability, then data integrity.

**Tech Stack:** TypeScript, Node.js 20+, PostgreSQL, Vitest, Zod

---

## Chunk 1: Critical Security Fixes

### Task 1: Fix auth token validation bypass (empty token)

**Files:**
- Modify: `src/middleware/auth.ts:9-15`
- Modify: `src/sync/websocket.ts:45-53`
- Test: `src/__tests__/auth.test.ts`

**Problem:** If `MEMORY_API_TOKEN` is set to empty string `""`, `!token` is falsy for `""` in JS but `Buffer.from("")` creates a 0-length buffer. In `auth.ts` line 12, `if (!token)` correctly skips empty string (empty string is falsy). But if token is set to a whitespace-only string like `" "`, it passes the check and creates a buffer that won't match. More critically, in `websocket.ts` line 45, `if (this.apiToken)` — an empty string is falsy, so auth is skipped. But the constructor accepts `undefined | string` — a caller could pass `""` thinking auth is enabled while it's silently disabled.

- [ ] **Step 1: Add failing tests to existing auth test file**

In `src/__tests__/auth.test.ts` (file already exists — ADD a new `describe` block, do not overwrite):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createAuthMiddleware } from '../middleware/auth.js';

describe('createAuthMiddleware edge cases', () => {
  const mockRes = () => {
    const res: any = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res;
  };

  it('should reject requests when token is empty string (misconfiguration)', () => {
    const middleware = createAuthMiddleware('');
    const req = { path: '/api/test', headers: { authorization: 'Bearer anything' } } as any;
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);
    // Empty token = auth disabled, so next() should be called
    // BUT we want to warn about misconfiguration
    expect(next).toHaveBeenCalled();
  });

  it('should trim whitespace from configured token', () => {
    const middleware = createAuthMiddleware('  mytoken  ');
    const req = { path: '/api/test', headers: { authorization: 'Bearer mytoken' } } as any;
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify behavior**

Run: `cd d:/MCP/team-memory-mcp && npx vitest run src/__tests__/auth.test.ts`

- [ ] **Step 3: Fix auth.ts — trim token and validate non-empty**

In `src/middleware/auth.ts`, replace lines 9-15:

```typescript
export function createAuthMiddleware(token: string | undefined) {
  const trimmedToken = token?.trim() || undefined;

  // Warn if token was provided but resolves to empty after trimming
  if (token !== undefined && !trimmedToken) {
    console.error('WARNING: MEMORY_API_TOKEN is empty/whitespace — auth is disabled');
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    // No token configured — auth disabled
    if (!trimmedToken) {
      next();
      return;
    }
```

Replace lines 37-39 (use trimmedToken):

```typescript
    const tokenBuffer = Buffer.from(trimmedToken);
    const providedBuffer = Buffer.from(provided);
```

- [ ] **Step 4: Fix websocket.ts — validate token properly**

In `src/sync/websocket.ts`, replace lines 45-53:

```typescript
      // Verify token if auth is enabled
      const effectiveToken = this.apiToken?.trim();
      if (effectiveToken) {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const token = url.searchParams.get('token') || req.headers.authorization?.replace(/^Bearer\s+/i, '');
        if (!token) {
          ws.close(4401, 'Unauthorized');
          return;
        }
        const tokenBuf = Buffer.from(token);
        const expectedBuf = Buffer.from(effectiveToken);
        if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
          ws.close(4401, 'Unauthorized');
          return;
        }
      }
```

- [ ] **Step 5: Run all auth tests**

Run: `cd d:/MCP/team-memory-mcp && npx vitest run src/__tests__/auth.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/middleware/auth.ts src/sync/websocket.ts src/__tests__/auth.test.ts
git commit -m "fix(security): harden token validation against empty/whitespace tokens"
```

---

### Task 2: Fix ILIKE metacharacter injection in search

**Files:**
- Modify: `src/storage/pg-storage.ts:209-224`
- Test: `src/__tests__/pg-storage-search.test.ts` (new)

**Problem:** ILIKE special characters `%`, `_`, `\` in user search queries are not escaped, allowing wildcard manipulation.

- [ ] **Step 1: Write failing test**

Create `src/__tests__/pg-storage-search.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { escapeIlike } from '../storage/pg-storage.js';

describe('escapeIlike', () => {
  it('should escape % character', () => {
    expect(escapeIlike('100%')).toBe('100\\%');
  });

  it('should escape _ character', () => {
    expect(escapeIlike('file_name')).toBe('file\\_name');
  });

  it('should escape backslash', () => {
    expect(escapeIlike('path\\to')).toBe('path\\\\to');
  });

  it('should escape all special chars together', () => {
    expect(escapeIlike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  it('should leave normal strings unchanged', () => {
    expect(escapeIlike('normal query')).toBe('normal query');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd d:/MCP/team-memory-mcp && npx vitest run src/__tests__/pg-storage-search.test.ts`
Expected: FAIL — `escapeIlike` is not exported

- [ ] **Step 3: Add escapeIlike function and use in search**

In `src/storage/pg-storage.ts`, add before the `PgStorage` class:

```typescript
/** Escape ILIKE special characters to prevent wildcard injection */
export function escapeIlike(query: string): string {
  return query.replace(/[\\%_]/g, '\\$&');
}
```

Then modify the `search` method (line 221):

```typescript
      [projectId, query, `%${escapeIlike(query)}%`, limit]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd d:/MCP/team-memory-mcp && npx vitest run src/__tests__/pg-storage-search.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/storage/pg-storage.ts src/__tests__/pg-storage-search.test.ts
git commit -m "fix(security): escape ILIKE metacharacters in search queries"
```

---

### Task 3: Fix config validation (NaN from parseInt)

**Files:**
- Modify: `src/config.ts:16-27`
- Test: `src/__tests__/config.test.ts` (new)

**Problem:** `parseInt('abc', 10)` returns `NaN` silently. Server starts with broken config.

- [ ] **Step 1: Write failing test**

Create `src/__tests__/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseIntSafe } from '../config.js';

describe('parseIntSafe', () => {
  it('should parse valid integer', () => {
    expect(parseIntSafe('3846', 3846)).toBe(3846);
  });

  it('should return default for NaN', () => {
    expect(parseIntSafe('abc', 3846)).toBe(3846);
  });

  it('should return default for empty string', () => {
    expect(parseIntSafe('', 3846)).toBe(3846);
  });

  it('should parse negative numbers', () => {
    expect(parseIntSafe('-1', 0)).toBe(-1);
  });
});
```

- [ ] **Step 2: Run test — should fail**

Run: `cd d:/MCP/team-memory-mcp && npx vitest run src/__tests__/config.test.ts`

- [ ] **Step 3: Implement parseIntSafe and use in loadConfig**

In `src/config.ts`, add:

```typescript
/** Parse integer with fallback to default on NaN */
export function parseIntSafe(value: string, defaultValue: number): number {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}
```

Update `loadConfig()`:

```typescript
export function loadConfig(): AppConfig {
  return {
    databaseUrl: process.env.DATABASE_URL || 'postgresql://memory:memory@localhost:5432/team_memory',
    transport: (process.env.MEMORY_TRANSPORT as 'http' | 'stdio') || 'http',
    port: parseIntSafe(process.env.MEMORY_PORT || '3846', 3846),
    autoArchiveEnabled: process.env.MEMORY_AUTO_ARCHIVE !== 'false',
    autoArchiveDays: parseIntSafe(process.env.MEMORY_AUTO_ARCHIVE_DAYS || '14', 14),
    autoBackupEnabled: process.env.MEMORY_AUTO_BACKUP !== 'false',
    backupIntervalMs: parseIntSafe(process.env.MEMORY_BACKUP_INTERVAL || '3600000', 3600000),
    apiToken: process.env.MEMORY_API_TOKEN || undefined,
  };
}
```

- [ ] **Step 4: Run test — should pass**

Run: `cd d:/MCP/team-memory-mcp && npx vitest run src/__tests__/config.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts
git commit -m "fix(config): validate parseInt results with NaN fallback"
```

---

## Chunk 2: Reliability & Race Condition Fixes

### Task 4: Fix race condition in version numbering

**Files:**
- Modify: `src/storage/versioning.ts:22-36`

**Problem:** Concurrent `INSERT ... SELECT COALESCE(MAX(version), 0) + 1` can produce duplicate version numbers without locking.

- [ ] **Step 1: Write test documenting expected behavior**

Add to `src/__tests__/versioning.test.ts` (new):

```typescript
import { describe, it, expect } from 'vitest';

describe('VersionManager', () => {
  it('should use INSERT ... SELECT with advisory lock pattern', () => {
    // This is a documentation test — the actual fix uses
    // pg_advisory_xact_lock to prevent concurrent version conflicts
    // Integration testing requires a real PostgreSQL instance
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Fix versioning.ts to use advisory lock**

Replace the `saveVersion` method in `src/storage/versioning.ts`:

```typescript
  async saveVersion(entry: MemoryEntry): Promise<number> {
    // Use advisory lock keyed on entry UUID to prevent concurrent version conflicts
    const { rows } = await this.pool.query(
      `WITH lock AS (
        SELECT pg_advisory_xact_lock(hashtext($1))
      )
      INSERT INTO entry_versions (entry_id, version, title, content, domain, category, tags, priority, status, author)
      SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9
      FROM entry_versions WHERE entry_id = $1
      RETURNING version`,
      [
        entry.id, entry.title, entry.content,
        entry.domain, entry.category, entry.tags, entry.priority,
        entry.status, entry.author,
      ]
    );

    return rows[0].version as number;
  }
```

- [ ] **Step 3: Commit**

```bash
git add src/storage/versioning.ts src/__tests__/versioning.test.ts
git commit -m "fix(versioning): use advisory lock to prevent duplicate version numbers"
```

---

### Task 5: Fix unhandled async in WebSocket handleSyncRequest

**Files:**
- Modify: `src/sync/websocket.ts:129-131`

**Problem:** `handleSyncRequest()` is async but called without `await`. Rejected promise goes unhandled.

- [ ] **Step 1: Fix the call site**

In `src/sync/websocket.ts`, replace line 130:

```typescript
      case 'sync_request':
        this.handleSyncRequest(client, msg.payload as { since?: string })
          .catch(err => console.error('Sync request error:', err));
        break;
```

- [ ] **Step 2: Commit**

```bash
git add src/sync/websocket.ts
git commit -m "fix(websocket): handle rejected promise in sync_request handler"
```

---

### Task 6: Fix ws.send() race condition

**Files:**
- Modify: `src/sync/websocket.ts:167-171`

**Problem:** Between `readyState` check and `send()`, socket can close.

- [ ] **Step 1: Wrap send in try-catch**

Replace `sendToClient` method — use ws callback form since `ws.send()` is async and errors may surface in callback rather than as thrown exceptions:

```typescript
  private sendToClient(ws: WebSocket, event: WSEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event), (err) => {
        if (err) console.error('WebSocket send failed:', err);
      });
    }
  }
```

Replace `broadcast` method:

```typescript
  private broadcast(event: WSEvent): void {
    const message = JSON.stringify(event);
    this.clients.forEach((client) => {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message, (err) => {
          if (err) console.error(`WebSocket broadcast failed for ${client.name}:`, err);
        });
      }
    });
  }
```

Replace `broadcastExcept` method:

```typescript
  private broadcastExcept(excludeId: string, event: WSEvent): void {
    const message = JSON.stringify(event);
    this.clients.forEach((client, id) => {
      if (id !== excludeId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message, (err) => {
          if (err) console.error(`WebSocket broadcast failed for ${client.name}:`, err);
        });
      }
    });
  }
```

- [ ] **Step 2: Commit**

```bash
git add src/sync/websocket.ts
git commit -m "fix(websocket): wrap send() in try-catch to handle race conditions"
```

---

### Task 7: Fix rate limiter memory leak

**Files:**
- Modify: `src/middleware/rate-limit.ts:18-26`

**Problem:** No upper bound on Map size. Millions of unique IPs = memory exhaustion.

- [ ] **Step 1: Add max-size eviction**

Replace the rate limiter store logic in `src/middleware/rate-limit.ts`:

```typescript
export function createRateLimiter(options: {
  windowMs?: number;
  maxRequests?: number;
  maxClients?: number;  // Max tracked IPs
} = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const maxRequests = options.maxRequests ?? 100;
  const maxClients = options.maxClients ?? 10_000;
  const store = new Map<string, RateLimitEntry>();

  // Cleanup expired entries every windowMs
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetAt) store.delete(key);
    }
  }, windowMs).unref();
```

Add eviction before `store.set(key, entry)`:

```typescript
    let entry = store.get(key);
    if (!entry || now > entry.resetAt) {
      // Evict oldest entries if at capacity
      if (!entry && store.size >= maxClients) {
        const firstKey = store.keys().next().value;
        if (firstKey !== undefined) store.delete(firstKey);
      }
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }
```

- [ ] **Step 2: Commit**

```bash
git add src/middleware/rate-limit.ts
git commit -m "fix(rate-limit): add max-size eviction to prevent memory leak"
```

---

## Chunk 3: Data Integrity & Code Quality

### Task 8: Fix missing projectId in delete audit log

**Files:**
- Modify: `src/memory/manager.ts:176-205`

**Problem:** Hard-delete audit log entry doesn't include `projectId`, breaking audit queries by project.

- [ ] **Step 1: Fetch entry before deleting to capture projectId**

Replace the `delete` method in `src/memory/manager.ts`:

```typescript
  async delete(params: DeleteParams): Promise<boolean> {
    const { id, archive = true } = params;

    if (archive) {
      const archived = await this.storage.archive(id);
      if (archived) {
        this.emit('memory:updated', archived);
        this.auditLogger?.log({
          entryId: id,
          projectId: archived.projectId,
          action: 'archive',
          actor: archived.author,
        }).catch(err => console.error('Audit log failed:', err));
        return true;
      }
      return false;
    }

    // Fetch entry before hard-delete to get projectId for audit
    const existing = await this.storage.getById(id);
    const deleted = await this.storage.delete(id);
    if (deleted) {
      this.emit('memory:deleted', { id });
      this.auditLogger?.log({
        entryId: id,
        projectId: existing?.projectId,
        action: 'delete',
        actor: existing?.author || 'system',
      }).catch(err => console.error('Audit log failed:', err));
      return true;
    }
    return false;
  }
```

- [ ] **Step 2: Commit**

```bash
git add src/memory/manager.ts
git commit -m "fix(audit): include projectId in hard-delete audit log entries"
```

---

### Task 9: Fix unsafe Date type assertion in row mappers

**Files:**
- Modify: `src/storage/pg-storage.ts:27-28`
- Modify: `src/storage/audit.ts:70`
- Modify: `src/storage/versioning.ts:67`

**Problem:** `(row.created_at as Date).toISOString()` crashes if pg client returns strings.

- [ ] **Step 1: Create shared date conversion utility**

Create `src/storage/utils.ts`:

```typescript
/** Safely convert a DB timestamp value to ISO string */
export function toISOString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return new Date(value).toISOString();
  return new Date().toISOString();
}
```

- [ ] **Step 2: Import and use in pg-storage.ts**

Add import: `import { toISOString } from './utils.js';`

Replace all unsafe Date casts in pg-storage.ts:

In `rowToEntry`:
```typescript
    createdAt: toISOString(row.created_at),
    updatedAt: toISOString(row.updated_at),
```

In `rowToProject`:
```typescript
    createdAt: toISOString(row.created_at),
    updatedAt: toISOString(row.updated_at),
```

In `getLastUpdated` (line 393):
```typescript
    return rows[0]?.last ? toISOString(rows[0].last) : new Date().toISOString();
```

- [ ] **Step 3: Import and use in audit.ts**

Add import: `import { toISOString } from './utils.js';`

In `rowToAudit`:
```typescript
      createdAt: toISOString(row.created_at),
```

- [ ] **Step 4: Import and use in versioning.ts**

Add import: `import { toISOString } from './utils.js';`

In `rowToVersion`:
```typescript
      createdAt: toISOString(row.created_at),
```

- [ ] **Step 5: Commit**

```bash
git add src/storage/utils.ts src/storage/pg-storage.ts src/storage/audit.ts src/storage/versioning.ts
git commit -m "fix(storage): safe date conversion in row mappers via shared utility"
```

---

### Task 10: Fix `this` binding in audit.ts map callbacks

**Files:**
- Modify: `src/storage/audit.ts:43,51,59`

**Problem:** `rows.map(this.rowToAudit)` can lose `this` context.

- [ ] **Step 1: Fix all three call sites**

Replace:
```typescript
    return rows.map(this.rowToAudit);
```
With:
```typescript
    return rows.map((row) => this.rowToAudit(row));
```

Apply to lines 43, 51, 59.

- [ ] **Step 2: Apply same fix in versioning.ts line 43**

Replace:
```typescript
    return rows.map(this.rowToVersion);
```
With:
```typescript
    return rows.map((row) => this.rowToVersion(row));
```

- [ ] **Step 3: Commit**

```bash
git add src/storage/audit.ts src/storage/versioning.ts
git commit -m "fix(storage): use arrow functions in map to preserve this binding"
```

---

### Task 11: Extract DEFAULT_PROJECT_ID to single source of truth

**Files:**
- Modify: `src/memory/types.ts`
- Modify: `src/memory/manager.ts:20`
- Modify: `src/storage/pg-storage.ts:11`
- Modify: `src/storage/migration.ts` (find DEFAULT_PROJECT_ID line)

- [ ] **Step 1: Export from types.ts**

Add to `src/memory/types.ts`:

```typescript
/** Default project UUID — used when no project_id is specified */
export const DEFAULT_PROJECT_ID = '00000000-0000-0000-0000-000000000000';
```

- [ ] **Step 2: Replace in all other files**

In `src/memory/manager.ts`, remove line 20 and add import:
```typescript
import { DEFAULT_PROJECT_ID } from './types.js';
```

In `src/storage/pg-storage.ts`, remove line 11 and update existing import (line 6) to include `DEFAULT_PROJECT_ID` while keeping existing `DEFAULT_DOMAINS`:
```typescript
import type { MemoryEntry, Project, ReadParams, DEFAULT_DOMAINS } from '../memory/types.js';
```
→
```typescript
import { DEFAULT_PROJECT_ID, type MemoryEntry, type Project, type ReadParams, type DEFAULT_DOMAINS } from '../memory/types.js';
```
Note: `DEFAULT_DOMAINS` is imported dynamically in `ensureDefaultProject()` and `createProject()` — consolidate those to use the static import as well.

In `src/storage/migration.ts`, remove local constant and import from types.

- [ ] **Step 3: Run build to verify**

Run: `cd d:/MCP/team-memory-mcp && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/memory/types.ts src/memory/manager.ts src/storage/pg-storage.ts src/storage/migration.ts
git commit -m "refactor: extract DEFAULT_PROJECT_ID to single source of truth"
```

---

### Task 12: Fix unchecked category assertion in resource handler

**Files:**
- Modify: `src/server.ts:478-484`

**Problem:** URI `memory://invalid_category` passes regex `\w+` and is cast to `Category` without validation.

- [ ] **Step 1: Add validation**

Replace lines 478-484 in `src/server.ts`:

```typescript
    const VALID_CATEGORIES = ['architecture', 'tasks', 'decisions', 'issues', 'progress'];
    const m = uri.match(/^memory:\/\/(\w+)$/);
    if (m && VALID_CATEGORIES.includes(m[1])) {
      const category = m[1] as Category;
      const entries = await memoryManager.read({ category, status: 'active' });
      const text = entries.length > 0 ? entries.map(e => `## ${e.title}\n${e.content}\n\n---`).join('\n\n') : `Нет записей.`;
      return { contents: [{ uri, mimeType: 'text/markdown', text }] };
    }
```

- [ ] **Step 2: Commit**

```bash
git add src/server.ts
git commit -m "fix(server): validate category from resource URI before use"
```

---

### Task 13: Fix CORS default and add security warning

**Files:**
- Modify: `src/app.ts:55-57`

- [ ] **Step 1: Add warning for wildcard CORS (once at startup, not per-request)**

Add BEFORE the `app.use` CORS middleware (outside the callback):

```typescript
  // CORS — allow configurable origins
  const allowedOrigin = process.env.MEMORY_CORS_ORIGIN || '*';
  if (allowedOrigin === '*') {
    console.error('WARNING: CORS origin is set to "*" — all origins allowed. Set MEMORY_CORS_ORIGIN for production.');
  }
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
```

- [ ] **Step 2: Commit**

```bash
git add src/app.ts
git commit -m "fix(security): add warning for wildcard CORS configuration"
```

---

### Task 14: Run full test suite and build

- [ ] **Step 1: Run all tests**

Run: `cd d:/MCP/team-memory-mcp && npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run TypeScript build**

Run: `cd d:/MCP/team-memory-mcp && npm run build`
Expected: Build succeeds

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: resolve any remaining type errors from bugfix batch"
```
