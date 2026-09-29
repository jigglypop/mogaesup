import hashlib
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from src.api.avatars import get_avatar_catalog, router
from src.api.characters import pipeline_error_handler
from src.auth import UserContext, get_current_user
from src.services.avatar_catalog import AvatarCatalog, DEFAULT_STATE
from src.services.character_pipeline import PipelineError


@pytest.fixture
def setup(tmp_path):
    service = AvatarCatalog(tmp_path)
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.add_exception_handler(PipelineError, pipeline_error_handler)
    app.dependency_overrides[get_current_user] = lambda: UserContext(1, "tester", [])
    app.dependency_overrides[get_avatar_catalog] = lambda: service
    with TestClient(app) as client:
        yield client, app, service


def test_catalog_artifacts_have_real_hashes_and_no_private_paths(setup):
    client, _, service = setup
    result = client.get('/api/avatars/catalog')
    records = result.json()['assets']
    assert len(records) == 17
    assert str(service.root) not in result.text and str(service.package) not in result.text
    for record in records:
        manifest = record['metadata']['avatar']
        assert record['kind'] == 'characterPart' and manifest['rig'] == 'gaesup-humanoid-v1'
        assert len(manifest['bones']) == 23
        for source in [manifest, *manifest['lods']]:
            response = client.get(source['source']['uri'])
            assert response.status_code == 200
            assert response.content[:4] == b'glTF'
            assert response.headers['etag'] == f'"{hashlib.sha256(response.content).hexdigest()}"'
    assert client.get('/api/avatars/assets/unknown/model').status_code == 404
    assert client.get('/api/avatars/assets/top-001/model?lod=4').status_code == 422


def test_equipment_survives_service_restart_and_is_owner_scoped(setup):
    client, app, service = setup
    initial = client.get('/api/avatars/me').json()
    state = {**initial['state'], 'equipment': {'onepiece': 'onepiece-001', 'hat': 'hat-002'}}
    response = client.put('/api/avatars/me', json=state, headers={'If-Match': initial['revision'], 'Idempotency-Key': 'save-1'})
    assert response.status_code == 200
    restored = AvatarCatalog(service.root.parent).read(1)
    assert restored == response.json() and restored['state'] == state
    journal = json.loads((service.root / '1/equipment.json').read_text(encoding='utf-8'))
    assert journal['receipts']['save-1']['response'] == restored
    assert 'url' not in json.dumps(journal).lower()
    app.dependency_overrides[get_current_user] = lambda: UserContext(2, 'other', [])
    assert client.get('/api/avatars/me').json() == {'revision': '0', 'state': DEFAULT_STATE}


def test_replay_conflicts_and_invalid_equipment_never_replace_saved_state(setup):
    client, _, _ = setup
    headers = {'If-Match': '0', 'Idempotency-Key': 'save-1'}
    first = client.put('/api/avatars/me', json=DEFAULT_STATE, headers=headers)
    assert client.put('/api/avatars/me', json=DEFAULT_STATE, headers=headers).json() == first.json()
    changed = {'body': DEFAULT_STATE['body'], 'equipment': {'top': 'top-002'}}
    assert client.put('/api/avatars/me', json=changed, headers=headers).status_code == 409
    assert client.put('/api/avatars/me', json=changed, headers={**headers, 'Idempotency-Key': 'save-2'}).status_code == 409
    for equipment in ({'top': 'hair-001'}, {'top': 'https://evil/model.glb'}, {'top': 'missing'},
                      {'onepiece': 'onepiece-001', 'bottom': 'bottom-001'}, {'unsupported': 'hat-001'}):
        result = client.put('/api/avatars/me', json={'body': DEFAULT_STATE['body'], 'equipment': equipment},
                            headers={'If-Match': first.json()['revision'], 'Idempotency-Key': 'bad-save'})
        assert result.status_code == 422
    assert client.get('/api/avatars/me').json() == first.json()


def test_changed_artifact_fails_integrity_gate(setup, tmp_path):
    _, _, service = setup
    package = tmp_path / 'tampered'
    package.mkdir()
    for name in ('catalog.json', 'evidence.json'):
        (package / name).write_bytes((service.package / name).read_bytes())
    (package / 'top-001.glb').write_bytes(b'glTF tampered')
    with pytest.raises(PipelineError, match='해시'):
        AvatarCatalog(tmp_path, package).model('top-001', 0)
