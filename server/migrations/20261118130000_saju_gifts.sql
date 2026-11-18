-- A keepsake from two birth charts. Retrying delivery of that pair's keepsake is idempotent.
CREATE TABLE saju_gifts (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    giver_id uuid REFERENCES users(id) ON DELETE SET NULL,
    pair_key bytea NOT NULL,
    tone text NOT NULL CHECK (tone IN ('union', 'flow', 'same', 'spark')),
    from_element text NOT NULL CHECK (from_element IN ('wood', 'fire', 'earth', 'metal', 'water')),
    to_element text NOT NULL CHECK (to_element IN ('wood', 'fire', 'earth', 'metal', 'water')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, giver_id, pair_key)
);
CREATE INDEX saju_gifts_inventory ON saju_gifts (owner_id, created_at DESC);
