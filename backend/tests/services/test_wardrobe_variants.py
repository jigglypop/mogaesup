import hashlib

import pytest

from src.services import avatar_fitting_management, avatar_variants
from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK
from src.services.avatar_image_pipeline import AvatarImagePipeline
from src.services.avatar_image_recovery import retry_view
from src.services.avatar_variants import AvatarVariants
from src.services.character_pipeline import PipelineError, read_json
from wardrobe_fixture import seed_variant_base, textured_glb

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


def test_a_glb_registered_as_it_was_is_refused_before_its_body_is_read(base, monkeypatch):
    factory, directory, payload = base
    version = directory/'native-parts'/payload['base_version']
    record = read_json(version/'record.json')
    record['result']['origin'] = 'uploaded_glb'
    _write_json(version/'record.json', record)
    spy = Spy(monkeypatch)
    with pytest.raises(PipelineError) as error:
        AvatarVariants(factory).create_single_part(1, KEY, payload)
    assert error.value.code == 'body_preparation_required' and spy.parses == []


def test_a_version_that_is_not_sealed_is_refused_before_its_body_is_read(base, monkeypatch):
    factory, directory, payload = base
    version = directory/'native-parts'/payload['base_version']
    record = read_json(version/'record.json')
    record['status'] = 'qc_failed'
    _write_json(version/'record.json', record)
    spy = Spy(monkeypatch)
    with pytest.raises(PipelineError) as error:
        AvatarVariants(factory).create_single_part(1, KEY, payload)
    assert error.value.code == 'base_changed' and spy.parses == []


def test_a_body_changed_after_sealing_is_refused_before_it_is_read(base, monkeypatch):
    factory, directory, payload = base
    (directory/'native-parts'/payload['base_version']/'body.glb').write_bytes(textured_glb())
    spy = Spy(monkeypatch)
    with pytest.raises(PipelineError) as error:
        AvatarVariants(factory).create_single_part(1, KEY, payload)
    assert error.value.code == 'body_changed' and spy.parses == [] and not avatar_fitting_management._facts


def test_a_base_that_cannot_be_parsed_is_reported_by_the_checks_not_by_the_warm_up(base):
    factory, directory, payload = base
    (directory/'native-parts'/payload['base_version']/'body.glb').write_bytes(b'not a glb')
    with pytest.raises(PipelineError) as error:
        AvatarVariants(factory).create_single_part(1, KEY, payload)
    assert error.value.code == 'body_changed'
    with pytest.raises(PipelineError) as error:
        AvatarVariants(factory).create_single_part(1, 'variant-key-0002', {**payload, 'base_version': '0'*24})
    assert error.value.code == 'base_changed'


UNFITTED_TOP = {'slot': 'top', 'objects': [], 'available': False, 'unavailable_reason': 'fit_exception',
                'fit_status': 'failed', 'errors': [{'code': 'fit_exception', 'message': 'ValueError: no sleeve'}]}


def test_a_part_is_made_on_a_base_whose_other_slot_could_not_be_fitted(base):
    # The base has no top file: its top is carried over as unavailable, as a refit does, not refused.
    factory, directory, payload = base
    version = directory/'native-parts'/payload['base_version']
    record = read_json(version/'record.json')
    record['files'].pop('top.glb')
    record['result']['parts'] = [UNFITTED_TOP if part['slot'] == 'top' else part for part in record['result']['parts']]
    _write_json(version/'record.json', record)
    (version/'top.glb').unlink()
    job, created = AvatarVariants(factory).create_single_part(1, KEY, payload)
    assert created
    reused = read_json(factory.directory(1, job['id'])/'pipeline.json')['native_part_reuse']['parts']
    assert reused['top'] == {'available': False, 'report': UNFITTED_TOP}
    assert reused['shoes']['file'] == 'shoes.glb' and 'hair' not in reused


def test_a_part_is_made_on_the_sealed_version_the_wardrobe_offers_while_a_newer_one_is_assembled(base):
    factory, directory, payload = base
    root = directory/'native-parts'
    newer = '9'*24
    (root/newer).mkdir()
    _write_json(root/newer/'record.json', {'status': 'running', 'files': {}, 'result': {}})
    _write_json(root/'current.json', {'version': newer})
    _write_json(root/'ready.json', {'version': payload['base_version']})
    job, created = AvatarVariants(factory).create_single_part(1, KEY, payload)
    assert created and job['base_version'] == payload['base_version']
    # The version being assembled is not a base yet.
    with pytest.raises(PipelineError) as error:
        AvatarVariants(factory).create_single_part(1, 'variant-key-0002', {**payload, 'base_version': newer})
    assert error.value.code == 'base_changed'


# A hair target measured around a head .72 m wide and .58 m deep (front at z .30), with the hair clearance.
HAIR_TARGET = [[-.385, .46, -.305], [.385, 1.27, .325]]


def test_equipment_of_a_base_without_a_measured_head_sits_on_its_head_and_hands(base):
    factory, directory, payload = base
    version = directory/'native-parts'/payload['base_version']
    record = read_json(version/'record.json')
    record['result'].update(fitting_targets={'hair': HAIR_TARGET},
                            body_profile={'landmarks': {'wrist_right': [-.41, .45, .01], 'wrist_left': [.41, .45, .01]}})
    _write_json(version/'record.json', record)
    job, created = AvatarVariants(factory).create_single_part(1, KEY, {**payload, 'slot': 'glasses'})
    spec = read_json(factory.directory(1, job['id'])/'pipeline.json')['production_spec']
    glasses = spec['equipment']['glasses']
    # Two fifths up the head from the neck (.46) to the crown (1.2), on its front: not at the neck (.48 m).
    assert created and glasses['position_m'] == pytest.approx([0, .756, .308])
    assert glasses['size_m'][0] == pytest.approx(.72*.72)
    assert spec['equipment']['weapon']['position_m'] == [-.41, .45, .01]
    assert spec['equipment']['tool']['position_m'] == [.41, .45, .01]


def test_equipment_keeps_the_head_its_base_measured(base):
    factory, directory, payload = base
    head = [[-.4, .455, -.3], [.4, 1.2, .33]]
    saved = read_json(directory/'pipeline.json')['production_spec']
    _write_json(directory/'native-parts'/payload['base_version']/'input.json',
                {'production_spec': {**saved, 'measured_head_bounds_m': head}})
    job, _ = AvatarVariants(factory).create_single_part(1, KEY, {**payload, 'slot': 'glasses'})
    spec = read_json(factory.directory(1, job['id'])/'pipeline.json')['production_spec']
    assert spec['measured_head_bounds_m'] == head
    assert spec['equipment']['glasses']['position_m'] == pytest.approx([0, .455+.4*.745, .338])


def test_a_failed_view_of_a_garment_made_on_the_body_is_requested_again_on_its_own(base):
    # A body-shell garment has no provider model: accepted with its model ready, it is built from its views at
    # assembly. Until its side view is drawn, nothing uses a front view the provider refused.
    factory, _, payload = base
    garment = {'base_job_id': payload['base_job_id'], 'base_version': payload['base_version'], 'slot': 'top',
               'part_name': '셔츠', 'part_method': 'body_shell'}
    job, _ = AvatarVariants(factory).create_single_part(1, KEY, garment)
    directory = factory.directory(1, job['id'])
    state = read_json(directory/'pipeline.json')
    top = next(part for part in state['parts'] if part['slot'] == 'top')
    top['views']['front'].update(status='rejected', attempted_at='2026-10-11T00:00:00+00:00', failure={
        'id': 'shellfront01', 'category': 'policy', 'message': '이미지 안전 필터로 생성 중단'})
    pipeline = AvatarImagePipeline(factory)
    pipeline.publish(1, job['id'], state)
    record = read_json(directory/'job.json')
    record.update(status='pipeline_paused', error='상의 정면: 이미지 안전 필터로 생성 중단')
    _write_json(directory/'job.json', record)
    offered = [(action['view'], action['enabled']) for action in factory.get(1, job['id'])['next_actions']
               if action['id'] == 'retry_image' and action['slot'] == 'top']
    assert offered == [('front', True)]
    _, accepted = retry_view(pipeline, 1, job['id'], 'top', 'front', 'shellfront01')
    top = next(part for part in read_json(directory/'pipeline.json')['parts'] if part['slot'] == 'top')
    assert accepted and top['views']['front']['status'] == 'pending' and top['model']['origin'] == 'body_shell'
