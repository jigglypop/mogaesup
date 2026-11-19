import pytest

from src.services.character_pipeline import PipelineError, read_json
from wardrobe_fixture import Library, put, sha

BODY, BODY_VERSION = 'b' * 24, '1' * 24
OTHER_BODY = '2' * 24
V1 = 'a' * 24
MEMBER, STRAY, DELETED, ARCHIVED, TOMBSTONED, UNREGISTERED, HIDDEN_CHARACTER = (
    'c' * 24, 'd' * 24, 'e' * 24, 'f' * 24, '3' * 24, '4' * 24, '5' * 24)
DESCENDANTS = (MEMBER, DELETED, ARCHIVED, TOMBSTONED, HIDDEN_CHARACTER)


@pytest.fixture
def library(tmp_path):
    library = Library(tmp_path)
    library.job(BODY)
    library.assembly(BODY, BODY_VERSION, slots=('hair',))
    library.current(BODY, BODY_VERSION)
    library.register((BODY, BODY_VERSION))
    for job in DESCENDANTS:
        library.job(job, base=(BODY, BODY_VERSION), requested=['hair'], character='hidden' if job == HIDDEN_CHARACTER else job)
    # A job nothing links to a body, and one built on a body the wardrobe no longer holds.
    library.job(STRAY)
    library.job(UNREGISTERED, base=(OTHER_BODY, BODY_VERSION), requested=['hair'])
    for job in (*DESCENDANTS, STRAY, UNREGISTERED):
        library.assembly(job, V1)
        library.current(job, V1)
    library.catalog(items={DELETED: {'deleted': True}, ARCHIVED: {'archived': True}},
                    parts={f'{TOMBSTONED}:hair': {'deleted': True}}, characters={'hidden': {'deleted': True}})
    return library


def cached_color(library, job, slot='hair', version=V1):
    root = library.wardrobe.library.root/'wardrobe-colors'
    name = library.file_sha(job, version, slot)[:20]
    root.mkdir(parents=True, exist_ok=True)
    put(root/f'{name}-v3.json', {'slot': slot, 'material': 0, 'regions': []})
    (root/f'{name}-v3.png').write_bytes(b'mask')


def cached_preview(library, job, slot='hair'):
    drawing = sha(f'{job}:drawing')
    put(library.directory(job)/'pipeline.json', {'parts': [{'slot': slot, 'views': {'front': {'file': 'front.png', 'sha256': drawing}}}]})
    root = library.wardrobe.library.root/'wardrobe-previews'
    root.mkdir(parents=True, exist_ok=True)
    (root/f'{drawing[:32]}-plain-v2.png').write_bytes(b'png')


def cached_coverage(library, job, slot='hair'):
    root = library.wardrobe.library.root/'wardrobe-coverage'
    root.mkdir(parents=True, exist_ok=True)
    body_sha = library.file_sha(BODY, BODY_VERSION, 'body')
    put(root/f'{body_sha[:20]}-{library.file_sha(job, V1, slot)[:20]}-v12.json', {'slot': slot, 'covers_bottom': False})


def not_found(call):
    with pytest.raises(PipelineError) as error:
        call()
    assert error.value.code == 'not_found' and error.value.status == 404


def test_a_member_part_is_readable_by_colour_preview_and_coverage(library):
    cached_color(library, MEMBER)
    cached_preview(library, MEMBER)
    cached_coverage(library, MEMBER)
    value, mask = library.wardrobe.colors(MEMBER, 'hair', V1)
    assert value['slot'] == 'hair' and mask.read_bytes() == b'mask'
    assert library.wardrobe.preview(MEMBER, 'hair', V1).read_bytes() == b'png'
    assert library.wardrobe.coverage(BODY, MEMBER, 'hair', V1)['slot'] == 'hair'


def test_the_registered_bodys_own_part_is_readable_too(library):
    cached_color(library, BODY, version=BODY_VERSION)
    assert library.wardrobe.colors(BODY, 'hair', BODY_VERSION)[0]['slot'] == 'hair'


@pytest.mark.parametrize('job', [STRAY, UNREGISTERED, DELETED, ARCHIVED, TOMBSTONED, HIDDEN_CHARACTER])
def test_a_job_the_wardrobe_does_not_list_is_not_found_by_colour_preview_or_coverage(library, job):
    cached_color(library, job)
    cached_preview(library, job)
    cached_coverage(library, job)
    not_found(lambda: library.wardrobe.colors(job, 'hair', V1))
    not_found(lambda: library.wardrobe.preview(job, 'hair', V1))
    not_found(lambda: library.wardrobe.coverage(BODY, job, 'hair', V1))


def test_a_tombstone_hides_one_slot_not_the_job(library):
    library.catalog(parts={f'{MEMBER}:hair': {'deleted': True}})
    cached_color(library, MEMBER)
    not_found(lambda: library.wardrobe.colors(MEMBER, 'hair', V1))


def test_membership_is_read_from_a_few_records_not_from_the_listing_of_every_job(library, monkeypatch):
    cached_color(library, MEMBER)
    cached_preview(library, MEMBER)
    cached_coverage(library, MEMBER)

    def listing(owner):
        raise AssertionError('a colour, preview or coverage request must not list every job')
    monkeypatch.setattr(library.factory, 'listing', listing)
    library.wardrobe.colors(MEMBER, 'hair', V1)
    library.wardrobe.preview(MEMBER, 'hair', V1)
    library.wardrobe.coverage(BODY, MEMBER, 'hair', V1)
    not_found(lambda: library.wardrobe.colors(STRAY, 'hair', V1))


def test_part_jobs_counts_only_jobs_the_wardrobe_lists_parts_of(library):
    # Re-assembling (a refit running on a sealed version) still lists its parts; one never sealed lists none.
    reassembling, unsealed, two_slots = '6' * 24, '7' * 24, '8' * 24
    library.job(reassembling, base=(BODY, BODY_VERSION), requested=['hair'])
    library.assembly(reassembling, V1)
    library.assembly(reassembling, '9' * 24, status='running')
    library.current(reassembling, '9' * 24)
    library.ready(reassembling, V1)
    library.job(unsealed, base=(BODY, BODY_VERSION), requested=['hair'])
    library.assembly(unsealed, V1, status='failed')
    library.current(unsealed, V1)
    # One tombstoned slot of two still leaves a part to list.
    library.job(two_slots, base=(BODY, BODY_VERSION), requested=['hair', 'hat'])
    library.assembly(two_slots, V1, slots=('hair', 'hat'))
    library.current(two_slots, V1)
    library.catalog(items={DELETED: {'deleted': True}, ARCHIVED: {'archived': True}},
                    parts={f'{TOMBSTONED}:hair': {'deleted': True}, f'{two_slots}:hair': {'deleted': True}},
                    characters={'hidden': {'deleted': True}})
    library.refresh()
    [body] = library.wardrobe.bodies()['bodies']
    assert body['part_jobs'] == 3   # MEMBER, the re-assembling job and the job with one slot left
    listed = {job for job, _, _, _ in library.listed(BODY)}
    assert listed == {BODY, MEMBER, reassembling, two_slots}


# What a member's browser loads: the registered body and the part files the listing names, nothing else.

def test_a_member_loads_the_body_and_the_part_files_the_wardrobe_lists(library):
    library.assembly(BODY, BODY_VERSION, slots=('hair',), contents={'body': b'body', 'hair': b'own hair'})
    library.assembly(MEMBER, V1, contents={'hair': b'member hair'})
    assert library.wardrobe.member_file(BODY, BODY_VERSION, 'body.glb').read_bytes() == b'body'
    assert library.wardrobe.member_file(BODY, BODY_VERSION, 'hair.glb').read_bytes() == b'own hair'
    assert library.wardrobe.member_file(MEMBER, V1, 'hair.glb').read_bytes() == b'member hair'
    listed = {(part['job_id'], part['version'], part['slot']) for part in library.wardrobe.parts(BODY, operator=False)['parts']}
    assert {(BODY, BODY_VERSION, 'hair'), (MEMBER, V1, 'hair')} <= listed


def test_the_bodys_own_parts_a_refit_froze_stay_listed_after_it_is_registered_at_the_refit_version(library):
    # A refit of the body job's hair freezes its top as 'reused_fitted_native'; both slots are still the body job's own.
    refit = '7' * 24
    library.assembly(BODY, refit, slots=('hair', 'top'), contents={'body': b'body', 'hair': b'refit hair', 'top': b'top'})
    record = library.directory(BODY)/'native-parts'/refit/'record.json'
    value = read_json(record)
    for part in value['result']['parts']:
        if part['slot'] == 'top':
            part['origin'] = 'reused_fitted_native'
    put(record, value)
    library.current(BODY, refit)
    library.register((BODY, refit))
    library.refresh()
    for operator in (True, False):
        slots = {part['slot'] for part in library.wardrobe.parts(BODY, operator=operator)['parts'] if part['job_id'] == BODY}
        assert slots == {'hair', 'top'}
    assert library.wardrobe.member_file(BODY, refit, 'top.glb').read_bytes() == b'top'


def test_a_variant_without_recorded_slots_still_lists_only_what_it_did_not_copy(library):
    # Jobs on a base name the slots they made; one without that list keeps the copied slots under the base.
    library.job(MEMBER, base=(BODY, BODY_VERSION))
    library.assembly(MEMBER, V1, slots=('hair', 'top'), contents={'hair': b'hair', 'top': b'copied top'})
    record = library.directory(MEMBER)/'native-parts'/V1/'record.json'
    value = read_json(record)
    for part in value['result']['parts']:
        if part['slot'] == 'top':
            part['origin'] = 'reused_fitted_native'
    put(record, value)
    library.refresh()
    assert {part['slot'] for part in library.wardrobe.parts(BODY)['parts'] if part['job_id'] == MEMBER} == {'hair'}
    not_found(lambda: library.wardrobe.member_file(MEMBER, V1, 'top.glb'))


@pytest.mark.parametrize('job', [STRAY, UNREGISTERED, DELETED, ARCHIVED, TOMBSTONED, HIDDEN_CHARACTER])
def test_a_member_cannot_load_a_part_the_wardrobe_does_not_list(library, job):
    library.assembly(job, V1, contents={'hair': b'hair', 'body': b'body'})
    not_found(lambda: library.wardrobe.member_file(job, V1, 'hair.glb'))
    not_found(lambda: library.wardrobe.member_file(job, V1, 'body.glb'))


def test_a_member_cannot_load_other_files_of_a_listed_job(library):
    library.assembly(MEMBER, V1, slots=('hair', 'hat'), contents={'hair': b'hair', 'body': b'body', 'model': b'model'})
    record = library.directory(MEMBER)/'native-parts'/V1/'record.json'
    for name in ('body.glb', 'model.glb', 'front.png', 'hair.json', '../hair.glb', 'hat.glb'):
        not_found(lambda: library.wardrobe.member_file(MEMBER, V1, name))
    # A part the job could not fit, though its file is there.
    value = read_json(record)
    value['result']['parts'] = [{**part, 'available': False} if part['slot'] == 'hair' else part
                                for part in value['result']['parts']]
    put(record, value)
    import src.services.avatar_wardrobe as wardrobe_module
    wardrobe_module._records.clear()
    not_found(lambda: library.wardrobe.member_file(MEMBER, V1, 'hair.glb'))


def test_a_member_loads_only_the_version_a_job_offers(library):
    later = '6' * 24
    library.assembly(MEMBER, V1, contents={'hair': b'old hair'})
    library.assembly(MEMBER, later, contents={'hair': b'new hair'})
    library.current(MEMBER, later)
    assert library.wardrobe.member_file(MEMBER, later, 'hair.glb').read_bytes() == b'new hair'
    not_found(lambda: library.wardrobe.member_file(MEMBER, V1, 'hair.glb'))
    # The body loads at its registered version only.
    library.assembly(BODY, later, slots=(), contents={'body': b'newer body'})
    not_found(lambda: library.wardrobe.member_file(BODY, later, 'body.glb'))


def check_fit(library, job, status, slot='hair', version=V1):
    """The limb check of one slot of a job's sealed record ends with `status`."""
    record = library.directory(job)/'native-parts'/version/'record.json'
    value = read_json(record)
    value['result']['parts'] = [{**part, 'limb_fit': {'check': {'status': status, 'failures': (
                                    [{'message': 'sleeve 2 cm off'}] if status == 'fail' else [])}}}
                                if part['slot'] == slot else part for part in value['result']['parts']]
    put(record, value)
    import src.services.avatar_wardrobe as wardrobe_module
    wardrobe_module._records.clear()
    library.refresh()


def test_a_members_listing_has_no_unfitted_parts_and_no_fit_messages(library):
    check_fit(library, MEMBER, 'fail')
    record = library.directory(MEMBER)/'native-parts'/V1/'record.json'
    value = read_json(record)
    value['result']['parts'].append({'slot': 'top', 'available': False, 'unavailable_reason': 'fit_exception'})
    put(record, value)
    library.job(MEMBER, base=(BODY, BODY_VERSION), requested=['hair', 'top'])
    library.refresh()
    import src.services.avatar_wardrobe as wardrobe_module
    wardrobe_module._records.clear()
    operator = library.wardrobe.parts(BODY)
    member = library.wardrobe.parts(BODY, operator=False)
    assert [row['slot'] for row in operator['unavailable'] if row['job_id'] == MEMBER] == ['top']
    assert next(part for part in operator['parts'] if part['job_id'] == MEMBER)['fit_check'] == {
        'status': 'fail', 'failures': ['sleeve 2 cm off']}
    assert member['unavailable'] == [] and all(part['fit_check'] is None for part in member['parts'])
    # The limb check is the operator's warning only: the member is listed every part the operator is.
    assert ([(part['job_id'], part['slot'], part['sha256']) for part in member['parts']]
            == [(part['job_id'], part['slot'], part['sha256']) for part in operator['parts']])
    assert MEMBER in [part['job_id'] for part in member['parts']]


@pytest.mark.parametrize('status', ['pass', 'fail'])
def test_a_member_is_served_a_part_whatever_its_limb_check_says(library, status):
    cached_color(library, MEMBER)
    cached_preview(library, MEMBER)
    cached_coverage(library, MEMBER)
    check_fit(library, MEMBER, status)
    assert library.wardrobe.colors(MEMBER, 'hair', V1, member=True)[0]['slot'] == 'hair'
    assert library.wardrobe.preview(MEMBER, 'hair', V1, member=True).read_bytes() == b'png'
    assert library.wardrobe.coverage(BODY, MEMBER, 'hair', V1, member=True)['slot'] == 'hair'
    library.assembly(MEMBER, V1, contents={'hair': b'member hair'})
    check_fit(library, MEMBER, status)
    assert library.wardrobe.member_file(MEMBER, V1, 'hair.glb').read_bytes() == b'member hair'


def refuse(library, job, code, slot='hair', version=V1):
    """The seal's quality gate refused `slot` of a job's sealed version with `code`."""
    record = library.directory(job)/'native-parts'/version/'record.json'
    value = read_json(record)
    value['result']['parts'] = [{**part, 'available': False, 'unavailable_reason': code, 'fit_status': 'failed'}
                                if part['slot'] == slot else part for part in value['result']['parts']]
    put(record, value)
    import src.services.avatar_wardrobe as wardrobe_module
    wardrobe_module._records.clear()
    library.refresh()


def test_a_part_the_quality_gate_refused_is_listed_to_operators_by_its_code_and_to_no_one_to_wear(library):
    cached_color(library, MEMBER)
    cached_preview(library, MEMBER)
    cached_coverage(library, MEMBER)
    refuse(library, MEMBER, 'shoes_incomplete')
    operator = library.wardrobe.parts(BODY)
    member = library.wardrobe.parts(BODY, operator=False)
    assert MEMBER not in [part['job_id'] for part in operator['parts']] + [part['job_id'] for part in member['parts']]
    assert [(row['job_id'], row['slot'], row['reason']) for row in operator['unavailable']] == [
        (MEMBER, 'hair', 'shoes_incomplete')]
    assert member['unavailable'] == []
    not_found(lambda: library.wardrobe.member_file(MEMBER, V1, 'hair.glb'))
    not_found(lambda: library.wardrobe.colors(MEMBER, 'hair', V1, member=True))
    not_found(lambda: library.wardrobe.preview(MEMBER, 'hair', V1, member=True))
    not_found(lambda: library.wardrobe.coverage(BODY, MEMBER, 'hair', V1, member=True))


def test_a_trashed_part_stays_out_for_everyone(library):
    cached_color(library, MEMBER)
    cached_preview(library, MEMBER)
    library.catalog(items={DELETED: {'deleted': True}, ARCHIVED: {'archived': True}},
                    parts={f'{TOMBSTONED}:hair': {'deleted': True}, f'{MEMBER}:hair': {'deleted': True}},
                    characters={'hidden': {'deleted': True}})
    library.refresh()
    for operator in (True, False):
        value = library.wardrobe.parts(BODY, operator=operator)
        assert MEMBER not in [part['job_id'] for part in value['parts']]
        assert MEMBER not in [row['job_id'] for row in value['unavailable']]
    not_found(lambda: library.wardrobe.member_file(MEMBER, V1, 'hair.glb'))
    not_found(lambda: library.wardrobe.colors(MEMBER, 'hair', V1))
    not_found(lambda: library.wardrobe.preview(MEMBER, 'hair', V1))


def test_the_gateway_marks_a_members_wardrobe_reads_with_the_member_role():
    from src.api.avatar_factory import wardrobe_operator
    from src.auth import UserContext
    assert wardrobe_operator(UserContext(7, '7', ['ADMIN']))
    assert not wardrobe_operator(UserContext(7, '7', ['ADMIN', 'member']))
