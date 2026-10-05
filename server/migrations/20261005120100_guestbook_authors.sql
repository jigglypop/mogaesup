-- One writer's entries in one guestbook: counted against the writer's caps there, and removed together by the owner
-- (src/social.rs).
CREATE INDEX IF NOT EXISTS guestbook_author ON guestbook_entries (home_owner_id, author_id, created_at);
