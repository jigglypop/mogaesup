-- The island listing pages by (updated_at, owner_id) newest first (src/homes.rs).
CREATE INDEX IF NOT EXISTS homes_listing ON homes (updated_at DESC, owner_id DESC) WHERE visibility = 'public';

-- Searching it looks for the text anywhere in a username, a name or a title (ILIKE '%…%'), which only trigram indexes
-- serve. pg_trgm is a trusted extension (PostgreSQL 13+, RDS included), so the database's owner may add it; where it
-- cannot be added the search keeps working without the indexes.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
  RAISE NOTICE 'pg_trgm is not available: island search stays unindexed';
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS users_username_trgm ON users USING gin (username gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS users_display_name_trgm ON users USING gin (display_name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS homes_title_trgm ON homes USING gin (title gin_trgm_ops);
  END IF;
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'pg_trgm operators are not on the search path: island search stays unindexed';
END
$$;
