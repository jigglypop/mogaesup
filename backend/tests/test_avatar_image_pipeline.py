import hashlib
import io
import json

import httpx
from PIL import Image
import pytest

from src.services import avatar_image_pipeline as module
from src.services.asset_editor import _write_json
from src.services.avatar_factory import AvatarFactory
from src.services.avatar_image_pipeline import AvatarImagePipeline, PARTS
from src.services.character_pipeline import PipelineError, read_json
from api.test_characters import rigged_glb


def png(color='red'):
    stream = io.BytesIO(); Image.new('RGBA', (24, 24), color).save(stream, format='PNG'); return stream.getvalue()


@pytest.fixture
def setup(tmp_path, monkeypatch):
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
    assert len(current['layers']) == 13
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
    assert job['limits']['image_tasks'] == job['limits']['meshy_tasks'] == 7
    service.execute(1, job['id'], poll_seconds=0)
    assert len(calls['images']) == len(calls['posts']) == 7
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
    assert len(attempts) == 7 and not calls['posts']
    top = next(part for part in current['parts'] if part['slot'] == 'top')
    assert top['image_status'] == 'rejected'
    assert top['image_failure']['category'] == 'policy' and top['image_failure']['id'] == 'rejecttop123'
    assert sum(part['image_status'] == 'succeeded' for part in current['parts']) == 6
    assert current['status'] == 'pipeline_paused' and 'Meshy 단계는 시작하지 않았습니다' in current['error']


def test_character_parts_uncertain_image_is_never_reposted(setup, monkeypatch):
    service, factory, payload, calls, _, _ = setup
    attempts = []
    def image(source, prompt, model, base, **kwargs):
        attempts.append(prompt)
        if 'back hair shell' in prompt:
            raise httpx.ReadTimeout('lost response')
        return png()
    monkeypatch.setattr(module, 'generate_openai_part_image', image)
    job, _ = service.create(1, 'character-parts-uncertain',
                            {**payload, 'production_mode': 'character_parts', 'slots': module.CHARACTER_PART_SLOTS})
    service.execute(1, job['id'], poll_seconds=0)
    current = factory.get(1, job['id'])
    hair = next(part for part in current['parts'] if part['slot'] == 'hairBack')
    assert hair['image_status'] == 'submission_uncertain' and len(attempts) == 7
    with pytest.raises(PipelineError):
        service.resume(1, job['id'])
    service.execute(1, job['id'], poll_seconds=0)
    assert len(attempts) == 7 and not calls['posts']


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
    assert len(calls['images']) == 7 and not calls['posts']
    assert sum(part['image_status'] == 'succeeded' for part in paused['parts']) == 6
    local = next(part for part in paused['parts'] if part['image_status'] == 'received')
    assert local['image_failure']['category'] == 'local_processing'
    monkeypatch.setattr(service.blueprints, 'upload', original_upload)
    service.resume(1, job['id']); service.execute(1, job['id'], poll_seconds=0)
    assert len(calls['images']) == 7
    assert sum(post.get('ai_model') == 'meshy-7' for post in calls['posts']) == 7


