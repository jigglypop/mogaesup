"""Job records that several writers change: compare-and-set in the record database, and the CLI that must see those records.

Runs against a throwaway database on the compose PostgreSQL (server/docker-compose.yml, 127.0.0.1:55432), like
test_record_store; skipped when it is not running. The records are JSON, so they never reach S3, which is an empty stand-in.
"""
import json
from pathlib import Path
import sys
import uuid

import httpx
from PIL import Image
from botocore.exceptions import ClientError
import psycopg
import pytest

from src import character_cli, records
from src.services import object_storage, record_store
from src.services.asset_editor import _write_json
from src.services.avatar_factory import AvatarFactory
from src.services.avatar_image_pipeline import AvatarImagePipeline
from src.services.avatar_stage_resume import AvatarStageResume
from src.services.character_pipeline import read_json
from src.services.object_storage import StoredPath
from src.services.process_identity import identity

ADMIN = 'host=127.0.0.1 port=55432 user=postgres password=postgres-dev connect_timeout=3'
JOB = 'a' * 24


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
            yield url
        finally:
            record_store.reset()
            admin.execute(f'DROP DATABASE IF EXISTS {name} WITH (FORCE)')


def _clear_caches():
    with object_storage._cache_lock:
        for cache in (object_storage._cache, object_storage._content_cache, object_storage._key_index,
                      object_storage._written_keys, object_storage._generations):
            cache.clear()


class EmptyS3:
    """An S3 bucket without objects that refuses writes: the records under test live in the database."""

    def head_object(self, **kwargs):
        raise ClientError({'Error': {'Code': '404'}}, 'HeadObject')

    def get_paginator(self, name):
        return self

    def paginate(self, **kwargs):
        yield {'Contents': []}

    def put_object(self, **kwargs):
        raise AssertionError('a JSON record must not be written to S3')


@pytest.fixture
def cloud(monkeypatch, tmp_path, database):
    """The data root whose job records live in the test database under a prefix of this test's own."""
    prefix = f'p{uuid.uuid4().hex[:12]}'
    monkeypatch.delenv('ASSET_STORAGE_WORKER_LOCAL', raising=False)
    monkeypatch.setenv('ASSET_S3_BUCKET', 'fixture-bucket')
    monkeypatch.setenv('ASSET_S3_PREFIX', prefix)
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path / 'cloud'))
    monkeypatch.setenv('CHARACTER_DATABASE_URL', database)
    monkeypatch.setattr(object_storage, '_s3', EmptyS3)
    record_store.reset()
    _clear_caches()
    with psycopg.connect(database, autocommit=True) as conn:
        conn.execute('INSERT INTO character_records.namespaces (prefix, imported_at, source) VALUES (%s, now(), %s)',
                     (prefix, 'test'))
    yield tmp_path / 'cloud'
    record_store.reset()
    _clear_caches()


def racing(monkeypatch, path, write):
    """Run `write` (another writer's change) right after the first read of `path` through update_json: the writer
    that read the record then holds a version that is already stale."""
    real = object_storage.read_json_versioned
    raced = []

    def read(requested):
        found = real(requested)
        if not raced and StoredPath(requested) == StoredPath(path):
            raced.append(True)
            write()
        return found
    monkeypatch.setattr(object_storage, 'read_json_versioned', read)
    return raced


def running_job(factory, **fields):
    path = factory.root / '1' / JOB / 'job.json'
    # An executor of an earlier server run: another instance, and a process that does not exist any more.
    _write_json(path, {'id': JOB, 'status': 'pipeline_running', 'executor': 'earlier-instance',
                       'executor_process': {'pid': 4242, 'created_at': 1.0}, 'resume_stage': 'models',
                       'created_at': '2026-09-30T00:00:00+00:00', 'updated_at': '2026-09-30T01:00:00+00:00', **fields})
    return path


# --- AvatarFactory.get ----------------------------------------------------------------------------------------------

def test_a_stopped_executor_is_recorded_as_paused(cloud, monkeypatch):
    monkeypatch.setattr('src.services.avatar_factory.process_state', lambda value: 'exited')
    factory = AvatarFactory(cloud)
    path = running_job(factory)
    public = factory.get(1, JOB)
    saved = read_json(path)
    assert public['status'] == saved['status'] == 'pipeline_paused' and saved['error'] == '서버 재시작으로 중단됨'
    assert saved['interrupted']['stage'] == 'models' and saved['interrupted']['at'] == '2026-09-30T01:00:00+00:00'


def test_a_resume_that_lands_while_the_stop_is_recorded_is_not_overwritten(cloud, monkeypatch):
    monkeypatch.setattr('src.services.avatar_factory.process_state', lambda value: 'exited')
    factory = AvatarFactory(cloud)
    path = running_job(factory)

    def resume():
        _write_json(path, {**read_json(path), 'status': 'pipeline_queued', 'executor': factory.instance,
                           'executor_process': identity(), 'error': None})
    raced = racing(monkeypatch, path, resume)
    public = factory.get(1, JOB)
    saved = read_json(path)
    assert raced == [True]
    assert saved['status'] == public['status'] == 'pipeline_queued' and saved['executor'] == factory.instance
    assert 'interrupted' not in saved and saved['error'] is None


def test_a_run_that_finished_while_the_stop_is_recorded_is_not_paused_again(cloud, monkeypatch):
    monkeypatch.setattr('src.services.avatar_factory.process_state', lambda value: 'exited')
    factory = AvatarFactory(cloud)
    path = running_job(factory)
    raced = racing(monkeypatch, path, lambda: _write_json(path, {**read_json(path), 'status': 'review_required'}))
    assert factory.get(1, JOB)['status'] == 'review_required' and raced == [True]
    assert read_json(path)['status'] == 'review_required' and 'interrupted' not in read_json(path)


# --- AvatarImagePipeline.publish --------------------------------------------------------------------------------------

def one_part_state():
    return {'parts': [{'slot': 'top', 'image': {'status': 'succeeded', 'file': 'top-image.png', 'sha256': 'f' * 64, 'asset': 'asset-1'},
                       'model': {'status': 'pending'}, 'provenance': {'origin': 'generated_part_candidate'}}]}


def test_publishing_the_state_keeps_a_change_another_writer_made_meanwhile(cloud, monkeypatch):
    factory = AvatarFactory(cloud)
    path = factory.root / '1' / JOB / 'job.json'
    _write_json(path, {'id': JOB, 'status': 'pipeline_running', 'executor': factory.instance, 'error': None})
    raced = racing(monkeypatch, path, lambda: _write_json(path, {**read_json(path), 'error': 'written elsewhere', 'resume_stage': 'models'}))
    AvatarImagePipeline(factory).publish(1, JOB, one_part_state())
    saved = read_json(path)
    assert raced == [True]
    assert saved['error'] == 'written elsewhere' and saved['resume_stage'] == 'models'
    assert saved['parts'][0]['image_asset'] == 'asset-1' and saved['files'] == {'top-image.png': 'f' * 64}
    assert read_json(factory.root / '1' / JOB / 'pipeline.json') == one_part_state()


# --- AvatarStageResume.execute -----------------------------------------------------------------------------------------

def test_the_expression_error_is_added_without_dropping_a_concurrent_change(cloud, monkeypatch):
    factory = AvatarFactory(cloud)
    directory = factory.root / '1' / JOB
    path = directory / 'job.json'
    _write_json(path, {'id': JOB, 'status': 'review_required', 'error': None})
    _write_json(directory / 'pipeline.json', {'parts': []})
    _write_json(directory / 'native-parts/current.json', {'version': 'v1'})
    request_id = 'r' * 64
    _write_json(directory / 'stage-runs' / f'{request_id}.json', {
        'id': request_id, 'stage': 'expressions', 'status': 'accepted', 'process': identity(), 'explicit': True})
    from src.services import avatar_expression_pipeline
    monkeypatch.setattr(avatar_expression_pipeline, 'execute', lambda *args, **kwargs: None)
    monkeypatch.setattr(avatar_expression_pipeline, 'summary', lambda *args, **kwargs: {'status': 'running', 'error': '텍스처 대기'})
    raced = racing(monkeypatch, path, lambda: _write_json(path, {**read_json(path), 'review': {'decision': 'approved'}}))
    AvatarStageResume(factory).execute(1, JOB, request_id)
    saved = read_json(path)
    assert raced == [True]
    assert saved['error'] == '텍스처 대기' and saved['review'] == {'decision': 'approved'}


# --- the command line sees the records the server writes ----------------------------------------------------------------

def test_a_second_generate_is_refused_when_the_first_one_lives_only_in_the_record_database(cloud, tmp_path, monkeypatch, capsys):
    image = tmp_path / 'source.png'
    Image.new('RGB', (4, 4), 'white').save(image)
    posts = []

    def handler(request):
        posts.append(json.loads(request.content))
        return httpx.Response(200, json={'result': 'task-1'})
    client_type = httpx.Client
    monkeypatch.setattr(character_cli.httpx, 'Client', lambda **kwargs: client_type(**kwargs, transport=httpx.MockTransport(handler)))
    monkeypatch.setenv('MESHY_API_KEY', 'fixture-key')
    run = cloud / 'characters' / 'A'
    arguments = ['character', '--run', str(run), 'generate', '--image', str(image), '--height', '1.2']
    monkeypatch.setattr(sys, 'argv', arguments)
    character_cli.main()
    assert len(posts) == 1 and read_json(run / 'character.json')['task_id'] == 'task-1'
    # The receipt lives in the record database only: a check of the local disk cannot see it.
    assert not Path(run / 'character.json').exists()
    with pytest.raises(SystemExit):
        character_cli.main()
    assert len(posts) == 1
