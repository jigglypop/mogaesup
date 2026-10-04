-- Every look save counts the looks baking under BAKING_LOCK (src/looks.rs); this keeps that count off the whole table.
CREATE INDEX IF NOT EXISTS user_looks_baking ON user_looks (updated_at) WHERE status = 'baking';
