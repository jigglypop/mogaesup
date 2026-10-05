"""Animal regeneration: request keys, paid Meshy receipts, and the worker that runs a job (animal_library,
animal_production). Meshy, S3 presigning, model downloads and Blender are faked; nothing leaves the machine."""
import hashlib
import io
import json
import subprocess
import sys
from types import SimpleNamespace

import httpx
from PIL import Image
import pytest

from src.services import animal_production, character_jobs, run_lock
from src.services.animal_library import JOBS, AnimalLibrary
from src.services.animal_production import AnimalProduction, StepBlocked
from src.services.asset_editor import _write_json
from src.services.character_pipeline import PipelineError, read_json, request_job_id
from src.services.object_storage import StoredPath
from src.services.process_identity import identity

ANIMAL = 'c' * 24
MODEL = {'model': True}
STEPS = {'views': [], 'note': '', 'steps': ['model', 'rig']}
TASK = {'id': 'task-1', 'status': 'SUCCEEDED', 'progress': 100, 'consumed_credits': 30,
        'model_urls': {'glb': 'https://assets.meshy.invalid/task-1.glb'}}


def png(shade):
    image = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
    image.paste((shade, shade, shade, 255), (16, 8, 48, 56))
    content = io.BytesIO()
    image.save(content, format='PNG')
    return content.getvalue()


def sha(content):
    return hashlib.sha256(content).hexdigest()


def store(path, value):
    """Save a record. These records live in S3, which has no directories; on the test's local disk they are made."""
    path.parent.mkdir(parents=True, exist_ok=True)
    return _write_json(path, value)


class Meshy:
    """Meshy's multi-image-to-3d API. Every POST is a paid submission and is counted; a GET reads the task."""

    def __init__(self):
        self.posts, self.reads = [], []
        self.answer = lambda request: httpx.Response(202, json={'result': 'task-1'})

    def handler(self, request):
        if request.method == 'POST':
            self.posts.append(request.url.path)
            return self.answer(request)
        self.reads.append(request.url.path)
        return httpx.Response(200, json=TASK)

    def client(self, provider, state=None, **_):
        assert provider == 'meshy'
        return httpx.Client(base_url='https://api.meshy.invalid', transport=httpx.MockTransport(self.handler))


def downloaded(run, stage):
    """The model of a finished task, as character_jobs.download saves it."""
    content = b'glTF model of task-1'
    (run / 'generated.glb').write_bytes(content)
    _write_json(run / 'generated-quality.json', {'metrics': {'triangles': 120}})
    artifacts = {'generated': {'path': str(run / 'generated.glb'), 'sha256': sha(content)}}
    _write_json(run / f'{stage}-artifacts.json', artifacts)
    return artifacts


@pytest.fixture
def exited():
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
    try:
        owner = identity(child.pid)
    finally:
        child.kill()
        child.wait(10)
    return owner


@pytest.fixture
def animal(tmp_path, monkeypatch):
    monkeypatch.setenv('ASSET_S3_BUCKET', 'fixture-bucket')
    monkeypatch.setenv('MESHY_API_KEY', 'fixture-key')
    monkeypatch.setattr(animal_production, 'blender_executable', lambda: 'blender')
    monkeypatch.setattr(animal_production, 'provider_image',
                        lambda path, content, mime: {'url': f'https://s3.invalid/{sha(content)}.png'})
    monkeypatch.setattr(character_jobs, 'download', downloaded)
    monkeypatch.setattr(run_lock, 'FINAL_WRITE_DELAYS', (0, 0))
    monkeypatch.setattr(animal_production, '_write_json', store)
    rigged = []
    monkeypatch.setattr(AnimalProduction, '_rig', lambda self, animal_id, work, job: rigged.append(job['id']))
    meshy = Meshy()
    monkeypatch.setattr(animal_production, 'provider_client', meshy.client)
    factory = SimpleNamespace(root=StoredPath(tmp_path) / 'avatar-factory')
    production = AnimalProduction(factory, 1)
    library = production.library
    files = {}
    for shade, name in enumerate(('reference.png', 'front.png', 'left.png', 'back.png', 'right.png')):
        content = png(200 + shade)
        blob = library.blob(ANIMAL, name, sha(content))
        blob.parent.mkdir(parents=True, exist_ok=True)
        blob.write_bytes(content)
        files[name] = sha(content)
    _write_json(library.directory(ANIMAL) / 'record.json', {
        'id': ANIMAL, 'name': '바둑이', 'species': 'dog', 'order': 1, 'created_at': '2026-10-01T00:00:00+00:00',
        'files': files, 'stages': {}, 'production': None})
    yield SimpleNamespace(production=production, library=library, meshy=meshy, rigged=rigged, factory=factory)
    # The worker table lives as long as the process: claims a test leaves must not reach the next one.
    for key in JOBS.snapshot():
        if key.startswith(str(tmp_path)):
            JOBS.release(key)


def job_record(animal, job_id):
    return read_json(animal.library.directory(ANIMAL) / 'jobs' / job_id / 'job.json')


def failing_job_start(monkeypatch):
    """Storage refuses every save of a job that starts running (the executor's first write)."""
    write = animal_production._write_json

    def storage_down(path, value):
        if path.name == 'job.json' and value.get('status') == 'running':
            raise OSError('storage unavailable')
        return write(path, value)
    monkeypatch.setattr(animal_production, '_write_json', storage_down)
    return write


# --- request keys and the worker that runs a job -------------------------------------------------------------------

def test_a_job_whose_first_save_fails_reads_paused_and_its_request_runs_it_once(animal, monkeypatch):
    production, library, meshy = animal.production, animal.library, animal.meshy
    accepted, run = production.start(ANIMAL, 'regen-key-1', MODEL)
    job_id = accepted['production']['id']
    assert run and accepted['production']['status'] == 'accepted'
    # Accepted and waiting for its executor: the same request schedules nothing more, and another one waits.
    assert production.start(ANIMAL, 'regen-key-1', MODEL)[1] is False
    with pytest.raises(PipelineError) as busy:
        production.start(ANIMAL, 'regen-key-2', MODEL)
    assert busy.value.code == 'animal_busy'

    write = failing_job_start(monkeypatch)
    production.execute(ANIMAL, job_id)
    assert job_record(animal, job_id)['status'] == 'accepted' and not meshy.posts
    # Nothing runs it any more: it reads as paused, not as running until the server restarts.
    assert library.get(ANIMAL)['production']['status'] == 'paused'

    monkeypatch.setattr(animal_production, '_write_json', write)
    resumed, run = production.start(ANIMAL, 'regen-key-1', MODEL)
    assert run and resumed['production']['id'] == job_id and resumed['production']['status'] == 'accepted'
    production.execute(ANIMAL, job_id)
    done = library.get(ANIMAL)
    assert done['production']['status'] == 'complete' and done['stages']['model']['task_id'] == 'task-1'
    assert meshy.posts == ['/openapi/v1/multi-image-to-3d'] and animal.rigged == [job_id]
    # A finished job is not run again by its request, nor by a second executor.
    assert production.start(ANIMAL, 'regen-key-1', MODEL)[1] is False
    production.execute(ANIMAL, job_id)
    assert len(meshy.posts) == 1 and animal.rigged == [job_id]


def test_a_new_request_replaces_a_job_that_nothing_runs_any_more(animal, monkeypatch):
    production = animal.production
    first, _ = animal.production.start(ANIMAL, 'regen-key-1', MODEL)
    failing_job_start(monkeypatch)
    production.execute(ANIMAL, first['production']['id'])
    replaced, run = production.start(ANIMAL, 'regen-key-2', MODEL)
    assert run and replaced['production']['id'] != first['production']['id']
    with pytest.raises(PipelineError) as old:
        production.start(ANIMAL, 'regen-key-1', MODEL)
    assert old.value.code == 'job_replaced'


def test_a_job_left_by_an_exited_process_reads_paused_and_its_request_resumes_it(animal, exited):
    production, library = animal.production, animal.library
    job_id = request_job_id(1, f'animal-job:{ANIMAL}', 'regen-key-1')
    store(library.directory(ANIMAL) / 'jobs' / job_id / 'job.json', {
        'id': job_id, 'request_key': 'regen-key-1', 'request': STEPS, 'steps': STEPS['steps'], 'done': [],
        'status': 'running', 'step': 'model', 'process': exited, 'error': None, 'created_at': 'x', 'updated_at': 'x'})
    record = read_json(library.directory(ANIMAL) / 'record.json')
    _write_json(library.directory(ANIMAL) / 'record.json', {**record, 'production': job_id})
    assert library.get(ANIMAL)['production']['status'] == 'paused'
    _, run = production.start(ANIMAL, 'regen-key-1', MODEL)
    assert run
    production.execute(ANIMAL, job_id)
    assert job_record(animal, job_id)['status'] == 'complete' and len(animal.meshy.posts) == 1


def test_a_job_that_could_not_be_accepted_leaves_nothing_claimed(animal, monkeypatch):
    production = animal.production
    write = animal_production._write_json

    def record_refused(path, value):
        if path.name == 'record.json':
            raise OSError('storage unavailable')
        return write(path, value)
    monkeypatch.setattr(animal_production, '_write_json', record_refused)
    with pytest.raises(OSError):
        production.start(ANIMAL, 'regen-key-1', MODEL)
    assert not JOBS.snapshot()
    monkeypatch.setattr(animal_production, '_write_json', write)
    assert production.start(ANIMAL, 'regen-key-2', MODEL)[1]


def test_a_request_key_names_one_request(animal):
    production = animal.production
    production.start(ANIMAL, 'regen-key-1', MODEL)
    with pytest.raises(PipelineError) as conflict:
        production.start(ANIMAL, 'regen-key-1', {'model': True, 'note': '귀를 더 크게'})
    assert conflict.value.code == 'idempotency_conflict'
    with pytest.raises(PipelineError) as invalid:
        production.start(ANIMAL, 'short', MODEL)
    assert invalid.value.code == 'invalid_key'
    assert not animal.meshy.posts


# --- the paid Meshy submission ---------------------------------------------------------------------------------------

def test_a_task_whose_id_could_not_be_saved_is_adopted_from_its_answer_and_never_sent_again(animal, monkeypatch):
    production, library, meshy = animal.production, animal.library, animal.meshy
    write = character_jobs._write_json

    def task_id_lost(path, value):
        if path.name == 'character.json' and value.get('task_id') and 'recovery_method' not in value:
            raise OSError('storage unavailable')
        return write(path, value)
    monkeypatch.setattr(character_jobs, '_write_json', task_id_lost)
    accepted, _ = production.start(ANIMAL, 'regen-key-1', MODEL)
    job_id = accepted['production']['id']
    production.execute(ANIMAL, job_id)
    assert job_record(animal, job_id)['status'] == 'complete' and meshy.posts == ['/openapi/v1/multi-image-to-3d']
    receipt = read_json(library.directory(ANIMAL) / 'jobs' / job_id / 'meshy' / 'character.json')
    assert receipt['task_id'] == 'task-1' and receipt['recovery_method'] == 'submission_response'
    # A new request for the same model is a new job; the accepted task was never sent twice.
    assert library.get(ANIMAL)['stages']['model']['task_id'] == 'task-1'


def test_a_resumed_job_adopts_a_task_named_only_by_its_saved_answer(animal, exited):
    production, library, meshy = animal.production, animal.library, animal.meshy
    job_id = request_job_id(1, f'animal-job:{ANIMAL}', 'regen-key-1')
    work = library.directory(ANIMAL) / 'jobs' / job_id
    store(work / 'job.json', {
        'id': job_id, 'request_key': 'regen-key-1', 'request': STEPS, 'steps': STEPS['steps'], 'done': [],
        'status': 'running', 'step': 'model', 'process': exited, 'error': None, 'created_at': 'x', 'updated_at': 'x'})
    record = read_json(library.directory(ANIMAL) / 'record.json')
    _write_json(library.directory(ANIMAL) / 'record.json', {**record, 'production': job_id})
    # The process stopped after Meshy answered and before the task ID was recorded.
    store(work / 'meshy' / 'character.json', {
        'stage': 'generation', 'status': 'submission_uncertain', 'generation_endpoint': '/openapi/v1/multi-image-to-3d'})
    _write_json(work / 'meshy' / 'generation-submission-response.json',
                {'http_status': 202, 'request_id': 'r-1', 'body': json.dumps({'result': 'task-1'})})
    assert production.start(ANIMAL, 'regen-key-1', MODEL)[1]
    production.execute(ANIMAL, job_id)
    assert job_record(animal, job_id)['status'] == 'complete'
    assert not meshy.posts and meshy.reads == ['/openapi/v1/multi-image-to-3d/task-1']


def unanswered(request):
    raise httpx.ReadTimeout('sent, no answer', request=request)


@pytest.mark.parametrize('answer', [lambda request: httpx.Response(500, json={'message': 'internal'}), unanswered],
                         ids=['server error', 'no answer'])
def test_a_submission_whose_acceptance_is_uncertain_blocks_the_job_and_is_never_sent_again(animal, answer):
    production, library, meshy = animal.production, animal.library, animal.meshy
    meshy.answer = answer
    accepted, _ = production.start(ANIMAL, 'regen-key-1', MODEL)
    job_id = accepted['production']['id']
    production.execute(ANIMAL, job_id)
    job = job_record(animal, job_id)
    assert job['status'] == 'blocked' and '다시 제출하지 않습니다' in job['error']
    assert library.get(ANIMAL)['production']['status'] == 'blocked'
    # Neither its request nor another executor sends it again.
    assert production.start(ANIMAL, 'regen-key-1', MODEL)[1] is False
    production.execute(ANIMAL, job_id)
    assert len(meshy.posts) == 1 and not animal.rigged
    receipt = read_json(library.directory(ANIMAL) / 'jobs' / job_id / 'meshy' / 'character.json')
    assert receipt['status'] == 'submission_uncertain' and not receipt.get('task_id')


def test_a_submission_that_never_left_pauses_and_its_request_sends_it_once_more(animal):
    production, library, meshy = animal.production, animal.library, animal.meshy

    def refused_once(request):
        if len(meshy.posts) == 1:
            raise httpx.ConnectError('connection refused', request=request)
        return httpx.Response(202, json={'result': 'task-1'})
    meshy.answer = refused_once
    accepted, _ = production.start(ANIMAL, 'regen-key-1', MODEL)
    job_id = accepted['production']['id']
    production.execute(ANIMAL, job_id)
    assert job_record(animal, job_id)['status'] == 'paused'
    assert production.start(ANIMAL, 'regen-key-1', MODEL)[1]
    production.execute(ANIMAL, job_id)
    assert job_record(animal, job_id)['status'] == 'complete' and len(meshy.posts) == 2
    archived = read_json(library.directory(ANIMAL) / 'jobs' / job_id / 'meshy' / 'attempts' / '1' / 'archive.json')
    assert archived['status'] == 'submission_not_sent'


def test_an_unconfirmed_image_request_blocks_the_views_step(tmp_path):
    receipt = StoredPath(tmp_path) / 'front-provider'
    _write_json(receipt.with_suffix('.request.json'), {'submission': 'uncertain'})
    assert isinstance(AnimalProduction._image_failure(receipt, OSError('read timeout')), StepBlocked)


# --- publishing ------------------------------------------------------------------------------------------------------

def test_publishing_again_stores_the_same_bytes_once_and_keeps_the_first_replaced_version(animal, monkeypatch):
    production, library = animal.production, animal.library
    work = library.directory(ANIMAL) / 'jobs' / ('d' * 24)
    work.mkdir(parents=True)
    old = library.record(ANIMAL)['files']['front.png']
    writes, write_bytes = [], StoredPath.write_bytes

    def counted(self, data):
        writes.append(self.name)
        return write_bytes(self, data)
    monkeypatch.setattr(StoredPath, 'write_bytes', counted)
    first, second = png(10), png(20)
    production._publish(ANIMAL, work, {'front.png': first})
    production._publish(ANIMAL, work, {'front.png': first})
    blobs = [name for name in writes if not name.endswith('.tmp')]
    assert blobs == [f'{sha(first)}.png'] and library.record(ANIMAL)['files']['front.png'] == sha(first)
    production._publish(ANIMAL, work, {'front.png': second})
    # The version to restore when the job's result is rejected is the one before the job, not its own first result.
    assert read_json(work / 'replaced.json') == {'front.png': old}
    assert library.file(ANIMAL, 'front.png').read_bytes() == second


# --- the library -----------------------------------------------------------------------------------------------------

def test_an_animal_is_created_once_per_request_key(animal):
    library = AnimalLibrary(animal.factory, 2)
    reference = library.upload_reference(png(90))['id']
    assert library.upload_reference(png(90))['id'] == reference
    payload = {'name': '초코', 'species': 'dog', 'reference': reference}
    first, created = library.create('animal-key-1', payload)
    again, created_again = library.create('animal-key-1', payload)
    assert created and not created_again and again['id'] == first['id']
    assert again['production'] is None and [item['id'] for item in library.listing()['items']] == [first['id']]
    with pytest.raises(PipelineError) as conflict:
        library.create('animal-key-1', {**payload, 'name': '쿠키'})
    assert conflict.value.code == 'idempotency_conflict'
