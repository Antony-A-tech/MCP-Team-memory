// src/__tests__/memory-read-sort-sanitize.test.ts
//
// Unit test for the public-output sanitizer that strips internal IDs from
// `personal_note` evidence sources (since note IDs leak owner identity by
// joining against the personal_notes table).

import { describe, it, expect } from 'vitest';
import { sanitizeEvidenceSourcesForPublic } from '../memory/manager.js';

describe('sanitizeEvidenceSourcesForPublic', () => {
  it('strips id from personal_note evidence but keeps shared_by', () => {
    const out = sanitizeEvidenceSourcesForPublic([
      {
        type: 'personal_note',
        id: 'note-uuid',
        shared_by: 'agent-uuid',
        confirmed_at: '2026-04-28T00:00:00Z',
      },
      {
        type: 'session',
        id: 'sess-uuid',
        agent_token_id: 'agent-uuid',
        confirmed_at: '2026-04-28T00:00:00Z',
      },
    ]);
    expect(out[0]).toEqual({
      type: 'personal_note',
      shared_by: 'agent-uuid',
      confirmed_at: '2026-04-28T00:00:00Z',
    });
    // Non-personal_note entries are kept untouched
    expect(out[1]).toEqual({
      type: 'session',
      id: 'sess-uuid',
      agent_token_id: 'agent-uuid',
      confirmed_at: '2026-04-28T00:00:00Z',
    });
  });

  it('returns [] for empty/undefined inputs', () => {
    expect(sanitizeEvidenceSourcesForPublic(undefined)).toEqual([]);
    expect(sanitizeEvidenceSourcesForPublic([])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [
      {
        type: 'personal_note' as const,
        id: 'note-uuid',
        shared_by: 'agent-uuid',
        confirmed_at: '2026-04-28T00:00:00Z',
      },
    ];
    const out = sanitizeEvidenceSourcesForPublic(input);
    expect(input[0].id).toBe('note-uuid');
    expect((out[0] as { id?: string }).id).toBeUndefined();
  });
});
