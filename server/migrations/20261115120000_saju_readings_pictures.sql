-- What the server makes for a 사주 home with a paid model (src/saju_made.rs): a written reading of its chart and its
-- island drawn again as a 미연시 illustration. Each is bound to the birth it was made from (`birth_key`, see
-- src/saju.rs): a home built again from another birth has neither, and a home taken down takes both with it.
CREATE TABLE IF NOT EXISTS saju_readings (
  owner_id uuid PRIMARY KEY REFERENCES saju_homes(owner_id) ON DELETE CASCADE,
  birth_key text NOT NULL,
  -- Every request that starts work takes a new attempt, and the work records its outcome only on its own attempt.
  attempt uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  model text NOT NULL,
  -- The reading as the app shows it (SajuReading in frontend/src/api/types.ts), once ready.
  reading jsonb,
  -- Why it failed, as this server names it; the message the app shows is the server's own for that code.
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS saju_pictures (
  owner_id uuid PRIMARY KEY REFERENCES saju_homes(owner_id) ON DELETE CASCADE,
  birth_key text NOT NULL,
  attempt uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  model text NOT NULL,
  -- The picture's site path in the model store (/models/<sha256>.webp); the store's sweep keeps what this names.
  url text,
  width integer,
  height integer,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- Every paid call, by member: a member's calls that replaced one already made (`again`) are limited.
CREATE TABLE IF NOT EXISTS saju_paid_calls (
  id bigserial PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('reading', 'picture')),
  again boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saju_paid_calls_member ON saju_paid_calls (owner_id, kind, created_at DESC);

-- Paid calls of each kind in a calendar month (UTC) across all members, against READINGS_MONTHLY and PICTURES_MONTHLY.
CREATE TABLE IF NOT EXISTS saju_paid_months (
  month date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reading', 'picture')),
  calls integer NOT NULL DEFAULT 0,
  PRIMARY KEY (month, kind)
);
