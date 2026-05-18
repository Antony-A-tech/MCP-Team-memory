import type { Request } from 'express';

const MAX_LIMIT = 500;
const MAX_OFFSET = 10_000;

/**
 * Parse pagination query parameters with safe bounds.
 *
 * Prevents DoS via unbounded OFFSET (e.g. `offset=9999999999`) which would
 * stall the database scanning the index. All caps are conservative; callers
 * needing more should paginate or stream.
 *
 * Defaults: limit=20, offset=0. Bounds: limit ∈ [1, 500], offset ∈ [0, 10000].
 * NaN/negative inputs fall back to the default.
 */
export function parsePagination(
  req: Request,
  defaults: { limit?: number; offset?: number } = {},
): { limit: number; offset: number } {
  const defaultLimit = defaults.limit ?? 20;
  const defaultOffset = defaults.offset ?? 0;

  const rawLimit = Number.parseInt((req.query.limit as string) ?? '', 10);
  const rawOffset = Number.parseInt((req.query.offset as string) ?? '', 10);

  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.min(rawLimit, MAX_LIMIT)
      : defaultLimit;

  const offset =
    Number.isFinite(rawOffset) && rawOffset >= 0
      ? Math.min(rawOffset, MAX_OFFSET)
      : defaultOffset;

  return { limit, offset };
}

export const PAGINATION_MAX_LIMIT = MAX_LIMIT;
export const PAGINATION_MAX_OFFSET = MAX_OFFSET;
