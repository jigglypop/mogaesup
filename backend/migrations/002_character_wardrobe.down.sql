-- Non-destructive rollback: stop the application, unset CHARACTER_DATABASE_URL,
-- then optionally archive the namespace below. Existing data remains available.
-- Refuse to overwrite an earlier archive.
BEGIN;
ALTER SCHEMA gaesup_character RENAME TO gaesup_character_002_archive;
COMMIT;
