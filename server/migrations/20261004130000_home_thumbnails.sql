-- The picture an island's link preview shows (src/share.rs): a stored 1200x630 JPEG, or the site's own when unset.
ALTER TABLE homes ADD COLUMN IF NOT EXISTS thumbnail_url text
  CHECK (thumbnail_url IS NULL OR thumbnail_url ~ '^/models/[0-9a-f]{64}\.jpg$');
