-- Character records (the JSON files the character server writes) in PostgreSQL; binary artifacts stay in S3.
-- Idempotent. Apply with: uv run python -m src.records migrate
CREATE SCHEMA IF NOT EXISTS character_records;

-- One row per storage prefix (ASSET_S3_PREFIX) whose records were imported. The server refuses the
-- records of a prefix without a row here instead of showing them as empty.
CREATE TABLE IF NOT EXISTS character_records.namespaces (
    prefix      text COLLATE "C" PRIMARY KEY,
    imported_at timestamptz NOT NULL,
    source      text NOT NULL
);

-- Keyed by the storage prefix and the path below the data root, e.g. avatar-factory/1/<job>/job.json.
-- `content` holds the exact bytes the server wrote (digests match the S3 objects they replace). A record
-- above 1 MiB keeps its bytes in S3 at `blob_key` (<prefix>/record-blobs/<sha256>.json) instead.
CREATE TABLE IF NOT EXISTS character_records.records (
    prefix          text COLLATE "C" NOT NULL,
    path            text COLLATE "C" NOT NULL,
    content         bytea,
    blob_key        text,
    doc             jsonb,
    size            bigint NOT NULL CHECK (size >= 0),
    sha256          text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    -- sha256 of the S3 object this row was last imported from; NULL for rows the server created.
    imported_sha256 text,
    version         bigint NOT NULL DEFAULT 1,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (prefix, path),
    CHECK ((content IS NULL) <> (blob_key IS NULL))
);

-- `doc` is the parsed record when its bytes are valid JSON, for queries; the bytes stay authoritative.
CREATE OR REPLACE FUNCTION character_records.try_jsonb(value bytea) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    RETURN convert_from(value, 'UTF8')::jsonb;
EXCEPTION WHEN others THEN
    RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION character_records.parse_doc() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.doc := CASE WHEN NEW.content IS NULL THEN NULL ELSE character_records.try_jsonb(NEW.content) END;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS records_parse_doc ON character_records.records;
CREATE TRIGGER records_parse_doc BEFORE INSERT OR UPDATE OF content ON character_records.records
    FOR EACH ROW EXECUTE FUNCTION character_records.parse_doc();

-- Production jobs (avatar-factory/<owner>/<job>/job.json).
CREATE OR REPLACE VIEW character_records.jobs AS
SELECT prefix,
       split_part(path, '/', 2) AS owner_id,
       split_part(path, '/', 3) AS job_id,
       doc ->> 'status' AS status,
       doc ->> 'created_at' AS created_at,
       updated_at,
       doc
FROM character_records.records
WHERE path LIKE 'avatar-factory/%/%/job.json' AND path NOT LIKE 'avatar-factory/%/%/%/%';
