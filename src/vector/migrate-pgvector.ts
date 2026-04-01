import type { Pool } from 'pg';
import type { VectorStore } from './vector-store.js';
import logger from '../logger.js';

/**
 * Migrate all existing embeddings from pgvector (entries.embedding) to Qdrant.
 * Run this BEFORE migration 011 (which drops the embedding column).
 *
 * Safe to re-run: upserts are idempotent (same ID overwrites).
 */
export async function migratePgvectorToQdrant(
  pool: Pool,
  vectorStore: VectorStore,
  dimensions: number,
): Promise<{ migrated: number; skipped: number }> {
  await vectorStore.ensureCollection('entries', dimensions);

  const { rows } = await pool.query(`
    SELECT id, project_id, category, domain, status, tags, author, embedding::text
    FROM entries
    WHERE embedding IS NOT NULL
  `);

  if (rows.length === 0) {
    logger.info('No embeddings to migrate from pgvector');
    return { migrated: 0, skipped: 0 };
  }

  let migrated = 0;
  let skipped = 0;
  const BATCH_SIZE = 100;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const points = batch.map(row => {
      try {
        // pgvector text format is already valid JSON: [0.1,0.2,...]
        const vector = JSON.parse(row.embedding);
        if (!Array.isArray(vector) || vector.length !== dimensions) {
          skipped++;
          return null;
        }
        migrated++;
        return {
          id: row.id,
          vector,
          payload: {
            entry_id: row.id,
            project_id: row.project_id,
            category: row.category,
            domain: row.domain ?? '',
            status: row.status,
            tags: row.tags || [],
            author: row.author,
          },
        };
      } catch {
        skipped++;
        return null;
      }
    }).filter((p): p is NonNullable<typeof p> => p !== null);

    if (points.length > 0) {
      await vectorStore.upsertBatch('entries', points);
    }

    logger.info({ progress: Math.min(i + BATCH_SIZE, rows.length), total: rows.length }, 'pgvector → Qdrant migration progress');
  }

  logger.info({ migrated, skipped, total: rows.length }, 'pgvector → Qdrant migration complete');
  return { migrated, skipped };
}
