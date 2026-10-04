import base64
import hashlib
import io
import json

import httpx
from PIL import Image
import pytest

from src.services import avatar_image_pipeline as module
from src.services import character_motion
from src.services.asset_editor import _write_json
from src.services.avatar_blueprints import SLOTS as BLUEPRINT_SLOTS
from src.services.avatar_factory import AvatarFactory
from src.services.avatar_image_pipeline import AvatarImagePipeline, PARTS
from src.services.character_pipeline import PipelineError, read_json
from api.test_characters import rigged_glb


PART_COUNT = len(module.CHARACTER_PART_SLOTS)


def png(color='red'):
    stream = io.BytesIO(); Image.new('RGBA', (24, 24), color).save(stream, format='PNG'); return stream.getvalue()


@pytest.fixture
def setup(tmp_path, monkeypatch, storage_configured):
    monkeypatch.setenv('OPENAI_API_KEY', 'fixture-image-key')
    monkeypatch.setenv('MESHY_API_KEY', 'fixture-mesh-key')
    monkeypatch.setattr(module, 'blender_executable', lambda: 'fixture-blender')
    factory = AvatarFactory(tmp_path); service = AvatarImagePipeline(factory)
    character = factory.pipeline.create('Image Fixture', None, 1)
    character = factory.pipeline.upload(character['id'], 1, png(), 'image', character['revision'])
    blueprint = service.blueprints.read(1, character['id'])
    payload = {'character_id': character['id'], 'source_sha256': blueprint['source_sha256'],
               'blueprint_revision': blueprint['revision'], 'slots': PARTS[:7], 'image_mode': 'generate'}
    calls = {'images': [], 'posts': [], 'gets': [], 'compiled': []}
    def image(source, prompt, model, base, **kwargs):
        calls['images'].append(prompt); return png((len(calls['images'])*20, 20, 50, 255))
    monkeypatch.setattr(module, 'generate_openai_part_image', image)
    def transport(request):
        if request.url.path.endswith('/animations/library'):
            # Character-part jobs validate their default motions against the Meshy library.
            return httpx.Response(200, json=[{'action_id': n, 'name': f'Action {n}'}
                                             for n in character_motion.DEFAULT_ACTIONS.values()])
        if request.method == 'POST':
            calls['posts'].append(json.loads(request.content))
            return httpx.Response(200, json={'result': f'fixture-task-{len(calls["posts"])}'})
        calls['gets'].append(request.url.path)
        return httpx.Response(200, json={'status': 'SUCCEEDED', 'progress': 100, 'model_urls': {'glb': 'https://fixture.invalid/model.glb'}})
    client_type = httpx.Client
    monkeypatch.setattr(module.httpx, 'Client', lambda **kwargs: client_type(**kwargs, transport=httpx.MockTransport(transport)))
    def download(directory, stage):
        path = directory/'generated.glb'; path.write_bytes(rigged_glb())
        result = {'generated': {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}}
        _write_json(directory/'generation-artifacts.json', result); return result
    monkeypatch.setattr(module.character_jobs, 'download', download)
    return service, factory, payload, calls, transport, client_type


def test_legacy_blueprint_save_keeps_new_equipment(setup):
    service, _, payload, _, _, _ = setup
    current = service.blueprints.read(1, payload['character_id'])
    next(l for l in current['layers'] if l['slot'] == 'weapon')['description'] = 'Keep this staff'
    current = service.blueprints.save(1, payload['character_id'], current['layers'], current['revision'], 'new-equipment-save')
    legacy = current['layers'][:8]
    current = service.blueprints.save(1, payload['character_id'], legacy, current['revision'], 'old-client-save')
    assert sorted(l['slot'] for l in current['layers']) == sorted(BLUEPRINT_SLOTS)
    assert next(l for l in current['layers'] if l['slot'] == 'weapon')['description'] == 'Keep this staff'


def test_corrupt_png_is_input_error_instead_of_internal_server_error(setup):
    service, factory, payload, _, _, _ = setup
    corrupted = bytearray(png()); corrupted[-5] ^= 1
    # Corrupt IDAT's checksum, which Pillow reports as SyntaxError.
    offset = corrupted.find(b'IDAT'); corrupted[offset+4] ^= 1
    with pytest.raises(PipelineError) as error:
        service.blueprints.upload(1, bytes(corrupted))
    assert error.value.code == 'invalid_image'
    character = factory.pipeline.detail(payload['character_id'], 1)
    with pytest.raises(PipelineError) as error:
        factory.pipeline.upload(character['id'], 1, bytes(corrupted), 'image', character['revision'])
    assert error.value.code == 'invalid_image'


def test_character_parts_produces_exact_source_set_and_native_body_handoff(setup, monkeypatch):
    from src.services import avatar_meshy
    service, factory, payload, calls, _, _ = setup
    handed_off = []
    monkeypatch.setattr(avatar_meshy.AvatarMeshy, 'start', lambda self, owner, job: handed_off.append(('start', job)))
    monkeypatch.setattr(avatar_meshy.AvatarMeshy, 'execute', lambda self, owner, job: handed_off.append(('execute', job)))
    submitted = {**payload, 'production_mode': 'character_parts', 'slots': []}
    job, _ = service.create(1, 'character-parts-set', submitted)
    assert [p['slot'] for p in job['parts']] == module.CHARACTER_PART_SLOTS
    assert job['auto_assemble'] is True
    assert job['limits']['image_tasks'] == job['limits']['meshy_tasks'] == PART_COUNT
    service.execute(1, job['id'], poll_seconds=0)
    assert len(calls['images']) == len(calls['posts']) == PART_COUNT
    nonbody_prompts = calls['images'][1:]
    assert all('exact design, colors, materials' in prompt and 'Do not invent' in prompt for prompt in nonbody_prompts)
    assert not calls['compiled'] and handed_off == [('start', job['id']), ('execute', job['id'])]
    current = factory.get(1, job['id'])
    names = {artifact['name'] for artifact in current['artifacts']}
    assert {f'generated-{slot}.glb' for slot in module.CHARACTER_PART_SLOTS} <= names
    assert all(part['provenance']['review'] == 'pending' for part in current['parts'])


def test_character_parts_image_rejection_continues_all_parts_and_blocks_meshy(setup, monkeypatch):
    service, factory, payload, calls, _, _ = setup
    attempts = []
    def image(source, prompt, model, base, **kwargs):
        attempts.append(prompt)
        if 'top alone' in prompt:
            raise module.OpenAIImageHTTPError(400, 'policy', 'rejecttop123')
        return png()
    monkeypatch.setattr(module, 'generate_openai_part_image', image)
    job, _ = service.create(1, 'character-parts-one-reject',
                            {**payload, 'production_mode': 'character_parts', 'slots': module.CHARACTER_PART_SLOTS})
    service.execute(1, job['id'], poll_seconds=0)
    current = factory.get(1, job['id'])
    assert len(attempts) == PART_COUNT and not calls['posts']
    top = next(part for part in current['parts'] if part['slot'] == 'top')
    assert top['image_status'] == 'rejected'
    assert top['image_failure']['category'] == 'policy' and top['image_failure']['id'] == 'rejecttop123'
    assert sum(part['image_status'] == 'succeeded' for part in current['parts']) == PART_COUNT - 1
    assert current['status'] == 'pipeline_paused' and 'Meshy 단계는 시작하지 않았습니다' in current['error']


def test_character_parts_uncertain_image_is_never_reposted(setup, monkeypatch):
    service, factory, payload, calls, _, _ = setup
    attempts = []
    def image(source, prompt, model, base, **kwargs):
        attempts.append(prompt)
        if 'voluminous hairstyle' in prompt:
            raise httpx.ReadTimeout('lost response')
        return png()
    monkeypatch.setattr(module, 'generate_openai_part_image', image)
    job, _ = service.create(1, 'character-parts-uncertain',
                            {**payload, 'production_mode': 'character_parts', 'slots': module.CHARACTER_PART_SLOTS})
    service.execute(1, job['id'], poll_seconds=0)
    current = factory.get(1, job['id'])
    hair = next(part for part in current['parts'] if part['slot'] == 'hair')
    assert hair['image_status'] == 'submission_uncertain' and len(attempts) == PART_COUNT
    with pytest.raises(PipelineError):
        service.resume(1, job['id'])
    service.execute(1, job['id'], poll_seconds=0)
    assert len(attempts) == PART_COUNT and not calls['posts']


def test_character_parts_local_image_failure_continues_and_resumes_without_repost(setup, monkeypatch):
    service, factory, payload, calls, _, _ = setup
    original_upload = service.blueprints.upload
    uploads = 0
    def upload(owner, raw):
        nonlocal uploads
        uploads += 1
        if uploads == 3:
            raise OSError('local index unavailable')
        return original_upload(owner, raw)
    monkeypatch.setattr(service.blueprints, 'upload', upload)
    job, _ = service.create(1, 'character-parts-local-failure',
                            {**payload, 'production_mode': 'character_parts', 'slots': module.CHARACTER_PART_SLOTS})
    service.execute(1, job['id'], poll_seconds=0)
    paused = factory.get(1, job['id'])
    assert len(calls['images']) == PART_COUNT and not calls['posts']
    assert sum(part['image_status'] == 'succeeded' for part in paused['parts']) == PART_COUNT - 1
    local = next(part for part in paused['parts'] if part['image_status'] == 'received')
    assert local['image_failure']['category'] == 'local_processing'
    monkeypatch.setattr(service.blueprints, 'upload', original_upload)
    service.resume(1, job['id']); service.execute(1, job['id'], poll_seconds=0)
    assert len(calls['images']) == PART_COUNT
    assert sum(post.get('ai_model') == 'meshy-7' for post in calls['posts']) == PART_COUNT




def test_character_parts_image_that_was_never_sent_is_sent_again_on_resume(setup, monkeypatch):
    service, factory, payload, calls, _, _ = setup
    attempts = []

    def image(source, prompt, model, base, **kwargs):
        attempts.append(prompt)
        if 'voluminous hairstyle' in prompt and attempts.count(prompt) == 1:
            # The connection never opened: the request receipt says so.
            kwargs['receipt'].with_suffix('.request.json').write_text(json.dumps(
                {'phase': 'prepared', 'request_started': False, 'submission': 'not_sent'}))
            raise httpx.ConnectError('connection refused')
        return png()
    monkeypatch.setattr(module, 'generate_openai_part_image', image)
    job, _ = service.create(1, 'character-parts-not-sent',
                            {**payload, 'production_mode': 'character_parts', 'slots': module.CHARACTER_PART_SLOTS})
    service.execute(1, job['id'], poll_seconds=0)
    hair = next(part for part in factory.get(1, job['id'])['parts'] if part['slot'] == 'hair')
    assert hair['image_status'] == 'not_sent' and hair['image_failure']['category'] == 'provider_connection'
    assert not calls['posts']
    # Nothing was sent, so resuming sends that request: it is not an attempt whose answer is unknown.
    service.resume(1, job['id'])
    service.execute(1, job['id'], poll_seconds=0)
    assert len(attempts) == PART_COUNT + 1 and attempts.count(attempts[1]) == 2
    assert all(part['image_status'] == 'succeeded' for part in factory.get(1, job['id'])['parts'])
    assert sum(post.get('ai_model') == 'meshy-7' for post in calls['posts']) == PART_COUNT


def test_resume_is_refused_while_the_worker_still_runs_the_job(setup):
    service, factory, payload, _, _, _ = setup
    job, _ = service.create(1, 'character-parts-busy-resume',
                            {**payload, 'production_mode': 'character_parts', 'slots': module.CHARACTER_PART_SLOTS})
    directory = factory.directory(1, job['id'])
    # The worker has finished the parts and still runs the rig and assembly of the same job.
    _write_json(directory/'job.json', {**read_json(directory/'job.json'), 'status': 'review_required'})
    assert module._RUN_LOCKS.acquire(str(directory))
    try:
        with pytest.raises(PipelineError) as busy:
            service.resume(1, job['id'], stage='models')
        assert busy.value.code == 'worker_running' and busy.value.status == 409
        assert read_json(directory/'job.json')['status'] == 'review_required'
    finally:
        module._RUN_LOCKS.release(str(directory))


def test_a_job_whose_first_publish_failed_keeps_its_rig_budget(setup, monkeypatch):
    service, factory, payload, _, _, _ = setup
    request = {**payload, 'production_mode': 'character_parts', 'slots': module.CHARACTER_PART_SLOTS}
    published = AvatarImagePipeline.publish

    def unavailable(self, owner, job_id, state):
        raise OSError('storage unavailable')
    monkeypatch.setattr(AvatarImagePipeline, 'publish', unavailable)
    with pytest.raises(OSError):
        service.create(1, 'character-parts-rig-budget', request)
    monkeypatch.setattr(AvatarImagePipeline, 'publish', published)
    job, created = service.create(1, 'character-parts-rig-budget', request)
    assert not created
    saved = read_json(factory.directory(1, job['id'])/'job.json')
    motions = read_json(factory.directory(1, job['id'])/'pipeline.json')['motion_actions']
    # The rig stage checks the accepted rig and motion budget: a replay must find it in the one accepted record.
    assert saved['limits']['meshy_rig_tasks'] == 1
    assert saved['limits']['meshy_animation_tasks'] == len(set(motions.values())) > 0
    assert saved['profile']['rig'] == 'meshy-native' and saved['profile']['height'] == 1.2


ANSWER = {'data': [{'b64_json': base64.b64encode(png()).decode()}]}


@pytest.mark.parametrize('stop', ['not_sent', 'answer_kept'])
def test_a_single_image_that_resume_takes_is_offered_for_resume(setup, monkeypatch, stop):
    from src.services.avatar_stage_resume import AvatarStageResume
    service, factory, payload, calls, _, _ = setup

    def image(source, prompt, model, base, **kwargs):
        receipt = kwargs['receipt']
        if 'voluminous hairstyle' not in prompt:
            return png()
        if stop == 'not_sent':
            receipt.with_suffix('.request.json').write_text(json.dumps(
                {'phase': 'prepared', 'request_started': False, 'submission': 'not_sent'}))
            raise httpx.ConnectError('connection refused')
        # The answer arrived and the store refused it: it is kept as the partial on this host.
        receipt.with_suffix('.request.json').write_text(json.dumps(
            {'phase': 'response_unsaved', 'http_status': 200, 'request_started': True, 'submission': 'unknown'}))
        receipt.with_suffix('.response.partial').write_text(json.dumps(ANSWER))
        raise OSError('storage unavailable')
    monkeypatch.setattr(module, 'generate_openai_part_image', image)
    job, _ = service.create(1, f'character-parts-offer-{stop.replace("_", "-")}',
                            {**payload, 'production_mode': 'character_parts', 'slots': module.CHARACTER_PART_SLOTS})
    service.execute(1, job['id'], poll_seconds=0)
    public = factory.get(1, job['id'])
    hair = next(part for part in public['parts'] if part['slot'] == 'hair')
    assert hair['image_status'] == ('not_sent' if stop == 'not_sent' else 'submission_uncertain')
    # resume() takes it, so the job and its images stage say so.
    assert next(action for action in public['next_actions'] if action['id'] == 'resume')['enabled']
    images = next(action for action in AvatarStageResume(factory).get(1, job['id'])['actions'] if action['stage'] == 'images')
    assert images['enabled'] and images['reason'] is None
    if stop == 'answer_kept':
        receipt = factory.directory(1, job['id'])/'output'/'hair-provider'
        assert receipt.with_suffix('.response.json').is_file() and not receipt.with_suffix('.response.partial').exists()
    service.resume(1, job['id'])
