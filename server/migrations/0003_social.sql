CREATE TABLE IF NOT EXISTS guestbook_entries (
  id uuid PRIMARY KEY,
  home_owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL,
  secret boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS guestbook_home ON guestbook_entries(home_owner_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS ilchon_requests (
  id uuid PRIMARY KEY,
  from_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  their_name text NOT NULL,
  message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id),
  CHECK (from_id <> to_id)
);
CREATE INDEX IF NOT EXISTS ilchon_requests_to ON ilchon_requests(to_id);
-- Both directions, each with the name that side gave the other.
CREATE TABLE IF NOT EXISTS ilchons (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  since timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, friend_id)
);
