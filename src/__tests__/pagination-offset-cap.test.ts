// src/__tests__/pagination-offset-cap.test.ts
//
// Regression test: pagination helper must cap offset and limit to safe bounds
// so an attacker can't DoS the DB via `OFFSET 9999999999` (PostgreSQL still
// scans the index up to that offset).
//
// Phase 0.B of docs/superpowers/plans/2026-05-15-v5-postwork-audit-fixes.md.

import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import {
  parsePagination,
  PAGINATION_MAX_LIMIT,
  PAGINATION_MAX_OFFSET,
} from '../middleware/pagination.js';

const reqWith = (query: Record<string, string | undefined>): Request =>
  ({ query } as unknown as Request);

describe('parsePagination', () => {
  it('returns defaults when query is empty', () => {
    expect(parsePagination(reqWith({}))).toEqual({ limit: 20, offset: 0 });
  });

  it('honors explicit defaults override', () => {
    expect(parsePagination(reqWith({}), { limit: 50 })).toEqual({ limit: 50, offset: 0 });
  });

  it('caps offset at PAGINATION_MAX_OFFSET on huge values', () => {
    const { offset } = parsePagination(reqWith({ offset: '9999999999' }));
    expect(offset).toBe(PAGINATION_MAX_OFFSET);
  });

  it('caps offset on Number.MAX_SAFE_INTEGER', () => {
    const { offset } = parsePagination(reqWith({ offset: String(Number.MAX_SAFE_INTEGER) }));
    expect(offset).toBe(PAGINATION_MAX_OFFSET);
  });

  it('caps limit at PAGINATION_MAX_LIMIT', () => {
    const { limit } = parsePagination(reqWith({ limit: '999999' }));
    expect(limit).toBe(PAGINATION_MAX_LIMIT);
  });

  it('falls back to default on negative offset', () => {
    expect(parsePagination(reqWith({ offset: '-5' })).offset).toBe(0);
  });

  it('falls back to default on zero limit', () => {
    expect(parsePagination(reqWith({ limit: '0' })).limit).toBe(20);
  });

  it('falls back to default on NaN inputs', () => {
    expect(parsePagination(reqWith({ limit: 'abc', offset: 'xyz' }))).toEqual({ limit: 20, offset: 0 });
  });

  it('honors valid inputs within bounds', () => {
    expect(parsePagination(reqWith({ limit: '100', offset: '500' }))).toEqual({ limit: 100, offset: 500 });
  });
});
