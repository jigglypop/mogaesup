"""Runtime derivatives retain the original slot's membership and immutable source identity."""
import hashlib

import pytest

from src.services import avatar_wardrobe
from src.services.character_pipeline import PipelineError, read_json
from wardrobe_fixture import Library, put

BODY, BODY_VERSION, PART, V1 = 'b'*24, '1'*24, 'c'*24, 'a'*24


@pytest.fixture
def library(tmp_path):
    value = Library(tmp_path)
    value.job(BODY)
    value.assembly(BODY, BODY_VERSION, slots=(), contents={'body': b'original body'})
    value.current(BODY, BODY_VERSION)
    value.register((BODY, BODY_VERSION))
    value.job(PART, base=(BODY, BODY_VERSION), requested=['hair'])
    value.assembly(PART, V1, contents={'hair': b'original hair'})
    value.current(PART, V1)
    add_delivery(value, PART, V1, 'hair')
    add_delivery(value, BODY, BODY_VERSION, 'body')
    return value


def add_delivery(library, job, version, slot):
    directory = library.directory(job)/'native-parts'/version
    record = read_json(directory/'record.json')
    content = f'web derivative {slot}'.encode()
    name = f'{slot}.runtime.glb'
    (directory/name).write_bytes(content)
    sha = hashlib.sha256(content).hexdigest()
    record['files'][name] = sha
    record['result'].setdefault('delivery', {})[slot] = {
        'artifact': name, 'sha256': sha, 'source_sha256': record['files'][f'{slot}.glb'],
        'source_bytes': len((directory/f'{slot}.glb').read_bytes()), 'runtime_bytes': len(content),
        'geometry_preserved': True,
    }
    put(directory/'record.json', record)
    avatar_wardrobe._records.clear()


def change_record(library, update):
    path = library.directory(PART)/'native-parts'/V1/'record.json'
    record = read_json(path); update(record); put(path, record)
    avatar_wardrobe._records.clear()


def rejected(call):
    with pytest.raises(PipelineError) as error:
        call()
    assert error.value.status == 404


def test_runtime_listing_preserves_source_sha_and_adds_verified_delivery(library):
    [item] = [row for row in library.wardrobe.parts(BODY)['parts'] if row['job_id'] == PART]
    assert item['sha256'] == hashlib.sha256(b'original hair').hexdigest()
    assert item['runtime_name'] == 'hair.runtime.glb'
    assert item['runtime_sha256'] == hashlib.sha256(b'web derivative hair').hexdigest()
    assert library.wardrobe.member_file(PART, V1, item['runtime_name']).read_bytes() == b'web derivative hair'
    assert library.wardrobe.member_file(PART, V1, 'hair.glb').read_bytes() == b'original hair'
    assert library.wardrobe.member_file(BODY, BODY_VERSION, 'body.runtime.glb').read_bytes() == b'web derivative body'


@pytest.mark.parametrize('field,value', [
    ('artifact', '../hair.runtime.glb'), ('artifact', 'body.runtime.glb'),
    ('source_sha256', '0'*64), ('sha256', '0'*64), ('sha256', True),
    ('geometry_preserved', False), ('geometry_preserved', 1),
])
def test_invalid_delivery_never_replaces_or_exposes_the_source(library, field, value):
    change_record(library, lambda record: record['result']['delivery']['hair'].update({field: value}))
    [item] = [row for row in library.wardrobe.parts(BODY)['parts'] if row['job_id'] == PART]
    assert 'runtime_name' not in item and 'runtime_sha256' not in item
    assert item['sha256'] == hashlib.sha256(b'original hair').hexdigest()
    rejected(lambda: library.wardrobe.member_file(PART, V1, 'hair.runtime.glb'))
    assert library.wardrobe.member_file(PART, V1, 'hair.glb').read_bytes() == b'original hair'


@pytest.mark.parametrize('name', ['../hair.runtime.glb', 'hair.runtime.runtime.glb', 'hair.RUNTIME.glb',
                                  'model.runtime.glb', 'front.png', 'body.runtime.glb', 'hair.runtime.glb/x'])
def test_runtime_names_cannot_change_the_slot_or_escape_its_scope(library, name):
    rejected(lambda: library.wardrobe.member_file(PART, V1, name))


@pytest.mark.parametrize('visibility', [
    {'items': {PART: {'deleted': True}}}, {'items': {PART: {'archived': True}}},
    {'characters': {PART: {'deleted': True}}}, {'parts': {f'{PART}:hair': {'deleted': True}}},
])
def test_runtime_files_cannot_bypass_catalog_visibility(library, visibility):
    library.catalog(**visibility)
    rejected(lambda: library.wardrobe.member_file(PART, V1, 'hair.runtime.glb'))


@pytest.mark.parametrize('file', ['hair.glb', 'hair.runtime.glb'])
def test_a_changed_source_or_derivative_is_rejected(library, file):
    (library.directory(PART)/'native-parts'/V1/file).write_bytes(b'changed')
    rejected(lambda: library.wardrobe.member_file(PART, V1, 'hair.runtime.glb'))


def test_runtime_receipt_requires_both_artifacts_to_be_sealed(library):
    change_record(library, lambda record: record['files'].pop('hair.glb'))
    rejected(lambda: library.wardrobe.member_file(PART, V1, 'hair.runtime.glb'))


def test_a_legacy_part_has_no_runtime_delivery(library):
    change_record(library, lambda record: record['result'].pop('delivery'))
    [item] = [row for row in library.wardrobe.parts(BODY)['parts'] if row['job_id'] == PART]
    assert 'runtime_name' not in item and 'runtime_sha256' not in item
    rejected(lambda: library.wardrobe.member_file(PART, V1, 'hair.runtime.glb'))


@pytest.mark.parametrize('delivery', [[], None, {'hair': []}])
def test_malformed_runtime_delivery_leaves_the_source_listed(library, delivery):
    change_record(library, lambda record: record['result'].update(delivery=delivery))
    [item] = [row for row in library.wardrobe.parts(BODY)['parts'] if row['job_id'] == PART]
    assert 'runtime_name' not in item
    assert library.wardrobe.member_file(PART, V1, 'hair.glb').read_bytes() == b'original hair'
    rejected(lambda: library.wardrobe.member_file(PART, V1, 'hair.runtime.glb'))


def test_runtime_file_must_be_of_the_slot_the_job_requested(library):
    library.job(PART, base=(BODY, BODY_VERSION), requested=['top'])
    rejected(lambda: library.wardrobe.member_file(PART, V1, 'hair.runtime.glb'))


def test_runtime_file_requires_the_offered_version(library):
    newer = '2'*24
    library.assembly(PART, newer, contents={'hair': b'new original hair'})
    add_delivery(library, PART, newer, 'hair')
    library.current(PART, newer)
    rejected(lambda: library.wardrobe.member_file(PART, V1, 'hair.runtime.glb'))
    assert library.wardrobe.member_file(PART, newer, 'hair.runtime.glb').read_bytes() == b'web derivative hair'
