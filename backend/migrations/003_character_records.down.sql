-- Non-destructive rollback: stop the character server and unset CHARACTER_DATABASE_URL first (records written
-- since the switch are only here; `uv run python -m src.records export --prefix <prefix>` copies them back to S3).
-- The schema is renamed, never dropped.
ALTER SCHEMA character_records RENAME TO character_records_003_archive;
