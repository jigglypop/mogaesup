"""Fails when a migration does more than add.

Both services apply their migrations while, or just before, the previous release still runs: the studio migrates
before it stops the running container (backend/infra/deploy-on-instance.sh), and a server that fails its health check
goes back to the previous binary on the migrated database (server/scripts/deploy-rust-server.py). So a migration may
create and add, never take away or tighten what the previous release reads and writes: no DROP, RENAME, DELETE or
TRUNCATE, no column type change or SET NOT NULL, no new NOT NULL column without a default, no new CHECK constraint.
Data that must go goes in a later release, once no running release reads it.

    python3 .github/scripts/check_migrations.py [folder ...]     (default: server/migrations backend/migrations)

Files applied before this check existed are listed in ALLOWED with their sha256 (an applied migration never changes).
Down migrations (*.down.sql) are never applied by a deploy and are not checked.
"""
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FOLDERS = ('server/migrations', 'backend/migrations')
ALLOWED = {
    # Replaced the catalog kind constraint and removed the builtin minime rows the residents replaced.
    'server/migrations/20260930160000_residents_looks.sql':
        '5c4bfa5a82e347559ae93f0e2242885052040790df1f88c27289fab9b087e52b',
    # Drops its own trigger before creating it again (CREATE OR REPLACE TRIGGER needs PostgreSQL 14).
    'backend/migrations/003_character_records.up.sql':
        'c2b8f212f62e9d56db0abf1371e691e6794a4e1a77bce008a7121e966e1e67cd',
}
RULES = (
    (re.compile(r'\bDROP\b', re.I), 'DROP'),
    (re.compile(r'\bRENAME\b', re.I), 'RENAME'),
    (re.compile(r'\bDELETE\s+FROM\b', re.I), 'DELETE FROM'),
    (re.compile(r'(^|;)\s*TRUNCATE\b', re.I), 'TRUNCATE'),
    (re.compile(r'\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b', re.I), 'a column type change'),
    (re.compile(r'\bSET\s+NOT\s+NULL\b', re.I), 'SET NOT NULL'),
    (re.compile(r'\bADD\s+(CONSTRAINT\s+\S+\s+)?CHECK\b', re.I), 'a new CHECK constraint'),
)
# ADD COLUMN ... NOT NULL without a DEFAULT in the same clause (up to the next comma or semicolon at depth zero).
ADD_COLUMN = re.compile(r'\bADD\s+COLUMN\b(?P<clause>[^,;]*)', re.I)


def statements(sql):
    """The SQL without comments and string literals (their text is not SQL: 'DELETE' in a trigger function)."""
    sql = re.sub(r'--[^\n]*', ' ', sql)
    sql = re.sub(r'/\*.*?\*/', ' ', sql, flags=re.S)
    return re.sub(r"'(?:[^']|'')*'", "''", sql)


def problems(sql):
    text = statements(sql)
    found = [what for rule, what in RULES if rule.search(text)]
    for match in ADD_COLUMN.finditer(text):
        clause = match.group('clause')
        if re.search(r'\bNOT\s+NULL\b', clause, re.I) and not re.search(r'\bDEFAULT\b', clause, re.I):
            found.append('a NOT NULL column without a default')
    return found


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check(folders, root=ROOT, allowed=None):
    allowed = ALLOWED if allowed is None else allowed
    failures = []
    for folder in folders:
        for path in sorted((root / folder).glob('*.sql')):
            if path.name.endswith('.down.sql'):
                continue
            name = path.relative_to(root).as_posix()
            if name in allowed:
                if digest(path) != allowed[name]:
                    failures.append(f'{name}: an applied migration changed; put the change in a new file')
                continue
            failures += [f'{name}: {what}' for what in problems(path.read_text(encoding='utf-8'))]
    return failures


def main(argv=None):
    folders = (argv if argv is not None else sys.argv[1:]) or FOLDERS
    failures = check(folders)
    for failure in failures:
        print(f'::error::{failure}. Migrations only add (see .github/scripts/check_migrations.py)')
    if not failures:
        print('Every migration only adds')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
