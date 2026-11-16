-- A member's 사주 home (src/saju.rs): the name on its gate and the birth its chart is read from. The app works the
-- chart out in the browser, where the calendar tables are; the server keeps what was entered, for whoever may see the
-- member's home.
CREATE TABLE IF NOT EXISTS saju_homes (
  owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  calendar text NOT NULL CHECK (calendar IN ('solar', 'lunar')),
  birth_year smallint NOT NULL,
  birth_month smallint NOT NULL CHECK (birth_month BETWEEN 1 AND 12),
  birth_day smallint NOT NULL CHECK (birth_day BETWEEN 1 AND 31),
  -- A lunar date in that year's leap month.
  leap_month boolean NOT NULL DEFAULT false,
  -- 'HH:MM' by Seoul's clock, or NULL when the hour is not known.
  birth_time text CHECK (birth_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  gender text NOT NULL CHECK (gender IN ('female', 'male')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A village fills the places its owner's 이웃 leave with the homes built or built again most recently.
CREATE INDEX IF NOT EXISTS saju_homes_recent ON saju_homes (updated_at DESC, owner_id);
