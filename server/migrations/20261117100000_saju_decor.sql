-- How a member dresses the island of their 사주 home (src/saju_decor.rs): what they placed on it, and the flags other
-- members gave them. A flag shows a 자미두수 star in one of the five elements; each member gives each home at most one
-- a day, by Seoul's calendar.
CREATE TABLE IF NOT EXISTS saju_decor (
  owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- The things placed, as the app placed them once the server checked them: [{id, kind, ref, x, z, turn}].
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saju_flags (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  giver_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- One of the 14 main stars of 자미두수, or 공궁 for a life palace without one.
  star text NOT NULL,
  element text NOT NULL CHECK (element IN ('wood', 'fire', 'earth', 'metal', 'water')),
  -- The Seoul day it was given on.
  given_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, giver_id, given_on)
);

-- A home's flags, the newest first.
CREATE INDEX IF NOT EXISTS saju_flags_owner ON saju_flags (owner_id, created_at DESC);
