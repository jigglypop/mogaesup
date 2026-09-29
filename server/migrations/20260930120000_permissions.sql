-- Relationship-based access (after Google's Zanzibar): `object#relation@subject`, where the subject is one user or
-- every member of a group (`group:<id>#member`). Only explicit grants are stored here; what other tables already hold
-- (a home's owner, its visibility, 일촌) is read from them at check time. Types, relations and how they imply each
-- other are in src/rebac.rs.
CREATE TABLE IF NOT EXISTS auth_tuples (
  object_type text NOT NULL CHECK (object_type ~ '^[a-z][a-z_]{0,31}$'),
  object_id text NOT NULL CHECK (object_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  relation text NOT NULL CHECK (relation ~ '^[a-z][a-z_]{0,31}$'),
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  subject_relation text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_tuples_key
    UNIQUE NULLS NOT DISTINCT (object_type, object_id, relation, subject_type, subject_id, subject_relation),
  -- A user is named by id; a set of users is a group's members.
  CONSTRAINT auth_tuples_subject CHECK (
    (subject_type = 'user' AND subject_relation IS NULL
      AND subject_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR (subject_type = 'group' AND subject_relation = 'member' AND subject_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$')
  )
);
-- Checks read by object (the unique key's prefix); the admin page also reads by subject.
CREATE INDEX IF NOT EXISTS auth_tuples_by_subject ON auth_tuples (subject_type, subject_id, subject_relation);

-- Every grant and revoke. Rows are never changed or removed; the actor is kept by id and name so a row outlives the
-- account, and changes the server makes itself name `migration` or `bootstrap`.
CREATE TABLE IF NOT EXISTS auth_audit (
  id bigserial PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('grant', 'revoke')),
  object_type text NOT NULL,
  object_id text NOT NULL,
  relation text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  subject_relation text,
  actor_id uuid,
  actor text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_audit_subject ON auth_audit (subject_type, subject_id, id DESC);
CREATE INDEX IF NOT EXISTS auth_audit_object ON auth_audit (object_type, object_id, id DESC);

CREATE OR REPLACE FUNCTION auth_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'auth_audit is append-only';
END
$$;
CREATE OR REPLACE TRIGGER auth_audit_append_only BEFORE UPDATE OR DELETE ON auth_audit
  FOR EACH ROW EXECUTE FUNCTION auth_audit_append_only();
CREATE OR REPLACE TRIGGER auth_audit_no_truncate BEFORE TRUNCATE ON auth_audit
  FOR EACH STATEMENT EXECUTE FUNCTION auth_audit_append_only();

-- Releases before this one read users.role. It follows the admin tuples, so rolling back the binary keeps the admins
-- this release granted and drops the ones it revoked. Nothing in this release reads it.
CREATE OR REPLACE FUNCTION auth_tuples_mirror_admin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  changed auth_tuples;
BEGIN
  IF TG_OP = 'DELETE' THEN
    changed := OLD;
  ELSE
    changed := NEW;
  END IF;
  IF changed.object_type = 'system' AND changed.object_id = 'mogaesup' AND changed.relation = 'admin'
     AND changed.subject_type = 'user' THEN
    UPDATE users SET role = CASE WHEN TG_OP = 'DELETE' THEN 'user' ELSE 'admin' END
    WHERE id = changed.subject_id::uuid;
  END IF;
  RETURN NULL;
END
$$;
CREATE OR REPLACE TRIGGER auth_tuples_mirror_admin AFTER INSERT OR DELETE ON auth_tuples
  FOR EACH ROW EXECUTE FUNCTION auth_tuples_mirror_admin();

-- Admins so far were users.role = 'admin'; they hold system:mogaesup#admin now.
WITH granted AS (
  INSERT INTO auth_tuples (object_type, object_id, relation, subject_type, subject_id)
  SELECT 'system', 'mogaesup', 'admin', 'user', id::text FROM users WHERE role = 'admin'
  ON CONFLICT DO NOTHING
  RETURNING subject_id
)
INSERT INTO auth_audit (action, object_type, object_id, relation, subject_type, subject_id, actor, reason)
SELECT 'grant', 'system', 'mogaesup', 'admin', 'user', subject_id, 'migration', '기존 관리자(users.role) 이전'
FROM granted;

-- The owner's account is an admin whenever it already exists; later, BOOTSTRAP_ADMIN_USERNAME or another admin grants it.
WITH granted AS (
  INSERT INTO auth_tuples (object_type, object_id, relation, subject_type, subject_id)
  SELECT 'system', 'mogaesup', 'admin', 'user', id::text FROM users WHERE username = 'ydh2244'
  ON CONFLICT DO NOTHING
  RETURNING subject_id
)
INSERT INTO auth_audit (action, object_type, object_id, relation, subject_type, subject_id, actor, reason)
SELECT 'grant', 'system', 'mogaesup', 'admin', 'user', subject_id, 'migration', '소유자 계정 ydh2244 관리자 지정'
FROM granted;
