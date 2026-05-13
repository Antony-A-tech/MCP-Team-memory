-- 022-knowledge-category.sql
-- v5 Knowledge unification: collapse architecture/decisions/conventions into one
-- 'knowledge' category. The original category name is preserved as a tag so
-- downstream queries / UI can filter/group by 'kind'.
--
-- Step A: extend CHECK constraint to include 'knowledge'.
-- Step B: rename matching rows AND append the original name as a tag.
--
-- Idempotency: on re-run, step A is no-op (constraint already has 'knowledge'),
-- and step B's WHERE filter matches no rows (everything was already renamed).
-- The array_agg(DISTINCT) inside the UPDATE handles the edge case where a
-- user had already added e.g. 'architecture' to tags manually before
-- the first run — it deduplicates without losing data.
--
-- See plan: docs/superpowers/plans/2026-05-13-v5-profile-events-knowledge.md

ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_category_check;
ALTER TABLE entries ADD CONSTRAINT entries_category_check
  CHECK (category IN ('architecture','tasks','decisions','issues','progress','conventions','profile','knowledge'));

UPDATE entries
SET category = 'knowledge',
    tags = (
      SELECT array_agg(DISTINCT t)
      FROM unnest(array_append(tags, category::text)) AS t
      WHERE t IS NOT NULL
    )
WHERE category IN ('architecture', 'decisions', 'conventions');
