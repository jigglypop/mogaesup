-- 주민 (NPCs) join the catalog: studio characters that stand on islands. They need a rig and an idle clip, not a walk.
ALTER TABLE catalog_items DROP CONSTRAINT IF EXISTS catalog_items_kind_check;
ALTER TABLE catalog_items ADD CONSTRAINT catalog_items_kind_check CHECK (kind IN ('minime', 'furniture', 'npc'));

-- The figures gaesup-world ships stood in as 미니미 before the studio made any. Only 'man' stays, as the fallback for
-- islands that have not picked one; islands wearing another take it, and their emoji when it came with the figure.
UPDATE homes h SET minime = 'man', emoji = CASE WHEN h.emoji = c.emoji THEN '🧑' ELSE h.emoji END
FROM catalog_items c
WHERE c.id = h.minime AND c.source = 'builtin' AND c.kind = 'minime' AND c.id <> 'man';
DELETE FROM catalog_items WHERE source = 'builtin' AND kind = 'minime' AND id <> 'man';
-- Studio characters come first in the picker; the fallback goes last unless an admin placed it.
UPDATE catalog_items SET sort_order = 1000 WHERE id = 'man' AND source = 'builtin' AND sort_order = 10;

-- A member's own character: a wardrobe body with studio parts, hair and garment colours. The server assembles it into
-- one GLB in the model store; `model_url` is the last one that finished, kept while a newer request is baking or after
-- one failed, and the island wears it while `worn` is on.
CREATE TABLE IF NOT EXISTS user_looks (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  request jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'baking' CHECK (status IN ('baking', 'ready', 'failed')),
  worn boolean NOT NULL DEFAULT false,
  model_url text,
  baked jsonb,
  error_code text,
  error_message text,
  report jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
