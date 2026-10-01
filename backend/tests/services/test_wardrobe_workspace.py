from contextlib import contextmanager
import hashlib
import json
import os
from types import SimpleNamespace

from botocore.exceptions import ClientError
import pytest

from src.services import avatar_native_parts, avatar_variants, object_storage, record_store
from src.services.asset_editor import _write_json
from src.services.avatar_factory import AvatarFactory
from src.services.avatar_native_parts import AvatarNativeParts
from src.services.character_pipeline import PipelineError, read_json
from src.services.object_storage import StoredPath, WorkspaceUploadError
from test_record_store import _clear_s3_caches, s3  # noqa: F401  (fixture)

JOB, VERSION, BODY_VERSION = 'e' * 24, 'f' * 24, '1' * 24


@pytest.fixture
def stored(monkeypatch, tmp_path, s3):
    """S3 alone, in memory, as test_storage_workspace has it."""
    monkeypatch.delenv('ASSET_STORAGE_WORKER_LOCAL', raising=False)
    monkeypatch.setenv('ASSET_S3_BUCKET', 'fixture-bucket')
    monkeypatch.setenv('ASSET_S3_PREFIX', 'assets')
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path / 'cloud'))
    monkeypatch.setenv('CHARACTER_DATABASE_URL', '')
    record_store.reset()
    _clear_s3_caches()
    object_storage._changes.clear()
    yield tmp_path / 'cloud'
    _clear_s3_caches()
    object_storage._changes.clear()


def seed(root):
    """A job whose newest assembly is accepted, with the body it fits to; everything is in the store."""
    factory = AvatarFactory(root)
    job = factory.directory(1, JOB)
    body = job / 'native-parts' / BODY_VERSION / 'body.glb'
    body.write_bytes(b'glTF body')
    _write_json(job / 'job.json', {
        'id': JOB, 'character_id': 'fixture', 'character_name': '조립', 'created_at': '2026-09-18T00:00:00+00:00',
        'status': 'review_required', 'input_kind': 'image', 'production_mode': 'character_parts',
        'source_sha256': hashlib.sha256(b'glTF body').hexdigest(), 'profile': {'name': 'fixture', 'rig': 'meshy-native'},
        'parts': [], 'files': {}})
    directory = job / 'native-parts' / VERSION
    _write_json(directory / 'input.json', {'source': str(body), 'parts': [], 'prefit_parts': [], 'unavailable_parts': []})
    _write_json(directory / 'record.json', {'status': 'accepted', 'files': {}, 'created_at': '2026-09-18T01:00:00+00:00'})
    _write_json(job / 'native-parts' / 'current.json', {'version': VERSION})
    return factory, directory


class Blender:
    """A worker that leaves a drawing in the scratch directory and fails."""

    pid = os.getpid()

    def __init__(self, command, **kwargs):
        (StoredPath(command[-1]).parent / 'front.png').write_bytes(b'png front')

    def wait(self, timeout=None):
        return 1


def key(name):
    return f'assets/avatar-factory/1/{JOB}/native-parts/{VERSION}/{name}'


def test_an_assembly_whose_files_did_not_reach_the_store_fails_instead_of_staying_running(stored, s3, monkeypatch):
    factory, directory = seed(stored)
    monkeypatch.setattr(avatar_native_parts, 'blender_executable', lambda: 'blender')
    monkeypatch.setattr(avatar_native_parts.subprocess, 'Popen', Blender)
    original = s3.put_object

    def put_object(**kwargs):
        if kwargs['Key'].endswith('/front.png'):
            raise ClientError({'Error': {'Code': 'InternalError', 'Message': 'try again'}}, 'PutObject')
        return original(**kwargs)
    monkeypatch.setattr(s3, 'put_object', put_object)
    AvatarNativeParts(factory).execute(1, JOB)
    record = json.loads(s3.objects[key('record.json')]['Body'])
    assert record['status'] == 'failed' and record['error'] == '조립 산출물 저장 실패'
    assert record['files'] == {} and record['result'] == {}
    # What the person is told names no exception and no path.
    shown = AvatarNativeParts(factory).get(1, JOB)
    assert shown['status'] == 'failed' and shown['error'] == '조립 산출물 저장 실패'
    assert 'Workspace' not in shown['error'] and str(stored) not in shown['error']


def test_a_sealed_record_is_never_replaced_by_the_upload_failure(stored, monkeypatch):
    factory, directory = seed(stored)
    native = AvatarNativeParts(factory)
    _write_json(directory / 'record.json', {'status': 'review_required', 'files': {}, 'result': {'parts': []}})

    @contextmanager
    def failing(path, *, inputs=()):
        yield path
        raise WorkspaceUploadError('Workspace files were not stored and stay on disk: fitted.glb (ClientError)')
    monkeypatch.setattr(avatar_native_parts, 'local_workspace', failing)
    monkeypatch.setattr(AvatarNativeParts, '_execute_local', lambda self, owner, job, version: None)
    native.execute(1, JOB)
    assert read_json(directory / 'record.json')['status'] == 'review_required'


def test_the_body_render_that_could_not_be_stored_pauses_the_job_with_a_message(tmp_path, monkeypatch):
    factory = AvatarFactory(tmp_path)
    directory = factory.directory(1, JOB)
    directory.mkdir(parents=True)
    state = {'base_body': {'sha256': 'ab' * 32}, 'production_spec': {'generated_views': ['front', 'side'], 'body_height_m': 1.2},
             'parts': [{'slot': 'body', 'views': {}}], 'reference_preparation': None}
    published = []
    service = SimpleNamespace(factory=factory, publish=lambda owner, job, state: published.append(state))

    def render(output, worker):
        for name in ('spec.json', 'body-front.png', 'body-side.png'):
            (output / name).write_bytes(b'{}' if name.endswith('.json') else b'png')
        files = {name: hashlib.sha256((output / name).read_bytes()).hexdigest() for name in ('spec.json', 'body-front.png', 'body-side.png')}
        _write_json(output / 'complete.json', {'input_sha256': hashlib.sha256((output / 'input.json').read_bytes()).hexdigest(), 'files': files})
    monkeypatch.setattr(avatar_variants, 'render_body_reference', render)

    @contextmanager
    def failing(path, *, inputs=()):
        yield path
        raise WorkspaceUploadError(f'Workspace files were not stored and stay on disk: body-front.png ({path})')
    monkeypatch.setattr(avatar_variants, 'local_workspace', failing)
    with pytest.raises(PipelineError) as error:
        avatar_variants.prepare_body(service, 1, JOB, state)
    assert error.value.code == 'body_render_failed' and error.value.message == '기본 몸 참조 렌더 저장 실패'
    assert error.value.__cause__ is None and str(directory) not in error.value.message
    # Nothing was published for a body that was never stored.
    assert published == [] and not state['base_body'].get('prepared')
