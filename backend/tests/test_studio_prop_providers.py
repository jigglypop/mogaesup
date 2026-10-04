"""Studio prop generations with Tripo image_to_model beside Meshy, and the provider-switch resume rule.

Every provider is an httpx.MockTransport: Tripo's task API and model CDN, Meshy's image-to-3D. The OpenAI image
and the short-lived S3 URL of the stored image are faked at the service boundary.
"""
import io
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
from PIL import Image
import pytest

from api.test_characters import rigged_glb
from src.api import studio as studio_api
from src.api.avatar_factory import get_factory
from src.api.characters import pipeline_error_handler
from src.auth import UserContext, get_current_user
from src.services import studio_generations as module
from src.services import model_providers
from src.services.asset_editor import _write_json
from src.services.avatar_factory import AvatarFactory
from src.services.character_pipeline import PipelineError, read_json

TRIPO = 'https://api.tripo3d.ai/v2/openapi'
MESHY = 'https://api.meshy.ai/openapi/v1/image-to-3d'
MODEL_URL = 'https://tripo-data.invalid/model.glb'
MESHY_MODEL_URL = 'https://assets.meshy.invalid/model.glb'
IMAGE_URL = 'https://assets.invalid/provider-inputs/image.png'
ACCEPTED = {'code': 0, 'data': {'task_id': 'tripo-task-1'}}
SUCCESS = {'code': 0, 'data': {'status': 'success', 'progress': 100, 'output': {'pbr_model': MODEL_URL}}}
RUNNING = {'code': 0, 'data': {'status': 'running', 'progress': 40}}
MESHY_SUCCESS = {'status': 'SUCCEEDED', 'progress': 100, 'model_urls': {'glb': MESHY_MODEL_URL}}


def png():
    stream = io.BytesIO(); Image.new('RGBA', (24, 24), 'orange').save(stream, format='PNG'); return stream.getvalue()


def body(provider=None, kind='prop'):
    value = {'kind': kind, 'category': 'furniture' if kind == 'prop' else 'wood', 'name': '의자',
             'prompt': '나무 의자 한 개', 'size': 512}
    return {**value, 'provider': provider} if provider else value


def reply(value):
    """A reply for the transport: an exception is raised, a dict is JSON, a Response is returned as is."""
    if isinstance(value, Exception):
        raise value
    return value if isinstance(value, httpx.Response) else httpx.Response(200, json=value)


@pytest.fixture
def studio(tmp_path, monkeypatch, storage_configured):
    for name in ('OPENAI_API_KEY', 'MESHY_API_KEY', 'TRIPO_API_KEY'):
        monkeypatch.setenv(name, 'fixture-key')
    # Status polls retry a lost answer after 1, 2 and 4 seconds; the tests do not wait for them.
    monkeypatch.setattr('src.services.provider_http._sleep', lambda seconds: None)
    calls = {'images': 0, 'meshy': [], 'tripo': [], 'polls': 0, 'downloads': 0}
    # Each list is consumed in order; its last reply repeats.
    replies = {'tripo_submit': [ACCEPTED], 'tripo_task': [SUCCESS], 'meshy_submit': [httpx.Response(402, json={})],
               'meshy_task': [MESHY_SUCCESS]}

    def next_reply(name):
        queue = replies[name]
        return reply(queue.pop(0) if len(queue) > 1 else queue[0])

    def transport(request):
        url = str(request.url)
        if url in (MODEL_URL, MESHY_MODEL_URL):
            assert 'authorization' not in request.headers
            calls['downloads'] += 1
            return httpx.Response(200, content=rigged_glb())
        for base, provider in ((TRIPO+'/task', 'tripo'), (MESHY, 'meshy')):
            if url.startswith(base):
                assert request.headers['authorization'] == 'Bearer fixture-key'
                if request.method == 'POST':
                    calls[provider].append(json.loads(request.content))
                    return next_reply(provider+'_submit')
                calls['polls'] += 1
                return next_reply(provider+'_task')
        raise AssertionError(f'unexpected provider request {request.method} {url}')

    client_type = httpx.Client
    monkeypatch.setattr(httpx, 'Client', lambda **kwargs: client_type(**kwargs, transport=httpx.MockTransport(transport)))

    def image(prompt, model, base, **kwargs):
        calls['images'] += 1
        return png()
    monkeypatch.setattr(module, 'generate_image', image)
    monkeypatch.setattr(module, 'provider_image', lambda path, content, mime: {'url': IMAGE_URL})
    monkeypatch.setattr(module.time, 'sleep', lambda seconds: None)
    factory = AvatarFactory(tmp_path)
    return module.StudioGenerations(factory, 1), calls, replies, factory


def run(service, provider=None, key='fixture-prop-1'):
    record, dispatch = service.create(key, body(provider))
    assert dispatch
    service.execute(record['id'])
    return service.get(record['id'])


def test_tripo_prop_is_polled_downloaded_and_saved_like_meshy(studio):
    service, calls, replies, _ = studio
    replies['tripo_task'] = [RUNNING, SUCCESS]
    listing = service.listing('prop')['capabilities']
    assert listing['ready'] and listing['providers'] == ['meshy', 'tripo'] and listing['default_provider'] == 'meshy'
    public = run(service, 'tripo')
    assert public['status'] == 'complete' and public['provider'] == 'tripo' and public['task_id'] == 'tripo-task-1'
    [submitted] = calls['tripo']
    assert submitted['type'] == 'image_to_model' and submitted['file'] == {'type': 'png', 'url': IMAGE_URL}
    assert submitted['texture'] is True and submitted['pbr'] is True
    assert submitted['face_limit'] == module.PROP_FACE_LIMIT
    assert calls['polls'] == 2 and calls['downloads'] == 1 and calls['images'] == 1 and not calls['meshy']
    assert {item['name'] for item in public['artifacts']} == {'image.png', 'source.glb', 'model.glb'}
    assert public['gpu']['requested_target_polygons'] == module.PROP_FACE_LIMIT
    directory = service.directory(public['id'])
    task = read_json(directory/'tripo/character.json')
    assert task['provider'] == 'tripo' and task['status'] == 'SUCCEEDED' and 'file' not in task['generation_settings']
    assert read_json(directory/'tripo/generation-artifacts.json')['generated']['sha256']
    assert not (directory/'meshy').exists()
    assert service.artifact(public['id'], 'model.glb').read_bytes()
    # A finished job is never sent again, whatever provider a replay or a resume names.
    assert service.resume(public['id'], 'meshy')[1] is False
    replay, dispatch = service.create('fixture-prop-1', body('meshy'))
    assert not dispatch and replay['provider'] == 'tripo' and replay['status'] == 'complete'
    assert len(calls['tripo']) == 1 and not calls['meshy']


def test_default_provider_comes_from_the_environment(studio, monkeypatch):
    service, calls, _, _ = studio
    monkeypatch.setenv('AVATAR_3D_PROVIDER', 'tripo')
    assert run(service)['provider'] == 'tripo' and len(calls['tripo']) == 1
    monkeypatch.delenv('TRIPO_API_KEY')
    with pytest.raises(PipelineError) as error:
        service.create('fixture-prop-2', body('tripo'))
    assert error.value.code == 'provider_unavailable' and error.value.status == 503
    with pytest.raises(PipelineError) as error:
        service.create('fixture-texture-1', body('meshy', kind='texture'))
    assert error.value.code == 'invalid_provider'


def test_tripo_client_id_hides_capability_and_refuses_admission_before_http_client(studio, monkeypatch):
    service, calls, _, _ = studio
    credential = 'tcli_offline-client-id'
    monkeypatch.setenv('TRIPO_API_KEY', ' '+credential+' ')
    clients = []
    def forbidden_client(**kwargs):
        clients.append(kwargs)
        raise AssertionError('A Client ID must never create an HTTP client')
    monkeypatch.setattr(model_providers.httpx, 'Client', forbidden_client)
    assert model_providers.configured() == {'meshy': True, 'tripo': False}
    assert service.listing('prop')['capabilities']['providers'] == ['meshy']
    with pytest.raises(PipelineError) as refused:
        service.create('fixture-client-id', body('tripo'))
    assert refused.value.code == 'provider_unavailable'
    assert service.listing('prop')['items'] == []
    with pytest.raises(PipelineError) as refused:
        model_providers.client('tripo')
    assert refused.value.code == 'provider_unavailable' and refused.value.status == 422
    assert refused.value.message == 'Tripo Client ID 대신 API 키를 설정하세요.'
    assert credential not in str(refused.value)
    assert clients == [] and calls['images'] == 0 and not calls['meshy'] and not calls['tripo']


@pytest.mark.parametrize('provider, key', [('tripo', 'fixture-key'), ('tripo', 'tsk_fixture-key'),
                                         ('meshy', 'fixture-key'), ('meshy', 'tcli_fixture-key')])
def test_only_tripo_client_ids_are_rejected_other_keys_keep_existing_client_contract(monkeypatch, provider, key):
    setting = 'TRIPO_API_KEY' if provider == 'tripo' else 'MESHY_API_KEY'
    monkeypatch.setenv(setting, key)
    clients = []
    sentinel = object()
    def fake_client(**kwargs):
        clients.append(kwargs)
        return sentinel
    monkeypatch.setattr(model_providers.httpx, 'Client', fake_client)
    assert model_providers.configured()[provider]
    assert model_providers.client(provider, timeout=17) is sentinel
    assert clients == [{'base_url': model_providers.TRIPO_BASE if provider == 'tripo' else model_providers.MESHY_BASE,
                        'headers': {'Authorization': 'Bearer '+key}, 'timeout': 17}]


@pytest.mark.parametrize('refusal, code, text', [
    (httpx.Response(200, json={'code': 2010, 'message': 'provider text'}), 'insufficient_credits', 'Tripo 크레딧 부족'),
    (httpx.Response(403, json={'code': 2010, 'message': 'provider text'}), 'insufficient_credits', 'Tripo 크레딧 부족'),
    (httpx.Response(200, json={'code': 2008, 'message': 'provider text'}), 'content_refused', 'Tripo 콘텐츠 정책'),
])
def test_tripo_refusal_blocks_and_only_an_explicit_resume_sends_again(studio, refusal, code, text):
    service, calls, replies, _ = studio
    replies['tripo_submit'] = [refusal]
    public = run(service, 'tripo')
    job = public['id']; directory = service.directory(job)
    assert public['status'] == 'blocked' and text in public['error'] and 'provider text' not in public['error']
    assert public['can_resume'] is False and public['can_change_provider'] is True and public['task_id'] is None
    task = read_json(directory/'tripo/character.json')
    assert task['status'] == 'submission_rejected'
    assert module.model_problem(task, directory/'tripo')['code'] == code
    assert service.resume(job)[1] is False and len(calls['tripo']) == 1
    # e.g. after a top-up: the refused attempt is archived and only the 3D step is sent again.
    replies['tripo_submit'] = [ACCEPTED]
    resumed, dispatch = service.resume(job, 'tripo')
    assert dispatch and resumed['status'] == 'accepted' and resumed['error'] is None
    assert resumed['model_attempts'][0]['provider'] == 'tripo'
    assert resumed['model_attempts'][0]['status'] == 'submission_rejected'
    assert resumed['model_attempts'][0]['provider_code'] == json.loads(refusal.content)['code']
    assert read_json(directory/'tripo/attempts/1/archive.json')['status'] == 'submission_rejected'
    service.execute(job)
    assert service.get(job)['status'] == 'complete'
    assert len(calls['tripo']) == 2 and calls['images'] == 1 and not calls['meshy']


@pytest.mark.parametrize('failed, code, text', [
    ({'code': 0, 'data': {'status': 'failed', 'error_code': 2008}}, 'content_refused', '같은 그림은 다시 거절되므로'),
    ({'code': 0, 'data': {'status': 'failed'}}, 'FAILED', 'Tripo 3D 생성 작업이 실패했습니다'),
    ({'code': 0, 'data': {'status': 'banned'}}, 'FAILED', 'Tripo 3D 생성 작업이 실패했습니다'),
])
def test_failed_tripo_task_locks_the_provider(studio, failed, code, text):
    service, calls, replies, _ = studio
    replies['tripo_task'] = [failed]
    public = run(service, 'tripo')
    job = public['id']
    assert public['status'] == 'blocked' and text in public['error'] and public['task_id'] == 'tripo-task-1'
    assert public['can_resume'] is False and public['can_change_provider'] is False
    task = read_json(service.directory(job)/'tripo/character.json')
    assert module.model_problem(task)['code'] == code
    for provider in ('meshy', 'tripo'):
        with pytest.raises(PipelineError) as error:
            service.resume(job, provider)
        assert error.value.code == 'provider_locked' and error.value.status == 409
    assert service.resume(job)[1] is False
    assert len(calls['tripo']) == 1 and not calls['meshy'] and not calls['downloads']


@pytest.mark.parametrize('outcome', [httpx.ReadTimeout('lost'), httpx.Response(500, json={})])
def test_uncertain_tripo_submit_is_never_sent_again(studio, outcome):
    service, calls, replies, _ = studio
    replies['tripo_submit'] = [outcome]
    public = run(service, 'tripo')
    job = public['id']
    assert public['status'] == 'blocked' and '접수 여부를 확인하지 못했습니다' in public['error']
    assert read_json(service.directory(job)/'tripo/character.json')['status'] == 'submission_uncertain'
    assert public['can_resume'] is False and public['can_change_provider'] is False
    assert service.resume(job)[1] is False
    for provider in ('meshy', 'tripo'):
        with pytest.raises(PipelineError) as error:
            service.resume(job, provider)
        assert error.value.code == 'provider_locked'
    service.execute(job)
    assert len(calls['tripo']) == 1 and not calls['meshy']


def test_meshy_credit_refusal_keeps_the_image_and_resumes_with_tripo(studio):
    service, calls, _, _ = studio
    public = run(service)
    job = public['id']; directory = service.directory(job)
    # Records accepted before provider choice carry no provider: they are Meshy's.
    record = read_json(directory/'record.json'); assert record.pop('provider') == 'meshy'
    _write_json(directory/'record.json', record)
    public = service.get(job)
    assert public['status'] == 'blocked' and public['provider'] == 'meshy' and 'Meshy 크레딧 부족' in public['error']
    assert public['can_resume'] is False and public['can_change_provider'] is True
    # A replay naming Tripo gets the saved job (the provider is not part of the fingerprint) and starts nothing.
    replay, dispatch = service.create('fixture-prop-1', body('tripo'))
    assert not dispatch and replay['id'] == job and replay['provider'] == 'meshy'
    resumed, dispatch = service.resume(job, 'tripo')
    assert dispatch and resumed['provider'] == 'tripo' and resumed['status'] == 'accepted'
    [attempt] = resumed['model_attempts']
    assert attempt['provider'] == 'meshy' and attempt['status'] == 'submission_rejected' and attempt['http_status'] == 402
    service.execute(job)
    public = service.get(job)
    assert public['status'] == 'complete' and public['task_id'] == 'tripo-task-1'
    assert calls['images'] == 1 and len(calls['meshy']) == 1 and len(calls['tripo']) == 1
    assert read_json(directory/'meshy/character.json')['http_status'] == 402
    assert read_json(directory/'record.json')['tripo_base'] == TRIPO


def test_meshy_credit_refusal_resumes_with_meshy_after_a_top_up(studio):
    service, calls, replies, _ = studio
    public = run(service)
    job = public['id']; directory = service.directory(job)
    assert public['status'] == 'blocked' and public['can_change_provider'] is True
    replies['meshy_submit'] = [{'result': 'meshy-task-1'}]
    # Naming the frozen provider on a job blocked by a refused 3D request sends only that step again.
    resumed, dispatch = service.resume(job, 'meshy')
    assert dispatch and resumed['provider'] == 'meshy' and resumed['model_attempts'][0]['http_status'] == 402
    assert read_json(directory/'meshy/attempts/1/archive.json')['http_status'] == 402
    service.execute(job)
    public = service.get(job)
    assert public['status'] == 'complete' and public['task_id'] == 'meshy-task-1'
    assert public['gpu']['requested_target_polygons'] == 2000
    assert calls['images'] == 1 and len(calls['meshy']) == 2 and not calls['tripo'] and calls['downloads'] == 1


def test_provider_switch_is_refused_once_a_task_was_accepted(studio):
    service, calls, replies, _ = studio
    # A status poll is retried 4 times before the job pauses; the fifth answer arrives after the resume.
    replies['tripo_task'] = [httpx.ReadTimeout('poll lost')] * 4 + [SUCCESS]
    public = run(service, 'tripo')
    job = public['id']
    assert public['status'] == 'paused' and public['can_resume'] is True and public['can_change_provider'] is False
    with pytest.raises(PipelineError) as error:
        service.resume(job, 'meshy')
    assert error.value.code == 'provider_locked' and error.value.status == 409
    # Naming the frozen provider on a paused job is a plain resume: it polls the accepted task.
    resumed, dispatch = service.resume(job, 'tripo')
    assert dispatch and not resumed['model_attempts']
    service.execute(job)
    assert service.get(job)['status'] == 'complete'
    assert len(calls['tripo']) == 1 and not calls['meshy'] and calls['polls'] == 5


def test_resume_route_takes_an_optional_provider(studio):
    service, calls, _, factory = studio
    app = FastAPI()
    app.include_router(studio_api.router, prefix='/api')
    app.add_exception_handler(PipelineError, pipeline_error_handler)
    app.dependency_overrides[get_factory] = lambda: factory
    app.dependency_overrides[get_current_user] = lambda: UserContext(1, 'tester', [])
    with TestClient(app) as client:
        created = client.post('/api/studio/generations', json=body('meshy'), headers={'Idempotency-Key': 'fixture-api-1'})
        assert created.status_code == 202, created.text
        job = created.json()['id']
        assert client.get(f'/api/studio/generations/{job}').json()['can_change_provider'] is True
        assert client.post(f'/api/studio/generations/{job}/resume', json={'provider': 'other'}).status_code == 422
        plain = client.post(f'/api/studio/generations/{job}/resume')
        assert plain.status_code == 202 and plain.json()['status'] == 'blocked'
        switched = client.post(f'/api/studio/generations/{job}/resume', json={'provider': 'tripo'})
        assert switched.status_code == 202 and switched.json()['provider'] == 'tripo'
        public = client.get(f'/api/studio/generations/{job}').json()
        assert public['status'] == 'complete' and public['can_change_provider'] is False
        again = client.post(f'/api/studio/generations/{job}/resume', json={'provider': 'meshy'})
        assert again.status_code == 202 and again.json()['status'] == 'complete'
        texture = client.post('/api/studio/generations', json=body('tripo', kind='texture'),
                              headers={'Idempotency-Key': 'fixture-api-2'})
        assert texture.status_code == 422 and texture.json()['error']['code'] == 'invalid_provider'
    assert len(calls['meshy']) == 1 and len(calls['tripo']) == 1 and calls['images'] == 1


def test_a_generation_left_running_by_a_failed_last_save_can_be_resumed(studio):
    from src.services.process_identity import identity
    service, calls, replies, _ = studio
    record, _ = service.create('fixture-prop-stuck', body())
    directory = service.directory(record['id'])
    # The worker of this very process ended, but its last save never landed.
    _write_json(directory/'record.json', {**read_json(directory/'record.json'), 'status': 'running', 'process': identity()})
    stuck = service.get(record['id'])
    assert stuck['status'] == 'paused' and stuck['can_resume']
    # While the worker holds its lock the same record is running and cannot be resumed twice.
    assert module._WORKERS.acquire(str(directory))
    try:
        held = service.get(record['id'])
        assert held['status'] == 'running' and not held['can_resume']
        assert [item['status'] for item in service.listing('prop')['items']] == ['running']
    finally:
        module._WORKERS.release(str(directory))
    assert service.resume(record['id'])[1] is True
    assert module._WORKERS == {}


def test_the_last_save_of_a_failed_generation_is_tried_again(studio, monkeypatch):
    from src.services import run_lock
    service, calls, replies, _ = studio
    monkeypatch.setattr(run_lock, 'FINAL_WRITE_DELAYS', (0, 0, 0))
    record, _ = service.create('fixture-prop-blip', body())
    save, failures = module.StudioGenerations._save, []

    def blip(directory, value):
        # The stop is saved while the storage still fails twice.
        if value.get('status') == 'paused' and len(failures) < 2:
            failures.append(1)
            raise OSError('storage blip')
        return save(directory, value)

    monkeypatch.setattr(module.StudioGenerations, '_save', staticmethod(blip))
    monkeypatch.setattr(module, 'generate_image', lambda *args, **kwargs: (_ for _ in ()).throw(httpx.ConnectError('down')))
    service.execute(record['id'])
    assert len(failures) == 2
    assert read_json(service.directory(record['id'])/'record.json')['status'] in ('paused', 'blocked')


def test_a_listing_reads_each_record_once(studio, monkeypatch):
    service, calls, replies, _ = studio
    for index in range(3):
        service.create(f'fixture-prop-list-{index}', body())
    reads = []
    real = module.read_json
    monkeypatch.setattr(module, 'read_json', lambda path, *args: (reads.append(path.name), real(path, *args))[1])
    items = service.listing('prop')['items']
    assert len(items) == 3 and reads.count('record.json') == 3


def test_a_generation_whose_image_answer_is_kept_on_this_host_can_be_resumed(studio):
    from src.services.process_identity import identity
    service, calls, replies, _ = studio
    record, _ = service.create('fixture-prop-kept', body())
    directory = service.directory(record['id'])
    receipt = directory/'image-provider.json'
    # The answer arrived and the store refused it: only the complete partial on this host has it.
    _write_json(receipt.with_suffix('.request.json'), {'phase': 'response_unsaved', 'http_status': 200,
                                                       'request_started': True, 'submission': 'unknown'})
    receipt.with_suffix('.response.partial').write_text(json.dumps({'data': [{'b64_json': 'aW1hZ2U='}]}))
    _write_json(directory/'record.json', {**read_json(directory/'record.json'), 'status': 'running', 'process': identity()})
    # While its worker runs, the answer it may be writing is left where it is.
    assert module._WORKERS.acquire(str(directory))
    try:
        assert service.get(record['id'])['status'] == 'running'
        assert receipt.with_suffix('.response.partial').exists() and not receipt.with_suffix('.response.json').exists()
    finally:
        module._WORKERS.release(str(directory))
    stopped = service.get(record['id'])
    assert stopped['status'] == 'paused' and stopped['can_resume'] and receipt.with_suffix('.response.json').is_file()
    assert calls['images'] == 0
