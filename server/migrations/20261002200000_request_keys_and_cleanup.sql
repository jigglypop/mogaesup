-- A paid studio request sent again with the same Idempotency-Key starts nothing new on the character server, so the
-- monthly budget counts such replays once (src/factory.rs).
ALTER TABLE factory_requests ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE INDEX IF NOT EXISTS factory_requests_paid_key ON factory_requests (path, idempotency_key)
  WHERE paid AND idempotency_key IS NOT NULL;
-- The periodic cleanup deletes guestbook entries removed a month ago; this keeps it from reading the whole table.
CREATE INDEX IF NOT EXISTS guestbook_deleted ON guestbook_entries (deleted_at) WHERE deleted_at IS NOT NULL;
