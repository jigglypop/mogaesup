-- A member's profile picture: a stored square JPEG's site path (/models/...), shown on their 섬. None until they
-- choose one.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text;
