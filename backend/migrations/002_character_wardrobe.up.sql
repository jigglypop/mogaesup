-- Additive: separate namespace; does not modify world tables or existing data.
BEGIN;
CREATE SCHEMA IF NOT EXISTS gaesup_character;
CREATE TABLE IF NOT EXISTS gaesup_character.characters (
    id text PRIMARY KEY,
    owner_id bigint NOT NULL,
    name text NOT NULL,
    height_meters double precision CHECK (height_meters BETWEEN 0.1 AND 100),
    registry jsonb NOT NULL,
    control jsonb NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS character_owner_idx ON gaesup_character.characters(owner_id);
CREATE TABLE IF NOT EXISTS gaesup_character.asset_versions (
    character_id text NOT NULL REFERENCES gaesup_character.characters(id),
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    kind text NOT NULL,
    storage_key text NOT NULL,
    byte_size bigint NOT NULL CHECK (byte_size >= 0),
    rig_origin text NOT NULL,
    source_sha256 text,
    metadata jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (character_id, sha256)
);
CREATE TABLE IF NOT EXISTS gaesup_character.operations (
    id text PRIMARY KEY,
    character_id text NOT NULL REFERENCES gaesup_character.characters(id),
    action_id text NOT NULL,
    status text NOT NULL,
    input_sha256 text,
    input_fingerprint text NOT NULL,
    receipt jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS character_operation_status_idx ON gaesup_character.operations(character_id, status);
CREATE TABLE IF NOT EXISTS gaesup_character.provider_tasks (
    character_id text NOT NULL REFERENCES gaesup_character.characters(id),
    stage text NOT NULL,
    provider_task_id text,
    status text NOT NULL,
    action_id integer,
    rig_task_id text,
    consumed_credits integer,
    snapshot jsonb NOT NULL,
    PRIMARY KEY(character_id, stage)
);
CREATE INDEX IF NOT EXISTS character_provider_task_idx ON gaesup_character.provider_tasks(provider_task_id);
CREATE TABLE IF NOT EXISTS gaesup_character.parts (
    character_id text NOT NULL,
    model_sha256 text NOT NULL,
    node_index integer NOT NULL CHECK (node_index >= 0),
    role text NOT NULL CHECK (role IN ('body','head','hair','hat','top','pants','skirt','dress','shoes','outfit_base','accessory','eyes','other')),
    body_coverage text NOT NULL CHECK (body_coverage IN ('full','partial','unknown')),
    metadata jsonb NOT NULL,
    PRIMARY KEY(character_id, model_sha256, node_index),
    FOREIGN KEY(character_id, model_sha256) REFERENCES gaesup_character.asset_versions(character_id, sha256)
);
CREATE TABLE IF NOT EXISTS gaesup_character.animation_clips (
    character_id text NOT NULL,
    model_sha256 text NOT NULL,
    slot text NOT NULL CHECK (slot IN ('idle','walk','run','jump','fall')),
    clip_sha256 text NOT NULL,
    provider_task_id text NOT NULL,
    action_id integer,
    source_kind text NOT NULL,
    PRIMARY KEY(character_id, model_sha256, slot),
    FOREIGN KEY(character_id, model_sha256) REFERENCES gaesup_character.asset_versions(character_id, sha256)
);
CREATE TABLE IF NOT EXISTS gaesup_character.reviews (
    operation_id text PRIMARY KEY REFERENCES gaesup_character.operations(id),
    character_id text NOT NULL,
    model_sha256 text NOT NULL,
    reviewer_id bigint NOT NULL,
    decision text NOT NULL CHECK (decision IN ('approved','changes_requested')),
    evidence jsonb NOT NULL,
    reviewed_at timestamptz NOT NULL,
    FOREIGN KEY(character_id, model_sha256) REFERENCES gaesup_character.asset_versions(character_id, sha256)
);
COMMIT;
