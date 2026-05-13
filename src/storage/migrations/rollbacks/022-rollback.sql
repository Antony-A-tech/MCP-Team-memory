-- Rollback for 022-knowledge-category.sql
-- Restores entries.category from the legacy 'kind' tag.
--
-- We use a single UPDATE per kind to avoid touching unrelated knowledge rows.
-- The 'architecture'/'decisions'/'conventions' tag stays in tags after rollback
-- (intentionally — manual cleanup if needed).

UPDATE entries
SET category = 'architecture'
WHERE category = 'knowledge' AND 'architecture' = ANY(tags);

UPDATE entries
SET category = 'decisions'
WHERE category = 'knowledge' AND 'decisions' = ANY(tags);

UPDATE entries
SET category = 'conventions'
WHERE category = 'knowledge' AND 'conventions' = ANY(tags);

-- Note: the CHECK constraint still has 'knowledge' in the allowed set after this rollback.
-- A separate constraint revert is needed if you want to fully back out v5.
