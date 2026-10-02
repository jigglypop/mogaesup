-- Administrator names cannot be taken through public registration. Existing accounts and grants are preserved;
-- bootstrap verifies their password before granting anything. Legacy migration ownership is checked at startup.
CREATE TABLE IF NOT EXISTS auth_reserved_usernames (
  username text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO auth_reserved_usernames (username) VALUES ('ydh2244') ON CONFLICT DO NOTHING;
