import io
import json
import struct

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from src.api.characters import get_pipeline, pipeline_error_handler, router
from src.auth import UserContext, get_current_user
from src.services import character_actions
from src.services.asset_editor import _write_json
from src.services.character_pipeline import CharacterPipeline, PipelineError


def rigged_glb():
    binary = struct.pack('<9f', 0, 0, 0, 1, 0, 0, 0, 1, 0) + bytes(12) + struct.pack('<12f', *([1, 0, 0, 0] * 3))
    doc = {"asset": {"version": "2.0"}, "buffers": [{"byteLength": len(binary)}],
           "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 36},
                           {"buffer": 0, "byteOffset": 36, "byteLength": 12},
                           {"buffer": 0, "byteOffset": 48, "byteLength": 48}],
           "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0, 0, 0], "max": [1, 1, 0]},
                         {"bufferView": 1, "componentType": 5121, "count": 3, "type": "VEC4"},
                         {"bufferView": 2, "componentType": 5126, "count": 3, "type": "VEC4"}],
           "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "JOINTS_0": 1, "WEIGHTS_0": 2}}]}],
           "nodes": [{"name": "body", "mesh": 0, "skin": 0}, {"name": "outfit", "mesh": 0, "skin": 0}, {"name": "root"}],
           "skins": [{"joints": [2]}], "scenes": [{"nodes": [0, 1, 2]}], "scene": 0}
    encoded = json.dumps(doc).encode()
    encoded += b' ' * (-len(encoded) % 4)
    return struct.pack('<III', 0x46546C67, 2, 28 + len(encoded) + len(binary)) + struct.pack('<II', len(encoded), 0x4E4F534A) + encoded + struct.pack('<II', len(binary), 0x004E4942) + binary


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.delenv("MESHY_API_KEY", raising=False)
    pipeline = CharacterPipeline(tmp_path, port=62127)
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.add_exception_handler(PipelineError, pipeline_error_handler)
    app.dependency_overrides[get_pipeline] = lambda: pipeline
    app.dependency_overrides[get_current_user] = lambda: UserContext(1, 'tester', [])
    with TestClient(app) as client:
        yield client, pipeline, app


def create(client):
    response = client.post('/api/characters', json={"name": "Test Character", "height_meters": 1.7})
    assert response.status_code == 201
    return response.json()


def with_model(client):
    value = create(client)
    response = client.post(f"/api/characters/{value['id']}/sources?kind=model", content=rigged_glb(),
                           headers={"If-Match": value['revision'], "Content-Type": "model/gltf-binary"})
    assert response.status_code == 200, response.text
    return response.json()


def test_list_update_and_reload_use_persisted_state_without_internal_paths(setup):
    client, pipeline, _ = setup
    value = create(client)
    endpoint = f"/api/characters/{value['id']}"
    updated = client.patch(endpoint, json={"height_meters": 1.8}, headers={"If-Match": value['revision']})
    assert updated.status_code == 200
    assert client.get(endpoint).json()['height_meters'] == 1.8
    assert CharacterPipeline(pipeline.root).detail(value['id'], 1)['height_meters'] == 1.8
    assert client.patch(endpoint, json={"name": "Stale"}, headers={"If-Match": value['revision']}).status_code == 409
    assert str(pipeline.root) not in client.get('/api/characters').text


def test_source_import_does_not_create_provider_work_and_is_owner_scoped(setup):
    client, pipeline, app = setup
    value = with_model(client)
    assert value['rig_origin'] == 'unknown'
    assert value['provider']['status'] is None
    assert value['model_id'] == 'imported'
    assert not (pipeline.root / f"characters/{value['id']}/character.json").exists()
    url = value['artifacts'][0]['url']
    assert client.get(url).content == rigged_glb()
    app.dependency_overrides[get_current_user] = lambda: UserContext(2, 'other', [])
    assert client.get('/api/characters').json()['characters'] == []
    assert client.get(url).status_code == 404
    assert client.get(f"/api/characters/{value['id']}").status_code == 404


def test_terminal_operation_reads_its_committed_inspection(setup, monkeypatch):
    client, pipeline, _ = setup
    value = with_model(client)
    entry, run, control = pipeline.entry(value['id'], 1)
    original = pipeline.latest_operation
    completed = False

    def finish_while_reading(path):
        nonlocal completed
        if not completed:
            completed = True
            model = pipeline.artifact(value['id'], 1, 'imported')
            control['inspection'] = character_actions.inspect_model(model)
            _write_json(run / 'control.json', control)
        return original(path)

    monkeypatch.setattr(pipeline, 'latest_operation', finish_while_reading)
    detail = pipeline.detail(value['id'], 1)
    assert detail['inspection']['model_sha256'] == value['model_sha256']


def test_view_revision_uses_the_same_operation_snapshot(setup, monkeypatch):
    client, pipeline, _ = setup
    value = with_model(client)
    reads = 0
    def snapshot(_run):
        nonlocal reads
        reads += 1
        return None
    monkeypatch.setattr(pipeline, 'latest_operation', snapshot)
    pipeline.detail(value['id'], 1)
    assert reads == 1  # A later status must produce a different revision on the next poll.


def test_same_action_key_replays_receipt_without_executing_twice(setup, monkeypatch):
    client, _, _ = setup
    value = with_model(client)
    called = []
    original = character_actions.perform
    def counting(*args):
        called.append(1)
        return original(*args)
    monkeypatch.setattr(character_actions, 'perform', counting)
    url = f"/api/characters/{value['id']}/actions/inspect_model"
    headers = {"If-Match": value['revision'], "Idempotency-Key": 'same-request-123'}
    first = client.post(url, json={}, headers=headers)
    second = client.post(url, json={}, headers=headers)
    assert first.status_code == second.status_code == 202
    assert first.json()['operation']['id'] == second.json()['operation']['id']
    assert called == [1]
    detail = client.get(f"/api/characters/{value['id']}").json()
    assert detail['operation']['status'] == 'succeeded'
    assert detail['inspection']['metrics']['skins'] == 1
    assert detail['pipeline_status'] == 'review_required'


def test_unknown_actions_and_arbitrary_code_are_rejected_before_execution(setup):
    client, _, _ = setup
    value = with_model(client)
    headers = {"If-Match": value['revision'], "Idempotency-Key": 'invalid-request-123'}
    assert client.post(f"/api/characters/{value['id']}/actions/shell", json={}, headers=headers).status_code == 400
    assert client.post(f"/api/characters/{value['id']}/actions/inspect_model", json={"code": "anything"}, headers=headers).status_code == 422


def test_restart_keeps_accepted_work_uncertain_and_blocks_new_local_work(setup):
    client, pipeline, _ = setup
    value = with_model(client)
    op, fresh = pipeline.accept(value['id'], 1, 'inspect_model', 'pending-request-123', value['revision'], {})
    restarted = CharacterPipeline(pipeline.root, port=pipeline.port)
    detail = restarted.detail(value['id'], 1)
    assert fresh
    assert detail['operation']['id'] == op['id']
    assert detail['operation']['status'] == 'recovery_required'
    assert not any(action['enabled'] for action in detail['next_actions'])


def test_provider_response_loss_does_not_allow_another_post(setup, monkeypatch):
    client, pipeline, _ = setup
    value = create(client)
    image = io.BytesIO()
    Image.new('RGB', (4, 4)).save(image, 'PNG')
    response = client.post(f"/api/characters/{value['id']}/sources?kind=image", content=image.getvalue(), headers={"If-Match": value['revision']})
    value = response.json()
    monkeypatch.setenv('MESHY_API_KEY', 'test-key')
    calls = []
    def handler(request):
        calls.append(request.method)
        raise httpx.ReadTimeout('lost response', request=request)
    real_client = httpx.Client
    monkeypatch.setattr(character_actions.httpx, 'Client', lambda **kwargs: real_client(**kwargs, transport=httpx.MockTransport(handler)))
    url = f"/api/characters/{value['id']}/actions/submit_generation"
    first = client.post(url, json={}, headers={"If-Match": value['revision'], "Idempotency-Key": 'paid-request-123'})
    assert first.status_code == 202
    value = client.get(f"/api/characters/{value['id']}").json()
    assert value['provider']['status'] == 'submission_uncertain'
    assert value['operation']['status'] == 'recovery_required'
    assert client.post(url, json={}, headers={"If-Match": value['revision'], "Idempotency-Key": 'another-paid-key'}).status_code == 409
    assert calls == ['POST']


def test_bad_upload_preserves_active_source(setup):
    client, pipeline, _ = setup
    value = with_model(client)
    response = client.post(f"/api/characters/{value['id']}/sources?kind=model", content=b'bad', headers={"If-Match": value['revision']})
    assert response.status_code == 400
    assert client.get(value['artifacts'][0]['url']).content == rigged_glb()
    assert str(pipeline.root) not in response.text


def test_new_model_invalidates_review_and_parts(setup):
    client, pipeline, _ = setup
    value = with_model(client)
    entry, run, control = pipeline.entry(value['id'], 1)
    control.update(review={"decision": "approved", "model_sha256": "different"}, inspection={"model_sha256": "different"})
    _write_json(run / 'control.json', control)
    assert pipeline.detail(value['id'], 1)['review'] == {}
    assert pipeline.detail(value['id'], 1)['pipeline_status'] != 'approved'


def test_character_endpoints_require_authentication(setup):
    client, _, app = setup
    del app.dependency_overrides[get_current_user]
    assert client.get('/api/characters').status_code == 401
