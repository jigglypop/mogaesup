import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from native_assembly_fixture import JOB, VERSION, seed_native_assembly
from src.api.avatar_factory import get_factory, router
from src.api.characters import pipeline_error_handler
from src.auth import UserContext, get_current_user
from src.services.avatar_native_outfits import AvatarNativeOutfits
from src.services.avatar_native_parts import AvatarNativeParts, SLOTS
from src.services.character_pipeline import PipelineError


@pytest.fixture
def setup(tmp_path):
    factory, directory = seed_native_assembly(tmp_path, 'fixture')
    app = FastAPI()
    app.include_router(router, prefix='/api')
    app.add_exception_handler(PipelineError, pipeline_error_handler)
    app.dependency_overrides[get_factory] = lambda: factory
    app.dependency_overrides[get_current_user] = lambda: UserContext(1, 'tester', [])
    with TestClient(app) as client:
        yield client, factory, directory, app


URL = f'/api/avatar-factory/jobs/{JOB}/native-outfits/{VERSION}'


def test_combination_persists_and_lost_response_replays_without_overwriting_newer_save(setup):
    client, factory, _, _ = setup
    initial = client.get(URL).json()
    assert initial['slots'] == list(SLOTS)
    payload = {'body_sha256': initial['body_sha256'], 'slots': ['top', 'shoes']}
    headers = {'If-Match': '0', 'Idempotency-Key': 'native-save-0001'}
    response = client.put(URL, json=payload, headers=headers)
    assert response.status_code == 200, response.text
    saved = response.json()
    assert AvatarNativeOutfits(AvatarNativeParts(factory)).get(1, JOB, VERSION) == saved
    second = client.put(URL, json={**payload, 'slots': ['hat']}, headers={
        'If-Match': saved['revision'], 'Idempotency-Key': 'native-save-0002'}).json()
    assert client.put(URL, json=payload, headers=headers).json() == saved
    assert client.get(URL).json() == second
    assert client.put(URL, json={**payload, 'slots': []}, headers=headers).status_code == 409
    assert client.put(URL, json=payload, headers={**headers, 'Idempotency-Key': 'native-save-0003'}).status_code == 409


@pytest.mark.parametrize('slots', [['body'], ['top', 'top'], ['../body'], ['other']])
def test_rejects_unknown_duplicate_and_body_slots(setup, slots):
    client, _, _, _ = setup
    initial = client.get(URL).json()
    response = client.put(URL, json={'body_sha256': initial['body_sha256'], 'slots': slots},
                          headers={'If-Match': '0', 'Idempotency-Key': 'native-invalid-01'})
    assert response.status_code == 422
    assert client.get(URL).json() == initial


def test_hash_change_owner_scope_and_required_headers(setup):
    client, _, directory, app = setup
    initial = client.get(URL).json()
    payload = {'body_sha256': initial['body_sha256'], 'slots': ['top']}
    assert client.put(URL, json=payload).status_code == 422
    (directory / 'top.glb').write_bytes(b'changed')
    assert client.put(URL, json=payload, headers={'If-Match': '0', 'Idempotency-Key': 'native-changed-01'}).status_code == 404
    assert client.get(URL).json() == initial
    app.dependency_overrides[get_current_user] = lambda: UserContext(2, 'other', [])
    assert client.get(URL).status_code == 404
    assert client.put(URL, json=payload, headers={'If-Match': '0', 'Idempotency-Key': 'native-other-0001'}).status_code == 404
