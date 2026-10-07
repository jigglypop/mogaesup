-- The devices an account signed in from (src/auth.rs): a known device has a wrong-password budget of its own, an account
-- keeps a few of them, and changing the password or signing out the other devices forgets all but the one that did it.
CREATE TABLE IF NOT EXISTS login_devices (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id)
);

-- Today's visitors of an island, counted as each visit is recorded (src/homes.rs) rather than counted on every read.
-- `visits_day` is the Seoul day `visits_today` counts; another day reads as none yet.
ALTER TABLE homes ADD COLUMN IF NOT EXISTS visits_day date;
ALTER TABLE homes ADD COLUMN IF NOT EXISTS visits_today integer NOT NULL DEFAULT 0;
UPDATE homes h SET visits_day = v.day, visits_today = v.today
FROM (
  SELECT owner_id, day, count(*)::int AS today FROM home_visits
  WHERE day = (now() AT TIME ZONE 'Asia/Seoul')::date GROUP BY owner_id, day
) v
WHERE h.owner_id = v.owner_id;

-- The stored models a world names, read from it as it is saved (src/homes.rs), so the model sweep (src/models.rs) need
-- not search every world's text. They hold for the revision they were read from: a world saved by a release that does
-- not write them is searched as before.
ALTER TABLE home_worlds ADD COLUMN IF NOT EXISTS model_refs text[];
ALTER TABLE home_worlds ADD COLUMN IF NOT EXISTS model_refs_revision bigint;

-- Where a guestbook entry was written from, as a keyed hash of the address (src/social.rs): entries from one address in
-- one guestbook are limited per day.
ALTER TABLE guestbook_entries ADD COLUMN IF NOT EXISTS author_address text;
CREATE INDEX IF NOT EXISTS guestbook_address ON guestbook_entries (home_owner_id, author_address, created_at)
  WHERE author_address IS NOT NULL;

-- Whether a studio request's status is the character server's own answer rather than this server's (src/factory.rs):
-- only an answer from the character server can follow work it started.
ALTER TABLE factory_requests ADD COLUMN IF NOT EXISTS upstream boolean;
