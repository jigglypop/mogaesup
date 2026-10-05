-- When each session began. A session in use is renewed, but never past 90 days from here (src/auth.rs), so a stolen
-- one cannot be kept alive forever. Sessions made before this column count from the migration.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
-- Whether the session may still be presented under the cookie name it had before `__Host-` (src/auth.rs): sessions made
-- before the rename (and by an older server after a rollback) may; those issued under the new name may not, so a cookie
-- planted under the old name from another subdomain cannot carry them.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS legacy_cookie boolean NOT NULL DEFAULT true;
