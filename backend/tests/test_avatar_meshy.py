import json
import threading

import httpx
import pytest

from services.test_character_preparation import animated_fixture
from src.services import avatar_meshy as module
from src.services import wardrobe
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
    def download_clip(client, url, path, *, preserve_detail=False):
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
    monkeypatch.setattr(avatar_native_parts.AvatarNativeParts, 'get', lambda self, owner, job: {'version': 'fixture-assembly', 'status': 'review_required'})
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
    monkeypatch.setattr(avatar_native_parts.AvatarNativeParts, 'get', lambda *args: {'version': 'fixture-assembly', 'status': 'review_required'})
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
    # Non-default walk/run ids: a default clip the rig already delivered is reused, never requested.
    expected = {'idle': 0, 'walk': 77, 'run': 104, 'jump': 101, 'fall': 102, 'sit': 103}
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


def lock_is_held_by_caller():
    """True when the running thread holds the factory's lock: another thread cannot take it."""
    taken = []

    def try_to_take():
        taken.append(module._LOCK.acquire(timeout=0.5))
        if taken[0]:
            module._LOCK.release()
    probe = threading.Thread(target=try_to_take)
    probe.start(), probe.join()
    return not taken[0]


def stopped_rig(service, jid, directory, **receipt):
    """A rig submission whose answer was lost, with its worker idle."""
    service.start(1, jid)
    run = directory/'meshy'
    _write_json(run/'worker.json', {'status': 'paused', 'error': None})
    _write_json(run/'character.json', {'stage': 'rigging', 'status': 'submission_uncertain',
                                      'generation_task_id': 'generation-fixture', 'height_meters': 1.81, **receipt})
    return run


def use_handler(monkeypatch, handler):
    monkeypatch.setattr(module, 'client', lambda base: httpx.Client(base_url=base, transport=httpx.MockTransport(handler)))


def test_recovering_a_lost_rig_asks_meshy_outside_the_lock(setup, monkeypatch):
    service, jid, directory, calls, transport = setup
    run = stopped_rig(service, jid, directory)
    held = []

    def handler(request):
        held.append((request.method, lock_is_held_by_caller()))
        return transport(request)
    use_handler(monkeypatch, handler)
    service.recover(1, jid, 'recovered-rig')
    assert held == [('GET', False)] and not calls
    saved = read_json(run/'character.json')
    assert saved['task_id'] == 'recovered-rig' and saved['stage'] == 'rigging' and saved['status'] == 'SUCCEEDED'
    assert (run/'rigging-result.json').is_file()


def test_a_rig_recovery_is_dropped_when_the_submission_changed_meanwhile(setup, monkeypatch):
    service, jid, directory, calls, transport = setup
    run = stopped_rig(service, jid, directory)

    def handler(request):
        # The operator retries the rig while Meshy is being asked.
        _write_json(run/'character.json', {**read_json(run/'character.json'), 'status': 'FAILED'})
        return transport(request)
    use_handler(monkeypatch, handler)
    with pytest.raises(PipelineError) as error:
        service.recover(1, jid, 'recovered-rig')
    assert error.value.code == 'invalid_state'
    assert 'task_id' not in read_json(run/'character.json') and not (run/'rigging-result.json').exists()


def stopped_animation(service, jid, directory):
    service.start(1, jid)
    run = directory/'meshy'
    _write_json(run/'worker.json', {'status': 'paused', 'error': None})
    action = run/'actions/77'
    action.mkdir(parents=True)
    _write_json(action/'motion-pack.json', {'action_id': 77, 'rig_task_id': 'fixture-rig', 'max_new_tasks': 1, 'submitted_tasks': 1,
                                           'tasks': {'clip': {'status': 'submission_uncertain', 'endpoint': '/openapi/v1/animations'}}})
    return action


def test_recovering_a_lost_animation_asks_meshy_outside_the_lock(setup, monkeypatch):
    service, jid, directory, calls, transport = setup
    action = stopped_animation(service, jid, directory)
    held = []

    def handler(request):
        held.append((request.method, lock_is_held_by_caller()))
        return transport(request)
    use_handler(monkeypatch, handler)
    service.recover(1, jid, 'recovered-clip', 77)
    assert held == [('GET', False)] and not calls
    clip = read_json(action/'motion-pack.json')['tasks']['clip']
    assert clip['task_id'] == 'recovered-clip' and clip['status'] == 'PENDING' and clip['recovery_method'] == 'operator_task_id'


def test_an_animation_of_another_rig_is_still_refused_after_the_lock_is_retaken(setup, monkeypatch):
    service, jid, directory, calls, transport = setup
    action = stopped_animation(service, jid, directory)
    use_handler(monkeypatch, lambda request: httpx.Response(200, json={'status': 'SUCCEEDED', 'rig_task_id': 'another-rig'}))
    with pytest.raises(PipelineError) as error:
        service.recover(1, jid, 'recovered-clip', 77)
    assert error.value.code == 'task_mismatch'
    assert read_json(action/'motion-pack.json')['tasks']['clip']['status'] == 'submission_uncertain'


def test_a_busy_provider_while_waiting_for_the_rig_is_asked_again_without_a_new_request(setup, monkeypatch):
    service, jid, directory, calls, transport = setup
    waited = []
    monkeypatch.setattr(wardrobe, '_sleep', waited.append)
    answers = iter([503, 502])

    def handler(request):
        if request.method == 'GET' and '/rigging/' in request.url.path and (status := next(answers, 200)) != 200:
            return httpx.Response(status)
        return transport(request)
    use_handler(monkeypatch, handler)
    service.start(1, jid); service.execute(1, jid, poll_seconds=0)
    assert service.get(1, jid)['status'] == 'ready' and waited == [1, 2] and len(calls) == 1


def test_a_provider_that_stays_down_pauses_the_rig_worker_and_sends_nothing_more(setup, monkeypatch):
    service, jid, directory, calls, transport = setup
    monkeypatch.setattr(wardrobe, '_sleep', lambda seconds: None)
    use_handler(monkeypatch, lambda request: httpx.Response(503) if request.method == 'GET' and '/rigging/' in request.url.path
                else transport(request))
    service.start(1, jid); service.execute(1, jid, poll_seconds=0)
    worker = read_json(directory/'meshy/worker.json')
    assert worker['status'] == 'paused' and worker['error'] == 'Meshy 응답을 가져오지 못했습니다. 저장된 작업에서 조회를 이어갈 수 있습니다.'
    assert len(calls) == 1


def test_a_refused_clip_download_pauses_the_rig_worker_with_the_reason(setup, monkeypatch):
    service, jid, directory, calls, transport = setup

    def refused(run, stage):
        raise PipelineError('download_failed', '3D 파일을 내려받지 못했습니다 (HTTP 403). 다시 시도할 수 있습니다.', 502)
    monkeypatch.setattr(module.character_jobs, 'download', refused)
    service.start(1, jid); service.execute(1, jid, poll_seconds=0)
    worker = read_json(directory/'meshy/worker.json')
    assert worker['status'] == 'paused' and 'HTTP 403' in worker['error']
