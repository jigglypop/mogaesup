"""Character records in PostgreSQL (src.services.record_store behind object_storage, src.records).

Runs against a throwaway database on the compose PostgreSQL (server/docker-compose.yml, 127.0.0.1:55432),
created as test_records_<random> and dropped afterwards; skipped when that server is not running. S3 is an
in-memory stand-in, and the local-disk storage mode is the reference behaviour for every path operation.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
import threading
import uuid

import psycopg
import pytest
from botocore.exceptions import ClientError

from src import records
from src.services import object_storage, record_store
from src.services.asset_editor import WriteConflict, update_json
from src.services.object_storage import StoredPath, child_names, local_workspace, sha256

ADMIN = 'host=127.0.0.1 port=55432 user=postgres password=postgres-dev connect_timeout=3'


def s3_error(code, status, operation):
    return ClientError({'Error': {'Code': code}, 'ResponseMetadata': {'HTTPStatusCode': status}}, operation)


class FakeS3:
    """The S3 calls object_storage makes, kept in memory and counted.

    Failure modes of the real service: `denied_deletes` (keys, or '*') answer AccessDenied as for a role without
    s3:DeleteObject, `forbidden_heads` makes a HEAD of a missing key 403 as for a role that may not list it,
    `conditional_writes` are keys another conditional PUT is writing (409), and `page_size` splits listings into pages."""

    def __init__(self):
        self.objects = {}
        self.calls = {}
        self.clock = datetime(2026, 9, 1, tzinfo=timezone.utc)
        self.lock = threading.Lock()
        self.denied_deletes = set()
        self.forbidden_heads = False
        self.conditional_writes = set()
        self.page_size = 1000

    def _count(self, name):
        with self.lock:
            self.calls[name] = self.calls.get(name, 0) + 1

    def _missing(self, operation):
        return s3_error('NoSuchKey', 404, operation)

    def tick(self):
        self.clock += timedelta(seconds=1)
        return self.clock

    def put(self, key, body, modified=None):
        self.objects[key] = {'Body': bytes(body), 'LastModified': modified or self.tick(), 'Metadata': {
            'sha256': hashlib.sha256(body).hexdigest()}, 'ContentType': 'application/octet-stream'}

    def put_object(self, *, Bucket, Key, Body, ContentType, Metadata, ChecksumSHA256, ServerSideEncryption, IfNoneMatch=None):
        self._count('put_object')
        if IfNoneMatch == '*' and Key in self.conditional_writes:
            raise s3_error('ConditionalRequestConflict', 409, 'PutObject')
        if IfNoneMatch == '*' and Key in self.objects:
            raise s3_error('PreconditionFailed', 412, 'PutObject')
        self.put(Key, Body)
        self.objects[Key].update(ContentType=ContentType, Metadata=Metadata, ChecksumSHA256=ChecksumSHA256)

    def head_object(self, *, Bucket, Key, ChecksumMode=None):
        self._count('head_object')
        item = self.objects.get(Key)
        if item is None:
            raise (s3_error('403', 403, 'HeadObject') if self.forbidden_heads else s3_error('404', 404, 'HeadObject'))
        return {'ContentLength': len(item['Body']), 'LastModified': item['LastModified'],
                'ChecksumSHA256': item.get('ChecksumSHA256'), 'Metadata': item['Metadata']}

    def get_object(self, *, Bucket, Key, Range=None, IfMatch=None):
        self._count('get_object')
        item = self.objects.get(Key)
        if item is None:
            raise self._missing('GetObject')
        body = item['Body']
        response = {'Metadata': item['Metadata'], 'ETag': '"%s"' % hashlib.md5(body).hexdigest()}
        if IfMatch and IfMatch != response['ETag']:
            raise s3_error('PreconditionFailed', 412, 'GetObject')
        if Range:
            start, end = (int(value) for value in Range.removeprefix('bytes=').split('-'))
            if start >= len(body):
                raise s3_error('InvalidRange', 416, 'GetObject')
            end = min(end, len(body) - 1)
            response['ContentRange'] = f'bytes {start}-{end}/{len(body)}'
            body = body[start:end + 1]
        response['Body'] = io.BytesIO(body)
        return response

    def delete_object(self, *, Bucket, Key):
        self._count('delete_object')
        if Key in self.denied_deletes or '*' in self.denied_deletes:
            raise s3_error('AccessDenied', 403, 'DeleteObject')
        self.objects.pop(Key, None)

    def copy_object(self, *, Bucket, Key, CopySource, **_):
        self._count('copy_object')
        self.put(Key, self.objects[CopySource['Key']]['Body'])

    def list_objects_v2(self, *, Bucket, Prefix, MaxKeys=1000, Delimiter=None, ContinuationToken=None):
        self._count('list_objects_v2')
        keys = sorted(key for key in self.objects if key.startswith(Prefix))
        if Delimiter:
            prefixes = sorted({Prefix + key[len(Prefix):].split(Delimiter)[0] + Delimiter
                               for key in keys if Delimiter in key[len(Prefix):]})
            keys = [key for key in keys if Delimiter not in key[len(Prefix):]]
            return {'Contents': [self._item(key) for key in keys], 'CommonPrefixes': [{'Prefix': p} for p in prefixes]}
        start = int(ContinuationToken or 0)
        page = keys[start:start + min(MaxKeys, self.page_size)]
        response = {'Contents': [self._item(key) for key in page], 'IsTruncated': start + len(page) < len(keys)}
        if response['IsTruncated']:
            response['NextContinuationToken'] = str(start + len(page))
        return response

    def _item(self, key):
        item = self.objects[key]
        return {'Key': key, 'Size': len(item['Body']), 'LastModified': item['LastModified']}

    def get_paginator(self, name):
        assert name == 'list_objects_v2'
        s3 = self

        class Paginator:
            def paginate(self, **kwargs):
                token = None
                while True:
                    page = s3.list_objects_v2(**kwargs, **({'ContinuationToken': token} if token else {}))
                    yield page
                    if not page.get('IsTruncated'):
                        return
                    token = page['NextContinuationToken']
        return Paginator()

    def generate_presigned_url(self, operation, Params, ExpiresIn):
        return f"https://fake-s3/{Params['Key']}"


@pytest.fixture(scope='module')
def database():
    try:
        admin = psycopg.connect(ADMIN + ' dbname=postgres', autocommit=True)
    except psycopg.OperationalError as exc:
        pytest.skip(f'local PostgreSQL at 127.0.0.1:55432 is not running (docker compose up -d postgres in server/): {exc}')
    name = f'test_records_{uuid.uuid4().hex}'
    with admin:
        admin.execute(f'CREATE DATABASE {name}')
        url = f'postgresql://postgres:postgres-dev@127.0.0.1:55432/{name}'
        try:
            with psycopg.connect(url, autocommit=True) as conn:
                records.migrate(conn, out=lambda line: None)
                records.migrate(conn, out=lambda line: None)  # idempotent
            yield url
        finally:
            record_store.reset()
            admin.execute(f'DROP DATABASE IF EXISTS {name} WITH (FORCE)')


@pytest.fixture
def s3(monkeypatch):
    fake = FakeS3()
    monkeypatch.setattr(object_storage, '_s3', lambda: fake)
    return fake


def _clear_s3_caches():
    with object_storage._cache_lock:
        for cache in (object_storage._cache, object_storage._content_cache, object_storage._key_index,
                      object_storage._written_keys, object_storage._generations):
            cache.clear()


@pytest.fixture
def cloud(monkeypatch, tmp_path, database, s3):
    """S3 for artifacts and the test database for records, under a prefix of this test's own."""
    prefix = f'p{uuid.uuid4().hex[:12]}'
    monkeypatch.delenv('ASSET_STORAGE_WORKER_LOCAL', raising=False)
    monkeypatch.setenv('ASSET_S3_BUCKET', 'fixture-bucket')
    monkeypatch.setenv('ASSET_S3_PREFIX', prefix)
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path / 'cloud'))
    monkeypatch.setenv('CHARACTER_DATABASE_URL', database)
    record_store.reset()
    _clear_s3_caches()
    with psycopg.connect(database, autocommit=True) as conn:
        conn.execute('INSERT INTO character_records.namespaces (prefix, imported_at, source) VALUES (%s, now(), %s)',
                     (prefix, 'test'))
    yield tmp_path / 'cloud', prefix
    record_store.reset()
    _clear_s3_caches()


@pytest.fixture
def disk(monkeypatch, tmp_path):
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path / 'disk'))
    return tmp_path / 'disk'


def _rows(url, prefix):
    with psycopg.connect(url, autocommit=True) as conn:
        return {path: (bytes(content) if content is not None else None, blob, doc) for path, content, blob, doc in conn.execute(
            'SELECT path, content, blob_key, doc FROM character_records.records WHERE prefix = %s', (prefix,))}


def scenario(root):
    """Every path operation the services use, recorded as plain values relative to the data root."""
    root = StoredPath(root)
    job = root / 'avatar-factory' / '1' / ('a' * 24)
    other = root / 'avatar-factory' / '1' / ('b' * 24)
    seen = []

    def note(label, value):
        seen.append((label, value))

    def outcome(action):
        try:
            return ('ok', action())
        except Exception as exc:
            return ('error', type(exc).__name__)

    def names(paths):
        return [path.relative_to(root).as_posix() for path in paths]

    (job / 'output').mkdir(parents=True, exist_ok=True)
    object_storage.write_json(job / 'job.json', {'status': 'pipeline_running', 'name': '모개'}) \
        or (job / 'job.json').write_text(json.dumps({'status': 'pipeline_running', 'name': '모개'}, ensure_ascii=False, indent=2), encoding='utf-8')
    (job / 'output' / 'progress.json').write_text('{"stage": "images"}', encoding='utf-8')
    (job / 'parts' / 'top').mkdir(parents=True, exist_ok=True)
    (job / 'parts' / 'top' / 'character.json').write_text('{"task_id": "t1"}', encoding='utf-8')
    (job / 'parts' / 'top' / 'model.glb').write_bytes(b'glTF\x02\x00\x00\x00binary')
    (job / 'output' / 'front.png').write_bytes(b'\x89PNG fixture')
    (other / 'output').mkdir(parents=True, exist_ok=True)
    (other / 'output' / 'model.glb').write_bytes(b'glTF only an artifact')
    (root / 'avatar-factory' / '1' / 'common-body.json').write_text('{"job": "a"}', encoding='utf-8')

    note('read job', json.loads((job / 'job.json').read_text(encoding='utf-8')))
    note('read bytes', (job / 'output' / 'progress.json').read_bytes())
    note('binary', (job / 'parts' / 'top' / 'model.glb').read_bytes())
    for relative in ('job.json', 'output/progress.json', 'parts/top/model.glb', 'missing.json', 'parts'):
        path = job / relative
        note(f'is_file {relative}', path.is_file())
        note(f'exists {relative}', path.exists())
    for path in (job, job / 'parts', job / 'parts' / 'top', other, other / 'output', job / 'nothing'):
        note(f'is_dir {path.relative_to(root).as_posix()}', path.is_dir())
    note('stat size', (job / 'output' / 'progress.json').stat().st_size)
    note('sha256', sha256(job / 'output' / 'progress.json'))

    # Exclusive creation: the first wins, the second sees the existing record.
    def create(text):
        with (job / 'lease.json').open('x', encoding='utf-8') as stream:
            stream.write(text)
        return (job / 'lease.json').read_text(encoding='utf-8')
    note('exclusive first', outcome(lambda: create('{"n": 1}')))
    note('exclusive second', outcome(lambda: create('{"n": 2}')))

    # Replace between records, and from a binary partial to a record (the image-response receipt).
    (job / 'draft.json').write_text('{"draft": true}', encoding='utf-8')
    (job / 'draft.json').replace(job / 'final.json')
    note('replace source gone', (job / 'draft.json').is_file())
    note('replace target', (job / 'final.json').read_text(encoding='utf-8'))
    (job / 'final.json').write_text('{"draft": false}', encoding='utf-8')
    (job / 'again.json').write_text('{"again": 1}', encoding='utf-8')
    (job / 'again.json').replace(job / 'final.json')
    note('replace over existing', (job / 'final.json').read_text(encoding='utf-8'))
    partial = job / 'output' / 'top-provider.response.partial'
    with partial.open('wb') as stream:
        stream.write(b'{"data": []}')
    partial.replace(job / 'output' / 'top-provider.response.json')
    note('partial gone', partial.is_file())
    note('partial target', (job / 'output' / 'top-provider.response.json').read_bytes())
    note('replace missing', outcome(lambda: (job / 'nope.json').replace(job / 'other.json')))

    # Deletes.
    (job / 'gone.json').write_text('{}', encoding='utf-8')
    (job / 'gone.json').unlink()
    note('deleted', (job / 'gone.json').is_file())
    note('delete missing', outcome(lambda: (job / 'gone.json').unlink()))
    note('delete missing ok', outcome(lambda: (job / 'gone.json').unlink(missing_ok=True)))

    # Listings mixing records and artifacts.
    for base, pattern in ((job, '*.json'), (job, '*'), (job, 'parts/*/character.json'), (job, '**/*.json'),
                          (job, '**/*'), (root / 'avatar-factory' / '1', '*/job.json'),
                          (root / 'avatar-factory' / '1', '*/output/*.glb'), (job / 'output', '*')):
        note(f'glob {base.relative_to(root).as_posix()} {pattern}', names(base.glob(pattern)))
    note('rglob glb', names(job.rglob('*.glb')))
    note('rglob json', names((root / 'avatar-factory').rglob('*.json')))
    note('children', child_names(root / 'avatar-factory' / '1'))
    note('children of job', child_names(job))
    return seen


def test_records_behave_like_local_files(disk, cloud, s3, database, monkeypatch):
    reference = scenario(disk)
    monkeypatch.setenv('ASSET_DATA_ROOT', str(cloud[0]))
    result = scenario(cloud[0])
    assert result == reference

    # Records went to the database, artifacts to S3, and nothing stayed on the local disk.
    prefix = cloud[1]
    stored = _rows(database, prefix)
    assert 'avatar-factory/1/' + 'a' * 24 + '/job.json' in stored
    assert stored['avatar-factory/1/' + 'a' * 24 + '/job.json'][2] == {'status': 'pipeline_running', 'name': '모개'}
    assert not [key for key in s3.objects if key.endswith('.json')]
    assert f'{prefix}/avatar-factory/1/{"a" * 24}/parts/top/model.glb' in s3.objects
    assert not [path for path in cloud[0].rglob('*') if path.is_file()]


def test_job_polling_reads_no_s3(cloud, s3):
    root, _ = cloud
    job = StoredPath(root) / 'avatar-factory' / '1' / ('c' * 24)
    object_storage.write_json(job / 'job.json', {'status': 'pipeline_running'})
    object_storage.write_json(job / 'output' / 'progress.json', {'stage': 'parts'})
    object_storage.write_json(job / 'parts' / 'top' / 'character.json', {'task_id': 't'})
    s3.calls.clear()
    for _ in range(20):
        json.loads((job / 'job.json').read_text(encoding='utf-8'))
        json.loads((job / 'output' / 'progress.json').read_text(encoding='utf-8'))
        [path.read_bytes() for path in job.glob('parts/*/character.json')]
        (job / 'output' / 'runner.json').is_file()
    assert s3.calls == {}


def test_stale_s3_json_is_invisible_to_the_record_store(cloud, s3):
    root, prefix = cloud
    job = f'{prefix}/avatar-factory/1/{"d" * 24}'
    s3.put(f'{job}/job.json', b'{"status": "old"}')             # left behind by the import
    s3.put(f'{prefix}/avatar-factory/1/{"e" * 24}/job.json', b'{}')  # a job deleted from the database
    s3.put(f'{job}/output/model.glb', b'glTF')
    base = StoredPath(root) / 'avatar-factory' / '1'
    assert not (base / ('d' * 24) / 'job.json').is_file()
    assert [p.name for p in base.glob('*/job.json')] == []
    assert [p.name for p in (base / ('d' * 24)).glob('**/*')] == ['model.glb']
    assert child_names(base) == ['d' * 24]
    assert not (base / ('e' * 24)).is_dir()


def test_directories_that_only_hold_records(cloud):
    root, prefix = cloud
    base = StoredPath(root) / 'avatar-factory' / '1'
    for relative in ('common-body.json', 'x/job.json', 'x/parts/a.json', 'x0/job.json', 'x-y/job.json', 'y.json'):
        (base / relative).write_text('{}', encoding='utf-8')
    assert record_store.children(prefix, 'avatar-factory/1/') == {'x', 'x0', 'x-y'}
    assert child_names(base) == ['x', 'x-y', 'x0']
    assert (base / 'x' / 'parts').is_dir() and not (base / 'y.json').is_dir() and not (base / 'z').is_dir()
    assert [p.relative_to(base).as_posix() for p in base.glob('*/job.json')] == ['x/job.json', 'x-y/job.json', 'x0/job.json']


def test_exclusive_create_admits_one_writer(cloud):
    root, _ = cloud
    path = StoredPath(root) / 'avatar-factory' / '1' / ('f' * 24) / 'lease.json'

    def claim(n):
        try:
            with path.open('xb') as stream:
                stream.write(json.dumps({'n': n}).encode())
            return n
        except FileExistsError:
            return None

    with ThreadPoolExecutor(max_workers=8) as pool:
        winners = [n for n in pool.map(claim, range(16)) if n is not None]
    assert len(winners) == 1
    assert json.loads(path.read_bytes()) == {'n': winners[0]}


def test_update_json_never_loses_a_concurrent_change(cloud):
    root, _ = cloud
    path = StoredPath(root) / 'avatar-factory' / '1' / ('l' * 24) / 'job.json'

    def bump(_):
        update_json(path, lambda document: {**document, 'n': document.get('n', 0) + 1}, attempts=200)

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(bump, range(48)))
    assert json.loads(path.read_bytes()) == {'n': 48}


def test_a_stale_version_is_refused(cloud):
    root, _ = cloud
    path = StoredPath(root) / 'avatar-factory' / '1' / ('m' * 24) / 'job.json'
    assert object_storage.read_json_versioned(path) == ({}, 0)
    assert object_storage.write_json_if_version(path, {'v': 1}, 0)
    assert not object_storage.write_json_if_version(path, {'v': 'again'}, 0)
    document, version = object_storage.read_json_versioned(path)
    assert document == {'v': 1} and version >= 1
    assert object_storage.write_json_if_version(path, {'v': 2}, version)
    assert not object_storage.write_json_if_version(path, {'v': 3}, version)
    assert json.loads(path.read_bytes()) == {'v': 2}


def test_update_json_gives_up_when_the_record_keeps_changing(cloud, monkeypatch):
    root, _ = cloud
    path = StoredPath(root) / 'avatar-factory' / '1' / ('n' * 24) / 'job.json'
    object_storage.write_json(path, {'n': 0})
    monkeypatch.setattr(object_storage, 'write_json_if_version', lambda *args: False)
    with pytest.raises(WriteConflict):
        update_json(path, lambda document: {**document, 'n': 1}, attempts=3)
    assert json.loads(path.read_bytes()) == {'n': 0}


def test_update_json_on_plain_files(disk):
    path = StoredPath(disk) / 'avatar-factory' / '1' / ('o' * 24) / 'job.json'
    path.parent.mkdir(parents=True)
    assert update_json(path, lambda document: {**document, 'a': 1}) == {'a': 1}
    assert update_json(path, lambda document: None) == {'a': 1}
    assert json.loads(path.read_text(encoding='utf-8')) == {'a': 1}


def test_another_process_write_shows_within_the_cache_horizon(cloud, database, monkeypatch):
    root, prefix = cloud
    path = StoredPath(root) / 'avatar-factory' / '1' / ('g' * 24) / 'job.json'
    path.write_text('{"v": 1}', encoding='utf-8')
    assert path.read_text(encoding='utf-8') == '{"v": 1}'
    with psycopg.connect(database, autocommit=True) as conn:
        conn.execute("UPDATE character_records.records SET content = '{\"v\": 2}', version = version + 1, "
                     "sha256 = %s WHERE prefix = %s AND path = %s",
                     (hashlib.sha256(b'{"v": 2}').hexdigest(), prefix, f'avatar-factory/1/{"g" * 24}/job.json'))
    monkeypatch.setattr(record_store, 'INDEX_SECONDS', 0)
    assert path.read_text(encoding='utf-8') == '{"v": 2}'


def test_large_records_keep_their_bytes_in_s3(cloud, s3, database):
    root, prefix = cloud
    job = StoredPath(root) / 'avatar-factory' / '1' / ('h' * 24)
    # An image response: a base64 PNG well above the inline limit.
    response = json.dumps({'data': [{'b64_json': 'A' * (3 * 1024 * 1024)}]}).encode()
    (job / 'output' / 'top-provider.response.json').write_bytes(response)
    digest = hashlib.sha256(response).hexdigest()
    row = _rows(database, prefix)[f'avatar-factory/1/{"h" * 24}/output/top-provider.response.json']
    assert row[0] is None and row[1] == f'{prefix}/record-blobs/{digest}.json' and row[2] is None
    assert s3.objects[row[1]]['Body'] == response
    assert (job / 'output' / 'top-provider.response.json').read_bytes() == response
    assert sha256(job / 'output' / 'top-provider.response.json') == digest
    assert [p.name for p in job.rglob('*.json')] == ['top-provider.response.json']
    (job / 'output' / 'top-provider.response.json').unlink()
    assert not (job / 'output' / 'top-provider.response.json').is_file()


def test_a_prefix_that_was_never_imported_is_refused(cloud, monkeypatch):
    root, _ = cloud
    monkeypatch.setenv('ASSET_S3_PREFIX', 'never-imported')
    path = StoredPath(root) / 'avatar-factory' / '1' / ('i' * 24) / 'job.json'
    with pytest.raises(record_store.RecordStoreUnavailable, match='never-imported'):
        path.is_file()
    with pytest.raises(record_store.RecordStoreUnavailable):
        path.write_text('{}', encoding='utf-8')


def test_blender_workspace_round_trip(cloud, s3, database):
    root, prefix = cloud
    job = StoredPath(root) / 'avatar-factory' / '1' / ('j' * 24)
    object_storage.write_json(job / 'record.json', {'status': 'running'})
    (job / 'body.glb').write_bytes(b'glTF body')
    with local_workspace(job):
        # The worker sees plain local files, then writes its outputs next to them.
        assert json.loads((job / 'record.json').read_text(encoding='utf-8')) == {'status': 'running'}
        assert (job / 'body.glb').read_bytes() == b'glTF body'
        (job / 'record.json').write_text('{"status": "done"}', encoding='utf-8')
        (job / 'fitted.glb').write_bytes(b'glTF fitted')
    assert _rows(database, prefix)[f'avatar-factory/1/{"j" * 24}/record.json'][2] == {'status': 'done'}
    assert s3.objects[f'{prefix}/avatar-factory/1/{"j" * 24}/fitted.glb']['Body'] == b'glTF fitted'
    assert not [path for path in root.rglob('*') if path.is_file()]


def test_health_pings_the_record_database(cloud):
    assert record_store.ping() == {'configured': True, 'ok': True}


def test_health_refuses_a_namespace_that_was_not_imported(cloud, monkeypatch):
    monkeypatch.setenv('ASSET_S3_PREFIX', 'never-imported')
    result = record_store.ping()
    assert result['configured'] is True and result['ok'] is False
    assert 'never-imported' in result['error']


def test_health_refuses_a_database_without_the_record_schema(database, monkeypatch):
    monkeypatch.setenv('CHARACTER_DATABASE_URL', database)
    with psycopg.connect(database, autocommit=True) as conn:
        conn.execute('ALTER SCHEMA character_records RENAME TO hidden_records')
    try:
        result = record_store.ping()
        assert result['configured'] is True and result['ok'] is False
    finally:
        with psycopg.connect(database, autocommit=True) as conn:
            conn.execute('ALTER SCHEMA hidden_records RENAME TO character_records')


def test_health_checks_record_columns_and_permissions(cloud, database, monkeypatch):
    with psycopg.connect(database, autocommit=True) as conn:
        conn.execute('ALTER TABLE character_records.records RENAME COLUMN content TO broken_content')
    try:
        result = record_store.ping()
        assert result['configured'] is True and result['ok'] is False
    finally:
        with psycopg.connect(database, autocommit=True) as conn:
            conn.execute('ALTER TABLE character_records.records RENAME COLUMN broken_content TO content')


def test_artifact_response_serves_records_from_the_database(cloud):
    root, _ = cloud
    path = StoredPath(root) / 'avatar-factory' / '1' / ('k' * 24) / 'output' / 'catalog.json'
    path.write_text('{"assets": []}', encoding='utf-8')
    response = object_storage.artifact_response(path)
    assert response.body == b'{"assets": []}'
    assert response.media_type == 'application/json'
    assert response.headers['cache-control'] == 'private, no-store'


@pytest.mark.anyio
@pytest.mark.parametrize('anyio_backend', ['asyncio'])
async def test_s3_models_stream_through_the_authenticated_origin_without_cors_or_redirect(cloud, s3, monkeypatch):
    from fastapi import FastAPI
    import httpx
    root, _ = cloud
    path = StoredPath(root) / 'avatar-factory' / '1' / ('k' * 24) / 'output' / 'model.glb'
    content = b'glTF' + b'x' * (600 * 1024)
    path.write_bytes(content)
    original = s3.get_object
    opened = []

    def get_object(**kwargs):
        value = original(**kwargs)
        opened.append(value['Body'])
        return {**value, 'ContentLength': len(content)}

    monkeypatch.setattr(s3, 'get_object', get_object)
    monkeypatch.setattr(s3, 'generate_presigned_url', lambda *args, **kwargs: pytest.fail('browser artifacts must stay same-origin'))
    response = object_storage.artifact_response(path, filename='모델.glb')
    assert response.status_code == 200 and 'location' not in response.headers
    assert response.headers['content-type'] == 'model/gltf-binary'
    assert response.headers['content-length'] == str(len(content))
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['content-disposition'].startswith("attachment; filename*=UTF-8''")
    app = FastAPI()
    app.add_api_route('/model.glb', lambda: response, methods=['GET'])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        received = await client.get('/model.glb')
    assert received.content == content
    assert opened[0].closed


# --- import and export ------------------------------------------------------------------------

def _seed(s3, prefix):
    job = f'{prefix}/avatar-factory/1/{"a" * 24}'
    s3.put(f'{job}/job.json', b'{"status": "approved"}')
    s3.put(f'{job}/parts/top/character.json', b'{"task_id": "t"}')
    s3.put(f'{job}/output/model.glb', b'glTF not a record')
    s3.put(f'{job}/.locks/run.json', b'{}')
    s3.put(f'{job}/output/top-provider.response.json', b'{"b64": "' + b'A' * (2 * 1024 * 1024) + b'"}')
    s3.put(f'{prefix}/avatar-blueprints/1/char/blueprint.json', b'{"v": 1}')
    s3.put(f'{prefix}/characters/batch.json', b'{"characters": []}')
    s3.put(f'{prefix}/unmapped/other.json', b'{}')
    s3.put('other-prefix/avatar-factory/1/x/job.json', b'{}')


@pytest.fixture
def importing(database, s3, monkeypatch):
    monkeypatch.setenv('ASSET_S3_BUCKET', 'fixture-bucket')
    prefix = f'import-{uuid.uuid4().hex[:8]}'
    _seed(s3, prefix)
    with psycopg.connect(database, autocommit=True) as conn:
        yield conn, prefix


def test_import_copies_records_and_skips_what_is_already_there(importing, s3, database):
    conn, prefix = importing
    dry = records.import_prefix(conn, s3, 'fixture-bucket', prefix, dry_run=True)
    assert (dry.listed, dry.inserted, dry.blobs) == (5, 5, 1)
    assert _rows(database, prefix) == {}
    assert conn.execute('SELECT 1 FROM character_records.namespaces WHERE prefix = %s', (prefix,)).fetchone() is None

    first = records.import_prefix(conn, s3, 'fixture-bucket', prefix)
    assert (first.inserted, first.updated, first.identical, first.blobs) == (5, 0, 0, 1)
    rows = _rows(database, prefix)
    assert set(rows) == {f'avatar-factory/1/{"a" * 24}/job.json', f'avatar-factory/1/{"a" * 24}/parts/top/character.json',
                         f'avatar-factory/1/{"a" * 24}/output/top-provider.response.json',
                         'avatar-blueprints/1/char/blueprint.json', 'characters/batch.json'}
    assert rows[f'avatar-factory/1/{"a" * 24}/job.json'][0] == b'{"status": "approved"}'
    large = rows[f'avatar-factory/1/{"a" * 24}/output/top-provider.response.json']
    assert large[0] is None and s3.objects[large[1]]['Body'] == s3.objects[
        f'{prefix}/avatar-factory/1/{"a" * 24}/output/top-provider.response.json']['Body']
    before = {key: dict(value) for key, value in s3.objects.items() if key.startswith(prefix + '/avatar')}

    # A second run lists again but reads nothing: every object predates the last import.
    s3.calls.clear()
    again = records.import_prefix(conn, s3, 'fixture-bucket', prefix)
    assert (again.inserted, again.updated, again.unchanged_since_import) == (0, 0, 5)
    assert 'get_object' not in s3.calls and 'delete_object' not in s3.calls
    # Its one write is the marker beside the records (see test_import_leaves_a_marker_...), never a record or artifact.
    assert s3.calls['put_object'] == 1 and f'{prefix}/.records-in-database' in s3.objects
    assert {key: value for key, value in s3.objects.items() if key.startswith(prefix + '/avatar')} == before


def test_import_reports_differences_and_never_overwrites_database_changes(importing, s3, database):
    conn, prefix = importing
    records.import_prefix(conn, s3, 'fixture-bucket', prefix)
    job = f'avatar-factory/1/{"a" * 24}'
    # The server changed one record in the database, then S3 changed it too (a server still on S3).
    conn.execute("UPDATE character_records.records SET content = '{\"status\": \"db\"}', sha256 = %s "
                 "WHERE prefix = %s AND path = %s", (hashlib.sha256(b'{"status": "db"}').hexdigest(), prefix, f'{job}/job.json'))
    s3.put(f'{prefix}/{job}/job.json', b'{"status": "s3"}', modified=datetime.now(timezone.utc) + timedelta(minutes=5))
    # S3 alone changed another; a third was deleted in the database; a fourth left S3.
    s3.put(f'{prefix}/{job}/parts/top/character.json', b'{"task_id": "t2"}', modified=datetime.now(timezone.utc) + timedelta(minutes=5))
    conn.execute('DELETE FROM character_records.records WHERE prefix = %s AND path = %s', (prefix, 'characters/batch.json'))
    del s3.objects[f'{prefix}/avatar-blueprints/1/char/blueprint.json']

    report = records.import_prefix(conn, s3, 'fixture-bucket', prefix)
    assert report.conflicts == [f'{job}/job.json']
    assert report.updated == 1
    assert report.not_restored == ['characters/batch.json']
    assert report.database_only == ['avatar-blueprints/1/char/blueprint.json']
    rows = _rows(database, prefix)
    assert rows[f'{job}/job.json'][0] == b'{"status": "db"}'
    assert rows[f'{job}/parts/top/character.json'][0] == b'{"task_id": "t2"}'
    assert 'characters/batch.json' not in rows
    lines = '\n'.join(report.lines(False))
    assert 'changed in both S3 and the database' in lines and 'not restored' in lines

    removed = records.import_prefix(conn, s3, 'fixture-bucket', prefix, delete_missing=True)
    assert removed.removed == 1 and 'avatar-blueprints/1/char/blueprint.json' not in _rows(database, prefix)


def test_export_writes_database_changes_back_to_s3(importing, s3, database):
    conn, prefix = importing
    records.import_prefix(conn, s3, 'fixture-bucket', prefix)
    job = f'avatar-factory/1/{"a" * 24}'
    conn.execute("UPDATE character_records.records SET content = '{\"status\": \"db\"}', sha256 = %s "
                 "WHERE prefix = %s AND path = %s", (hashlib.sha256(b'{"status": "db"}').hexdigest(), prefix, f'{job}/job.json'))
    conn.execute('INSERT INTO character_records.records (prefix, path, content, size, sha256) VALUES (%s, %s, %s, %s, %s)',
                 (prefix, f'{job}/new.json', b'{"new": true}', 13, hashlib.sha256(b'{"new": true}').hexdigest()))
    lines = []
    assert records.export_prefix(conn, s3, 'fixture-bucket', prefix, dry_run=True, out=lines.append) == 2
    assert s3.objects[f'{prefix}/{job}/job.json']['Body'] == b'{"status": "approved"}'
    assert records.export_prefix(conn, s3, 'fixture-bucket', prefix, out=lines.append) == 2
    assert s3.objects[f'{prefix}/{job}/job.json']['Body'] == b'{"status": "db"}'
    assert s3.objects[f'{prefix}/{job}/new.json']['Body'] == b'{"new": true}'
    assert records.export_prefix(conn, s3, 'fixture-bucket', prefix, out=lines.append) == 0


def test_command_line(database, s3, monkeypatch, capsys):
    monkeypatch.setenv('ASSET_S3_BUCKET', 'fixture-bucket')
    monkeypatch.setenv('CHARACTER_DATABASE_URL', database)
    prefix = f'cli-{uuid.uuid4().hex[:8]}'
    _seed(s3, prefix)
    records.main(['migrate'])
    records.main(['status', '--prefix', prefix])
    assert 'not imported' in capsys.readouterr().out
    records.main(['import', '--prefix', prefix, '--dry-run'])
    assert 'would insert 5' in capsys.readouterr().out
    records.main(['import', '--prefix', prefix])
    records.main(['status', '--prefix', prefix])
    out = capsys.readouterr().out
    assert 'insert 5' in out and f'{prefix}: imported' in out and '5 records' in out


def test_remote_paths_are_told_from_local_files(cloud):
    root, _ = cloud
    assert object_storage.is_remote(StoredPath(root) / 'avatar-factory' / '1' / ('p' * 24) / 'output' / 'a.glb')
    assert not object_storage.is_remote(StoredPath(root) / 'elsewhere' / 'a.glb')
    job = StoredPath(root) / 'avatar-factory' / '1' / ('q' * 24)
    with local_workspace(job):
        assert not object_storage.is_remote(job / 'output' / 'a.glb')


# --- import while the server runs, and the marker that keeps a server without the database away -----

def test_import_never_overwrites_a_row_the_server_changes_while_it_runs(importing, s3, database, monkeypatch):
    conn, prefix = importing
    records.import_prefix(conn, s3, 'fixture-bucket', prefix)
    job = f'avatar-factory/1/{"a" * 24}'
    later = datetime.now(timezone.utc) + timedelta(minutes=5)
    s3.put(f'{prefix}/{job}/job.json', b'{"status": "s3"}', modified=later)
    s3.put(f'{prefix}/{job}/parts/top/character.json', b'{"task_id": "t2"}', modified=later)
    s3.put(f'{prefix}/{job}/parts/new.json', b'{"new": "s3"}', modified=later)
    get = s3.get_object
    server = psycopg.connect(database, autocommit=True)

    def get_while_the_server_writes(**kwargs):
        # The import has its snapshot of the rows by now; the server writes before the batch does.
        if kwargs['Key'].endswith(f'{job}/job.json'):
            server.execute("UPDATE character_records.records SET content = %s, sha256 = %s, version = version + 1 "
                           "WHERE prefix = %s AND path = %s", (b'{"status": "server"}',
                           hashlib.sha256(b'{"status": "server"}').hexdigest(), prefix, f'{job}/job.json'))
        if kwargs['Key'].endswith('/parts/new.json'):
            server.execute('INSERT INTO character_records.records (prefix, path, content, size, sha256) VALUES (%s, %s, %s, %s, %s)',
                           (prefix, f'{job}/parts/new.json', b'{"new": "server"}', 16,
                            hashlib.sha256(b'{"new": "server"}').hexdigest()))
        return get(**kwargs)

    monkeypatch.setattr(s3, 'get_object', get_while_the_server_writes)
    with server:
        report = records.import_prefix(conn, s3, 'fixture-bucket', prefix)
    # Both rows are reported, and neither was written; the record nobody touched was updated as usual.
    assert sorted(report.conflicts) == [f'{job}/job.json', f'{job}/parts/new.json']
    assert (report.updated, report.inserted) == (1, 0)
    rows = _rows(database, prefix)
    assert rows[f'{job}/job.json'][0] == b'{"status": "server"}'
    assert rows[f'{job}/parts/new.json'][0] == b'{"new": "server"}'
    assert rows[f'{job}/parts/top/character.json'][0] == b'{"task_id": "t2"}'
    assert conn.execute('SELECT version FROM character_records.records WHERE prefix = %s AND path = %s',
                        (prefix, f'{job}/job.json')).fetchone()[0] == 2
    assert 'changed in both S3 and the database' in '\n'.join(report.lines(False))


def _marker(prefix):
    return f'{prefix}/.records-in-database'


def test_import_leaves_a_marker_and_export_removes_it(importing, s3, database):
    conn, prefix = importing
    records.import_prefix(conn, s3, 'fixture-bucket', prefix, dry_run=True)
    assert _marker(prefix) not in s3.objects
    records.import_prefix(conn, s3, 'fixture-bucket', prefix)
    marker = json.loads(s3.objects[_marker(prefix)]['Body'])
    assert marker['records'] == 'postgresql' and marker['schema'] == 'character_records' and marker['imported_at']
    # It lies outside the mapped namespaces: no import takes it for a record, no listing of a job shows it.
    assert records.import_prefix(conn, s3, 'fixture-bucket', prefix).listed == 5
    lines = []
    records.status(conn, [prefix], out=lines.append, s3=s3, bucket='fixture-bucket')
    assert lines[-1] == f'  S3 marker {_marker(prefix)}: present'
    # A dry run and a failed export leave it; only an export that put the records back removes it.
    records.export_prefix(conn, s3, 'fixture-bucket', prefix, dry_run=True, out=lambda line: None)
    assert _marker(prefix) in s3.objects
    job = f'avatar-factory/1/{"a" * 24}'
    conn.execute('UPDATE character_records.records SET sha256 = %s WHERE prefix = %s AND path = %s',
                 ('0' * 64, prefix, f'{job}/job.json'))
    with pytest.raises(SystemExit, match='do not match'):
        records.export_prefix(conn, s3, 'fixture-bucket', prefix, out=lambda line: None)
    assert _marker(prefix) in s3.objects
    conn.execute('UPDATE character_records.records SET sha256 = %s WHERE prefix = %s AND path = %s',
                 (hashlib.sha256(b'{"status": "approved"}').hexdigest(), prefix, f'{job}/job.json'))
    records.export_prefix(conn, s3, 'fixture-bucket', prefix, out=lambda line: None)
    assert _marker(prefix) not in s3.objects
    lines.clear()
    records.status(conn, [prefix], out=lines.append, s3=s3, bucket='fixture-bucket')
    assert lines[-1] == f'  S3 marker {_marker(prefix)}: absent'


def test_status_without_s3_names_no_marker_and_an_s3_error_does_not_fail_it(importing, s3, monkeypatch):
    conn, prefix = importing
    lines = []
    records.status(conn, [prefix], out=lines.append)
    assert len(lines) == 1 and 'marker' not in lines[0]

    def refuse(**kwargs):
        raise ClientError({'Error': {'Code': 'AccessDenied'}}, 'ListObjectsV2')

    monkeypatch.setattr(s3, 'list_objects_v2', refuse)
    records.status(conn, [prefix], out=lines.append, s3=s3, bucket='fixture-bucket')
    assert lines[-1] == f'  S3 marker {_marker(prefix)}: unknown (ClientError)'


def test_command_line_reports_and_clears_the_marker(database, s3, monkeypatch, capsys):
    monkeypatch.setenv('ASSET_S3_BUCKET', 'fixture-bucket')
    monkeypatch.setenv('CHARACTER_DATABASE_URL', database)
    prefix = f'cli-{uuid.uuid4().hex[:8]}'
    _seed(s3, prefix)
    records.main(['migrate'])
    records.main(['status', '--prefix', prefix])
    assert f'S3 marker {_marker(prefix)}: absent' in capsys.readouterr().out
    records.main(['import', '--prefix', prefix])
    records.main(['status', '--prefix', prefix])
    assert f'S3 marker {_marker(prefix)}: present' in capsys.readouterr().out
    records.main(['export', '--prefix', prefix])
    assert _marker(prefix) not in s3.objects


@pytest.fixture
def without_database(monkeypatch, s3):
    """A server with a bucket and no CHARACTER_DATABASE_URL, as after an instance lost its environment file."""
    monkeypatch.delenv('ASSET_STORAGE_WORKER_LOCAL', raising=False)
    monkeypatch.setenv('ASSET_S3_BUCKET', 'fixture-bucket')
    monkeypatch.setenv('ASSET_S3_PREFIX', 'assets')
    monkeypatch.setenv('CHARACTER_DATABASE_URL', '')
    return s3


def test_a_server_that_lost_the_database_refuses_to_use_the_stale_records(without_database):
    s3 = without_database
    object_storage.assert_records_mode()
    assert s3.calls == {'list_objects_v2': 1}
    s3.put('assets/.records-in-database', b'{}')
    with pytest.raises(RuntimeError) as refused:
        object_storage.assert_records_mode()
    message = str(refused.value)
    assert "'assets'" in message and 'CHARACTER_DATABASE_URL is not set' in message
    assert 'python -m src.records export --prefix assets' in message


def test_nothing_is_asked_of_s3_unless_records_could_have_moved(without_database, monkeypatch):
    s3 = without_database
    s3.put('assets/.records-in-database', b'{}')
    monkeypatch.setenv('CHARACTER_DATABASE_URL', 'postgresql://u:p@db.invalid/records')
    object_storage.assert_records_mode()
    monkeypatch.setenv('CHARACTER_DATABASE_URL', '')
    monkeypatch.setenv('ASSET_S3_BUCKET', '')
    object_storage.assert_records_mode()
    monkeypatch.setenv('ASSET_S3_BUCKET', 'fixture-bucket')
    monkeypatch.setenv('ASSET_STORAGE_WORKER_LOCAL', '1')
    object_storage.assert_records_mode()
    assert s3.calls == {}


@pytest.mark.parametrize('failure', [ClientError({'Error': {'Code': 'AccessDenied'}}, 'ListObjectsV2'), OSError('no route to S3')])
def test_a_check_that_cannot_answer_stops_the_server(without_database, monkeypatch, failure):
    def unavailable(**kwargs):
        raise failure

    monkeypatch.setattr(without_database, 'list_objects_v2', unavailable)
    with pytest.raises(RuntimeError, match='Could not verify the records storage mode'):
        object_storage.assert_records_mode()


def test_a_check_that_takes_too_long_stops_the_server_with_a_bounded_wait(without_database, monkeypatch):
    hang = threading.Event()
    monkeypatch.setattr(without_database, 'list_objects_v2', lambda **kwargs: hang.wait(10))
    try:
        with pytest.raises(RuntimeError, match='Could not verify the records storage mode'):
            started = datetime.now()
            object_storage.assert_records_mode(timeout=.05)
        assert (datetime.now() - started).total_seconds() < 5
    finally:
        hang.set()


def test_the_marker_follows_the_records_through_import_and_rollback(importing, s3, monkeypatch):
    conn, prefix = importing
    monkeypatch.delenv('ASSET_STORAGE_WORKER_LOCAL', raising=False)
    monkeypatch.setenv('ASSET_S3_PREFIX', prefix)
    monkeypatch.setenv('CHARACTER_DATABASE_URL', '')
    object_storage.assert_records_mode()
    records.import_prefix(conn, s3, 'fixture-bucket', prefix)
    with pytest.raises(RuntimeError, match=f"'{prefix}' live in PostgreSQL"):
        object_storage.assert_records_mode()
    # Another prefix of the same bucket is not affected.
    monkeypatch.setenv('ASSET_S3_PREFIX', 'elsewhere')
    object_storage.assert_records_mode()
    monkeypatch.setenv('ASSET_S3_PREFIX', prefix)
    records.export_prefix(conn, s3, 'fixture-bucket', prefix, out=lambda line: None)
    object_storage.assert_records_mode()


# --- rollback safety of export, migrations that changed, and S3 failure modes ------------------------------------

def test_export_keeps_the_marker_while_s3_holds_json_of_deleted_records(importing, s3, database):
    conn, prefix = importing
    records.import_prefix(conn, s3, 'fixture-bucket', prefix)
    # Deleted in the database while it held the records: a server on S3 would read the old JSON again.
    conn.execute('DELETE FROM character_records.records WHERE prefix = %s AND path = %s', (prefix, 'characters/batch.json'))
    lines = []
    with pytest.raises(SystemExit, match='marker kept'):
        records.export_prefix(conn, s3, 'fixture-bucket', prefix, out=lines.append)
    assert _marker(prefix) in s3.objects
    assert any(line.strip() == 'characters/batch.json' for line in lines) and any('--ignore-stale' in line for line in lines)
    records.export_prefix(conn, s3, 'fixture-bucket', prefix, out=lines.append, ignore_stale=True)
    assert _marker(prefix) not in s3.objects


def test_a_marker_the_role_may_not_delete_keeps_servers_refusing_and_says_so(importing, s3, database):
    conn, prefix = importing
    records.import_prefix(conn, s3, 'fixture-bucket', prefix)
    s3.denied_deletes.add(_marker(prefix))
    lines = []
    with pytest.raises(SystemExit, match='s3:DeleteObject was denied'):
        records.export_prefix(conn, s3, 'fixture-bucket', prefix, out=lines.append)
    assert _marker(prefix) in s3.objects
    assert any('keep refusing to start' in line and 's3:DeleteObject was denied' in line for line in lines)


def test_a_migration_that_changed_after_it_was_applied_is_refused(database, tmp_path, monkeypatch):
    folder = tmp_path / 'migrations'
    folder.mkdir()
    for path in records.MIGRATIONS.glob('*.sql'):
        (folder / path.name).write_bytes(path.read_bytes())
    monkeypatch.setattr(records, 'MIGRATIONS', folder)
    with psycopg.connect(database, autocommit=True) as conn:
        applied = dict(conn.execute('SELECT name, sha256 FROM character_records.migrations').fetchall())
        name = sorted(applied)[0]
        original = (folder / name).read_bytes()
        (folder / name).write_bytes(original + b'\n-- an edit after it was applied\n')
        with pytest.raises(SystemExit, match='new numbered migration'):
            records.migrate(conn, out=lambda line: None)
        assert dict(conn.execute('SELECT name, sha256 FROM character_records.migrations').fetchall()) == applied
        # The change goes into a new numbered file, applied once.
        (folder / name).write_bytes(original)
        (folder / '999_test_extra.up.sql').write_text('CREATE TABLE IF NOT EXISTS character_records.test_extra (id int)')
        lines = []
        records.migrate(conn, out=lines.append)
        records.migrate(conn, out=lines.append)
        assert lines.count('applied 999_test_extra.up.sql') == 1
        conn.execute('DROP TABLE character_records.test_extra')
        conn.execute("DELETE FROM character_records.migrations WHERE name = '999_test_extra.up.sql'")


def test_import_reads_every_page_of_a_listing(importing, s3, database):
    conn, prefix = importing
    s3.page_size = 2
    report = records.import_prefix(conn, s3, 'fixture-bucket', prefix)
    assert (report.listed, report.inserted) == (5, 5)


def test_an_attempt_whose_input_delete_is_refused_keeps_its_receipt_in_the_database(cloud, s3, database):
    from src.services import character_jobs
    root, prefix = cloud
    run = StoredPath(root) / 'avatar-factory' / '1' / ('r' * 24) / 'meshy'
    object_storage.write_json(run / 'character.json', {'stage': 'rigging', 'status': 'FAILED', 'task_id': 'task-1'})
    (run / 'rig-input.glb').write_bytes(b'glTF input')
    s3.denied_deletes.add(f'{prefix}/avatar-factory/1/{"r" * 24}/meshy/rig-input.glb')
    with pytest.raises(ClientError):
        character_jobs.archive_attempt(run, 'retry')
    # The database row goes last, so the refused S3 delete leaves the attempt whole and retryable.
    assert character_jobs.state(run)['status'] == 'FAILED' and (run / 'rig-input.glb').is_file()
    s3.denied_deletes.clear()
    character_jobs.archive_attempt(run, 'retry')
    assert not (run / 'character.json').is_file() and not (run / 'rig-input.glb').is_file()
