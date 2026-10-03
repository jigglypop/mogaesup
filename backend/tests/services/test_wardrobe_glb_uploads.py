import asyncio
import hashlib
import logging
from threading import Barrier, Thread
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from services.test_character_preparation import animated_fixture
from src.api import avatar_factory as factory_api, studio_glb_assets as studio_api
from src.api.characters import pipeline_error_handler
from src.auth import UserContext, get_current_user
from src.services import avatar_glb_bodies, object_storage
from src.services.asset_editor import _write_json
from src.services.avatar_factory import AvatarFactory, _LOCK
from src.services.avatar_glb_bodies import AvatarGlbBodies
from src.services.character_pipeline import PipelineError, read_json
from src.services.glb import build_glb, parse_glb
from src.services.studio_glb_assets import StudioGlbAssets
from wardrobe_fixture import Overlap


def glb(label='one'):
    doc, binary = parse_glb(animated_fixture(), strict=True)
    doc['asset']['generator'] = label
    return build_glb(doc, binary)


@pytest.fixture
def factory(tmp_path, storage_configured):
    return AvatarFactory(tmp_path)


def together(count, call):
    start, results = Barrier(count), [None]*count

    def work(index):
        start.wait()
        try:
            results[index] = call(index)
        except BaseException as exc:
            results[index] = exc
    threads = [Thread(target=work, args=(index,)) for index in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    return results


class Writes:
    """Which files were written, and whether the process lock was held while they were."""

    def __init__(self, monkeypatch):
        self.log, real = [], object_storage.StoredPath.write_bytes
        log = self.log
        monkeypatch.setattr(object_storage.StoredPath, 'write_bytes',
                            lambda path, data: (log.append((path.name, _LOCK._is_owned())), real(path, data))[1])


def test_an_upload_is_written_without_the_process_lock_and_accepts_a_bytearray(factory, monkeypatch):
    writes = Writes(monkeypatch)
    content = glb()
    receipt = AvatarGlbBodies(factory).upload(1, bytearray(content))
    root = factory.root/'1/base-body-glb-assets'/receipt['id']
    assert receipt['id'] == hashlib.sha256(content).hexdigest() and (root/'source.glb').read_bytes() == content
    assert read_json(root/'receipt.json') == receipt
    assert ('source.glb', False) in writes.log


def test_uploading_the_same_file_again_keeps_the_receipt_registered_assets_copied(factory):
    uploads = AvatarGlbBodies(factory)
    first = uploads.upload(1, glb())
    path = factory.root/'1/base-body-glb-assets'/first['id']/'receipt.json'
    _write_json(path, {**first, 'triangles': first['triangles'] + 1})
    stored = read_json(path)
    assert uploads.upload(1, glb()) == stored and read_json(path) == stored


def test_the_same_file_uploaded_together_is_stored_once(factory, monkeypatch):
    writes = Writes(monkeypatch)
    content = glb()
    results = together(4, lambda index: AvatarGlbBodies(factory).upload(1, bytearray(content)))
    assert not [result for result in results if isinstance(result, BaseException)], results
    assert all(result == results[0] for result in results)
    assert [name for name, _ in writes.log].count('source.glb') == 1


def register(factory, uploads, key='glb-body-key-0001', **changes):
    asset = uploads.upload(1, glb())
    payload = {'name': '몸', 'body_type': 'female', 'model_asset': asset['id'], 'import_mode': 'register',
               'generate_motions': False, 'prepare_expression_uv': False, **changes}
    return asset, payload, uploads.create(1, key, payload)


def test_registering_a_body_copies_and_parses_without_the_process_lock_and_accepts_under_it(factory, monkeypatch):
    uploads = AvatarGlbBodies(factory)
    copies, accepted = [], []
    real_copy, real_write = avatar_glb_bodies.copy_file, avatar_glb_bodies._write_json
    monkeypatch.setattr(avatar_glb_bodies, 'copy_file', lambda source, target: (copies.append(_LOCK._is_owned()), real_copy(source, target))[1])
    monkeypatch.setattr(avatar_glb_bodies, '_write_json',
                        lambda path, value: (accepted.append((path.name, _LOCK._is_owned())), real_write(path, value))[1])
    asset, payload, (job, created) = register(factory, uploads)
    assert created and job['status'] == 'review_required' and job['source_sha256'] == asset['id']
    assert copies and not any(copies)
    assert ('job.json', True) in accepted and all(held for name, held in accepted if name in ('job.json', 'record.json', 'pipeline.json'))
    native = factory.directory(1, job['id'])/'native-parts'
    version = read_json(native/'current.json')['version']
    assert read_json(native/version/'record.json')['files'] == {'body.glb': asset['id'], 'model.glb': asset['id']}
    assert (native/version/'body.glb').read_bytes() == (factory.directory(1, job['id'])/'source.glb').read_bytes()


def test_a_registration_replayed_or_changed_is_answered_from_its_record(factory):
    uploads = AvatarGlbBodies(factory)
    asset, payload, (job, created) = register(factory, uploads)
    again, created_again = uploads.create(1, 'glb-body-key-0001', payload)
    assert created_again is False and again['id'] == job['id']
    with pytest.raises(PipelineError) as error:
        uploads.create(1, 'glb-body-key-0001', {**payload, 'name': '다른 이름'})
    assert error.value.code == 'idempotency_conflict'


def test_the_same_registration_sent_together_makes_one_job(factory):
    uploads = AvatarGlbBodies(factory)
    asset = uploads.upload(1, glb())
    payload = {'name': '몸', 'body_type': 'male', 'model_asset': asset['id'], 'import_mode': 'register',
               'generate_motions': False, 'prepare_expression_uv': False}
    results = together(3, lambda index: AvatarGlbBodies(factory).create(1, 'glb-body-key-0002', payload))
    assert not [result for result in results if isinstance(result, BaseException)], results
    assert sorted(created for _, created in results) == [False, False, True] and len({job['id'] for job, _ in results}) == 1


def test_a_source_that_changed_is_refused_before_anything_is_copied(factory, monkeypatch):
    uploads = AvatarGlbBodies(factory)
    asset = uploads.upload(1, glb())
    (factory.root/'1/base-body-glb-assets'/asset['id']/'source.glb').write_bytes(b'tampered')
    copies = []
    monkeypatch.setattr(avatar_glb_bodies, 'copy_file', lambda source, target: copies.append(target))
    with pytest.raises(PipelineError) as error:
        uploads.create(1, 'glb-body-key-0003', {'name': '몸', 'body_type': 'male', 'model_asset': asset['id'],
                                                'import_mode': 'register', 'generate_motions': False, 'prepare_expression_uv': False})
    assert error.value.code == 'source_changed' and copies == []


def library_with(factory, count=2):
    assets, library = [], StudioGlbAssets(factory, 1)
    for index in range(count):
        asset = library.upload(glb(f'asset {index}'))
        library.create(f'studio-glb-key-{index:04}', {'name': f'헤어 {index}', 'slot': 'hair', 'model_asset': asset['id']})
        assets.append(asset)
    return library, assets


def test_the_library_lists_the_other_assets_when_one_receipt_differs(factory, caplog):
    library, [first, second] = library_with(factory)
    assert {item['info']['id'] for item in library.listing()['items']} == {first['id'], second['id']}
    path = factory.root/'1/base-body-glb-assets'/first['id']/'receipt.json'
    _write_json(path, {**read_json(path), 'triangles': 999})
    with caplog.at_level(logging.WARNING, logger='src.services.studio_glb_assets'):
        items = library.listing()['items']
    assert [item['info']['id'] for item in items] == [second['id']]
    assert 'source_changed' in caplog.text
    [record] = [path for path in library.root.glob('*/record.json') if read_json(path)['model_asset'] == first['id']]
    with pytest.raises(PipelineError) as error:
        library.get(record.parent.name)
    assert error.value.code == 'source_changed'


def test_a_deleted_or_unreadable_record_is_left_out_of_the_library(factory, caplog):
    library, _ = library_with(factory, 3)
    records = sorted(library.root.glob('*/record.json'))
    deleted, unreadable = records[0], records[1]
    _write_json(deleted, {**read_json(deleted), 'deleted': True})
    _write_json(unreadable, {**read_json(unreadable), 'slot': 'not a slot'})
    with caplog.at_level(logging.WARNING, logger='src.services.studio_glb_assets'):
        items = library.listing()['items']
    assert [item['id'] for item in items] == [records[2].parent.name]
    # A deleted record is not news; one that cannot be read is.
    assert unreadable.parent.name in caplog.text and deleted.parent.name not in caplog.text


# The upload endpoints -----------------------------------------------------------

@pytest.fixture
def client(factory):
    app = FastAPI()
    app.include_router(factory_api.router, prefix='/api')
    app.include_router(studio_api.router, prefix='/api')
    app.add_exception_handler(PipelineError, pipeline_error_handler)
    app.dependency_overrides[factory_api.get_factory] = lambda: factory
    app.dependency_overrides[get_current_user] = lambda: UserContext(1, 'tester', [])
    with TestClient(app) as client:
        yield client


UPLOADS = ('/api/avatar-factory/base-bodies/glb-assets', '/api/studio/glb-assets/upload')


@pytest.mark.parametrize('url', UPLOADS)
def test_an_upload_reaches_the_service_as_it_was_read_not_as_a_second_copy(client, monkeypatch, url):
    received = []
    real = AvatarGlbBodies.upload
    monkeypatch.setattr(AvatarGlbBodies, 'upload', lambda self, owner, content: (received.append(type(content)), real(self, owner, content))[1])
    response = client.post(url, content=glb(), headers={'Content-Type': 'model/gltf-binary'})
    assert response.status_code == 201 and response.json()['id'] == hashlib.sha256(glb()).hexdigest()
    assert received == [bytearray]


@pytest.mark.parametrize('url', UPLOADS)
def test_a_file_over_the_limit_is_refused(client, monkeypatch, url):
    monkeypatch.setattr(avatar_glb_bodies, 'MAX_GLB_BYTES', 100)
    response = client.post(url, content=b'x'*101)
    assert response.status_code == 413 and response.json()['error']['code'] == 'glb_too_large'


@pytest.mark.parametrize('url', UPLOADS)
def test_an_upload_that_finds_no_free_slot_is_refused_with_503(client, monkeypatch, url):
    full = factory_api.UploadSlots(0, .05)
    monkeypatch.setattr(factory_api, 'GLB_UPLOADS', full)
    monkeypatch.setattr(studio_api, 'GLB_UPLOADS', full)
    response = client.post(url, content=glb())
    assert response.status_code == 503 and response.json()['error']['code'] == 'upload_busy'


def test_at_most_two_uploads_are_in_flight_and_the_rest_wait_for_a_slot(client, monkeypatch):
    slots = factory_api.UploadSlots(2, 20)
    monkeypatch.setattr(factory_api, 'GLB_UPLOADS', slots)
    monkeypatch.setattr(studio_api, 'GLB_UPLOADS', slots)
    # Generous: the first two wait for each other however slowly a loaded machine starts the threads.
    inside = Overlap(wait=30)

    def slow(self, owner, content):
        with inside:
            time.sleep(.05)
        return {'id': hashlib.sha256(content).hexdigest()}
    monkeypatch.setattr(AvatarGlbBodies, 'upload', slow)
    results = together(5, lambda index: client.post(UPLOADS[index % 2], content=glb(f'upload {index}')).status_code)
    assert results == [201]*5 and inside.peak == 2


def test_the_slots_are_given_back_and_a_waiter_gives_up_after_its_wait():
    async def scenario():
        slots = factory_api.UploadSlots(2, .1)
        order, release = [], asyncio.Event()

        async def hold(name, until=None):
            async with slots.slot():
                order.append(name)
                if until:
                    await until.wait()
        # The first two keep their slots until the third has given up, however slow the machine is.
        first, second = asyncio.create_task(hold('first', release)), asyncio.create_task(hold('second', release))
        while len(order) < 2:
            await asyncio.sleep(0)
        with pytest.raises(PipelineError) as refused:
            await hold('third')
        assert refused.value.status == 503 and refused.value.code == 'upload_busy'
        release.set()
        await asyncio.gather(first, second)
        await hold('fourth')
        return order
    assert asyncio.run(scenario()) == ['first', 'second', 'fourth']
