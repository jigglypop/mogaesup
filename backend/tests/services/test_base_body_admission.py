"""A base body is accepted with its sources hashed, Meshy's action list fetched and its files staged outside the
process lock: the lock that every admission of every job waits for is taken only for the records that accept it."""
import io
import threading
import time

from PIL import Image
import pytest

from src.services import avatar_base_bodies, avatar_meshy, character_motion, character_pipeline
from src.services.avatar_base_bodies import AvatarBaseBodies
from src.services.avatar_factory import _LOCK, AvatarFactory
from src.services.character_pipeline import CharacterPipeline, PipelineError, read_json
from src.services.run_lock import run_lock

KEY = 'base-body-key-0001'


def png(color):
    data = io.BytesIO()
    Image.new('RGBA', (8, 8), color).save(data, format='PNG')
    return data.getvalue()


@pytest.fixture
def bodies(tmp_path, monkeypatch, storage_configured):
    monkeypatch.setenv('MESHY_API_KEY', 'fixture-only')
    monkeypatch.setattr(avatar_base_bodies, 'blender_executable', lambda: 'blender')
    service = AvatarBaseBodies(AvatarFactory(tmp_path))
    views = {view: service.blueprints.upload(1, png(color))['id']
             for view, color in (('front', 'red'), ('side', 'green'), ('back', 'blue'))}
    fetched = []
    items = [{'action_id': action_id} for action_id in set(character_motion.DEFAULT_ACTIONS.values())]
    monkeypatch.setattr(avatar_meshy.AvatarMeshy, 'library',
                        lambda self, owner: (fetched.append(_LOCK._is_owned()), items)[1])
    return service, {'name': '기본 몸', 'body_type': 'male', 'views': views}, fetched


def test_the_sources_and_the_meshy_list_are_read_without_the_process_lock(bodies, monkeypatch):
    service, payload, fetched = bodies
    hashed, real = [], avatar_base_bodies.digest
    monkeypatch.setattr(avatar_base_bodies, 'digest', lambda path: (hashed.append(_LOCK._is_owned()), real(path))[1])
    written, real_write = [], avatar_base_bodies._write_json
    monkeypatch.setattr(avatar_base_bodies, '_write_json',
                        lambda path, value: (written.append((path.name, _LOCK._is_owned())), real_write(path, value))[1])
    job, created = service.create(1, KEY, payload)
    assert created and job['status'] == 'pipeline_queued' and job['job_kind'] == 'base_body'
    assert hashed and not any(hashed) and fetched and not any(fetched)
    # Only the records that accept the job are written under the lock.
    assert [name for name, locked in written if locked] == ['pipeline.json', 'progress.json', 'job.json',
                                                            service._receipt(1, KEY).name]
    directory = service.factory.directory(1, job['id'])
    assert read_json(directory/'pipeline.json')['motion_actions'] == character_motion.DEFAULT_ACTIONS
    assert all((directory/'output'/f'body-{view}.png').is_file() for view in ('front', 'side', 'back'))


def test_the_same_key_is_a_replay_and_other_input_a_conflict(bodies):
    service, payload, _ = bodies
    first, created = service.create(1, KEY, payload)
    again, created_again = service.create(1, KEY, payload)
    assert created and not created_again and again['id'] == first['id']
    with pytest.raises(PipelineError) as error:
        service.create(1, KEY, {**payload, 'name': '다른 몸'})
    assert error.value.code == 'idempotency_conflict'


def test_concurrent_requests_with_one_key_make_one_job_and_one_character(bodies):
    service, payload, _ = bodies
    results, errors = [], []

    def create():
        try:
            results.append(service.create(1, KEY, payload))
        except Exception as exc:  # pragma: no cover - reported below
            errors.append(exc)
    threads = [threading.Thread(target=create) for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == [] and sorted(created for _, created in results) == [False, False, True]
    assert len({job['id'] for job, _ in results}) == 1
    marker = f'__base_body_request_{results[0][0]["id"]}__'
    assert len([item for item in service.factory.pipeline.records() if item.get('name') == marker or
                item['id'] == results[0][0]['character_id']]) == 1


# --- the character registry ---------------------------------------------------------------------------------------

def slow_registry_writes(monkeypatch, seconds=.2):
    """Each registry write takes a while, so requests that arrive together meet at the registry."""
    real = character_pipeline._write_json

    def write(path, value):
        if path.name == 'batch.json':
            time.sleep(seconds)
        return real(path, value)
    monkeypatch.setattr(character_pipeline, '_write_json', write)


def test_base_bodies_requested_together_are_all_accepted(bodies, monkeypatch):
    service, payload, _ = bodies
    slow_registry_writes(monkeypatch)
    results, errors = [], []

    def create(index):
        try:
            results.append(service.create(1, f'base-body-key-100{index}', {**payload, 'name': f'몸 {index}'}))
        except Exception as exc:  # The registry refused a request for another one's sake.
            errors.append(exc)
    threads = [threading.Thread(target=create, args=(index,)) for index in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    assert errors == [] and len(results) == 3 and all(created for _, created in results)
    assert len({job['character_id'] for job, _ in results}) == 3


def test_a_character_waits_for_the_registry_another_process_holds_for_a_moment(tmp_path, monkeypatch):
    pipeline = CharacterPipeline(tmp_path)
    monkeypatch.setattr(character_pipeline, 'REGISTRY_POLL_SECONDS', .02)
    held, release = threading.Event(), threading.Event()

    def other_process():
        # A CLI on the same data root holds the registry's run lock.
        with run_lock(tmp_path/'characters/.registry', pipeline.port, blender=False):
            held.set()
            release.wait(10)
    thread = threading.Thread(target=other_process)
    thread.start()
    try:
        assert held.wait(10)
        threading.Timer(.3, release.set).start()
        assert pipeline.create('기다린 캐릭터', 1.2, 1)['name'] == '기다린 캐릭터'
    finally:
        release.set()
        thread.join(10)
    monkeypatch.setattr(character_pipeline, 'REGISTRY_WAIT_SECONDS', .2)
    held.clear()
    release.clear()
    thread = threading.Thread(target=other_process)
    thread.start()
    try:
        assert held.wait(10)
        with pytest.raises(PipelineError) as error:
            pipeline.create('기다리지 못한 캐릭터', 1.2, 1)
        assert error.value.code == 'busy'
    finally:
        release.set()
        thread.join(10)
