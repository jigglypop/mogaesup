CREATE TABLE IF NOT EXISTS catalog_items (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('minime', 'furniture')),
  label text NOT NULL,
  emoji text NOT NULL,
  model_url text NOT NULL,
  source text NOT NULL DEFAULT 'builtin' CHECK (source IN ('builtin', 'factory')),
  source_ref text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  sort_order integer NOT NULL DEFAULT 100,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS catalog_items_published ON catalog_items(kind, sort_order) WHERE status = 'published';
-- The 1.7m adults that ship with gaesup-world, each with idle, walk and run clips.
INSERT INTO catalog_items (id, kind, label, emoji, model_url, status, sort_order) VALUES
  ('man', 'minime', '청년', '🧑', '/gltf/man.glb', 'published', 10),
  ('teacher', 'minime', '선생님', '👩‍🏫', '/gltf/teacher.glb', 'published', 20),
  ('nurse', 'minime', '간호사', '👩‍⚕️', '/gltf/nurse.glb', 'published', 30),
  ('docter', 'minime', '의사', '👨‍⚕️', '/gltf/docter.glb', 'published', 40),
  ('police', 'minime', '경찰', '👮', '/gltf/police.glb', 'published', 50),
  ('mountain', 'minime', '산악인', '🧗', '/gltf/mountain.glb', 'published', 60),
  ('trainer_green', 'minime', '초록 트레이너', '🧢', '/gltf/trainer_green.glb', 'published', 70),
  ('trainer_red', 'minime', '빨강 트레이너', '🎒', '/gltf/trainer_red.glb', 'published', 80)
ON CONFLICT (id) DO NOTHING;
