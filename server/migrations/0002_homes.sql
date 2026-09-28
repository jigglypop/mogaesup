CREATE TABLE IF NOT EXISTS homes (
  owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  status_message text NOT NULL DEFAULT '',
  mood smallint NOT NULL DEFAULT 0,
  minime text NOT NULL DEFAULT 'man',
  emoji text NOT NULL DEFAULT '🧑',
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'ilchon', 'private')),
  visits_total bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS homes_recent ON homes(updated_at DESC) WHERE visibility = 'public';
-- The runtime's save envelope per world; the revision keeps a stale tab from overwriting a newer save.
CREATE TABLE IF NOT EXISTS home_worlds (
  owner_id uuid NOT NULL REFERENCES homes(owner_id) ON DELETE CASCADE,
  world_id text NOT NULL,
  revision bigint NOT NULL,
  data jsonb NOT NULL,
  byte_size integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, world_id)
);
-- One row per visitor per Seoul day; TODAY counts rows, TOTAL is the running counter on homes.
CREATE TABLE IF NOT EXISTS home_visits (
  owner_id uuid NOT NULL REFERENCES homes(owner_id) ON DELETE CASCADE,
  day date NOT NULL,
  visitor text NOT NULL,
  PRIMARY KEY (owner_id, day, visitor)
);
CREATE INDEX IF NOT EXISTS home_visits_day ON home_visits(day);
