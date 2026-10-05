"""S3 answers that ask for a retry or say an object changed, the library's narrow listings, the narrowed record globs,
the digest of objects stored without a checksum, the migration check of /health and the listing views of finished
studio generations.

S3 is test_record_store's in-memory stand-in; the tests named for records run on the compose PostgreSQL like it.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path as LocalPath
import struct

import psycopg
import pytest
from botocore.exceptions import ClientError

from src.services import object_storage, record_store
from src.services.asset_editor import _write_json
from src.services.object_storage import ArtifactChanged, StorageConflict, StoredPath, sha256
from test_record_store import cloud, database, s3, s3_error  # noqa: F401  (fixtures)
from test_storage_workspace import JOB, bucket, clock, key  # noqa: F401  (fixtures)


@pytest.fixture
def no_wait(monkeypatch):
    monkeypatch.setattr(object_storage, '_CONFLICT_DELAYS', (0, 0, 0, 0))


# --- 409 ConditionalRequestConflict, a missing record blob, a 412 between HEAD and GET -----------------------------

def test_a_conflicting_write_is_sent_again_until_s3_takes_it(bucket, s3, no_wait, monkeypatch):
    path = bucket / 'avatar-factory' / '1' / JOB / 'lease.json'
    s3.conditional_writes.add(key(JOB, 'lease.json'))
    put_object, attempts = s3.put_object, []

    def conflict_clears(**kwargs):
        attempts.append(1)
        if len(attempts) == 3:
            # The other conditional write was abandoned: nothing exists, so this exclusive create goes through.
            s3.conditional_writes.clear()
        return put_object(**kwargs)

    monkeypatch.setattr(s3, 'put_object', conflict_clears)
    with path.open('xb') as stream:
        stream.write(b'{"n": 1}')
    assert len(attempts) == 3
    assert s3.objects[key(JOB, 'lease.json')]['Body'] == b'{"n": 1}'


@pytest.mark.parametrize('exclusive', [True, False])
def test_a_conflict_that_does_not_clear_is_a_retryable_error_not_an_existing_file(bucket, s3, no_wait, monkeypatch,
                                                                                exclusive):
    path = bucket / 'avatar-factory' / '1' / JOB / 'output' / 'model.glb'
    attempts = []

    def always_conflicting(**kwargs):
        attempts.append(kwargs.get('IfNoneMatch'))
        raise s3_error('ConditionalRequestConflict', 409, 'PutObject')

    monkeypatch.setattr(s3, 'put_object', always_conflicting)
    with pytest.raises(StorageConflict) as refused:
        if exclusive:
            with path.open('xb') as stream:
                stream.write(b'glTF')
        else:
            path.write_bytes(b'glTF')
    assert not isinstance(refused.value, FileExistsError)
    assert len(attempts) == len(object_storage._CONFLICT_DELAYS) + 1
    assert key(JOB, 'output/model.glb') not in s3.objects


def test_a_record_whose_blob_is_gone_is_a_missing_file(cloud, s3, monkeypatch):
    root, prefix = cloud
    path = StoredPath(root) / 'avatar-factory' / '1' / ('h' * 24) / 'output' / 'top-provider.response.json'
    response = json.dumps({'data': [{'b64_json': 'A' * (record_store.INLINE_LIMIT + 10)}]}).encode()
    path.write_bytes(response)
    blob = object_storage.record_blob_key(prefix, hashlib.sha256(response).hexdigest())
    assert object_storage.artifact_response(path).status_code == 200
    del s3.objects[blob]
    with pytest.raises(FileNotFoundError):
        object_storage.artifact_response(path)
    # A refusal is still a failure to find out, not a missing file.
    def refused(**kwargs):
        raise s3_error('AccessDenied', 403, 'HeadObject')

    monkeypatch.setattr(s3, 'head_object', refused)
    with pytest.raises(ClientError):
        object_storage.artifact_response(path)


def glb():
    """A one-triangle GLB whose JSON chunk alone describes it."""
    document = {'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0}],
                'meshes': [{'primitives': [{'attributes': {'POSITION': 0}, 'indices': 1}]}],
                'accessors': [{'count': 3}, {'count': 3}]}
    payload = json.dumps(document).encode()
    payload += b' ' * (-len(payload) % 4)
    return struct.pack('<4sIIII', b'glTF', 2, 20 + len(payload), len(payload), 0x4e4f534a) + payload


@pytest.mark.parametrize('races', [1, 2])
def test_model_stats_reads_a_model_replaced_between_its_two_reads_again(bucket, s3, monkeypatch, races):
    from src.services.avatar_factory import AvatarFactory
    from src.services.avatar_model_stats import model_stats
    from src.services.character_pipeline import PipelineError
    content = glb()
    job = bucket / 'avatar-factory' / '1' / JOB
    (job / 'output' / 'model.glb').write_bytes(content)
    object_storage.write_json(job / 'job.json', {'files': {'model.glb': hashlib.sha256(content).hexdigest()}})
    get_object, refused = s3.get_object, []

    def replaced_after_the_header(**kwargs):
        if kwargs.get('IfMatch') and len(refused) < races:
            refused.append(1)
            raise s3_error('PreconditionFailed', 412, 'GetObject')
        return get_object(**kwargs)

    monkeypatch.setattr(s3, 'get_object', replaced_after_the_header)
    factory = AvatarFactory(LocalPath(bucket))
    if races == 1:
        stats = model_stats(factory, 1, JOB, 'model.glb')
        assert stats['triangles'] == 1 and stats['vertices'] == 3 and stats['file_bytes'] == len(content)
    else:
        with pytest.raises(PipelineError) as changed:
            model_stats(factory, 1, JOB, 'model.glb')
        assert (changed.value.code, changed.value.status) == ('artifact_changed', 409)
        assert isinstance(changed.value.__cause__, ArtifactChanged)


# --- the library is listed one item at a time ------------------------------------------------------------------------

def test_a_file_check_in_the_library_lists_its_item_not_the_whole_library(bucket, s3, clock, monkeypatch):
    library = bucket / 'avatar-factory' / '1' / 'library'
    generation, other, reference = 'a' * 24, 'b' * 24, 'd' * 64 + '.png'
    for relative in (f'generations/{generation}/image.png', f'generations/{other}/image.png',
                     f'textures/{"c" * 24}/albedo.png', f'animal-references/{reference}'):
        s3.put(f'assets/avatar-factory/1/library/{relative}', b'png')
    listing, prefixes = s3.list_objects_v2, []

    def recorded(**kwargs):
        prefixes.append(kwargs['Prefix'])
        return listing(**kwargs)

    monkeypatch.setattr(s3, 'list_objects_v2', recorded)
    assert (library / 'generations' / generation / 'image.png').is_file()
    assert not (library / 'generations' / generation / 'model.glb').is_file()
    assert prefixes == [f'assets/avatar-factory/1/library/generations/{generation}/']
    # A file directly in a collection or in the library is listed by its own key, and a missing one stays missing
    # without another listing.
    assert (library / 'animal-references' / reference).is_file()
    assert not (library / 'catalog.png').is_file()
    assert not (library / 'catalog.png').is_file()
    assert prefixes[1:] == [f'assets/avatar-factory/1/library/animal-references/{reference}',
                            'assets/avatar-factory/1/library/catalog.png']
    # Written-through keys show at once; the horizon is the one every listing has.
    (library / 'catalog.png').write_bytes(b'png')
    assert (library / 'catalog.png').is_file() and len(prefixes) == 3
    clock[0] += object_storage._INDEX_SECONDS
    assert (library / 'generations' / generation / 'image.png').is_file()
    assert len(prefixes) == 4
    # Job directories keep one listing per job.
    assert object_storage._scope(key(JOB, 'parts/top/model.glb')) == f'assets/avatar-factory/1/{JOB}/'


def test_the_key_index_drops_expired_listings_before_fresh_ones(bucket, s3, clock, monkeypatch):
    monkeypatch.setattr(object_storage, '_TABLE_LIMIT', 3)
    for number in range(3):
        object_storage._index('fixture-bucket', f'assets/old-{number}/')
    clock[0] += object_storage._INDEX_SECONDS
    object_storage._index('fixture-bucket', 'assets/fresh-0/')
    assert sorted(prefix for _, prefix in object_storage._key_index) == [
        'assets/fresh-0/', 'assets/old-0/', 'assets/old-1/', 'assets/old-2/']
    object_storage._index('fixture-bucket', 'assets/fresh-1/')
    assert sorted(prefix for _, prefix in object_storage._key_index) == ['assets/fresh-0/', 'assets/fresh-1/']


# --- owner-wide record globs are narrowed in the database ------------------------------------------------------------

def test_the_like_pattern_only_widens_a_glob():
    like = record_store._like
    assert like('d/', None) is None and like('d/', '*') is None and like('d/', '**/*') is None
    assert like('d/', '[ab].json') is None
    assert like('d/', '*/job.json') == 'd/%/job.json'
    assert like('d/', 'parts/*/character.json') == 'd/parts/%/character.json'
    assert like('d/', '**/*.json') == 'd/%.json'
    assert like('d/', 'x/**/y.json') == 'd/%x/%y.json'
    assert like('d/', 'a?.json') == 'd/a_.json'
    assert like('d/', 'a[bc]/x.json') == 'd/a%'
    assert like('d_1%/', 'a%_\\*') == 'd\\_1\\%/a\\%\\_\\\\%'


def test_an_owner_wide_glob_leaves_unmatched_records_in_the_database(cloud):
    root, prefix = cloud
    paths = ['avatar-factory/1/top.json', 'avatar-factory/1/x/job.json', 'avatar-factory/1/x/parts/a.json',
             'avatar-factory/1/x/parts/job.json', 'avatar-factory/1/x_y/job.json', 'avatar-factory/1/xzy/job.json',
             'avatar-factory/1/a%b/job.json', 'avatar-factory/1/aXXb/job.json', 'avatar-factory/2/a\\b/job.json',
             'avatar-factory/2/aYb/job.json']
    for path in paths:
        record_store.put(prefix, path, content=b'{}', size=2, sha256=hashlib.sha256(b'{}').hexdigest())

    def listed(directory, pattern):
        return sorted(record_store.listing(prefix, directory, pattern))

    owner = 'avatar-factory/1/'
    # The database returns what LIKE matches: a wider set than the glob, never a narrower one.
    assert listed(owner, '*/job.json') == sorted(path for path in paths if path.startswith(owner)
                                                  and path.endswith('/job.json'))
    assert listed(owner, 'x_y/*.json') == ['avatar-factory/1/x_y/job.json']
    assert listed(owner, 'a%b/*.json') == ['avatar-factory/1/a%b/job.json']
    assert listed('avatar-factory/2/', 'a\\b/*.json') == ['avatar-factory/2/a\\b/job.json']
    assert listed('avatar-factory/', '**/a.json') == ['avatar-factory/1/x/parts/a.json']
    assert listed('avatar-factory/', '**/*.json') == sorted(paths)
    assert listed(owner, None) == sorted(path for path in paths if path.startswith(owner))
    # The glob itself still answers exactly what the pattern matches.
    base = StoredPath(root) / 'avatar-factory' / '1'
    assert [path.relative_to(base).as_posix() for path in base.glob('*/job.json')] == [
        'a%b/job.json', 'aXXb/job.json', 'x/job.json', 'x_y/job.json', 'xzy/job.json']
    assert [path.relative_to(base).as_posix() for path in base.glob('**/a.json')] == ['x/parts/a.json']


# --- the digest of an object stored without ChecksumSHA256 ------------------------------------------------------------

@pytest.fixture
def etags(s3, monkeypatch):
    """HEAD answers carry the ETag S3 gives; the objects put by hand have no ChecksumSHA256, as from other tools."""
    head_object = s3.head_object

    def with_etag(**kwargs):
        return {**head_object(**kwargs), 'ETag': '"%s"' % hashlib.md5(s3.objects[kwargs['Key']]['Body']).hexdigest()}

    monkeypatch.setattr(s3, 'head_object', with_etag)
    object_storage._digests.clear()
    yield
    object_storage._digests.clear()


def test_an_object_without_a_checksum_is_downloaded_once_per_version(bucket, s3, etags, monkeypatch):
    path = bucket / 'avatar-factory' / '1' / JOB / 'output' / 'model.glb'
    s3.put(key(JOB, 'output/model.glb'), b'glTF first')
    assert 'ChecksumSHA256' not in s3.objects[key(JOB, 'output/model.glb')]
    s3.calls.clear()
    for _ in range(3):
        assert sha256(path) == hashlib.sha256(b'glTF first').hexdigest()
        object_storage._cache.clear()  # a HEAD each time, as after its 2 s horizon
    assert s3.calls['get_object'] == 1 and s3.calls['head_object'] == 3
    # Another version has another ETag: it is downloaded again.
    s3.put(key(JOB, 'output/model.glb'), b'glTF second')
    object_storage._cache.clear()
    assert sha256(path) == hashlib.sha256(b'glTF second').hexdigest()
    assert s3.calls['get_object'] == 2
    monkeypatch.setattr(object_storage, '_DIGEST_LIMIT', 1)
    other = bucket / 'avatar-factory' / '1' / JOB / 'output' / 'other.glb'
    s3.put(key(JOB, 'output/other.glb'), b'glTF other')
    object_storage._key_index.clear()
    assert sha256(other) == hashlib.sha256(b'glTF other').hexdigest()
    assert [entry[1] for entry in object_storage._digests] == [key(JOB, 'output/other.glb')]


def test_an_object_replaced_after_its_head_is_hashed_as_it_is_now(bucket, s3, etags):
    path = bucket / 'avatar-factory' / '1' / JOB / 'output' / 'model.glb'
    s3.put(key(JOB, 'output/model.glb'), b'glTF first')
    stale = object_storage._head(path)
    s3.put(key(JOB, 'output/model.glb'), b'glTF second')
    # The HEAD of the first version is still within its horizon: the GET of that version is refused (412).
    assert object_storage._head(path) == stale
    assert sha256(path) == hashlib.sha256(b'glTF second').hexdigest()
    assert list(object_storage._digests) == []


# --- /health and the migrations this release ships -------------------------------------------------------------------

@pytest.fixture
def shipped(tmp_path, monkeypatch):
    """The release's migration files, in a directory the test may change."""
    from src import records
    directory = tmp_path / 'migrations'
    directory.mkdir()
    for path in records.MIGRATIONS.glob('*.sql'):
        (directory / path.name).write_bytes(path.read_bytes())
    monkeypatch.setattr(records, 'MIGRATIONS', directory)
    return directory


def test_health_is_ok_once_every_shipped_migration_is_applied(cloud, shipped):
    from src.api.server import _public_database_status
    assert record_store.ping() == {'configured': True, 'ok': True}
    assert _public_database_status(record_store.ping()) == {'configured': True, 'ok': True}


def test_health_reports_a_shipped_migration_the_database_has_not_applied(cloud, shipped):
    from src.api.server import _public_database_status
    (shipped / '004_next.up.sql').write_text('CREATE TABLE IF NOT EXISTS character_records.next (id int);\n',
                                             encoding='utf-8')
    result = record_store.ping()
    assert result['configured'] is True and result['ok'] is False and '004_next.up.sql' in result['error']
    # The public answer names neither the file nor the error.
    assert _public_database_status(result) == {'configured': True, 'ok': False}


def test_health_reports_an_applied_migration_whose_file_changed(cloud, shipped):
    path = shipped / '003_character_records.up.sql'
    path.write_bytes(path.read_bytes() + b'\n-- changed after it was applied\n')
    result = record_store.ping()
    assert result['ok'] is False and '003_character_records.up.sql' in result['error']


def test_health_stays_ok_on_a_database_that_a_newer_release_migrated(cloud, shipped, database):
    with psycopg.connect(database, autocommit=True) as conn:
        conn.execute("INSERT INTO character_records.migrations (name, sha256) VALUES ('999_newer.up.sql', 'x')")
    try:
        assert record_store.ping() == {'configured': True, 'ok': True}
    finally:
        with psycopg.connect(database, autocommit=True) as conn:
            conn.execute("DELETE FROM character_records.migrations WHERE name = '999_newer.up.sql'")


# --- listing views of finished studio generations ---------------------------------------------------------------------

@pytest.fixture(params=['disk', 's3'])
def generations(request, tmp_path, monkeypatch):
    """A StudioGenerations of owner 1 on local disk, or on S3 (the bucket fixture) where digests come from HEAD."""
    from src.services import studio_generations as module
    from src.services.avatar_factory import AvatarFactory
    if request.param == 's3':
        root = request.getfixturevalue('bucket')
    else:
        monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path / 'disk'))
        root = StoredPath(tmp_path / 'disk')
    reads = []
    read_json, read_digested = module.read_json, module._read_digested
    monkeypatch.setattr(module, 'read_json', lambda path, *args: (reads.append(path.name), read_json(path, *args))[1])
    monkeypatch.setattr(module, '_read_digested', lambda path: (reads.append(path.name), read_digested(path))[1])
    return module, module.StudioGenerations(AvatarFactory(LocalPath(root)), 1), reads


def save(service, job_id, **fields):
    record = {'id': job_id, 'request_key': f'key-{job_id}', 'kind': 'prop', 'category': 'furniture', 'name': '의자',
              'prompt': '나무 의자', 'size': 512, 'stage': 'complete', 'status': 'complete',
              'created_at': f'2026-10-05T00:00:0{job_id[0]}+00:00', 'files': {'image.png': 'a' * 64}, 'error': None,
              'provider': 'meshy', **fields}
    service.directory(job_id).mkdir(parents=True, exist_ok=True)
    _write_json(service.directory(job_id) / 'record.json', record)
    return record


def receipt(service, job_id, task_id):
    (service.directory(job_id) / 'meshy').mkdir(parents=True, exist_ok=True)
    _write_json(service.directory(job_id) / 'meshy' / 'character.json',
                {'task_id': task_id, 'progress': 100, 'status': 'SUCCEEDED'})


def test_a_listing_answers_unchanged_finished_generations_from_memory(generations):
    module, service, reads = generations
    prop, running = '1' * 24, '2' * 24
    save(service, prop)
    receipt(service, prop, 'task-1')
    save(service, running, status='paused', stage='model')
    first = service.listing('prop')['items']
    assert [(item['id'], item['status'], item['task_id']) for item in first] == [
        (running, 'paused', None), (prop, 'complete', 'task-1')]
    reads.clear()
    second = service.listing('prop')['items']
    assert second == first
    # The finished one is answered from memory; the paused one is read again, as it may change at any time.
    assert reads.count('record.json') == 1
    reads.clear()
    assert service.listing('texture')['items'] == [] and reads.count('record.json') == 1
    # A changed receipt or record is read again.
    receipt(service, prop, 'task-2')
    assert [item['task_id'] for item in service.listing('prop')['items'] if item['id'] == prop] == ['task-2']
    save(service, prop, name='새 의자')
    assert [item['name'] for item in service.listing('prop')['items'] if item['id'] == prop] == ['새 의자']
    # Views handed out are copies.
    service.listing('prop')['items'][1]['artifacts'].clear()
    assert service.listing('prop')['items'][1]['artifacts']


def test_a_finished_illustration_that_changes_later_is_not_answered_stale(generations):
    module, service, _ = generations
    illustration = '3' * 24
    save(service, illustration, kind='illustration', category=next(iter(module.DEFAULTS['illustration'])),
         provider=None, size=1024)
    assert service.listing('illustration')['items'][0]['rig'] is None
    save(service, illustration, kind='illustration', category=next(iter(module.DEFAULTS['illustration'])),
         provider=None, size=1024, rig={'sha256': 'b' * 64})
    assert service.listing('illustration')['items'][0]['rig'] == {'sha256': 'b' * 64}


def test_a_record_that_changes_while_it_is_read_is_not_kept(generations, monkeypatch):
    module, service, reads = generations
    job = '4' * 24
    save(service, job)
    read_digested = module._read_digested
    # Between the read that made the view and the read of the bytes for its key, the record was saved again.
    monkeypatch.setattr(module, '_read_digested', lambda path: ({'changed': True}, 'c' * 64)
                        if path.name == 'record.json' else read_digested(path))
    service.listing('prop')
    assert str(service.directory(job) / 'record.json') not in module._FINISHED
    monkeypatch.setattr(module, '_read_digested', read_digested)
    reads.clear()
    service.listing('prop')
    assert reads.count('record.json') == 2  # read for the view, and for the digest it is kept under
    reads.clear()
    service.listing('prop')
    assert reads.count('record.json') == 0


def test_kept_views_are_bounded(generations, monkeypatch):
    module, service, _ = generations
    monkeypatch.setattr(module, '_FINISHED_LIMIT', 1)
    save(service, '5' * 24)
    save(service, '6' * 24)
    assert len(service.listing('prop')['items']) == 2
    assert len(module._FINISHED) == 1
