"""Fails when a migration does more than add.

Both services apply their migrations while, or just before, the previous release still runs: the studio migrates
before it stops the running container (backend/infra/deploy-on-instance.sh), and a server that fails its health check
goes back to the previous binary on the migrated database (server/scripts/deploy-rust-server.py). So a migration may
create and add, never take away or tighten what the previous release reads and writes: no DROP, RENAME, DELETE or
TRUNCATE, no REVOKE or SET SCHEMA, no column type change or SET NOT NULL, no new NOT NULL column without a default, no
new CHECK, UNIQUE, PRIMARY KEY, FOREIGN KEY or EXCLUDE constraint and no new unique index on a table the file does not
create itself (a table created in the same file is new to the previous release). Neither may it add a trigger, a row
security policy or row level security to such a table, or switch one of its triggers on or off: each can refuse or
change the previous release's writes. A new column whose filling rewrites the whole table under its lock (a volatile
DEFAULT such as gen_random_uuid() or clock_timestamp(), serial, identity or generated columns) stops the previous release
on that table until it is done; add the column without it and fill it in batches. Data that must go goes in a later
release, once no running release reads it.

An index built without CONCURRENTLY on one of the tables that grow with use (GROWING) holds their writes until it is
built: a warning, not a failure (build it by hand with CREATE INDEX CONCURRENTLY first, and the file's IF NOT EXISTS
skips it; the server's migrator also takes a file of its own that starts with `-- no-transaction`).

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
    (re.compile(r'(^|;)\s*REVOKE\b', re.I), 'REVOKE'),
    (re.compile(r'\bSET\s+SCHEMA\b', re.I), 'SET SCHEMA'),
    (re.compile(r'\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b', re.I), 'a column type change'),
    (re.compile(r'\bSET\s+NOT\s+NULL\b', re.I), 'SET NOT NULL'),
)
NAME = r'(?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))*'
CREATED_TABLE = re.compile(r'\bCREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+'
                           rf'(?:IF\s+NOT\s+EXISTS\s+)?(?P<table>{NAME})', re.I)
UNIQUE_INDEX = re.compile(r'\bCREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?'
                          rf'(?:{NAME}\s+)?ON\s+(?:ONLY\s+)?(?P<table>{NAME})', re.I)
ALTER_TABLE = re.compile(rf'\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?P<table>{NAME})(?P<body>[^;]*)', re.I)
# An ALTER TABLE clause that adds a constraint, named or not, and the kind it adds.
ADD_CONSTRAINT = re.compile(rf'^ADD\s+(?:CONSTRAINT\s+{NAME}\s+)?(?P<kind>CHECK|UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|EXCLUDE)\b',
                            re.I)
# One that adds a column: COLUMN may be left out.
ADD_COLUMN = re.compile(r'^ADD\s+(?!CONSTRAINT\b)', re.I)
# ALTER TABLE clauses that change who may read or write the table's rows, and how.
ROW_SECURITY = re.compile(r'^(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY\b', re.I)
TRIGGER_SWITCH = re.compile(r'^(?:ENABLE(?:\s+(?:ALWAYS|REPLICA))?|DISABLE)\s+TRIGGER\b', re.I)
TRIGGER = re.compile(rf'\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+{NAME}\s+(?:BEFORE|AFTER|INSTEAD\s+OF)\b'
                     rf'[^;]*?\bON\s+(?:ONLY\s+)?(?P<table>{NAME})', re.I)
POLICY = re.compile(rf'\b(?:CREATE|ALTER)\s+POLICY\s+{NAME}\s+ON\s+(?P<table>{NAME})', re.I)
# What a new column of an existing table fills every row with by rewriting the table: a volatile default (now() and
# the other stable ones are evaluated once and stored, no rewrite), a sequence, an identity or a generated column.
REWRITE = re.compile(r'\bDEFAULT\b[\s\S]*?\b(?:random|gen_random_uuid|uuid_generate_v1(?:mc)?|uuid_generate_v4|uuidv4|'
                     r'uuidv7|clock_timestamp|timeofday|nextval)\s*\(|\b(?:small|big)?serial[248]?\b|\bGENERATED\b', re.I)
INDEX = re.compile(r'\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?P<concurrently>CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?'
                   rf'(?:{NAME}\s+)?ON\s+(?:ONLY\s+)?(?P<table>{NAME})', re.I)
# The tables that grow with use (members, islands, their visits and posts, requests, records); the others hold settings
# and catalogs of a few hundred rows.
GROWING = {'users', 'sessions', 'login_devices', 'homes', 'home_worlds', 'home_visits', 'guestbook_entries', 'ilchons',
           'ilchon_requests', 'factory_requests', 'user_looks', 'auth_audit', 'catalog_versions', 'records'}
# Files up to these names were applied or reviewed before the index warning existed; their index builds ran on small
# tables and are not warned about again in every run.
LOCKS_REVIEWED_THROUGH = {'server/migrations': '20261006100000_audit_boundaries.sql',
                          'backend/migrations': '003_character_records.up.sql'}


def statements(sql):
    """The SQL without comments and string literals (their text is not SQL: 'DELETE' in a trigger function)."""
    sql = re.sub(r'--[^\n]*', ' ', sql)
    sql = re.sub(r'/\*.*?\*/', ' ', sql, flags=re.S)
    return re.sub(r"'(?:[^']|'')*'", "''", sql)


def table_name(name):
    """A table as the rules compare it: without its schema and quotes, in lower case."""
    return name.rsplit('.', 1)[-1].strip('"').lower()


def clauses(body):
    """The comma-separated clauses of an ALTER TABLE, split at depth zero only (numeric(10,2) is one type)."""
    parts, depth, start = [], 0, 0
    for at, character in enumerate(body):
        if character == '(':
            depth += 1
        elif character == ')':
            depth -= 1
        elif character == ',' and depth == 0:
            parts.append(body[start:at])
            start = at + 1
    parts.append(body[start:])
    return [part.strip() for part in parts if part.strip()]


def created_tables(text):
    return {table_name(match.group('table')) for match in CREATED_TABLE.finditer(text)}


def problems(sql):
    text = statements(sql)
    found = [what for rule, what in RULES if rule.search(text)]
    created = created_tables(text)
    for match in UNIQUE_INDEX.finditer(text):
        if table_name(match.group('table')) not in created:
            found.append('a new unique index')
    for match in TRIGGER.finditer(text):
        if table_name(match.group('table')) not in created:
            found.append('a new trigger on a table the previous release writes')
    for match in POLICY.finditer(text):
        if table_name(match.group('table')) not in created:
            found.append('a row security policy on a table the previous release reads')
    for match in ALTER_TABLE.finditer(text):
        if table_name(match.group('table')) in created:
            continue
        for clause in clauses(match.group('body')):
            constraint = ADD_CONSTRAINT.match(clause)
            if constraint:
                found.append(f"a new {' '.join(constraint.group('kind').upper().split())} constraint")
            elif ROW_SECURITY.match(clause):
                found.append('row level security on a table the previous release reads')
            elif TRIGGER_SWITCH.match(clause):
                found.append('a trigger switched on or off')
            elif ADD_COLUMN.match(clause):
                if re.search(r'\bNOT\s+NULL\b', clause, re.I) and not re.search(r'\bDEFAULT\b', clause, re.I):
                    found.append('a NOT NULL column without a default')
                if REWRITE.search(clause):
                    found.append('a new column that rewrites the table (volatile DEFAULT, serial, identity or generated)')
    return found


def cautions(sql):
    """What a migration may do but should not do unawares: build an index on a growing table without CONCURRENTLY."""
    text = statements(sql)
    created = created_tables(text)
    found = []
    for match in INDEX.finditer(text):
        table = table_name(match.group('table'))
        if table in GROWING and table not in created and not match.group('concurrently'):
            found.append(f'CREATE INDEX on {table} without CONCURRENTLY holds its writes until the index is built; '
                         'on a big table build it by hand first with CREATE INDEX CONCURRENTLY')
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


def warnings(folders, root=ROOT, reviewed=None):
    reviewed = LOCKS_REVIEWED_THROUGH if reviewed is None else reviewed
    found = []
    for folder in folders:
        for path in sorted((root / folder).glob('*.sql')):
            if path.name.endswith('.down.sql') or path.name <= reviewed.get(Path(folder).as_posix(), ''):
                continue
            name = path.relative_to(root).as_posix()
            found += [f'{name}: {what}' for what in cautions(path.read_text(encoding='utf-8'))]
    return found


def main(argv=None):
    folders = (argv if argv is not None else sys.argv[1:]) or FOLDERS
    failures = check(folders)
    for failure in failures:
        print(f'::error::{failure}. Migrations only add (see .github/scripts/check_migrations.py)')
    for warning in warnings(folders):
        print(f'::warning::{warning}')
    if not failures:
        print('Every migration only adds')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
