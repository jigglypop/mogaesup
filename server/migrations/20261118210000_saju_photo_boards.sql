-- A home's current photo. The checked, re-encoded JPEG is served through home visibility checks.
CREATE TABLE saju_photo_boards (
    owner_id uuid PRIMARY KEY REFERENCES saju_homes(owner_id) ON DELETE CASCADE,
    version uuid NOT NULL,
    width integer NOT NULL CHECK (width BETWEEN 1 AND 1280),
    height integer NOT NULL CHECK (height BETWEEN 1 AND 1280),
    jpeg bytea NOT NULL
);
