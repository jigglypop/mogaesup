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
                    "CREATE OR REPLACE TRIGGER t BEFORE UPDATE OR DELETE ON a FOR EACH ROW EXECUTE FUNCTION f();\n"
                    "CREATE OR REPLACE TRIGGER u BEFORE TRUNCATE ON a EXECUTE FUNCTION g();",
                    "-- DROP TABLE a; is only a comment\nSELECT 1;"):
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
                          ("ALTER TABLE a ADD COLUMN owner uuid NOT NULL;", 'a NOT NULL column without a default')):
            with self.subTest(sql=sql):
                self.assertIn(what, self.check.problems(sql))

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
