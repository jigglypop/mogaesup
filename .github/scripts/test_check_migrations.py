"""check_migrations.py: what counts as a migration that only adds."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


def load():
    spec = importlib.util.spec_from_file_location('check_migrations', HERE / 'check_migrations.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Additive(unittest.TestCase):
    def setUp(self):
        self.check = load()

    def test_adding_passes(self):
        for sql in ("CREATE TABLE IF NOT EXISTS a (id bigint PRIMARY KEY, owner uuid REFERENCES users(id) ON DELETE CASCADE);",
                    "ALTER TABLE a ADD COLUMN IF NOT EXISTS note text;",
                    "ALTER TABLE a ADD COLUMN done boolean NOT NULL DEFAULT false, ADD COLUMN at timestamptz;",
                    "CREATE INDEX IF NOT EXISTS a_owner ON a (owner);",
                    "INSERT INTO a (id) VALUES (1) ON CONFLICT DO NOTHING; UPDATE a SET note = 'DROP me' WHERE id = 1;",
                    # Triggers, policies and row level security of a table the same file creates bind nothing old (and
                    # DELETE or TRUNCATE among a trigger's events is no DELETE FROM or TRUNCATE).
                    "CREATE TABLE IF NOT EXISTS a (id bigint);\n"
                    "CREATE OR REPLACE TRIGGER t BEFORE UPDATE OR DELETE ON a FOR EACH ROW EXECUTE FUNCTION f();\n"
                    "CREATE OR REPLACE TRIGGER u BEFORE TRUNCATE ON a EXECUTE FUNCTION g();\n"
                    "ALTER TABLE a ENABLE ROW LEVEL SECURITY; CREATE POLICY own ON a USING (id > 0);",
                    # now() is evaluated once and stored: no rewrite. A volatile default set on an existing column
                    # applies to new rows only.
                    "ALTER TABLE a ADD COLUMN seen timestamptz NOT NULL DEFAULT now();",
                    "ALTER TABLE a ALTER COLUMN id SET DEFAULT gen_random_uuid();",
                    "CREATE INDEX CONCURRENTLY IF NOT EXISTS a_note ON guestbook_entries (note);",
                    "-- DROP TABLE a; is only a comment\nSELECT 1;",
                    "ALTER TABLE a ADD COLUMN price numeric(10,2) NOT NULL DEFAULT 0, ADD note text;",
                    "ALTER TABLE a ADD COLUMN IF NOT EXISTS owner uuid REFERENCES users(id);",
                    # A table the same file creates is new to the previous release: its constraints bind nothing old.
                    "CREATE TABLE IF NOT EXISTS b (id bigint, owner uuid);\n"
                    "CREATE UNIQUE INDEX IF NOT EXISTS b_owner ON b (owner) WHERE owner IS NOT NULL;\n"
                    "ALTER TABLE b ADD CONSTRAINT b_pk PRIMARY KEY (id), ADD UNIQUE (owner), ADD note text NOT NULL;",
                    'CREATE TABLE "public"."C" (id int); ALTER TABLE ONLY public."C" ADD CONSTRAINT c_check CHECK (id > 0);',
                    "GRANT SELECT ON a TO reader;"):
            with self.subTest(sql=sql):
                self.assertEqual(self.check.problems(sql), [])

    def test_taking_away_or_tightening_fails(self):
        for sql, what in (("DROP TABLE a;", 'DROP'), ("ALTER TABLE a DROP COLUMN note;", 'DROP'),
                          ("ALTER TABLE a DROP CONSTRAINT IF EXISTS a_check;", 'DROP'),
                          ("ALTER TABLE a RENAME COLUMN note TO body;", 'RENAME'),
                          ("DELETE FROM a WHERE id = 1;", 'DELETE FROM'), ("TRUNCATE a;", 'TRUNCATE'),
                          ("ALTER TABLE a ALTER COLUMN note TYPE varchar(10);", 'a column type change'),
                          ("ALTER TABLE a ALTER COLUMN note SET NOT NULL;", 'SET NOT NULL'),
                          ("ALTER TABLE a ADD CONSTRAINT short CHECK (length(note) < 10);", 'a new CHECK constraint'),
                          ("ALTER TABLE a ADD COLUMN owner uuid NOT NULL;", 'a NOT NULL column without a default'),
                          # COLUMN is optional, and a type with a comma is one clause.
                          ("ALTER TABLE a ADD owner uuid NOT NULL;", 'a NOT NULL column without a default'),
                          ("ALTER TABLE a ADD COLUMN price numeric(10,2) NOT NULL;",
                           'a NOT NULL column without a default'),
                          ("ALTER TABLE a ADD COLUMN note text, ADD owner uuid NOT NULL;",
                           'a NOT NULL column without a default'),
                          ("ALTER TABLE a ADD CONSTRAINT a_note UNIQUE (note);", 'a new UNIQUE constraint'),
                          ("ALTER TABLE a ADD UNIQUE (note);", 'a new UNIQUE constraint'),
                          ("ALTER TABLE a ADD CONSTRAINT a_pk PRIMARY KEY (id);", 'a new PRIMARY KEY constraint'),
                          ("ALTER TABLE IF EXISTS a ADD CONSTRAINT a_owner FOREIGN KEY (owner) REFERENCES users(id) NOT VALID;",
                           'a new FOREIGN KEY constraint'),
                          ("ALTER TABLE a ADD CONSTRAINT a_span EXCLUDE USING gist (span WITH &&);",
                           'a new EXCLUDE constraint'),
                          ("CREATE UNIQUE INDEX IF NOT EXISTS a_note ON a (note);", 'a new unique index'),
                          ("CREATE UNIQUE INDEX CONCURRENTLY ON public.a (note);", 'a new unique index'),
                          # Another table created in the file does not cover this one.
                          ("CREATE TABLE b (id int); CREATE UNIQUE INDEX a_note ON a (note);", 'a new unique index'),
                          ("REVOKE SELECT ON a FROM reader;", 'REVOKE'),
                          ("ALTER TABLE a SET SCHEMA archive;", 'SET SCHEMA'),
                          # A trigger, a policy or row level security on a table the previous release writes can refuse
                          # or change its writes.
                          ("CREATE OR REPLACE TRIGGER t BEFORE UPDATE OR DELETE ON a FOR EACH ROW EXECUTE FUNCTION f();",
                           'a new trigger on a table the previous release writes'),
                          ("CREATE CONSTRAINT TRIGGER t AFTER INSERT ON public.a DEFERRABLE FOR EACH ROW EXECUTE FUNCTION f();",
                           'a new trigger on a table the previous release writes'),
                          ("CREATE TABLE b (id int); CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW EXECUTE FUNCTION f();",
                           'a new trigger on a table the previous release writes'),
                          ("CREATE POLICY own ON a USING (owner = current_user);",
                           'a row security policy on a table the previous release reads'),
                          ("ALTER POLICY own ON a USING (false);",
                           'a row security policy on a table the previous release reads'),
                          ("ALTER TABLE a ENABLE ROW LEVEL SECURITY;", 'row level security on a table the previous release reads'),
                          ("ALTER TABLE ONLY a FORCE ROW LEVEL SECURITY;",
                           'row level security on a table the previous release reads'),
                          ("ALTER TABLE a DISABLE TRIGGER auth_audit_append_only;", 'a trigger switched on or off'),
                          ("ALTER TABLE a ENABLE ALWAYS TRIGGER t;", 'a trigger switched on or off'),
                          # The whole table is rewritten under its lock while every row gets the new value.
                          ("ALTER TABLE a ADD COLUMN token uuid NOT NULL DEFAULT gen_random_uuid();",
                           'a new column that rewrites the table (volatile DEFAULT, serial, identity or generated)'),
                          ("ALTER TABLE a ADD COLUMN at timestamptz DEFAULT clock_timestamp();",
                           'a new column that rewrites the table (volatile DEFAULT, serial, identity or generated)'),
                          ("ALTER TABLE a ADD COLUMN n int DEFAULT coalesce(1, (random() * 10)::int);",
                           'a new column that rewrites the table (volatile DEFAULT, serial, identity or generated)'),
                          ("ALTER TABLE a ADD COLUMN number bigserial;",
                           'a new column that rewrites the table (volatile DEFAULT, serial, identity or generated)'),
                          ("ALTER TABLE a ADD id2 bigint GENERATED ALWAYS AS IDENTITY;",
                           'a new column that rewrites the table (volatile DEFAULT, serial, identity or generated)'),
                          ("ALTER TABLE a ADD COLUMN total numeric GENERATED ALWAYS AS (price * 2) STORED;",
                           'a new column that rewrites the table (volatile DEFAULT, serial, identity or generated)')):
            with self.subTest(sql=sql):
                self.assertIn(what, self.check.problems(sql))

    def test_an_index_on_a_growing_table_without_concurrently_is_a_warning(self):
        for sql in ("CREATE INDEX IF NOT EXISTS guestbook_note ON guestbook_entries (note);",
                    "CREATE UNIQUE INDEX sessions_x ON public.sessions (x);",
                    "CREATE INDEX ON character_records.records (prefix);"):
            with self.subTest(sql=sql):
                self.assertEqual(len(self.check.cautions(sql)), 1)
                self.assertIn('without CONCURRENTLY', self.check.cautions(sql)[0])
        for sql in ("CREATE INDEX CONCURRENTLY IF NOT EXISTS guestbook_note ON guestbook_entries (note);",
                    "CREATE INDEX IF NOT EXISTS catalog_items_kind ON catalog_items (kind);",
                    "CREATE TABLE users (id int); CREATE INDEX users_id ON users (id);"):
            with self.subTest(sql=sql):
                self.assertEqual(self.check.cautions(sql), [])

    def test_index_warnings_skip_the_files_reviewed_before_them(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'm').mkdir()
            sql = 'CREATE INDEX IF NOT EXISTS s ON sessions (user_id);\n'
            for name in ('001_old.sql', '002_new.sql', '003_x.down.sql'):
                (root / 'm' / name).write_text(sql, encoding='utf-8')
            (caution,) = self.check.cautions(sql)
            self.assertEqual(self.check.warnings(['m'], root=root, reviewed={'m': '001_old.sql'}),
                             [f'm/002_new.sql: {caution}'])
        # The repository's migrations so far were reviewed: no warning in every run.
        self.assertEqual(self.check.warnings(self.check.FOLDERS), [])

    def test_applied_files_are_allowed_only_unchanged_and_down_files_are_skipped(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'm').mkdir()
            (root / 'm/001_old.sql').write_text('DELETE FROM a;\n', encoding='utf-8')
            (root / 'm/002_new.sql').write_text('DROP TABLE b;\n', encoding='utf-8')
            (root / 'm/003_x.down.sql').write_text('DROP TABLE c;\n', encoding='utf-8')
            allowed = {'m/001_old.sql': self.check.digest(root / 'm/001_old.sql')}
            self.assertEqual(self.check.check(['m'], root=root, allowed=allowed), ['m/002_new.sql: DROP'])
            (root / 'm/001_old.sql').write_text('DELETE FROM a WHERE true;\n', encoding='utf-8')
            self.assertIn('m/001_old.sql: an applied migration changed; put the change in a new file',
                          self.check.check(['m'], root=root, allowed=allowed))

    def test_the_repository_migrations_only_add(self):
        self.assertEqual(self.check.check(self.check.FOLDERS), [])


if __name__ == '__main__':
    unittest.main()
