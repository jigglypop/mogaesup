"""The native-parts endpoints check the job's stage before their slow reads and again under the process lock."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from native_assembly_fixture import JOB, VERSION, seed_native_assembly
from src.api import avatar_factory as api
from src.api.characters import pipeline_error_handler
from src.auth import UserContext, get_current_user
from src.services import avatar_native_parts
from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, digest
from src.services.avatar_native_parts import SLOTS, AvatarNativeParts
from src.services.character_pipeline import PipelineError, read_json
from src.services.process_identity import identity


@pytest.fixture
def client(tmp_path, monkeypatch):
    factory, directory = seed_native_assembly(tmp_path, 'fixture')
    job = directory.parent.parent
    (job/'output/generated-hair.glb').write_bytes(b'raw hair model')
    record = read_json(job/'job.json')
    _write_json(job/'job.json', {**record, 'files': {**record['files'], 'generated-hair.glb': digest(job/'output/generated-hair.glb')}})
    _write_json(job/'pipeline.json', {'hair_length': 'source', 'parts': [{'slot': slot} for slot in ('body', *SLOTS)]})
    (directory.parent/'refit-requests').mkdir()
    monkeypatch.setattr(avatar_native_parts, 'blender_executable', lambda: 'blender')
    # The assembly worker is not what these tests are about.
    monkeypatch.setattr(AvatarNativeParts, 'execute_refit', lambda self, owner, job: None)
    app = FastAPI()
    app.include_router(api.router, prefix='/api')
    app.add_exception_handler(PipelineError, pipeline_error_handler)
    app.dependency_overrides[api.get_factory] = lambda: factory
    app.dependency_overrides[get_current_user] = lambda: UserContext(1, 'tester', ['ADMIN'])
    with TestClient(app) as test_client:
        yield test_client, job


def refit(client, key='refit-request-0001'):
    return client.post(f'/api/avatar-factory/jobs/{JOB}/native-parts/refit', headers={'Idempotency-Key': key},
                       json={'source_version': VERSION, 'slot': 'hair'})


def checks(monkeypatch):
    """Whether the process lock was held at each stage check the endpoints make."""
    held, real = [], api.ensure_stage_idle
    monkeypatch.setattr(api, 'ensure_stage_idle', lambda *args: (held.append(_LOCK._is_owned()), real(*args))[1])
    return held


def test_a_refit_checks_the_stage_first_and_again_under_the_lock(client, monkeypatch):
    test_client, job = client
    held = checks(monkeypatch)
    response = refit(test_client)
    assert response.status_code == 202, response.text
    assert response.json()['status'] == 'accepted'
    # Once before the reads, then once when the request is written and once when its version is.
    assert held == [False, True, True]


def test_an_assembly_request_checks_the_stage_again_under_the_lock(client, monkeypatch):
    test_client, job = client
    _write_json(job/'pipeline.json', {**read_json(job/'pipeline.json'), 'native_assembly_version': VERSION})
    held = checks(monkeypatch)
    response = test_client.post(f'/api/avatar-factory/jobs/{JOB}/native-parts')
    assert response.status_code == 202, response.text
    assert response.json()['version'] == VERSION and held == [False, True]


def test_a_running_stage_refuses_a_refit_before_anything_is_written(client):
    test_client, job = client
    (job/'stage-runs').mkdir()
    _write_json(job/'stage-runs/run-1.json', {'id': 'run-1', 'stage': 'models', 'status': 'accepted', 'process': identity()})
    _write_json(job/'stage-runs/current.json', {'id': 'run-1'})
    pipeline = read_json(job/'pipeline.json')
    response = refit(test_client)
    assert response.status_code == 409 and response.json()['error']['code'] == 'stage_running'
    assert read_json(job/'pipeline.json') == pipeline and not list((job/'native-parts/refit-requests').iterdir())
