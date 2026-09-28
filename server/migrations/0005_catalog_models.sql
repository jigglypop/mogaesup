-- Catalog models copied from the character server keep a picture and the clips gaesup-world can play.
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS thumbnail_url text;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS clips text[] NOT NULL DEFAULT '{}';
