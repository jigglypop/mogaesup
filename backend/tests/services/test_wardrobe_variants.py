import hashlib

import pytest

from src.services import avatar_fitting_management, avatar_variants
from src.services.avatar_factory import _LOCK
from src.services.avatar_variants import AvatarVariants
from src.services.character_pipeline import PipelineError, read_json
from wardrobe_fixture import seed_variant_base

KEY = 'variant-key-0001'


@pytest.fixture
def base(tmp_path, monkeypatch, storage_configured):
    factory, directory, job, version = seed_variant_base(tmp_path)
    monkeypatch.setattr(avatar_variants, 'capabilities', lambda: {
        'blender_available': True, 'image_configured': True, 'meshy_configured': True, 'image_model': 'gpt-image-test'})
    # Parsed body facts are remembered by file hash for the process; every test starts without them.
    monkeypatch.setattr(avatar_fitting_management, '_facts', type(avatar_fitting_management._facts)())
    uploaded = tmp_path/'uploaded.glb'
    uploaded.write_bytes(b'uploaded glb')
    sha = hashlib.sha256(b'uploaded glb').hexdigest()
    payload = {'base_job_id': job, 'base_version': version, 'slot': 'hair', 'part_name': '새 헤어',
               'uploaded_model': {'asset_id': sha, 'path': str(uploaded), 'sha256': sha}}
    return factory, directory, payload


class Spy:
    """Whether the process lock was held when the heavy steps ran, and whether the job was accepted under it."""

    def __init__(self, monkeypatch):
        self.copies, self.trees, self.parses, self.written = [], [], [], []
        real_copy, real_tree = avatar_variants.copy_file, avatar_variants.copy_tree
        real_write, real_identity = avatar_variants._write_json, avatar_fitting_management.geometry_identity
        monkeypatch.setattr(avatar_variants, 'copy_file', lambda source, target: (self.copies.append(_LOCK._is_owned()), real_copy(source, target))[1])
        monkeypatch.setattr(avatar_variants, 'copy_tree', lambda source, target: (self.trees.append(_LOCK._is_owned()), real_tree(source, target))[1])
        monkeypatch.setattr(avatar_variants, '_write_json', lambda path, value: (self.written.append((path.name, _LOCK._is_owned())), real_write(path, value))[1])
        monkeypatch.setattr(avatar_fitting_management, 'geometry_identity', lambda content: (self.parses.append(_LOCK._is_owned()), real_identity(content))[1])


def test_a_variant_copies_and_parses_without_the_process_lock_and_is_accepted_under_it(base, monkeypatch):
    factory, directory, payload = base
    spy = Spy(monkeypatch)
    job, created = AvatarVariants(factory).create_single_part(1, KEY, payload)
    assert created and job['status'] == 'pipeline_queued' and job['base_job_id'] == payload['base_job_id']
    assert spy.copies and not any(spy.copies) and spy.trees and not any(spy.trees)
    # The body is parsed once, before the lock; the checks under it read the result from memory.
    assert spy.parses == [False]
    accepted = dict(spy.written)
    assert accepted['job.json'] and accepted['pipeline.json'] and accepted['receipt.json']
    target = factory.directory(1, job['id'])
    body_hash = read_json(target/'meshy/delivery.json')['files']['model.glb']
    assert (target/'meshy/versions'/body_hash[:24]/'model.glb').read_bytes() == (directory/'native-parts'/payload['base_version']/'body.glb').read_bytes()
    assert [clip['slot'] for clip in read_json(target/'meshy/delivery.json')['clips']] == ['idle', 'walk', 'run', 'jump', 'sit', 'fall']
    # What the job keeps of the base: its drawings and part models, and the fitted files of the parts left alone.
    for name in ('source.png', 'output/body-front.png', 'output/top-side.png', 'parts/body/generated.glb',
                 'parts/shoes/generation-artifacts.json', 'prefit-parts/top.glb', 'prefit-parts/shoes.glb', 'parts/hair/generated.glb'):
        assert (target/name).is_file(), name
    assert not (target/'prefit-parts/hair.glb').is_file()


def test_the_same_key_again_is_a_replay_and_another_request_is_a_conflict(base):
    factory, _, payload = base
    service = AvatarVariants(factory)
    first, created = service.create_single_part(1, KEY, payload)
    again, created_again = service.create_single_part(1, KEY, payload)
    assert created and not created_again and again['id'] == first['id']
    with pytest.raises(PipelineError) as error:
        service.create_single_part(1, KEY, {**payload, 'part_name': '다른 이름'})
    assert error.value.code == 'idempotency_conflict'


def test_a_request_accepted_while_the_files_are_copied_is_not_written_twice(base, monkeypatch):
    factory, _, payload = base
    service = AvatarVariants(factory)
    real, accepted = avatar_variants.copy_file, []

    def copying(source, target):
        if not accepted:
            # Another request with the same key gets in while this one copies, and is accepted first.
            monkeypatch.setattr(avatar_variants, 'copy_file', real)
            accepted.append(service.create_single_part(1, KEY, payload))
        return real(source, target)
    monkeypatch.setattr(avatar_variants, 'copy_file', copying)
    job, created = service.create_single_part(1, KEY, payload)
    [(first, first_created)] = accepted
    assert first_created and not created and job['id'] == first['id']


def test_nothing_is_copied_when_a_check_fails(base, monkeypatch):
    factory, directory, payload = base
    spy = Spy(monkeypatch)
    (directory/'native-parts'/payload['base_version']/'top.glb').write_bytes(b'changed after sealing')
    with pytest.raises(PipelineError) as error:
        AvatarVariants(factory).create_single_part(1, KEY, payload)
    assert error.value.code == 'fitted_part_changed' and spy.copies == [] and spy.trees == []
    assert not (factory.directory(1, hashlib.sha256(f'1:variant:{KEY}'.encode()).hexdigest()[:24])/'job.json').is_file()


def test_a_base_that_cannot_be_parsed_is_reported_by_the_checks_not_by_the_warm_up(base):
    factory, directory, payload = base
    (directory/'native-parts'/payload['base_version']/'body.glb').write_bytes(b'not a glb')
    with pytest.raises(PipelineError) as error:
        AvatarVariants(factory).create_single_part(1, KEY, payload)
    assert error.value.code == 'body_changed'
    with pytest.raises(PipelineError) as error:
        AvatarVariants(factory).create_single_part(1, 'variant-key-0002', {**payload, 'base_version': '0'*24})
    assert error.value.code == 'base_changed'
