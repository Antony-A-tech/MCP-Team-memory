// src/__tests__/pg-dump-no-credential-leak.test.ts
//
// Regression test: backup endpoint must NOT include the DB password in
// argv to pg_dump or docker. Password leaks to `ps aux`, container inspect,
// and any process-list-reading process.
//
// Phase 0.C of docs/superpowers/plans/2026-05-15-v5-postwork-audit-fixes.md.

import { describe, it, expect } from 'vitest';
import { buildPgDumpInvocation } from '../web/server.js';

const SECRET_PASSWORD = 's3cret-Pa55w0rd_should_NEVER_appear_in_argv';

describe('buildPgDumpInvocation — no credential leak', () => {
  it('does not include the password in directArgs', () => {
    const { directArgs } = buildPgDumpInvocation(
      `postgresql://memory:${SECRET_PASSWORD}@db.example.com:5432/team_memory`,
      'team-memory-pg',
    );
    for (const arg of directArgs) {
      expect(arg).not.toContain(SECRET_PASSWORD);
    }
  });

  it('does not include the password in dockerArgs', () => {
    const { dockerArgs } = buildPgDumpInvocation(
      `postgresql://memory:${SECRET_PASSWORD}@localhost:5432/team_memory`,
      'team-memory-pg',
    );
    for (const arg of dockerArgs) {
      expect(arg).not.toContain(SECRET_PASSWORD);
    }
  });

  it('passes the password via PGPASSWORD env var (urldecoded)', () => {
    const { env } = buildPgDumpInvocation(
      `postgresql://memory:${SECRET_PASSWORD}@localhost:5432/team_memory`,
      'team-memory-pg',
    );
    expect(env.PGPASSWORD).toBe(SECRET_PASSWORD);
  });

  it('urldecodes special characters in the password', () => {
    // Password "p@ss/word" → URL-encoded "p%40ss%2Fword"
    const encoded = 'p%40ss%2Fword';
    const decoded = 'p@ss/word';
    const { env } = buildPgDumpInvocation(
      `postgresql://memory:${encoded}@localhost:5432/team_memory`,
      'team-memory-pg',
    );
    expect(env.PGPASSWORD).toBe(decoded);
  });

  it('handles missing password (trust auth) without crashing', () => {
    const inv = buildPgDumpInvocation(
      'postgresql://memory@localhost:5432/team_memory',
      'team-memory-pg',
    );
    expect(inv.env.PGPASSWORD).toBe('');
    expect(inv.directArgs).toContain('memory');
  });

  it('uses default port 5432 when URL omits it', () => {
    const { directArgs } = buildPgDumpInvocation(
      'postgresql://memory:pwd@localhost/team_memory',
      'c',
    );
    const portIdx = directArgs.indexOf('-p');
    expect(directArgs[portIdx + 1]).toBe('5432');
  });

  it('passes correct host/user/db via direct args', () => {
    const { directArgs } = buildPgDumpInvocation(
      'postgresql://alice:pwd@dbhost.local:6543/mydb',
      'c',
    );
    expect(directArgs).toEqual(['-h', 'dbhost.local', '-p', '6543', '-U', 'alice', '-d', 'mydb']);
  });
});
