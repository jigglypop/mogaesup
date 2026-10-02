import pytest

from native_assembly_fixture import JOB, VERSION, seed_native_assembly
from src.services.asset_editor import _write_json
from src.services.avatar_native_outfits import AvatarNativeOutfits
from src.services.avatar_native_parts import AvatarNativeParts
from src.services.character_pipeline import PipelineError, read_json
from wardrobe_fixture import Library


@pytest.fixture
def outfits(tmp_path):
    factory, directory = seed_native_assembly(tmp_path, 'fixture')
    record = read_json(directory / 'record.json')
    for slot in ('head', 'hairFront', 'hairBack'):
        (directory / f'{slot}.glb').write_bytes((directory / 'hair.glb').read_bytes())
        record['files'][f'{slot}.glb'] = record['files']['hair.glb']
        record['result']['parts'].append({'slot': slot})
    _write_json(directory / 'record.json', record)
    return AvatarNativeOutfits(AvatarNativeParts(factory)), directory


@pytest.mark.parametrize('slots', [['hair', 'hairFront'], ['hair', 'hairBack'], ['head', 'hair'],
                                  ['head', 'hairFront'], ['head', 'hairBack'], ['head', 'hat']])
def test_saved_combination_refuses_overlapping_head_assets_without_changing_selection(outfits, slots):
    service, directory = outfits
    original = service.get(1, JOB, VERSION)
    # Both files exist and are offered; refusal must come from the combination, not a missing fixture asset.
    assert set(slots) <= set(original['slots'])
    with pytest.raises(PipelineError) as error:
        service.put(1, JOB, VERSION, {'body_sha256': original['body_sha256'], 'slots': slots}, '0', 'reject-head-parts')
    assert error.value.code == 'invalid_parts'
    assert service.get(1, JOB, VERSION) == original
    assert not (directory / 'selection.json').exists()


def test_split_front_and_back_can_be_saved_together_with_a_hat(outfits):
    service, _ = outfits
    original = service.get(1, JOB, VERSION)
    slots = ['hairFront', 'hairBack', 'hat']
    saved = service.put(1, JOB, VERSION, {'body_sha256': original['body_sha256'], 'slots': slots}, '0', 'save-split-head-parts')
    assert saved['slots'] == slots


def test_wardrobe_outfit_refuses_conflicting_offered_hair_but_accepts_split_pair(tmp_path, monkeypatch):
    library = Library(tmp_path)
    monkeypatch.setattr(library.wardrobe.library, 'require_storage', lambda: None)
    body, version = 'b' * 24, 'a' * 24
    library.job(body)
    library.assembly(body, version, slots=())
    library.current(body, version)
    library.register((body, version))
    parts = {}
    for job, slot in [('c' * 24, 'hair'), ('d' * 24, 'hairFront'), ('e' * 24, 'hairBack')]:
        library.job(job, base=(body, version), requested=[slot])
        library.assembly(job, version, slots=(slot,))
        library.current(job, version)
        parts[slot] = {'job_id': job, 'version': version, 'sha256': library.file_sha(job, version, slot)}
    payload = {'name': 'split hairstyle', 'body': {'job_id': body, 'version': version}, 'parts': parts}
    before = library.wardrobe.outfits()
    with pytest.raises(PipelineError) as error:
        library.wardrobe.save_outfit('f' * 32, payload, before['revision'], 'reject-mixed-wardrobe')
    assert error.value.code == 'invalid_parts'
    assert library.wardrobe.outfits() == before
    payload['parts'] = {slot: part for slot, part in parts.items() if slot != 'hair'}
    saved = library.wardrobe.save_outfit('f' * 32, payload, before['revision'], 'save-split-wardrobe')
    assert set(saved['outfits']['f' * 32]['parts']) == {'hairFront', 'hairBack'}
