"""Blender workspaces, server-side replace and the bounded caches of StoredPath, against an in-memory S3.

The S3-only tests need no database. The ones named for records run on the compose PostgreSQL like test_record_store.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path as LocalPath
from threading import Event, Thread
import time
from types import SimpleNamespace

import pytest
from botocore.exceptions import ClientError

from src.services import object_storage, record_store
from src.services.object_storage import StoredPath, WorkspaceUploadError, local_workspace
from test_record_store import _clear_s3_caches, _rows, cloud, database, s3  # noqa: F401  (fixtures)

JOB = 'a' * 24


@pytest.fixture
def bucket(monkeypatch, tmp_path, s3):
    """S3 alone, with the JSON records as objects of the bucket, as before the record database."""
    monkeypatch.delenv('ASSET_STORAGE_WORKER_LOCAL', raising=False)
    monkeypatch.setenv('ASSET_S3_BUCKET', 'fixture-bucket')
    monkeypatch.setenv('ASSET_S3_PREFIX', 'assets')
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path / 'cloud'))
    monkeypatch.setenv('CHARACTER_DATABASE_URL', '')
    record_store.reset()
    _clear_s3_caches()
    object_storage._changes.clear()
    yield StoredPath(tmp_path / 'cloud')
    _clear_s3_caches()
    object_storage._changes.clear()


def key(job, name):
    return f'assets/avatar-factory/1/{job}/{name}'


def scratch(directory):
    """The files the local disk holds below a directory, relative to it."""
    return sorted(path.relative_to(directory).as_posix() for path in LocalPath(directory).rglob('*') if path.is_file())


def refuse_uploads(s3, monkeypatch, *suffixes):
    """S3 fails every upload of a key that ends with one of `suffixes`. Returns put_object as it was."""
    original = s3.put_object

    def put_object(**kwargs):
        if kwargs['Key'].endswith(suffixes):
            raise ClientError({'Error': {'Code': 'InternalError', 'Message': 'try again'}}, 'PutObject')
        return original(**kwargs)

    monkeypatch.setattr(s3, 'put_object', put_object)
    return original


def test_a_workspace_stores_what_the_worker_wrote_and_clears_its_scratch(bucket, s3):
    job = bucket / 'avatar-factory' / '1' / JOB
    other = bucket / 'avatar-factory' / '1' / ('b' * 24) / 'output' / 'body.glb'
    other.write_bytes(b'glTF body')
    (job / 'record.json').write_text('{"status": "running"}', encoding='utf-8')
    (job / 'input.glb').write_bytes(b'glTF input')
    with local_workspace(job, inputs=[other]):
        assert LocalPath(other).read_bytes() == b'glTF body'
        assert (job / 'input.glb').read_bytes() == b'glTF input'
        (job / 'record.json').write_text('{"status": "complete"}', encoding='utf-8')
        (job / 'fitted.glb').write_bytes(b'glTF fitted')
    assert json.loads(s3.objects[key(JOB, 'record.json')]['Body']) == {'status': 'complete'}
    assert s3.objects[key(JOB, 'fitted.glb')]['Body'] == b'glTF fitted'
    assert scratch(bucket) == []
    assert object_storage._materialized == {} and object_storage._directory_locks == {}


def test_completion_is_published_only_after_its_evidence_is_stored(bucket, s3, monkeypatch, caplog):
    job = bucket / 'avatar-factory' / '1' / JOB
    other = bucket / 'avatar-factory' / '1' / ('b' * 24) / 'output' / 'body.glb'
    other.write_bytes(b'glTF body')
    (job / 'record.json').write_text('{"status": "running"}', encoding='utf-8')
    (job / 'input.glb').write_bytes(b'glTF input')
    refuse_uploads(s3, monkeypatch, '/fitted.glb')
    with caplog.at_level(logging.WARNING, logger='src.services.object_storage'):
        with pytest.raises(WorkspaceUploadError) as caught:
            with local_workspace(job, inputs=[other]):
                (job / 'record.json').write_text('{"status": "complete"}', encoding='utf-8')
                (job / 'fitted.glb').write_bytes(b'glTF fitted')
                (job / 'front.png').write_bytes(b'png front')
                (job / 'quality.json').write_text('{"ok": true}', encoding='utf-8')
    # One error names what did not make it: the artifact, and the record that was held back for it.
    message = str(caught.value)
    assert 'fitted.glb (ClientError)' in message and 'record.json (withheld' in message
    assert 'front.png' not in message and 'quality.json' not in message
    assert isinstance(caught.value.__cause__, ClientError)
    assert 'fitted.glb was not stored' in caplog.text
    # The record still says what the last checkpoint said; everything that could be stored was.
    assert json.loads(s3.objects[key(JOB, 'record.json')]['Body']) == {'status': 'running'}
    assert key(JOB, 'fitted.glb') not in s3.objects
    assert s3.objects[key(JOB, 'front.png')]['Body'] == b'png front'
    assert json.loads(s3.objects[key(JOB, 'quality.json')]['Body']) == {'ok': True}
    # Only what failed stays on disk, and the bookkeeping ran to the end.
    assert scratch(bucket) == [f'avatar-factory/1/{JOB}/fitted.glb', f'avatar-factory/1/{JOB}/record.json']
    assert LocalPath(job / 'record.json').read_text(encoding='utf-8') == '{"status": "complete"}'
    assert object_storage._materialized == {} and object_storage._directory_locks == {}


def test_a_failing_final_record_does_not_stop_the_others(bucket, s3, monkeypatch):
    job = bucket / 'avatar-factory' / '1' / JOB
    refuse_uploads(s3, monkeypatch, '/record.json')
    with pytest.raises(WorkspaceUploadError, match=r'stay on disk: record\.json \(ClientError\)$'):
        with local_workspace(job):
            (job / 'record.json').write_text('{"status": "complete"}', encoding='utf-8')
            (job / 'delivery.json').write_text('{"version": 1}', encoding='utf-8')
            (job / 'model.glb').write_bytes(b'glTF')
    assert key(JOB, 'model.glb') in s3.objects and key(JOB, 'delivery.json') in s3.objects
    assert scratch(bucket) == [f'avatar-factory/1/{JOB}/record.json']


def test_an_error_in_the_body_is_not_masked_by_failed_uploads(bucket, s3, monkeypatch, caplog):
    job = bucket / 'avatar-factory' / '1' / JOB
    refuse_uploads(s3, monkeypatch, '/fitted.glb')

    class BlenderCrashed(RuntimeError):
        pass

    with caplog.at_level(logging.ERROR, logger='src.services.object_storage'):
        with pytest.raises(BlenderCrashed):
            with local_workspace(job):
                (job / 'fitted.glb').write_bytes(b'glTF fitted')
                (job / 'partial.png').write_bytes(b'png')
                raise BlenderCrashed('exit code 1')
    assert 'fitted.glb was not stored' in caplog.text
    assert key(JOB, 'partial.png') in s3.objects
    assert scratch(bucket) == [f'avatar-factory/1/{JOB}/fitted.glb']


def test_files_left_by_a_failed_upload_go_up_when_the_next_workspace_ends(bucket, s3, monkeypatch):
    job = bucket / 'avatar-factory' / '1' / JOB
    (job / 'record.json').write_text('{"status": "running"}', encoding='utf-8')
    working = refuse_uploads(s3, monkeypatch, '/fitted.glb')
    with pytest.raises(WorkspaceUploadError):
        with local_workspace(job):
            (job / 'fitted.glb').write_bytes(b'glTF fitted')
    assert scratch(bucket) == [f'avatar-factory/1/{JOB}/fitted.glb']
    # S3 is back. The next workspace finds the file on the disk and in no store: it is not an unchanged download.
    monkeypatch.setattr(s3, 'put_object', working)
    with local_workspace(job):
        assert (job / 'fitted.glb').read_bytes() == b'glTF fitted'
    assert s3.objects[key(JOB, 'fitted.glb')]['Body'] == b'glTF fitted'
    assert scratch(bucket) == []
    # Stored, it is an ordinary download from now on.
    with local_workspace(job):
        (job / 'fitted.glb').read_bytes()
    assert scratch(bucket) == []


def test_a_stored_file_is_not_replaced_by_a_stale_leftover(bucket, s3, monkeypatch, caplog):
    job = bucket / 'avatar-factory' / '1' / JOB
    (job / 'record.json').write_text('{"status": "running"}', encoding='utf-8')
    working = refuse_uploads(s3, monkeypatch, '/fitted.glb')
    with pytest.raises(WorkspaceUploadError):
        with local_workspace(job):
            (job / 'record.json').write_text('{"status": "complete"}', encoding='utf-8')
            (job / 'fitted.glb').write_bytes(b'glTF fitted')
    # The control plane accepted a new run in the meantime; what the store holds is the current state.
    object_storage.write_json(job / 'record.json', {'status': 'accepted'})
    monkeypatch.setattr(s3, 'put_object', working)
    with caplog.at_level(logging.WARNING, logger='src.services.object_storage'):
        with local_workspace(job):
            assert json.loads((job / 'record.json').read_text(encoding='utf-8')) == {'status': 'accepted'}
    assert 'record.json differs from the stored one' in caplog.text and 'fitted.glb differs' not in caplog.text
    assert json.loads(s3.objects[key(JOB, 'record.json')]['Body']) == {'status': 'accepted'}
    assert s3.objects[key(JOB, 'fitted.glb')]['Body'] == b'glTF fitted'


def test_a_failed_entry_gives_back_the_inputs_it_took(bucket, s3):
    job = bucket / 'avatar-factory' / '1' / JOB
    first = bucket / 'avatar-factory' / '1' / ('b' * 24) / 'output' / 'first.glb'
    second = bucket / 'avatar-factory' / '1' / ('b' * 24) / 'output' / 'second.glb'
    first.write_bytes(b'glTF first')
    second.write_bytes(b'glTF second')
    LocalPath(second).parent.mkdir(parents=True, exist_ok=True)
    LocalPath(second).write_bytes(b'glTF something else')
    with pytest.raises(ValueError, match='differs'):
        with local_workspace(job, inputs=[first, second]):
            pytest.fail('the workspace must not open')
    assert object_storage._materialized == {} and object_storage._directory_locks == {}
    assert not LocalPath(first).exists() and LocalPath(second).read_bytes() == b'glTF something else'


def test_one_workspace_per_directory_and_no_lock_left_behind(bucket, s3):
    job = bucket / 'avatar-factory' / '1' / JOB
    inside, release, order = Event(), Event(), []

    def first():
        with local_workspace(job):
            order.append('first in')
            inside.set()
            release.wait(5)
            order.append('first out')

    def second():
        inside.wait(5)
        with local_workspace(job):
            order.append('second in')

    threads = [Thread(target=first), Thread(target=second)]
    for thread in threads:
        thread.start()
    inside.wait(5)
    # The second workspace is waiting for the directory; it counts as a holder of the lock.
    deadline = time.monotonic() + 5
    while object_storage._directory_locks.get(LocalPath(job).resolve(), [None, 0])[1] < 2 and time.monotonic() < deadline:
        time.sleep(.01)
    assert object_storage._directory_locks[LocalPath(job).resolve()][1] == 2
    assert order == ['first in']
    release.set()
    for thread in threads:
        thread.join(5)
    assert order == ['first in', 'first out', 'second in']
    assert object_storage._directory_locks == {}


def test_completion_waits_for_its_evidence_in_the_record_database_too(cloud, s3, database, monkeypatch):
    root, prefix = cloud
    job = StoredPath(root) / 'avatar-factory' / '1' / JOB
    row = f'avatar-factory/1/{JOB}/record.json'
    object_storage.write_json(job / 'record.json', {'status': 'running'})
    working = refuse_uploads(s3, monkeypatch, '/fitted.glb')
    with pytest.raises(WorkspaceUploadError, match=r'fitted\.glb'):
        with local_workspace(job):
            (job / 'record.json').write_text('{"status": "complete"}', encoding='utf-8')
            (job / 'fitted.glb').write_bytes(b'glTF fitted')
            (job / 'quality.json').write_text('{"ok": true}', encoding='utf-8')
    rows = _rows(database, prefix)
    assert rows[row][2] == {'status': 'running'}
    assert rows[f'avatar-factory/1/{JOB}/quality.json'][2] == {'ok': True}
    # A JSON record that fails to store holds the completion back as well.
    monkeypatch.setattr(s3, 'put_object', working)
    put = record_store.put

    def refuse_json(prefix, path, **kwargs):
        if path.endswith(('/quality.json', '/report.json')):
            raise record_store.RecordStoreUnavailable('database is away')
        return put(prefix, path, **kwargs)

    monkeypatch.setattr(record_store, 'put', refuse_json)
    with pytest.raises(WorkspaceUploadError, match=r'quality\.json \(RecordStoreUnavailable\)'):
        with local_workspace(job):
            (job / 'record.json').write_text('{"status": "complete"}', encoding='utf-8')
            (job / 'quality.json').write_text('{"ok": false}', encoding='utf-8')
            (job / 'report.json').write_text('{"bones": 22}', encoding='utf-8')
    assert _rows(database, prefix)[row][2] == {'status': 'running'}
    assert scratch(root) == sorted(f'avatar-factory/1/{JOB}/{name}' for name in ('quality.json', 'record.json', 'report.json'))
    # A record the database never had, left on the disk by that failure, is stored by the next workspace.
    monkeypatch.setattr(record_store, 'put', put)
    with local_workspace(job):
        assert json.loads((job / 'report.json').read_text(encoding='utf-8')) == {'bones': 22}
    rows = _rows(database, prefix)
    assert rows[f'avatar-factory/1/{JOB}/report.json'][2] == {'bones': 22}
    assert scratch(root) == []


# --- replace ----------------------------------------------------------------------------------

def test_replacing_between_plain_objects_copies_inside_s3(bucket, s3):
    output = bucket / 'avatar-factory' / '1' / JOB / 'output'
    (output / 'model.glb.part').write_bytes(b'glTF' + bytes(1000))
    s3.calls.clear()
    assert (output / 'model.glb.part').replace(output / 'model.glb') == output / 'model.glb'
    # No byte of the model passed through this process, and S3 ends up as a rename would leave it.
    assert s3.calls['copy_object'] == 1 and s3.calls['delete_object'] == 1
    assert 'get_object' not in s3.calls and 'put_object' not in s3.calls
    assert key(JOB, 'output/model.glb.part') not in s3.objects
    assert s3.objects[key(JOB, 'output/model.glb')]['Body'] == b'glTF' + bytes(1000)
    assert not (output / 'model.glb.part').is_file() and (output / 'model.glb').is_file()
    assert (output / 'model.glb').read_bytes() == b'glTF' + bytes(1000)


def test_replace_falls_back_to_a_copy_through_this_process(bucket, s3, monkeypatch):
    output = bucket / 'avatar-factory' / '1' / JOB / 'output'
    (output / 'model.glb.part').write_bytes(b'glTF')

    def refuse(**kwargs):
        raise ClientError({'Error': {'Code': 'InternalError'}}, 'CopyObject')

    monkeypatch.setattr(s3, 'copy_object', refuse)
    s3.calls.clear()
    (output / 'model.glb.part').replace(output / 'model.glb')
    assert s3.calls['get_object'] == 1 and s3.calls['put_object'] == 1 and s3.calls['delete_object'] == 1
    assert s3.objects[key(JOB, 'output/model.glb')]['Body'] == b'glTF'
    assert key(JOB, 'output/model.glb.part') not in s3.objects


def test_replacing_a_missing_object_still_fails_like_a_file(bucket, s3):
    output = bucket / 'avatar-factory' / '1' / JOB / 'output'
    with pytest.raises(FileNotFoundError):
        (output / 'nothing.glb').replace(output / 'model.glb')
    assert s3.objects == {}


def test_replace_over_a_record_still_goes_through_the_database(cloud, s3):
    root, _ = cloud
    output = StoredPath(root) / 'avatar-factory' / '1' / JOB / 'output'
    (output / 'response.partial').write_bytes(b'{"data": []}')
    s3.calls.clear()
    (output / 'response.partial').replace(output / 'response.json')
    assert 'copy_object' not in s3.calls
    assert (output / 'response.json').read_bytes() == b'{"data": []}'
    assert not (output / 'response.partial').is_file()


# --- bounded caches -----------------------------------------------------------------------------

@pytest.fixture
def clock(monkeypatch):
    """object_storage's notion of monotonic time, moved by hand."""
    now = [1000.0]
    monkeypatch.setattr(object_storage, 'time', SimpleNamespace(monotonic=lambda: now[0]))
    return now


def test_written_keys_are_forgotten_once_no_listing_can_miss_them(bucket, s3, clock):
    output = bucket / 'avatar-factory' / '1' / JOB / 'output'
    (output / 'one.glb').write_bytes(b'1')
    assert list(object_storage._written_keys['fixture-bucket']) == [key(JOB, 'output/one.glb')]
    clock[0] += 119
    (output / 'two.glb').write_bytes(b'2')
    assert list(object_storage._written_keys['fixture-bucket']) == [key(JOB, 'output/one.glb'), key(JOB, 'output/two.glb')]
    clock[0] += 2
    (output / 'three.glb').write_bytes(b'3')
    assert list(object_storage._written_keys['fixture-bucket']) == [key(JOB, 'output/two.glb'), key(JOB, 'output/three.glb')]
    # A key written again is as young as that write.
    clock[0] += 100
    (output / 'two.glb').write_bytes(b'22')
    clock[0] += 30
    (output / 'four.glb').write_bytes(b'4')
    assert list(object_storage._written_keys['fixture-bucket']) == [key(JOB, 'output/two.glb'), key(JOB, 'output/four.glb')]
    # Deleting a key forgets it at once.
    (output / 'two.glb').unlink()
    assert list(object_storage._written_keys['fixture-bucket']) == [key(JOB, 'output/four.glb')]


def test_a_key_that_another_process_deleted_is_not_listed_for_ever(bucket, s3, clock):
    output = bucket / 'avatar-factory' / '1' / JOB / 'output'
    (output / 'gone.glb').write_bytes(b'1')
    (output / 'kept.glb').write_bytes(b'2')
    del s3.objects[key(JOB, 'output/gone.glb')]
    # Once no listing can have missed this process's writes, they stop being added to what S3 says.
    clock[0] += 121
    assert [path.name for path in output.glob('*.glb')] == ['kept.glb']
    assert not (output / 'gone.glb').is_file()


def test_a_rewritten_key_is_as_young_as_its_last_write(bucket, s3, clock, monkeypatch):
    monkeypatch.setattr(object_storage, '_TABLE_LIMIT', 2)
    output = bucket / 'avatar-factory' / '1' / JOB / 'output'
    names = {}
    for name, moment in (('a', 0), ('b', 10), ('a', 500), ('c', 1000)):
        clock[0] = 1000 + moment
        (output / f'{name}.glb').write_bytes(b'x')
        names[key(JOB, f'output/{name}.glb')] = name
    # b is the oldest by the clock, and the only one dropped; a sits behind it because it was written again.
    assert [names[key[1]] for key in object_storage._generations] == ['a', 'c']


def test_a_listing_that_began_before_a_write_still_sees_it(bucket, s3, clock, monkeypatch):
    output = bucket / 'avatar-factory' / '1' / JOB / 'output'
    (output / 'early.glb').write_bytes(b'1')
    listing, written = s3.list_objects_v2, []

    def list_while_a_write_lands(**kwargs):
        result = listing(**kwargs)
        if not written:
            written.append(1)
            (output / 'late.glb').write_bytes(b'2')
        return result

    monkeypatch.setattr(s3, 'list_objects_v2', list_while_a_write_lands)
    _clear_s3_caches()
    assert sorted(path.name for path in output.glob('*.glb')) == ['early.glb', 'late.glb']
    # The index that listing built has the late key as well: nothing lists again within its horizon.
    s3.calls.clear()
    assert sorted(path.name for path in output.glob('*.glb')) == ['early.glb', 'late.glb']
    assert 'list_objects_v2' not in s3.calls


def test_change_tables_only_forget_what_is_old_and_large(bucket, s3, clock, monkeypatch):
    monkeypatch.setattr(object_storage, '_TABLE_LIMIT', 5)
    for number in range(12):
        job = bucket / 'avatar-factory' / '1' / f'{number:024x}'
        (job / 'model.glb').write_bytes(b'glTF')
    # Fresh entries stay however many there are: a read that began before them may still be running.
    assert len(object_storage._generations) == 12 and len(object_storage._changes) == 12
    for number in range(12, 40):
        clock[0] += 700
        job = bucket / 'avatar-factory' / '1' / f'{number:024x}'
        (job / 'model.glb').write_bytes(b'glTF')
    assert len(object_storage._generations) == 5 and len(object_storage._changes) == 5
    newest = bucket / 'avatar-factory' / '1' / f'{39:024x}' / 'model.glb'
    assert object_storage.changed_since(newest, clock[0] - 1)
    assert not object_storage.changed_since(newest, clock[0] + 1)


def test_a_read_that_overlaps_a_write_does_not_keep_the_old_bytes(bucket, s3, monkeypatch):
    path = bucket / 'avatar-factory' / '1' / JOB / 'state.json'
    path.write_text('{"v": 1}', encoding='utf-8')
    get = s3.get_object
    raced = []

    def get_then_get_overwritten(**kwargs):
        response = get(**kwargs)
        if not raced:
            raced.append(1)
            path.write_text('{"v": 2}', encoding='utf-8')
        return response

    monkeypatch.setattr(s3, 'get_object', get_then_get_overwritten)
    assert path.read_text(encoding='utf-8') == '{"v": 1}'
    assert path.read_text(encoding='utf-8') == '{"v": 2}'


# --- S3 answers as domain errors, its failure modes, and copies of large bytes -------------------------------------

@pytest.mark.parametrize('race', ['exists', 'in_progress'])
def test_an_exclusive_create_that_loses_the_race_is_a_file_exists_error(bucket, s3, monkeypatch, race):
    path = bucket / 'avatar-factory' / '1' / JOB / 'lease.json'
    if race == 'exists':
        # Another writer stored it after this one looked (412 Precondition Failed).
        s3.put(key(JOB, 'lease.json'), b'{"n": 0}')
        monkeypatch.setattr(StoredPath, 'is_file', lambda self: False)
    else:
        # Another conditional write of the key is in progress (409 Conditional Request Conflict).
        s3.conditional_writes.add(key(JOB, 'lease.json'))
    with pytest.raises(FileExistsError):
        with path.open('xb') as stream:
            stream.write(b'{"n": 1}')
    assert s3.objects.get(key(JOB, 'lease.json'), {}).get('Body') in (None, b'{"n": 0}')


def test_ranged_reads_answer_missing_changed_and_out_of_range_as_files_do(bucket, s3, monkeypatch):
    path = bucket / 'avatar-factory' / '1' / JOB / 'output' / 'model.glb'
    with pytest.raises(FileNotFoundError):
        object_storage.read_byte_range(path, 0, 20)
    path.write_bytes(b'glTF' + b'x' * 60)
    content, total, etag, _ = object_storage.read_byte_range(path, 0, 20)
    assert content == b'glTF' + b'x' * 16 and total == 64
    s3.put(key(JOB, 'output/model.glb'), b'glTF' + b'y' * 60)
    with pytest.raises(ValueError, match='changed'):
        object_storage.read_byte_range(path, 20, 10, etag=etag)
    with pytest.raises(ValueError, match='Incomplete'):
        object_storage.read_byte_range(path, 64, 10)


def test_model_stats_of_a_missing_model_is_not_found(bucket, s3):
    from src.services.avatar_factory import AvatarFactory
    from src.services.avatar_model_stats import model_stats
    from src.services.character_pipeline import PipelineError
    factory = AvatarFactory(LocalPath(bucket))
    object_storage.write_json(bucket / 'avatar-factory' / '1' / JOB / 'job.json', {'files': {'model.glb': 'a' * 64}})
    with pytest.raises(PipelineError) as missing:
        model_stats(factory, 1, JOB, 'model.glb')
    assert missing.value.status == 404
    (bucket / 'avatar-factory' / '1' / JOB / 'output' / 'model.glb').write_bytes(b'not a glb at all, but long enough')
    with pytest.raises(PipelineError) as invalid:
        model_stats(factory, 1, JOB, 'model.glb')
    assert invalid.value.status == 422


def test_a_head_that_s3_refuses_is_not_taken_for_a_missing_file(bucket, s3):
    # A role that may not list a key gets 403 for a missing one: that cannot be told from a real denial.
    s3.forbidden_heads = True
    with pytest.raises(ClientError):
        (bucket / 'avatar-factory' / '1' / 'shallow.json').is_file()


def test_listings_read_every_page(bucket, s3):
    s3.page_size = 2
    job = bucket / 'avatar-factory' / '1' / JOB
    names = [f'part-{index}.glb' for index in range(7)]
    for name in names:
        (job / 'output' / name).write_bytes(b'glTF')
    _clear_s3_caches()
    assert [path.name for path in (job / 'output').glob('*.glb')] == names
    assert object_storage._holds_artifacts('fixture-bucket', key(JOB, 'output/'))
    assert s3.calls['list_objects_v2'] >= 4


def test_an_attempt_whose_input_delete_is_refused_stays_retryable(bucket, s3):
    """A role without s3:DeleteObject refuses the delete of rig-input.glb. The attempt must stay as it was, not lose
    its receipt and leave an input behind that refuses every new submission as an "Existing run"."""
    from src.services import character_jobs
    run = bucket / 'avatar-factory' / '1' / JOB / 'meshy'
    object_storage.write_json(run / 'character.json', {'stage': 'rigging', 'status': 'FAILED', 'task_id': 'task-1'})
    object_storage.write_json(run / 'rigging-result.json', {'status': 'FAILED'})
    (run / 'rig-input.glb').write_bytes(b'glTF input')
    s3.denied_deletes.add(key(JOB, 'meshy/rig-input.glb'))
    with pytest.raises(ClientError):
        character_jobs.archive_attempt(run, 'retry')
    assert character_jobs.state(run)['status'] == 'FAILED'
    assert (run / 'rig-input.glb').is_file() and (run / 'rigging-result.json').is_file()
    # Once the role may delete, the same retry archives the attempt and frees the run for a new submission.
    s3.denied_deletes.clear()
    assert character_jobs.archive_attempt(run, 'retry') == 2
    assert not (run / 'character.json').is_file() and not (run / 'rig-input.glb').is_file()
    archived = json.loads((run / 'attempts' / '2' / 'archive.json').read_text(encoding='utf-8'))
    assert archived['task_id'] == 'task-1' and (run / 'attempts' / '2' / 'rig-input.glb').read_bytes() == b'glTF input'


def test_workspace_inputs_are_compared_and_written_outside_the_shared_lock(bucket, s3, monkeypatch):
    job = bucket / 'avatar-factory' / '1' / JOB
    shared = bucket / 'avatar-factory' / '1' / ('b' * 24) / 'output' / 'body.glb'
    shared.write_bytes(b'glTF body')
    held = []
    materialize = object_storage._materialize

    def watched(target, content):
        held.append(object_storage._workspace_lock._is_owned())
        return materialize(target, content)

    monkeypatch.setattr(object_storage, '_materialize', watched)
    with local_workspace(job, inputs=[shared]):
        assert LocalPath(shared).read_bytes() == b'glTF body'
        with local_workspace(bucket / 'avatar-factory' / '1' / ('c' * 24), inputs=[shared]):
            assert object_storage._materialized[LocalPath(shared).resolve()][0] == 2
        assert LocalPath(shared).is_file()
    assert held == [False, False]
    assert object_storage._materialized == {} and not LocalPath(shared).exists()


def test_a_downloaded_model_is_inspected_and_stored_without_a_copy(bucket, s3, monkeypatch):
    import httpx
    from src.services import provider_http
    content = b'glTF' + b'm' * 1000
    seen = []
    monkeypatch.setattr(provider_http, 'inspect_glb', lambda data, policy, **_: seen.append(data) or {'errors': []})
    write = StoredPath.write_bytes
    monkeypatch.setattr(StoredPath, 'write_bytes', lambda self, data: (seen.append(data), write(self, data))[1])
    output = bucket / 'avatar-factory' / '1' / JOB / 'parts' / 'top' / 'generated.glb'
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=content))) as client:
        provider_http.download_glb(client, 'https://cdn.example/model.glb', output)
    assert len(seen) == 2 and seen[0] is seen[1] and isinstance(seen[0], bytearray)
    assert s3.objects[key(JOB, 'parts/top/generated.glb')]['Body'] == content


def test_cached_bytes_stay_within_their_budget():
    cache = record_store.ByteBoundedCache(100)
    for index in range(5):
        cache[index] = ('tag', b'x' * 30)
    assert list(cache) == [2, 3, 4] and cache.size == 90
    cache[3] = ('tag', b'y' * 10)
    assert list(cache) == [2, 4, 3] and cache.size == 70
    assert cache.pop(2)[1] == b'x' * 30 and cache.pop('missing', None) is None and cache.size == 40
    del cache[4]
    assert cache.size == 10
    cache.clear()
    assert cache.size == 0 and not cache
    assert object_storage._content_cache.budget == record_store.CONTENT_CACHE_BYTES == record_store._contents.budget


def test_write_marks_are_forgotten_once_no_query_can_still_be_comparing_them(monkeypatch):
    moment = [1000.0]
    monkeypatch.setattr(record_store, 'time', SimpleNamespace(monotonic=lambda: moment[0]))
    monkeypatch.setattr(record_store, '_WRITE_TABLE_LIMIT', 3)
    monkeypatch.setattr(record_store, '_writes', record_store.OrderedDict())
    with record_store._lock:
        for index in range(6):
            record_store._mark_write(('p', f'scope-{index}/'))
        # Recent marks stay however many there are: a query that began before them may still compare them.
        assert len(record_store._writes) == 6
        before = record_store._write_number(('p', 'scope-5/'))
        moment[0] += 121
        record_store._mark_write(('p', 'scope-6/'))
        assert list(record_store._writes) == [('p', 'scope-4/'), ('p', 'scope-5/'), ('p', 'scope-6/')]
        assert record_store._write_number(('p', 'scope-5/')) == before
        assert record_store._write_number(('p', 'scope-0/')) == 0
