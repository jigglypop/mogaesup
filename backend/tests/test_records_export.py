"""`src.records export` and `import` around a server that still writes: export refuses while the character server runs
on its data root and keeps the marker when a record changed while it ran; import reads again what was written about
when the last import ran instead of trusting S3's whole-second clock.

Runs against a throwaway database on the compose PostgreSQL (127.0.0.1:55432), like tests/test_record_store.py; S3 is
an in-memory stand-in."""

from datetime import datetime, timedelta, timezone
import hashlib
import io
import os
import uuid

import psycopg
import pytest
from botocore.exceptions import ClientError

from src import records
from src.services import object_storage, record_store, runtime_activity

ADMIN = 'host=127.0.0.1 port=55432 user=postgres password=postgres-dev connect_timeout=3'
BUCKET = 'fixture-bucket'
JOB = f'avatar-factory/1/{"a" * 24}'


class S3:
    """The S3 calls of records import/export, in memory. `on_put` runs after each stored PUT (a server writing)."""

    def __init__(self):
        self.objects = {}
        self.reads = []
        self.on_put = None

    def put(self, key, body, modified):
        self.objects[key] = {'Body': bytes(body), 'LastModified': modified}

    def put_object(self, *, Bucket, Key, Body, **_):
        self.put(Key, Body, datetime.now(timezone.utc))
        if self.on_put:
            self.on_put(Key)

    def get_object(self, *, Bucket, Key, **_):
        self.reads.append(Key)
        if Key not in self.objects:
            raise ClientError({'Error': {'Code': 'NoSuchKey'}, 'ResponseMetadata': {'HTTPStatusCode': 404}}, 'GetObject')
        return {'Body': io.BytesIO(self.objects[Key]['Body'])}

    def delete_object(self, *, Bucket, Key):
        self.objects.pop(Key, None)

    def get_paginator(self, name):
        s3 = self

        class Paginator:
            @staticmethod
            def paginate(*, Bucket, Prefix):
                yield {'Contents': [{'Key': key, 'Size': len(item['Body']), 'LastModified': item['LastModified']}
                                    for key, item in sorted(s3.objects.items()) if key.startswith(Prefix)]}
        return Paginator()


@pytest.fixture(scope='module')
def database():
    try:
        admin = psycopg.connect(ADMIN + ' dbname=postgres', autocommit=True)
    except psycopg.OperationalError as exc:
        if os.environ.get('REQUIRE_TEST_DATABASE'):
            pytest.fail(f'PostgreSQL at 127.0.0.1:55432 is required here: {exc}')
        pytest.skip(f'local PostgreSQL at 127.0.0.1:55432 is not running (docker compose up -d postgres in server/): {exc}')
    name = f'test_records_export_{uuid.uuid4().hex}'
    with admin:
        admin.execute(f'CREATE DATABASE {name}')
        url = f'postgresql://postgres:postgres-dev@127.0.0.1:55432/{name}'
        try:
            with psycopg.connect(url, autocommit=True) as conn:
                records.migrate(conn, out=lambda line: None)
            yield url
        finally:
            record_store.reset()
            admin.execute(f'DROP DATABASE IF EXISTS {name} WITH (FORCE)')


LONG_AGO = datetime(2026, 9, 1, tzinfo=timezone.utc)


@pytest.fixture
def imported(database, monkeypatch, tmp_path):
    """A prefix of three records imported from S3, the marker in place; the server guard of a data root of its own."""
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path / 'data'))
    monkeypatch.setenv('ASSET_S3_BUCKET', BUCKET)
    s3 = S3()
    monkeypatch.setattr(object_storage, '_s3', lambda: s3)
    prefix = f'export-{uuid.uuid4().hex[:8]}'
    for name, body in (('job.json', b'{"status": "approved"}'), ('parts/top/character.json', b'{"task_id": "t"}'),
                       ('parts/hat/character.json', b'{"task_id": "h"}')):
        s3.put(f'{prefix}/{JOB}/{name}', body, LONG_AGO)
    with psycopg.connect(database, autocommit=True) as conn:
        records.import_prefix(conn, s3, BUCKET, prefix)
        yield conn, s3, prefix


def marker(prefix):
    return f'{prefix}/.records-in-database'


def change(conn, prefix, path, body):
    conn.execute('UPDATE character_records.records SET content = %s, sha256 = %s, size = %s WHERE prefix = %s AND path = %s',
                 (body, hashlib.sha256(body).hexdigest(), len(body), prefix, path))


# --- export ----------------------------------------------------------------------------------------------------------

def test_export_is_refused_while_the_character_server_runs_on_its_data_root(imported):
    conn, s3, prefix = imported
    change(conn, prefix, f'{JOB}/job.json', b'{"status": "db"}')
    with runtime_activity.server_lease():
        with pytest.raises(SystemExit, match='running'):
            records.export_prefix(conn, s3, BUCKET, prefix, out=lambda line: None)
        assert s3.objects[f'{prefix}/{JOB}/job.json']['Body'] == b'{"status": "approved"}' and marker(prefix) in s3.objects
        # A dry run changes nothing, so it may look while the server runs.
        assert records.export_prefix(conn, s3, BUCKET, prefix, dry_run=True, out=lambda line: None) == 1
        # Holding the guard, the export also keeps a server from starting meanwhile.
    assert records.export_prefix(conn, s3, BUCKET, prefix, out=lambda line: None) == 1
    assert s3.objects[f'{prefix}/{JOB}/job.json']['Body'] == b'{"status": "db"}' and marker(prefix) not in s3.objects


def test_a_server_cannot_start_on_the_data_root_while_export_runs(imported):
    conn, s3, prefix = imported
    change(conn, prefix, f'{JOB}/job.json', b'{"status": "db"}')
    refused = []

    def server_starts(key):
        try:
            with runtime_activity.server_lease():
                pass
        except runtime_activity.RuntimeUncertain:
            refused.append(key)
    s3.on_put = server_starts
    records.export_prefix(conn, s3, BUCKET, prefix, out=lambda line: None)
    assert refused == [f'{prefix}/{JOB}/job.json']


@pytest.mark.parametrize('write', ['update', 'insert', 'delete'])
def test_the_marker_stays_when_a_record_changes_while_the_export_runs(imported, database, write):
    conn, s3, prefix = imported
    change(conn, prefix, f'{JOB}/job.json', b'{"status": "db"}')
    server = psycopg.connect(database, autocommit=True)

    def server_writes(key):
        # A server elsewhere (another host, so not held off by the guard) writes after the export read the rows.
        if write == 'update':
            change(server, prefix, f'{JOB}/parts/top/character.json', b'{"task_id": "t2"}')
        elif write == 'insert':
            body = b'{"new": true}'
            server.execute('INSERT INTO character_records.records (prefix, path, content, size, sha256) '
                           'VALUES (%s, %s, %s, %s, %s)', (prefix, f'{JOB}/new.json', body, len(body),
                                                           hashlib.sha256(body).hexdigest()))
        else:
            server.execute('DELETE FROM character_records.records WHERE prefix = %s AND path = %s',
                           (prefix, f'{JOB}/parts/hat/character.json'))
        s3.on_put = None
    s3.on_put = server_writes
    lines = []
    with server:
        with pytest.raises(SystemExit, match='changed during the export'):
            # A deleted record also leaves its JSON in S3, which keeps the marker by itself unless accepted.
            records.export_prefix(conn, s3, BUCKET, prefix, out=lines.append, ignore_stale=write == 'delete')
    assert marker(prefix) in s3.objects and any('stays' in line for line in lines)
    # Once nothing writes any more, export runs again and puts the rest back (a deleted record's JSON stays refused).
    if write == 'delete':
        with pytest.raises(SystemExit, match='stale JSON'):
            records.export_prefix(conn, s3, BUCKET, prefix, out=lambda line: None)
        records.export_prefix(conn, s3, BUCKET, prefix, out=lambda line: None, ignore_stale=True)
    else:
        records.export_prefix(conn, s3, BUCKET, prefix, out=lambda line: None)
    assert marker(prefix) not in s3.objects
    if write == 'update':
        assert s3.objects[f'{prefix}/{JOB}/parts/top/character.json']['Body'] == b'{"task_id": "t2"}'
    if write == 'insert':
        assert s3.objects[f'{prefix}/{JOB}/new.json']['Body'] == b'{"new": true}'


def test_the_command_line_names_the_stopped_server_requirement(capsys):
    with pytest.raises(SystemExit):
        records.main(['export', '--help'])
    assert 'stop the character server first' in ' '.join(capsys.readouterr().out.split())


# --- import ----------------------------------------------------------------------------------------------------------

def test_import_reads_again_what_was_written_about_when_the_last_import_ran(imported):
    conn, s3, prefix = imported
    (last,) = conn.execute('SELECT imported_at FROM character_records.namespaces WHERE prefix = %s', (prefix,)).fetchone()
    # S3 keeps whole seconds on its own clock: writes just after that import started can carry an earlier time.
    around = last.replace(microsecond=0) - timedelta(seconds=1)
    s3.put(f'{prefix}/{JOB}/job.json', b'{"status": "written as it ran"}', around)
    s3.put(f'{prefix}/{JOB}/parts/new.json', b'{"new": "s3"}', around)
    # A record only the database changed since: S3 holds what was imported, which is no conflict.
    change(conn, prefix, f'{JOB}/parts/top/character.json', b'{"task_id": "db"}')
    s3.put(f'{prefix}/{JOB}/parts/top/character.json', b'{"task_id": "t"}', around)
    s3.reads.clear()
    report = records.import_prefix(conn, s3, BUCKET, prefix)
    rows = dict(conn.execute('SELECT path, content FROM character_records.records WHERE prefix = %s', (prefix,)).fetchall())
    assert bytes(rows[f'{JOB}/job.json']) == b'{"status": "written as it ran"}' and report.updated == 1
    assert bytes(rows[f'{JOB}/parts/top/character.json']) == b'{"task_id": "db"}' and not report.conflicts
    # A record without a row may also be one deleted in the database since: it is reported, never brought back.
    assert report.around_import == [f'{JOB}/parts/new.json'] and f'{JOB}/parts/new.json' not in rows
    assert 'written while that import ran' in '\n'.join(report.lines(False))
    # What was written long before is still not read again.
    assert f'{prefix}/{JOB}/parts/hat/character.json' not in s3.reads and report.unchanged_since_import == 2
