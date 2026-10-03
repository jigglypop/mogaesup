"""Review an immutable disposable assembly; no Blender or provider executes."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from native_assembly_fixture import JOB, VERSION, seed_native_assembly
from src.api.avatar_factory import get_factory, router
from src.api.characters import pipeline_error_handler
from src.auth import UserContext, get_current_user
from src.services.asset_editor import _write_json
from src.services.avatar_factory import digest
from src.services.avatar_fitting_management import FittingManagement
from src.services.avatar_native_reviews import AvatarNativeReviews
from src.services.character_pipeline import PipelineError, read_json


@pytest.fixture
def setup(tmp_path):
    factory, directory = seed_native_assembly(tmp_path, 'char-'+'a'*12)
    # These are fixture evidence only, not a claimed visual quality result.
    for name in ('front.png', 'side.png', 'back.png', 'opposite.png', 'motion.png'):
        Image.new('RGB', (2, 2)).save(directory/name)
    (directory/'quality.json').write_text('{"visual_review":"required"}', encoding='utf-8')
    record = read_json(directory/'record.json')
    record['files'].update({p.name: digest(p) for p in directory.iterdir() if p.suffix in ('.png', '.glb') or p.name == 'quality.json'})
    _write_json(directory/'record.json', record)
    app = FastAPI()
    app.include_router(router, prefix='/api')
    app.add_exception_handler(PipelineError, pipeline_error_handler)
    app.dependency_overrides[get_factory] = lambda: factory
    app.dependency_overrides[get_current_user] = lambda: UserContext(1, 'tester', ['ADMIN'])
    with TestClient(app) as client:
        yield client, factory, directory, app


def payload(directory, **overrides):
    return {'expected_assembly_sha256': digest(directory/'model.glb'), 'decision': 'approved',
            'appearance_checked': True, 'motion_checked': True, 'notes': '외형과 동작 확인 완료', **overrides}


def submit(client, directory, key='native-review-001', **overrides):
    return client.post(f'/api/avatar-factory/jobs/{JOB}/native-parts/{VERSION}/review',
                       headers={'Idempotency-Key': key}, json=payload(directory, **overrides))


def test_approval_persists_overlay_without_rewriting_seal_and_replays(setup):
    client, factory, directory, _ = setup
    sealed = {name: (directory/name).read_bytes() for name in ('record.json', 'quality.json')}
    response = submit(client, directory)
    assert response.status_code == 200, response.text
    state = response.json()
    assert state['status'] == 'review_required'
    assert state['review']['status'] == 'approved'
    assert state['review']['assembly_sha256'] == state['assembly_sha256']
    assert state['review']['reviewer_id'] == 1
    assert state['review']['reviewer_name'] == 'tester'
    assert submit(client, directory).json()['review'] == state['review']
    assert client.get(f'/api/avatar-factory/jobs/{JOB}/native-parts').json()['review'] == state['review']
    assert AvatarNativeReviews(type(factory)(factory.data)).overlay(1, JOB, VERSION, read_json(directory/'record.json')) == state['review']
    versions = FittingManagement(factory, 1).versions(JOB)
    assert versions['items'][0]['review'] == state['review']
    assert versions['items'][0]['assembly_sha256'] == state['assembly_sha256']
    assert all((directory/name).read_bytes() == data for name, data in sealed.items())
    changed = submit(client, directory, notes='같은 키의 검수 내용을 변경함')
    assert changed.status_code == 409
    assert changed.json()['error']['code'] == 'idempotency_conflict'


def test_review_rejects_wrong_sha_non_current_version_and_other_owner(setup):
    client, _, directory, app = setup
    assert submit(client, directory, expected_assembly_sha256='0'*64).json()['error']['code'] == 'assembly_changed'
    _write_json(directory.parent/'current.json', {'version': 'd'*24})
    assert submit(client, directory).status_code == 409
    app.dependency_overrides[get_current_user] = lambda: UserContext(2, 'other', ['ADMIN'])
    assert submit(client, directory).status_code == 404


def test_member_cannot_submit_review(setup):
    client, _, directory, app = setup
    app.dependency_overrides[get_current_user] = lambda: UserContext(1, 'member', ['ADMIN', 'MEMBER'])
    assert submit(client, directory).status_code == 403
    assert not (directory/'reviews.json').exists()


@pytest.mark.parametrize('override', [
    {'appearance_checked': False}, {'motion_checked': False},
])
def test_approval_requires_both_visual_confirmations(setup, override):
    client, _, directory, _ = setup
    response = submit(client, directory, **override)
    assert response.status_code == 409
    assert response.json()['error']['code'] == 'review_required'


@pytest.mark.parametrize('override', [{'notes': '    '}, {'motion_checked': 'yes'}, {'command': 'arbitrary'}, {'expected_assembly_sha256': '../path'}])
def test_review_input_is_bounded_strict_and_typed(setup, override):
    client, _, directory, _ = setup
    assert submit(client, directory, **override).status_code == 422
    assert not (directory/'reviews.json').exists()


def test_incomplete_assembly_can_receive_changes_but_cannot_be_approved(setup):
    client, _, directory, _ = setup
    record = read_json(directory/'record.json')
    record['result']['incomplete_parts'] = [{'slot': 'hair', 'reason': 'missing'}]
    _write_json(directory/'record.json', record)
    assert submit(client, directory).json()['error']['code'] == 'assembly_incomplete'
    response = submit(client, directory, decision='changes_requested', appearance_checked=False, motion_checked=False)
    assert response.status_code == 200, response.text
    assert response.json()['review']['status'] == 'changes_requested'


def test_changed_artifact_invalidates_review_and_rejects_new_review(setup):
    client, _, directory, _ = setup
    assert submit(client, directory).status_code == 200
    (directory/'front.png').write_bytes(b'changed evidence')
    state = client.get(f'/api/avatar-factory/jobs/{JOB}/native-parts').json()
    assert state['review']['status'] == 'stale'
    assert submit(client, directory, key='native-review-002').json()['error']['code'] == 'artifact_changed'


def test_missing_render_and_invalid_model_prevent_approval(setup):
    client, _, directory, _ = setup
    record = read_json(directory/'record.json')
    record['files'].pop('opposite.png')
    _write_json(directory/'record.json', record)
    assert submit(client, directory).json()['error']['code'] == 'review_evidence_missing'
    (directory/'model.glb').write_bytes(b'invalid model')
    record['files']['model.glb'] = digest(directory/'model.glb')
    _write_json(directory/'record.json', record)
    assert submit(client, directory).json()['error']['code'] == 'technical_failure'


def test_frozen_expression_application_must_finish_before_review(setup):
    client, _, directory, _ = setup
    _write_json(directory.parent.parent/'pipeline.json', {
        'native_assembly_version': VERSION, 'expression_reuse': {'expressions': [{'source_id': 'saved'}]}})
    assert submit(client, directory).json()['error']['code'] == 'expression_pending'
