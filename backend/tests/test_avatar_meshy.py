import json

import httpx
import pytest

from services.test_character_preparation import animated_fixture
from src.services import avatar_meshy as module
from src.services.asset_editor import _write_json
from src.services.avatar_factory import AvatarFactory, digest
from src.services.character_pipeline import PipelineError, read_json
from src.services.glb import parse_glb


@pytest.fixture
def setup(tmp_path, monkeypatch):
    factory = AvatarFactory(tmp_path)
    job_id = 'e'*24
    directory = factory.root/'1'/job_id
    (directory/'output').mkdir(parents=True)
    source = directory/'output/generated-body.glb'; source.write_bytes(animated_fixture())
    _write_json(directory/'job.json', {'id': job_id, 'status': 'review_required', 'input_kind': 'image',
        'parts': [{'slot': 'body'}], 'files': {'generated-body.glb': digest(source)}})
    _write_json(directory/'pipeline.json', {'meshy_base': 'https://api.meshy.ai'})
    (directory/'parts/body').mkdir(parents=True)
    _write_json(directory/'parts/body/character.json', {'stage': 'generation', 'status': 'SUCCEEDED', 'task_id': 'generation-fixture'})
    calls = []
    def transport(request):
        if request.url.path.endswith('/library'):
            return httpx.Response(200, json=[{'action_id': n, 'name': f'Action {n}'} for n in [0, 14, 77]])
        if request.method == 'POST':
            body = json.loads(request.content); calls.append((request.url.path, body))
            return httpx.Response(200, json={'result': 'fixture-rig' if request.url.path.endswith('rigging') else 'fixture-action'})
        if '/rigging/' in request.url.path:
            return httpx.Response(200, json={'status': 'SUCCEEDED', 'result': {'rigged_character_glb_url': 'https://assets.meshy.ai/rig.glb'}})
        return httpx.Response(200, json={'status': 'SUCCEEDED', 'result': {'animation_glb_url': 'https://assets.meshy.ai/clip.glb'}})
    def api(base):
        return httpx.Client(base_url=base, transport=httpx.MockTransport(transport))
    monkeypatch.setattr(module, 'client', api)
    def download(run, stage):
        assert stage == 'rigging'
        files = {}
        for name in ('rigged', 'walking', 'running'):
            path = run/(name+'.glb'); path.write_bytes(animated_fixture()); files[name] = {'sha256': digest(path)}
        _write_json(run/'rigging-artifacts.json', files)
    monkeypatch.setattr(module.character_jobs, 'download', download)
    def download_clip(client, url, path):
        assert 'Authorization' not in client.headers
        path.write_bytes(animated_fixture())
    monkeypatch.setattr(module, 'download_glb', download_clip)
    return module.AvatarMeshy(factory), job_id, directory, calls, transport


def test_rig_preserves_provider_skin_and_defaults_do_not_submit(setup):
    service, jid, directory, calls, _ = setup
    assert service.defaults(1)['selections'] == {}
    service.defaults(1, {'walk': 77})
    assert not calls
    service.start(1, jid); service.execute(1, jid, poll_seconds=0)
    public = service.get(1, jid)
    assert public['status'] == 'ready' and public['bone_count'] == 1
    assert {c['slot'] for c in public['clips']} == {'walk', 'run'}
    assert all(c['source'] == 'rigging_basic' and c['action_id'] is None for c in public['clips'])
    source_doc, source_bin = parse_glb(animated_fixture())
    doc, binary = parse_glb(service.artifact(1, jid, public['version'], 'model.glb').read_bytes())
    assert doc['skins'] == source_doc['skins'] and doc['nodes'] == source_doc['nodes']
    assert doc['accessors'][:len(source_doc['accessors'])] == source_doc['accessors']
    assert binary[:len(source_bin)] == source_bin
    service.start(1, jid); service.execute(1, jid, poll_seconds=0)
    assert len(calls) == 1 and calls[0][1] == {'input_task_id': 'generation-fixture', 'height_meters': 1.81}
    assert read_json(directory/'parts/body/character.json')['stage'] == 'generation'
    assert str(directory) not in json.dumps(public)
    with pytest.raises(PipelineError): service.get(2, jid)
    with pytest.raises(PipelineError): service.artifact(1, jid, '../other', 'model.glb')


def test_selected_walk_uses_exact_library_action_and_reuses_download(setup):
    service, jid, directory, calls, _ = setup
    service.start(1, jid); service.execute(1, jid, poll_seconds=0)
    original_version = service.get(1, jid)['version']
    service.request_action(1, jid, 'walk', 77); service.execute(1, jid, poll_seconds=0)
    result = service.get(1, jid)
    assert result['version'] != original_version
    assert calls[-1][1] == {'rig_task_id': 'fixture-rig', 'action_id': 77}
    assert next(c for c in result['clips'] if c['slot'] == 'walk') == {'slot': 'walk', 'source': 'animation_library', 'action_id': 77}
    service.request_action(1, jid, 'walk', 77); service.execute(1, jid, poll_seconds=0)
    assert len(calls) == 2
    assert service.artifact(1, jid, original_version, 'model.glb').is_file()
    assert (directory/'meshy/actions/77/clip.glb').is_file()


def test_photo_character_automatically_assembles_after_native_rig_and_preserves_provider_completion(setup, monkeypatch):
    from src.services import avatar_native_parts
    service, jid, directory, calls, _ = setup
    job = read_json(directory/'job.json')
    job.update(production_mode='character_parts', auto_assemble=True)
    _write_json(directory/'job.json', job)
    events = []
    monkeypatch.setattr(avatar_native_parts.AvatarNativeParts, 'start', lambda self, owner, job: (events.append(('start', job)) or {}, True))
    monkeypatch.setattr(avatar_native_parts.AvatarNativeParts, 'execute', lambda self, owner, job: events.append(('execute', job)))
    monkeypatch.setattr(avatar_native_parts.AvatarNativeParts, 'get', lambda self, owner, job: {'status': 'review_required'})
    service.start(1, jid); service.execute(1, jid, poll_seconds=0)
    assert events == [('start', jid), ('execute', jid)]
    assert read_json(directory/'output/progress.json')['stage'] == 'complete'
    assert read_json(directory/'meshy/worker.json')['status'] == 'complete'
    assert len(calls) == 1


def test_local_assembly_failure_continues_without_resubmitting_rig(setup, monkeypatch):
    from src.services import avatar_native_parts
    from src.services.avatar_character_flow import continue_character
    service, jid, directory, calls, _ = setup
    job = read_json(directory/'job.json')
    job.update(production_mode='character_parts', auto_assemble=True)
    _write_json(directory/'job.json', job)
    def failed(*args):
        raise RuntimeError('private local path')
    monkeypatch.setattr(avatar_native_parts.AvatarNativeParts, 'start', failed)
    service.start(1, jid); service.execute(1, jid, poll_seconds=0)
    assert read_json(directory/'meshy/worker.json')['status'] == 'complete'
    assert 'private' not in read_json(directory/'job.json')['error']
    assert read_json(directory/'job.json')['error']
    monkeypatch.setattr(avatar_native_parts.AvatarNativeParts, 'start', lambda *args: ({}, False))
    monkeypatch.setattr(avatar_native_parts.AvatarNativeParts, 'get', lambda *args: {'status': 'review_required'})
    continue_character(service.factory, 1, jid)
    assert read_json(directory/'job.json')['error'] is None
    assert len(calls) == 1


def test_uncertain_animation_is_not_reposted_and_changed_source_blocks(setup, monkeypatch):
    service, jid, directory, calls, transport = setup
    service.start(1, jid); service.execute(1, jid, poll_seconds=0)
    lost = []
    def interrupt(request):
        if request.method == 'POST':
            lost.append(request)
            assert read_json(directory/'meshy/actions/77/motion-pack.json')['submitted_tasks'] == 1
            raise httpx.ReadError('private credential must not leak')
        return transport(request)
    monkeypatch.setattr(module, 'client', lambda base: httpx.Client(base_url=base, transport=httpx.MockTransport(interrupt)))
    service.request_action(1, jid, 'walk', 77)
    service.execute(1, jid, poll_seconds=0); service.execute(1, jid, poll_seconds=0)
    assert len(lost) == 1 and len(calls) == 1
    assert 'private credential' not in json.dumps(service.get(1, jid))
    (directory/'output/generated-body.glb').write_bytes(b'changed')
    service.execute(1, jid, poll_seconds=0)
    assert len(lost) == 1


def test_frozen_actions_resume_after_rig_timeout_with_new_service_once_each(setup, monkeypatch):
    service, jid, directory, calls, transport = setup
    pipeline = read_json(directory/'pipeline.json')
    expected = {'idle': 0, 'walk': 77, 'run': 14, 'jump': 101, 'fall': 102, 'sit': 103}
    pipeline['motion_actions'] = expected
    _write_json(directory/'pipeline.json', pipeline)
    job = read_json(directory/'job.json')
    job['limits'] = {'meshy_rig_tasks': 1, 'meshy_animation_tasks': 6}
    _write_json(directory/'job.json', job)
    rig_pending = True
    def delayed(request):
        if request.method == 'GET' and '/rigging/' in request.url.path and rig_pending:
            return httpx.Response(200, json={'status': 'IN_PROGRESS', 'progress': 40})
        return transport(request)
    monkeypatch.setattr(module, 'client', lambda base: httpx.Client(
        base_url=base, transport=httpx.MockTransport(delayed)))
    service.start(1, jid)
    service.execute(1, jid, poll_seconds=0, timeout=0)
    assert len(calls) == 1
    assert read_json(directory/'meshy/input.json')['motion_actions'] == expected
    rig_pending = False
    restarted = module.AvatarMeshy(service.factory)
    restarted.execute(1, jid, poll_seconds=0)
    action_posts = [body for path, body in calls if path.endswith('/animations')]
    assert {body['action_id'] for body in action_posts} == set(expected.values())
    assert len(action_posts) == len(set(expected.values())) == 6
    assert read_json(directory/'meshy/selected.json') == expected
    restarted.execute(1, jid, poll_seconds=0)
    assert len([path for path, _ in calls if path.endswith('/animations')]) == 6


def test_frozen_uncertain_action_is_preserved_without_repost(setup, monkeypatch):
    service, jid, directory, calls, transport = setup
    pipeline = read_json(directory/'pipeline.json')
    pipeline['motion_actions'] = {'walk': 77}
    _write_json(directory/'pipeline.json', pipeline)
    job = read_json(directory/'job.json')
    job['limits'] = {'meshy_rig_tasks': 1, 'meshy_animation_tasks': 1}
    _write_json(directory/'job.json', job)
    lost = []
    def interrupt(request):
        if request.method == 'POST' and request.url.path.endswith('/animations'):
            lost.append(request)
            pack = read_json(directory/'meshy/actions/77/motion-pack.json')
            assert pack['submitted_tasks'] == 1
            raise httpx.ReadError('lost action response')
        return transport(request)
    monkeypatch.setattr(module, 'client', lambda base: httpx.Client(
        base_url=base, transport=httpx.MockTransport(interrupt)))
    service.start(1, jid)
    service.execute(1, jid, poll_seconds=0)
    pack_before = read_json(directory/'meshy/actions/77/motion-pack.json')
    assert pack_before['tasks']['clip']['status'] == 'submission_uncertain'
    restarted = module.AvatarMeshy(service.factory)
    restarted.execute(1, jid, poll_seconds=0)
    assert len(lost) == 1
    assert read_json(directory/'meshy/actions/77/motion-pack.json') == pack_before


def test_frozen_actions_preserve_manual_selection_and_successful_pack(setup, monkeypatch):
    service, jid, directory, calls, transport = setup
    pipeline = read_json(directory/'pipeline.json')
    pipeline['motion_actions'] = {'walk': 77}
    _write_json(directory/'pipeline.json', pipeline)
    job = read_json(directory/'job.json')
    job['limits'] = {'meshy_rig_tasks': 1, 'meshy_animation_tasks': 1}
    _write_json(directory/'job.json', job)
    rig_pending = True
    def delayed(request):
        if request.method == 'GET' and '/rigging/' in request.url.path and rig_pending:
            return httpx.Response(200, json={'status': 'IN_PROGRESS', 'progress': 40})
        return transport(request)
    monkeypatch.setattr(module, 'client', lambda base: httpx.Client(
        base_url=base, transport=httpx.MockTransport(delayed)))
    service.start(1, jid)
    service.execute(1, jid, poll_seconds=0, timeout=0)
    run = directory/'meshy'
    _write_json(run/'selected.json', {'walk': 14})
    action = run/'actions/14'; action.mkdir(parents=True)
    _write_json(action/'motion-pack.json', {'action_id': 14, 'rig_task_id': 'fixture-rig',
        'max_new_tasks': 1, 'submitted_tasks': 1,
        'tasks': {'clip': {'task_id': 'existing-action', 'status': 'SUCCEEDED'}}})
    (action/'clip.glb').write_bytes(animated_fixture())
    _write_json(action/'clip.json', {'sha256': digest(action/'clip.glb'), 'task_id': 'existing-action'})
    rig_pending = False
    restarted = module.AvatarMeshy(service.factory)
    restarted.execute(1, jid, poll_seconds=0)
    assert read_json(run/'selected.json') == {'walk': 14}
    assert not (run/'actions/77').exists()
    assert len([path for path, _ in calls if path.endswith('/animations')]) == 0
    assert next(clip for clip in restarted.get(1, jid)['clips'] if clip['slot'] == 'walk')['action_id'] == 14


def test_character_parts_job_uses_only_generated_body_for_native_rig(setup):
    service, jid, directory, calls, _ = setup
    job = read_json(directory/'job.json')
    job['production_mode'] = 'character_parts'
    job['parts'] = [{'slot': slot} for slot in ('body', 'hairBack', 'hairFront', 'hat', 'top', 'bottom', 'shoes')]
    _write_json(directory/'job.json', job)
    service.start(1, jid); service.execute(1, jid, poll_seconds=0)
    assert calls[0][1]['input_task_id'] == 'generation-fixture'
    assert read_json(directory/'meshy/input.json')['source_sha256'] == digest(directory/'output/generated-body.glb')


def test_defaults_and_actions_require_current_library_ids(setup):
    service, jid, _, calls, _ = setup
    with pytest.raises(PipelineError): service.defaults(1, {'walk': 999})
    with pytest.raises(PipelineError): service.defaults(1, {'invalid': 77})
    with pytest.raises(PipelineError): service.request_action(1, jid, 'run', 14)
    assert not calls


def test_api_saves_defaults_restores_state_and_scopes_artifacts(setup):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from src.api.avatar_factory import router, get_factory
    from src.api.characters import pipeline_error_handler
    from src.auth import UserContext, get_current_user
    service, jid, _, calls, _ = setup
    app = FastAPI(); app.include_router(router, prefix='/api')
    app.add_exception_handler(PipelineError, pipeline_error_handler)
    app.dependency_overrides[get_factory] = lambda: service.factory
    app.dependency_overrides[get_current_user] = lambda: UserContext(1, 'fixture', [])
    with TestClient(app) as api:
        assert api.put('/api/avatar-factory/motion-defaults', json={'selections': {'walk': 77}}).status_code == 200
        assert api.get('/api/avatar-factory/motion-defaults').json()['selections'] == {'walk': 77}
        assert not calls
        endpoint = '/api/avatar-factory/jobs/'+jid+'/meshy'
        assert api.post(endpoint+'/rig').status_code == 202
        current = api.get(endpoint).json()
        assert current['status'] == 'ready'
        artifact = current['artifacts'][0]['url']
        assert api.get(artifact).status_code == 200
        assert api.post(endpoint+'/actions', json={'slot': 'walk', 'action_id': 77}).status_code == 202
        assert api.post(endpoint+'/actions', json={'slot': 'walk', 'action_id': 77}).status_code == 202
        assert len(calls) == 2
        app.dependency_overrides[get_current_user] = lambda: UserContext(2, 'other', [])
        assert api.get(endpoint).status_code == 404
        assert api.get(artifact).status_code == 404
        assert api.get('/api/avatar-factory/motion-defaults').json()['selections'] == {}
