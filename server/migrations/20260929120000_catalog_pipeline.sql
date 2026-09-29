-- Copies from the character server run in the background: each import records its step, progress, error and a report
-- of every check it made, so the admin page can follow it and a restart can tell which ones it cut short.
CREATE TABLE IF NOT EXISTS catalog_imports (
  id uuid PRIMARY KEY,
  item_id text NOT NULL,
  kind text NOT NULL,
  label text NOT NULL,
  emoji text NOT NULL,
  factory_job_id text NOT NULL,
  character_id text,
  -- Whether the item already existed when the import was queued: an update, not a new item.
  replaces boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  step text NOT NULL DEFAULT 'queued',
  progress smallint NOT NULL DEFAULT 0,
  detail text,
  error_code text,
  error_message text,
  report jsonb,
  version_id bigint,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS catalog_imports_created ON catalog_imports (created_at DESC);
-- One import at a time per catalog item.
CREATE UNIQUE INDEX IF NOT EXISTS catalog_imports_active_item ON catalog_imports (item_id) WHERE status IN ('queued', 'running');

-- Every model a catalog item has shown. Stored files are named by their hash and never deleted, so a rollback can put
-- any of them back.
CREATE TABLE IF NOT EXISTS catalog_versions (
  id bigserial PRIMARY KEY,
  item_id text NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  model_url text NOT NULL,
  thumbnail_url text,
  clips text[] NOT NULL DEFAULT '{}',
  source_ref text,
  character_id text,
  stage text,
  report jsonb,
  import_id uuid REFERENCES catalog_imports(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS catalog_versions_item ON catalog_versions (item_id, id DESC);

-- The character a studio item copies (a remade job of the same character updates the same item) and the version the
-- item shows now.
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS character_id text;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS version_id bigint REFERENCES catalog_versions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS catalog_items_character ON catalog_items (character_id) WHERE character_id IS NOT NULL;

-- Items copied before versions were kept start their history with the model they hold.
INSERT INTO catalog_versions (item_id, model_url, thumbnail_url, clips, source_ref, created_at)
SELECT i.id, i.model_url, i.thumbnail_url, i.clips, i.source_ref, i.updated_at FROM catalog_items i
WHERE i.source = 'factory' AND i.version_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM catalog_versions v WHERE v.item_id = i.id);
UPDATE catalog_items i SET version_id = (SELECT max(v.id) FROM catalog_versions v WHERE v.item_id = i.id)
WHERE i.source = 'factory' AND i.version_id IS NULL;
