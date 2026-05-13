-- Rollback for 021-profile-category.sql
DROP INDEX IF EXISTS idx_entries_one_active_profile;
ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_category_check;
ALTER TABLE entries ADD CONSTRAINT entries_category_check
  CHECK (category IN ('architecture','tasks','decisions','issues','progress','conventions'));
