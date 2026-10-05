from contextlib import contextmanager
import hashlib
import io
import shutil

from PIL import Image
import pytest

from lock_probe import lock_free
from native_assembly_fixture import JOB, VERSION, seed_native_assembly
from src.services import avatar_native_parts, avatar_part_batches, meshy_status, run_lock
from src.services.asset_editor import _write_json
from src.services.avatar_blueprints import AvatarBlueprints
from src.services.avatar_factory import _LOCK, digest
from src.services.avatar_native_parts import SLOTS
from src.services.avatar_part_batches import PartBatches
from src.services.character_pipeline import PipelineError, read_json
from src.services.meshy_options import MeshyPartOptions


@pytest.fixture
def batches(tmp_path, monkeypatch, storage_configured):
    factory, directory = seed_native_assembly(tmp_path, 'fixture')
    _write_json(directory.parent.parent/'pipeline.json', {
        'production_spec': {'id': 'spec'}, 'parts': [{'slot': slot, 'model': {'status': 'ready'}} for slot in ('body', *SLOTS)]})
    # Records go to object storage, which has no directories; on a local disk they have to be made.
    real = avatar_part_batches._write_json
    monkeypatch.setattr(avatar_part_batches, '_write_json',
                        lambda path, value: (path.parent.mkdir(parents=True, exist_ok=True), real(path, value))[1])
    monkeypatch.setattr(meshy_status, 'require_credits', lambda count: None)
    return factory, directory, PartBatches(factory)


def image(color, size=(8, 8)):
    content = io.BytesIO()
    Image.new('RGBA', size, color).save(content, 'PNG')
    return content.getvalue()


def payload(factory, *items, **changes):
    assets = AvatarBlueprints(factory.data)
    return {'base_job_id': JOB, 'base_version': VERSION, 'concurrency': 2,
            'meshy_options': MeshyPartOptions().model_dump(mode='json'),
            'items': [{'name': name, 'views': {view: assets.upload(1, content)['id'] for view, content in views.items()}}
                      for name, views in items], **changes}


def three(color):
    return {'front': image(color), 'side': image(color, (9, 8)), 'back': image(color, (8, 9))}


class Entries:
    """Where image checks and the lease happen, so a test can tell whether the process lock was held."""

    def __init__(self, monkeypatch):
        self.checks, self.leases = [], []
        real = avatar_part_batches._validate_source_image
        monkeypatch.setattr(avatar_part_batches, '_validate_source_image',
                            lambda content: (self.checks.append(_LOCK._is_owned()), real(content))[1])
        real_lease = avatar_part_batches._batch_lease

        @contextmanager
        def lease(directory):
            self.leases.append(1)
            with real_lease(directory):
                yield
        monkeypatch.setattr(avatar_part_batches, '_batch_lease', lease)


def test_every_image_is_checked_before_the_process_lock_and_the_batch_lease_are_taken(batches, monkeypatch):
    factory, _, service = batches
    seen = Entries(monkeypatch)
    # Two hairs sharing one drawing: each distinct image is decoded once.
    shared = three((40, 40, 60, 255))
    record, dispatch = service.create(1, 'part-batch-key-0001', payload(
        factory, ('헤어 A', shared), ('헤어 B', {**three((60, 40, 40, 255)), 'front': shared['front']})))
    assert dispatch and record['status'] == 'accepted' and [item['name'] for item in record['items']] == ['헤어 A', '헤어 B']
    assert len(seen.checks) == 5 and not any(seen.checks)
    assert seen.leases == [1]


def plant(factory, content):
    """A saved upload under its own hash, whatever the bytes are."""
    asset_id = hashlib.sha256(content).hexdigest()
    path = factory.data/'avatar-blueprints/1/assets'/f'{asset_id}.png'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return asset_id


def test_a_bad_image_stops_the_request_before_any_lock_is_taken(batches, monkeypatch):
    factory, _, service = batches
    seen = Entries(monkeypatch)
    request = payload(factory, ('헤어', three((40, 40, 60, 255))))
    request['items'][0]['views']['side'] = plant(factory, b'not an image')
    with pytest.raises(PipelineError) as error:
        service.create(1, 'part-batch-key-0002', request)
    assert error.value.code == 'invalid_part_image' and seen.leases == [] and not any(seen.checks)
    batch = hashlib.sha256(b'1:part-batch:part-batch-key-0002').hexdigest()[:24]
    assert not (service.root(1, batch)/'batch.json').is_file()


def test_a_changed_image_is_reported_before_the_lock(batches, monkeypatch):
    factory, _, service = batches
    seen = Entries(monkeypatch)
    request = payload(factory, ('헤어', three((40, 40, 60, 255))))
    asset = request['items'][0]['views']['back']
    (factory.data/'avatar-blueprints/1/assets'/f'{asset}.png').write_bytes(b'changed')
    with pytest.raises(PipelineError) as error:
        service.create(1, 'part-batch-key-0003', request)
    assert error.value.status in (404, 409) and seen.leases == []


def test_too_many_items_and_missing_views_are_refused_before_images_are_read(batches, monkeypatch):
    factory, _, service = batches
    seen = Entries(monkeypatch)
    with pytest.raises(PipelineError) as error:
        service.create(1, 'part-batch-key-0004', {**payload(factory, ('헤어', three((40, 40, 60, 255)))),
                                                  'items': [{'name': 'x', 'views': {}}]*49})
    assert error.value.code == 'batch_too_large'
    with pytest.raises(PipelineError) as error:
        service.create(1, 'part-batch-key-0005', {**payload(factory, ('헤어', three((40, 40, 60, 255)))),
                                                  'items': [{'name': 'x', 'views': {'front': 'a'*64}}]})
    assert error.value.code == 'invalid_views' and seen.checks == [] and seen.leases == []


def test_a_replayed_request_is_answered_without_reading_its_images_again(batches, monkeypatch):
    factory, _, service = batches
    request = payload(factory, ('헤어', three((40, 40, 60, 255))))
    first, dispatch = service.create(1, 'part-batch-key-0006', request)
    seen = Entries(monkeypatch)
    again, dispatch_again = service.create(1, 'part-batch-key-0006', request)
    assert dispatch and not dispatch_again and again['id'] == first['id'] and seen.checks == []
    with pytest.raises(PipelineError) as error:
        service.create(1, 'part-batch-key-0006', {**request, 'concurrency': 1})
    assert error.value.code == 'idempotency_conflict'


def test_a_changed_base_is_refused_and_its_messages_do_not_name_a_sex(batches):
    factory, directory, service = batches
    request = payload(factory, ('헤어', three((40, 40, 60, 255))))
    record, _ = service.create(1, 'part-batch-key-0007', request)
    path = service.root(1, record['id'])/'batch.json'
    saved = read_json(path)
    _write_json(path, {**saved, 'base_receipt': {**saved['base_receipt'], 'body_sha256': 'f'*64}})
    with pytest.raises(PipelineError) as changed:
        service.resume(1, record['id'])
    assert changed.value.code == 'base_changed' and '여성' not in changed.value.message and '기준 몸' in changed.value.message
    sealed = read_json(directory/'record.json')
    _write_json(directory/'record.json', {**sealed, 'files': {name: sha for name, sha in sealed['files'].items() if name != 'body.glb'}})
    with pytest.raises(PipelineError) as incomplete:
        service._base_receipt(1, request)
    assert incomplete.value.code == 'base_incomplete' and '여성' not in incomplete.value.message and '기준 몸' in incomplete.value.message


def test_a_listing_reads_each_child_once_and_trusts_the_saved_receipts(batches, monkeypatch):
    factory, _, service = batches
    for index, color in enumerate(((40, 40, 60, 255), (60, 40, 40, 255))):
        service.create(1, f'part-batch-list-{index:04}', payload(factory, ('헤어', three(color))))
    gets, real_get = [], factory.get
    monkeypatch.setattr(factory, 'get', lambda owner, job: (gets.append(job), real_get(owner, job))[1])
    monkeypatch.setattr(avatar_part_batches, 'digest', lambda path: pytest.fail('a listing must not hash the saved models'))
    listing = service.list(1)
    assert len(listing['items']) == 2
    assert all(item['status'] == 'queued' and item['child_status'] == 'not_created'
               for batch in listing['items'] for item in batch['items'])
    # One factory read per child; a child that was never created is not looked up twice.
    assert sorted(gets) == sorted(item['job_id'] for batch in listing['items'] for item in batch['items'])


def test_a_batch_whose_last_save_fails_is_not_left_running(batches, monkeypatch):
    factory, _, service = batches
    monkeypatch.setattr(run_lock, 'FINAL_WRITE_DELAYS', (0, 0))
    record, _ = service.create(1, 'part-batch-key-0008', payload(factory, ('헤어', three((40, 40, 60, 255)))))

    class Stopped:
        def __init__(self, factory):
            pass

        def create_single_part(self, *args, **kwargs):
            raise PipelineError('fixture_stopped', '헤어 처리 중단', 409)
    monkeypatch.setattr(avatar_part_batches, 'AvatarVariants', Stopped)
    write = avatar_part_batches._write_json

    def refuse_the_end(path, value):
        if path.name == 'batch.json' and value.get('status') in ('paused', 'complete'):
            raise OSError('storage unavailable')
        return write(path, value)
    monkeypatch.setattr(avatar_part_batches, '_write_json', refuse_the_end)
    with pytest.raises(OSError):
        service.execute(1, record['id'])
    assert read_json(service.root(1, record['id'])/'batch.json')['status'] == 'running'
    # Running in this live process but held by no worker: it reads as paused and can be resumed, not as running.
    public = service.get(1, record['id'])
    assert public['status'] == 'paused' and public['can_resume'] and avatar_part_batches._RUNS == {}
    monkeypatch.setattr(avatar_part_batches, '_write_json', write)
    resumed, dispatch = service.resume(1, record['id'])
    assert dispatch and read_json(service.root(1, record['id'])/'batch.json')['status'] == 'accepted'


def hashes_while_free(monkeypatch):
    """Each base and model hash a batch takes, as whether the process lock was free for other threads meanwhile."""
    seen = []
    for module in (avatar_part_batches, avatar_native_parts):
        monkeypatch.setattr(module, 'digest', lambda path: (seen.append(lock_free()), digest(path))[1])
    return seen


def test_the_base_is_read_and_hashed_while_the_process_lock_is_free(batches, monkeypatch):
    factory, _, service = batches
    request = payload(factory, ('헤어', three((40, 40, 60, 255))))
    seen = hashes_while_free(monkeypatch)
    record, dispatch = service.create(1, 'part-batch-key-0010', request)
    assert dispatch and seen and all(seen)
    path = service.root(1, record['id'])/'batch.json'
    _write_json(path, {**read_json(path), 'status': 'paused'})
    seen.clear()
    resumed, dispatch = service.resume(1, record['id'])
    assert dispatch and read_json(path)['status'] == 'accepted' and seen and all(seen)


def test_a_batch_written_while_its_base_is_hashed_is_not_resumed_over(batches, monkeypatch):
    factory, _, service = batches
    record, _ = service.create(1, 'part-batch-key-0011', payload(factory, ('헤어', three((40, 40, 60, 255)))))
    path = service.root(1, record['id'])/'batch.json'
    _write_json(path, {**read_json(path), 'status': 'paused'})

    def written_meanwhile(file):
        _write_json(path, {**read_json(path), 'error': '다른 실행이 남긴 기록'})
        return digest(file)
    monkeypatch.setattr(avatar_part_batches, 'digest', written_meanwhile)
    with pytest.raises(PipelineError) as error:
        service.resume(1, record['id'])
    assert error.value.code == 'worker_active'
    saved = read_json(path)
    assert saved['status'] == 'paused' and saved['error'] == '다른 실행이 남긴 기록'


def test_the_last_save_reads_the_children_outside_the_lock_and_again_when_the_record_changed(batches, monkeypatch):
    factory, _, service = batches
    monkeypatch.setattr(run_lock, 'FINAL_WRITE_DELAYS', (0, 0))
    record, _ = service.create(1, 'part-batch-key-0012', payload(factory, ('헤어', three((40, 40, 60, 255)))))
    path = service.root(1, record['id'])/'batch.json'

    class Stopped:
        def __init__(self, factory):
            pass

        def create_single_part(self, *args, **kwargs):
            raise PipelineError('fixture_stopped', '헤어 처리 중단', 409)
    monkeypatch.setattr(avatar_part_batches, 'AvatarVariants', Stopped)
    held, real_public = [], PartBatches._public

    def public(self, owner, current, **kwargs):
        held.append(_LOCK._is_owned())
        if len(held) == 1:
            _write_json(path, {**read_json(path), 'note': 'written meanwhile'})
        return real_public(self, owner, current, **kwargs)
    monkeypatch.setattr(PartBatches, '_public', public)
    service.execute(1, record['id'])
    saved = read_json(path)
    assert held == [False, False]
    assert saved['status'] == 'paused' and saved['note'] == 'written meanwhile' and saved['items'][0]['status'] == 'paused'


def test_a_listing_reads_the_job_of_a_made_child_once(batches, monkeypatch):
    factory, directory, service = batches
    record, _ = service.create(1, 'part-batch-list-0100', payload(factory, ('헤어', three((40, 40, 60, 255)))))
    child = record['items'][0]['job_id']
    # A child that was made and assembled: a copy of the sealed fixture job.
    shutil.copytree(directory.parent.parent, factory.directory(1, child))
    gets, real_get = [], factory.get
    monkeypatch.setattr(factory, 'get', lambda owner, job: (gets.append(job), real_get(owner, job))[1])
    [batch] = service.list(1)['items']
    [item] = batch['items']
    assert item['status'] == 'complete' and item['native_receipt']['version'] == VERSION
    # The assembly state is read from the child's records; the whole job is read once, for its own state.
    assert gets == [child]
