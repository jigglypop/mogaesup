-- Every studio request that changes something on the character server, and whether it could cost money.
CREATE TABLE IF NOT EXISTS factory_requests (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  method text NOT NULL,
  path text NOT NULL,
  paid boolean NOT NULL,
  status smallint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS factory_requests_paid_created ON factory_requests (created_at) WHERE paid;
