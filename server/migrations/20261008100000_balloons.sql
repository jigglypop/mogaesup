-- The speech balloon a member talks in on every island (src/homes.rs `BALLOONS`, the app's
-- frontend/src/minihome/balloons/designs.json). The server checks a change against its list, so a new design needs no
-- migration: the column keeps only the shape of an id.
ALTER TABLE homes ADD COLUMN IF NOT EXISTS balloon text NOT NULL DEFAULT 'glass' CHECK (balloon ~ '^[a-z][a-z0-9-]{0,31}$');
