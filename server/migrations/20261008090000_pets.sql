-- Dogs members keep on their islands (src/pets.rs). A breed is a dog model anyone may adopt: the ones the app ships
-- (frontend/public/gltf/pets, made by frontend/scripts/pets-normalize.mjs and listed in frontend/src/pets/breeds.json)
-- and the ones the catalog's editors add. Each member keeps one pet, with the readout its training changed (`brain`,
-- the `pet-brain-v1` bytes), how it feels (`drives`) and its training counts (`stats`); the server stores them and never
-- runs the brain. `revision` rises with every brain save, so two pages cannot save over each other.
CREATE TABLE IF NOT EXISTS pet_breeds (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  species text NOT NULL DEFAULT 'dog' CHECK (species IN ('dog')),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  emoji text NOT NULL DEFAULT '🐶',
  model_url text NOT NULL,
  thumbnail_url text,
  clips text[] NOT NULL DEFAULT '{}',
  -- Metres from the ground to the top of the ears in the first frame of idle: the engine template's height.
  height_m real NOT NULL DEFAULT 0.55 CHECK (height_m BETWEEN 0.1 AND 3),
  source text NOT NULL DEFAULT 'factory' CHECK (source IN ('builtin', 'factory')),
  source_ref text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pet_breeds_published ON pet_breeds (sort_order) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS pets (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  breed_id text NOT NULL REFERENCES pet_breeds(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 12),
  -- Where it rests while its owner is away, on the island's ground.
  home_x real NOT NULL DEFAULT 0 CHECK (abs(home_x) <= 200),
  home_z real NOT NULL DEFAULT 0 CHECK (abs(home_z) <= 200),
  seed bigint NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
  brain_model text NOT NULL DEFAULT 'pet-brain-v1',
  graph_id text NOT NULL,
  brain bytea CHECK (brain IS NULL OR octet_length(brain) <= 16384),
  drives jsonb NOT NULL DEFAULT '{}',
  stats jsonb NOT NULL DEFAULT '{}',
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- When the brain, drives and stats were last saved (the adoption until then): the time the drives are as of.
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pets_breed ON pets (breed_id);

-- The dogs the app ships, published, in the studio's order. A row only goes in once, so what editors change (name,
-- order, status) stays.
INSERT INTO pet_breeds (id, label, model_url, thumbnail_url, clips, height_m, source, source_ref, status, sort_order) VALUES
  ('golden-retriever', '골든리트리버', '/gltf/pets/golden-retriever.glb', '/gltf/pets/golden-retriever.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:c0105e174869ed6f38b56085', 'published', 1),
  ('bichon-frise', '비숑프리제', '/gltf/pets/bichon-frise.glb', '/gltf/pets/bichon-frise.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:91094f742dbb388fb05f5e44', 'published', 2),
  ('poodle', '푸들', '/gltf/pets/poodle.glb', '/gltf/pets/poodle.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:a69572dde678a32079af6302', 'published', 3),
  ('welsh-corgi', '웰시코기', '/gltf/pets/welsh-corgi.glb', '/gltf/pets/welsh-corgi.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:0fe21567b168507ffc299c2c', 'published', 4),
  ('samoyed', '사모예드', '/gltf/pets/samoyed.glb', '/gltf/pets/samoyed.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:8d0d57b90dd2abb3bb87507b', 'published', 5),
  ('siberian-husky', '시베리안허스키', '/gltf/pets/siberian-husky.glb', '/gltf/pets/siberian-husky.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:147207a1a4da0fbe68ba4623', 'published', 6),
  ('shiba-inu', '시바견', '/gltf/pets/shiba-inu.glb', '/gltf/pets/shiba-inu.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:fa357047d711d0f6328e2f32', 'published', 7),
  ('dachshund', '닥스훈트', '/gltf/pets/dachshund.glb', '/gltf/pets/dachshund.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:fd0ec825ccedc6e7bac18286', 'published', 8),
  ('maltese', '말티즈', '/gltf/pets/maltese.glb', '/gltf/pets/maltese.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:6394aa3fa72edf58217fcc4f', 'published', 9),
  ('french-bulldog', '프렌치불독', '/gltf/pets/french-bulldog.glb', '/gltf/pets/french-bulldog.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:171e47f9d22dec6dfffed9e0', 'published', 10),
  ('pug', '퍼그', '/gltf/pets/pug.glb', '/gltf/pets/pug.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:505cb0c57d1b44fe143418c1', 'published', 11),
  ('dalmatian', '달마시안', '/gltf/pets/dalmatian.glb', '/gltf/pets/dalmatian.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:2c8f11ce4dc9ac4d67a86a22', 'published', 12),
  ('pomeranian', '포메라니안', '/gltf/pets/pomeranian.glb', '/gltf/pets/pomeranian.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:ad7b816f3c345474c608b12e', 'published', 13),
  ('schnauzer', '슈나우저', '/gltf/pets/schnauzer.glb', '/gltf/pets/schnauzer.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:87dbcb6935256725e039a9f3', 'published', 14),
  ('cocker-spaniel', '코카스파니엘', '/gltf/pets/cocker-spaniel.glb', '/gltf/pets/cocker-spaniel.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:374cac242f065685aadf2692', 'published', 15),
  ('chihuahua', '치와와', '/gltf/pets/chihuahua.glb', '/gltf/pets/chihuahua.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:27b52a8779933beac02d9902', 'published', 17),
  ('border-collie', '보더콜리', '/gltf/pets/border-collie.glb', '/gltf/pets/border-collie.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:12eb94391cddc24dea7caf57', 'published', 18),
  ('papillon', '파피용', '/gltf/pets/papillon.glb', '/gltf/pets/papillon.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:e5e69ad0bc50a9d22716971a', 'published', 19),
  ('bulldog', '불독', '/gltf/pets/bulldog.glb', '/gltf/pets/bulldog.webp', '{bark,idle,jump,lie,run,sit,walk,sit_hold,lie_hold}', 0.55, 'builtin', 'animal:5393d5e7d3c29db9b9382035', 'published', 20)
ON CONFLICT (id) DO NOTHING;
