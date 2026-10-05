"""Character record database commands (CHARACTER_DATABASE_URL).

    uv run python -m src.records migrate
    uv run python -m src.records import --prefix assets --prefix mogaesup-props [--dry-run] [--delete-missing]
    uv run python -m src.records export --prefix assets [--dry-run] [--ignore-stale]
    uv run python -m src.records status [--prefix assets]

`import` copies the JSON records of the S3-mapped namespaces from ASSET_S3_BUCKET into the database. It
never writes to or deletes from those S3 keys, skips rows that are already identical, and never
overwrites a row the server changed since it was imported, not even one it changed while the import
ran; such differences are reported. Run it while the character server is stopped, then start the server
with CHARACTER_DATABASE_URL set. Last, it leaves the marker object <prefix>/.records-in-database: a server
without CHARACTER_DATABASE_URL refuses to start while the marker exists, instead of reading the S3 JSON
that is stale from now on.

`export` is the rollback aid: it writes the records created or changed in the database since their import
back to their S3 keys and removes the marker, so the server can run without CHARACTER_DATABASE_URL again. JSON
that S3 still holds for records deleted in the database would be read again by such a server, so while any is
left the marker stays (delete those objects, or pass --ignore-stale to accept them). Stop the character server
first: export refuses to run while one holds this data root's server guard, and it keeps the marker when any
record changed while it ran (a server elsewhere still writing), since S3 would then miss that write.

`migrate` applies each numbered file once. A file that changed after it was applied is refused: the change goes
into a new numbered file.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, field
from datetime import timedelta
import hashlib
import json
import os
import sys

from src.paths import BACKEND_ROOT, load_environment
from src.services.runtime_activity import running_task

NAMESPACES = ('avatar-factory', 'avatar-blueprints', 'characters')
MIGRATIONS = BACKEND_ROOT / 'migrations'
# An S3 LastModified has whole seconds on S3's clock and the last import's start comes from the database's clock, so
# an object written about when that import ran is read again and compared by content, never skipped by its time.
IMPORT_MARGIN = timedelta(minutes=15)


def _schema():
    from src.services.record_store import SCHEMA
    return SCHEMA


def create_database(url, out=print):
    """Create the URL's database on its server when missing (local development)."""
    import psycopg
    from psycopg import sql
    from psycopg.conninfo import conninfo_to_dict, make_conninfo
    name = conninfo_to_dict(url).get('dbname')
    if not name:
        raise SystemExit('CHARACTER_DATABASE_URL names no database')
    with psycopg.connect(make_conninfo(url, dbname='postgres'), autocommit=True, connect_timeout=5) as conn:
        if not conn.execute('SELECT 1 FROM pg_database WHERE datname = %s', (name,)).fetchone():
            conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
            out(f'created database {name}')


def migrate(conn, out=print):
    schema = _schema()
    with conn.transaction():
        conn.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', (f'{schema}.migrate',))
        conn.execute(f'CREATE SCHEMA IF NOT EXISTS {schema}')
        conn.execute(f'CREATE TABLE IF NOT EXISTS {schema}.migrations ('
                     'name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())')
        applied = dict(conn.execute(f'SELECT name, sha256 FROM {schema}.migrations').fetchall())
        for path in sorted(MIGRATIONS.glob('[0-9][0-9][0-9]_*.up.sql')):
            sql = path.read_bytes()
            digest = hashlib.sha256(sql).hexdigest()
            if path.name in applied:
                if applied[path.name] != digest:
                    # Running it again would not apply the change: CREATE ... IF NOT EXISTS keeps the old table.
                    raise SystemExit(f'{path.name} changed after it was applied to this database; nothing was changed. '
                                     f'Restore the applied file and put the change in a new numbered migration.')
                continue
            conn.execute(sql.decode('utf-8'))
            conn.execute(f'INSERT INTO {schema}.migrations (name, sha256) VALUES (%s, %s)', (path.name, digest))
            out(f'applied {path.name}')
    out('record schema ready')


@dataclass
class _Object:
    key: str
    path: str
    size: int
    modified: object


@dataclass
class Report:
    prefix: str
    listed: int = 0
    listed_bytes: int = 0
    inserted: int = 0
    inserted_bytes: int = 0
    updated: int = 0
    updated_bytes: int = 0
    identical: int = 0
    unchanged_since_import: int = 0
    blobs: int = 0
    conflicts: list = field(default_factory=list)
    not_restored: list = field(default_factory=list)
    around_import: list = field(default_factory=list)
    database_only: list = field(default_factory=list)
    removed: int = 0

    def lines(self, dry_run):
        verb = 'would ' if dry_run else ''
        yield (f'{self.prefix or "(no prefix)"}: {self.listed} JSON objects in S3 ({self.listed_bytes} bytes); '
               f'{verb}insert {self.inserted} ({self.inserted_bytes} bytes), {verb}update {self.updated} '
               f'({self.updated_bytes} bytes), identical {self.identical}, unchanged since the last import '
               f'{self.unchanged_since_import}, above 1 MiB kept in S3 {self.blobs}')
        for title, paths in (('changed in both S3 and the database since the last import (database kept)', self.conflicts),
                             ('in S3 but deleted from the database since the last import (not restored)', self.not_restored),
                             ('in S3 from about the time of the last import but not in the database: deleted there since, '
                              'or written while that import ran (not imported)', self.around_import),
                             ('in the database but not in S3', self.database_only)):
            if paths:
                yield f'  {title}: {len(paths)}'
                yield from (f'    {path}' for path in sorted(paths)[:20])
                if len(paths) > 20:
                    yield f'    ... {len(paths) - 20} more'
        if self.removed:
            yield f'  {verb}removed from the database (deleted in S3): {self.removed}'


def _bucket():
    bucket = os.getenv('ASSET_S3_BUCKET', '').strip()
    if not bucket:
        raise SystemExit('ASSET_S3_BUCKET is not set')
    return bucket


def _objects(s3, bucket, prefix):
    """The JSON objects that object_storage maps to records, by path below the data root."""
    found = {}
    for namespace in NAMESPACES:
        root = '/'.join(filter(None, (prefix, namespace))) + '/'
        for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=root):
            for item in page.get('Contents', []):
                key = item['Key']
                path = key[len(prefix) + 1:] if prefix else key
                if not key.endswith('.json') or '.locks' in path.split('/'):
                    continue
                found[path] = _Object(key, path, item['Size'], item['LastModified'])
    return found


def _get(s3, bucket, key):
    response = s3.get_object(Bucket=bucket, Key=key)
    with response['Body'] as body:
        return body.read()


def import_prefix(conn, s3, bucket, prefix, *, dry_run=False, delete_missing=False):
    from src.services.object_storage import _upload, record_blob_key, records_marker_key
    from src.services.record_store import INLINE_LIMIT
    schema = _schema()
    report = Report(prefix)
    started = conn.execute('SELECT now()').fetchone()[0]
    row = conn.execute(f'SELECT imported_at FROM {schema}.namespaces WHERE prefix = %s', (prefix,)).fetchone()
    last_import = row[0] if row else None
    rows = {path: (sha, imported) for path, sha, imported in conn.execute(
        f'SELECT path, sha256, imported_sha256 FROM {schema}.records WHERE prefix = %s', (prefix,))}
    objects = _objects(s3, bucket, prefix)
    report.listed, report.listed_bytes = len(objects), sum(item.size for item in objects.values())

    wanted = []
    for path, item in objects.items():
        # Objects not written since the last import are already in the database (or were deleted there). One written
        # about when it ran is read and compared by content below; without a row it may also be a deleted record, which
        # is never brought back.
        if last_import is not None and item.modified <= last_import:
            if path not in rows:
                (report.not_restored if item.modified < last_import - IMPORT_MARGIN else report.around_import).append(path)
                continue
            if item.modified < last_import - IMPORT_MARGIN:
                report.unchanged_since_import += 1
                continue
        wanted.append(item)

    # The snapshot above is old by the time a batch is written, and the server may be running: the row itself says
    # whether it is still as imported. A row the server created or changed since is left alone, and writes nothing.
    write = (f'INSERT INTO {schema}.records AS r (prefix, path, content, blob_key, size, sha256, imported_sha256, '
             f'created_at, updated_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) '
             f'ON CONFLICT (prefix, path) DO UPDATE SET content = excluded.content, blob_key = excluded.blob_key, '
             f'size = excluded.size, sha256 = excluded.sha256, imported_sha256 = excluded.imported_sha256, '
             f'version = r.version + 1, updated_at = excluded.updated_at WHERE r.sha256 = r.imported_sha256')
    with ThreadPoolExecutor(max_workers=16) as pool:
        for start in range(0, len(wanted), 256):
            batch = wanted[start:start + 256]
            contents = list(pool.map(lambda item: _get(s3, bucket, item.key), batch))
            with conn.transaction():
                for item, content in zip(batch, contents):
                    digest = hashlib.sha256(content).hexdigest()
                    current = rows.get(item.path)
                    if current and current[0] == digest:
                        report.identical += 1
                        if current[1] != digest and not dry_run:
                            conn.execute(f'UPDATE {schema}.records SET imported_sha256 = %s WHERE prefix = %s AND path = %s',
                                         (digest, prefix, item.path))
                        continue
                    if current and current[1] == digest:
                        # S3 still holds what was imported: only the database changed it since.
                        report.unchanged_since_import += 1
                        continue
                    if current and current[0] != current[1]:
                        report.conflicts.append(item.path)
                        continue
                    inline, blob = content, None
                    if len(content) > INLINE_LIMIT:
                        inline, blob = None, record_blob_key(prefix, digest)
                        if not dry_run:
                            _upload(bucket, blob, content, 'application/json')
                    if not dry_run and not conn.execute(write, (prefix, item.path, inline, blob, len(content), digest,
                                                                digest, item.modified, item.modified)).rowcount:
                        report.conflicts.append(item.path)
                        continue
                    if current:
                        report.updated += 1
                        report.updated_bytes += len(content)
                    else:
                        report.inserted += 1
                        report.inserted_bytes += len(content)
                    if blob:
                        report.blobs += 1
    for path, (sha, imported) in rows.items():
        if path in objects:
            continue
        if delete_missing and imported == sha:
            report.removed += 1
            if not dry_run:
                conn.execute(f'DELETE FROM {schema}.records WHERE prefix = %s AND path = %s AND sha256 = imported_sha256',
                             (prefix, path))
        else:
            report.database_only.append(path)
    if not dry_run:
        conn.execute(f'INSERT INTO {schema}.namespaces (prefix, imported_at, source) VALUES (%s, %s, %s) '
                     'ON CONFLICT (prefix) DO UPDATE SET imported_at = excluded.imported_at, source = excluded.source',
                     (prefix, started, 's3'))
        # Last, so that a marker means the import finished: servers without CHARACTER_DATABASE_URL then refuse to start.
        _upload(bucket, records_marker_key(prefix), json.dumps(
            {'records': 'postgresql', 'schema': schema, 'imported_at': started.isoformat()}, indent=2).encode(),
            'application/json')
    return report


@contextmanager
def _server_stopped():
    """Hold the character server's own guard (runtime_activity.server_lease) while records go back to S3: a server on
    this data root holds it while it runs, so the export is refused, and one started meanwhile refuses to start."""
    from src.services.runtime_activity import _open_lock, _root, _take_lock
    stream = _open_lock(_root() / 'server.guard')
    try:
        try:
            _take_lock(stream, blocking=False)
        except OSError:
            raise SystemExit('The character server is running on this data root: stop it before export, or the records '
                             'it writes meanwhile are missing from S3.') from None
        yield
    finally:
        stream.close()


def _records_state(conn, schema, prefix):
    """(rows, digest of every path and sha256, rows changed since their import) of a prefix: any write, insert or
    delete changes it; export's own imported_sha256 updates do not."""
    return conn.execute(
        f"SELECT count(*), encode(sha256(convert_to(coalesce(string_agg(path || ' ' || sha256, E'\\n' ORDER BY path), "
        f"''), 'UTF8')), 'hex'), count(*) FILTER (WHERE imported_sha256 IS DISTINCT FROM sha256) "
        f'FROM {schema}.records WHERE prefix = %s', (prefix,)).fetchone()


def export_prefix(conn, s3, bucket, prefix, *, dry_run=False, out=print, ignore_stale=False):
    """Write the records created or changed in the database since their import back to their S3 keys, then remove the
    marker unless S3 still holds JSON of records deleted in the database (`ignore_stale` accepts them). Refused while a
    character server runs on this data root; the marker stays when a record changed while the export ran."""
    with nullcontext() if dry_run else _server_stopped():
        return _export_prefix(conn, s3, bucket, prefix, dry_run=dry_run, out=out, ignore_stale=ignore_stale)


def _export_prefix(conn, s3, bucket, prefix, *, dry_run, out, ignore_stale):
    from botocore.exceptions import ClientError
    from src.services.object_storage import _content_type, _upload, records_marker_key
    schema = _schema()
    before = _records_state(conn, schema, prefix)[:2]
    rows = conn.execute(f'SELECT path, content, blob_key, sha256 FROM {schema}.records '
                        f'WHERE prefix = %s AND imported_sha256 IS DISTINCT FROM sha256 ORDER BY path', (prefix,)).fetchall()
    written = total = 0
    for path, content, blob, digest in rows:
        content = bytes(content) if content is not None else _get(s3, bucket, blob)
        if hashlib.sha256(content).hexdigest() != digest:
            raise SystemExit(f'{path}: stored bytes do not match the record')
        key = '/'.join(filter(None, (prefix, path)))
        written += 1
        total += len(content)
        if not dry_run:
            _upload(bucket, key, content, _content_type(path))
            conn.execute(f'UPDATE {schema}.records SET imported_sha256 = sha256 WHERE prefix = %s AND path = %s AND sha256 = %s',
                         (prefix, path, digest))
    known = {path for (path,) in conn.execute(f'SELECT path FROM {schema}.records WHERE prefix = %s', (prefix,))}
    stale = sorted(path for path in _objects(s3, bucket, prefix) if path not in known)
    verb = 'would write' if dry_run else 'wrote'
    out(f'{prefix or "(no prefix)"}: {verb} {written} records to S3 ({total} bytes)')
    if stale:
        # Deleted in the database while it was the record store; S3 still holds the old JSON.
        out(f'  JSON in S3 without a record (left in place): {len(stale)}')
        for path in stale[:20]:
            out(f'    {path}')
        if len(stale) > 20:
            out(f'    ... {len(stale) - 20} more')
    marker = records_marker_key(prefix)
    if dry_run:
        return written
    if stale and not ignore_stale:
        # A server reading S3 again would bring those records back (an archived character.json, a deleted job).
        out(f'  The marker {marker} stays, so servers without CHARACTER_DATABASE_URL keep refusing to start: delete '
            f'that JSON from S3, or run export again with --ignore-stale to let servers read it.')
        raise SystemExit(f'{prefix or "(no prefix)"}: records written back, marker kept because of stale JSON in S3')
    count, digest, changed = _records_state(conn, schema, prefix)
    if (count, digest) != before or changed:
        # A server elsewhere still writes: S3 lacks what it wrote after the rows were read.
        out(f'  Records changed while the export ran, so the marker {marker} stays. Stop every character server that '
            f'uses this database, then run export again.')
        raise SystemExit(f'{prefix or "(no prefix)"}: records changed during the export, marker kept')
    try:
        # S3 holds the records again, so a server without CHARACTER_DATABASE_URL may start.
        s3.delete_object(Bucket=bucket, Key=marker)
    except ClientError as exc:
        code = str(exc.response.get('Error', {}).get('Code', ''))
        reason = 's3:DeleteObject was denied' if code in ('AccessDenied', '403') else f'S3 answered {code or type(exc).__name__}'
        out(f'  The marker {marker} could not be deleted ({reason}). The records are back in S3, but servers without '
            f'CHARACTER_DATABASE_URL keep refusing to start until a role that may delete it removes the marker.')
        raise SystemExit(f'{prefix or "(no prefix)"}: records written back, marker not deleted ({reason})')
    return written


def status(conn, prefixes, out=print, s3=None, bucket=None):
    """Per prefix: the import state and record counts, and with `s3` the marker that keeps servers without the database away."""
    from src.services.object_storage import records_marker_key, records_marker_present
    schema = _schema()
    namespaces = {prefix: at for prefix, at in conn.execute(f'SELECT prefix, imported_at FROM {schema}.namespaces')}
    rows = conn.execute(
        f'SELECT prefix, count(*), coalesce(sum(size), 0), count(blob_key), '
        f'count(*) FILTER (WHERE imported_sha256 IS DISTINCT FROM sha256) FROM {schema}.records GROUP BY prefix').fetchall()
    counts = {row[0]: row[1:] for row in rows}
    for prefix in prefixes or sorted(set(namespaces) | set(counts)):
        count, size, blobs, changed = counts.get(prefix, (0, 0, 0, 0))
        imported = namespaces.get(prefix)
        state = f'imported {imported.isoformat()}' if imported else 'not imported (the server refuses its records)'
        out(f'{prefix or "(no prefix)"}: {state}; {count} records ({size} bytes, {blobs} in S3 blobs), '
            f'{changed} created or changed since their import')
        if s3 is not None:
            try:
                marker = 'present' if records_marker_present(s3, bucket, prefix) else 'absent'
            except Exception as exc:
                marker = f'unknown ({type(exc).__name__})'
            out(f'  S3 marker {records_marker_key(prefix)}: {marker}')


def main(argv=None):
    parser = argparse.ArgumentParser(prog='python -m src.records', description=__doc__.split('\n\n')[0])
    commands = parser.add_subparsers(dest='command', required=True)
    migrate_command = commands.add_parser('migrate', help='create or update the record schema')
    migrate_command.add_argument('--create-database', action='store_true',
                                 help='first create the database itself when missing (local development)')
    for name, help_text in (('import', 'copy S3 JSON records into the database'),
                            ('export', 'write records changed in the database back to S3 (stop the character '
                                       'server first; refused while it runs on this data root)'),
                            ('status', 'show imported prefixes and record counts')):
        command = commands.add_parser(name, help=help_text, description=help_text)
        command.add_argument('--prefix', action='append', required=name != 'status',
                             help='storage prefix (ASSET_S3_PREFIX); repeat for several')
        if name != 'status':
            command.add_argument('--dry-run', action='store_true', help='report only; change nothing')
        if name == 'import':
            command.add_argument('--delete-missing', action='store_true',
                                 help='remove rows whose S3 object was deleted since their import and that the database never changed')
        if name == 'export':
            command.add_argument('--ignore-stale', action='store_true',
                                 help='remove the marker although S3 still holds JSON of records deleted in the database')
    args = parser.parse_args(argv)
    load_environment()
    from src.services import record_store
    if not record_store.configured():
        raise SystemExit('CHARACTER_DATABASE_URL is not set')
    prefixes = [value.strip('/') for value in (getattr(args, 'prefix', None) or [])]
    with running_task() if args.command != 'status' else nullcontext():
        if getattr(args, 'create_database', False):
            create_database(os.environ['CHARACTER_DATABASE_URL'].strip())
        _execute(args, prefixes, record_store)
    record_store.reset()


def _execute(args, prefixes, record_store):
    with record_store.connect(options='-c statement_timeout=0') as conn:
        if args.command == 'migrate':
            migrate(conn)
        elif args.command == 'status':
            # Without a bucket there is no marker to look for.
            bucket, s3 = os.getenv('ASSET_S3_BUCKET', '').strip(), None
            if bucket:
                from src.services.object_storage import _s3
                try:
                    s3 = _s3()
                except Exception as exc:
                    print(f'S3 marker not checked: {type(exc).__name__}')
            status(conn, prefixes, s3=s3, bucket=bucket)
        else:
            from src.services.object_storage import _s3
            s3, bucket = _s3(), _bucket()
            for prefix in prefixes:
                if args.command == 'import':
                    report = import_prefix(conn, s3, bucket, prefix, dry_run=args.dry_run,
                                           delete_missing=args.delete_missing)
                    for line in report.lines(args.dry_run):
                        print(line)
                else:
                    export_prefix(conn, s3, bucket, prefix, dry_run=args.dry_run, ignore_stale=args.ignore_stale)


if __name__ == '__main__':
    sys.exit(main())
