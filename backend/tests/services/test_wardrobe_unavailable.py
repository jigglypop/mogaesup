import json

import pytest

from src.services.character_pipeline import read_json
from wardrobe_fixture import Library, put

BODY, BODY_VERSION = 'b' * 24, '1' * 24
MAKER, OTHER = 'c' * 24, 'd' * 24
V1 = 'a' * 24
FAILED = {'slot': 'top', 'available': False, 'unavailable_reason': 'garment_fit_incomplete', 'fit_status': 'failed',
          'errors': [{'code': 'fit_exception', 'message': 'RuntimeError: /srv/data/secret/top.blend cannot be read'}]}


@pytest.fixture
def library(tmp_path):
    library = Library(tmp_path)
    library.job(BODY)
    library.assembly(BODY, BODY_VERSION, slots=())
    library.current(BODY, BODY_VERSION)
    library.register((BODY, BODY_VERSION))
    return library


def fail(library, job, report=None, *, slot='top'):
    """The sealed record of `job` with one slot reported as not fitted: no file for it, as the worker leaves it."""
    path = library.directory(job)/'native-parts'/V1/'record.json'
    record = read_json(path)
    record['files'].pop(f'{slot}.glb', None)
    record['result']['parts'] = [{**part, **(report or FAILED)} if part['slot'] == slot else part
                                 for part in record['result']['parts']]
    put(path, record)


def maker(library, job=MAKER, *, requested=('hair', 'top'), created_at='2026-09-21T00:00:00+00:00', **extra):
    library.job(job, base=(BODY, BODY_VERSION), requested=list(requested), name=extra.pop('name', '청바지'), created_at=created_at, **extra)
    library.assembly(job, V1, slots=('hair', 'top'))
    library.current(job, V1)


def listed(library):
    library.refresh()
    return library.wardrobe.parts(BODY)


def test_a_part_that_could_not_be_fitted_is_listed_as_unavailable_not_as_a_part(library):
    maker(library)
    fail(library, MAKER)
    value = listed(library)
    assert [(part['job_id'], part['slot']) for part in value['parts']] == [(MAKER, 'hair')]
    assert value['unavailable'] == [{'job_id': MAKER, 'version': V1, 'slot': 'top', 'name': '청바지', 'reason': 'garment_fit_incomplete'}]
    assert value['body']['job_id'] == BODY


def test_nothing_is_unavailable_when_every_part_fitted(library):
    maker(library)
    assert [part['slot'] for part in listed(library)['parts']] == ['hair', 'top']
    assert listed(library)['unavailable'] == []


def test_the_reason_is_a_code_and_never_a_message_or_a_path(library):
    maker(library)
    fail(library, MAKER)
    assert 'secret' not in json.dumps(listed(library)) and 'RuntimeError' not in json.dumps(listed(library))


@pytest.mark.parametrize('report, reason', [
    ({'available': False, 'unavailable_reason': 'fit_exception', 'fit_status': 'failed'}, 'fit_exception'),
    ({'available': False, 'fit_status': 'needs_anchors'}, 'needs_anchors'),
    ({'available': False}, 'fit_incomplete'),
    # Only a short lower-case code is passed on, whatever else a report carries.
    ({'available': False, 'unavailable_reason': 'C:\\data\\top.blend failed', 'fit_status': 7}, 'fit_incomplete'),
    ({'available': False, 'unavailable_reason': 'x' * 80, 'fit_status': 'failed'}, 'failed'),
])
def test_the_reason_is_the_reported_reason_then_the_fit_status_then_a_default(library, report, reason):
    maker(library)
    fail(library, MAKER, {'slot': 'top', **report})
    assert [part['reason'] for part in listed(library)['unavailable']] == [reason]


def test_a_part_the_member_cannot_see_is_not_listed_as_unavailable(library):
    maker(library)
    fail(library, MAKER)
    library.catalog(parts={f'{MAKER}:top': {'deleted': True}})
    value = listed(library)
    assert value['unavailable'] == [] and [part['slot'] for part in value['parts']] == ['hair']


@pytest.mark.parametrize('catalog', [{'items': {MAKER: {'deleted': True}}}, {'items': {MAKER: {'archived': True}}},
                                     {'parts': {f'{MAKER}:hair': {'deleted': True}, f'{MAKER}:top': {'deleted': True}}}])
def test_a_deleted_archived_or_fully_tombstoned_job_lists_nothing(library, catalog):
    maker(library)
    fail(library, MAKER)
    library.catalog(**catalog)
    value = listed(library)
    assert value['unavailable'] == [] and all(part['job_id'] != MAKER for part in value['parts'])


def test_a_slot_the_job_did_not_make_is_listed_under_the_job_that_did(library):
    # A variant copies its base's fitted files; a report of a slot it did not request is not its own.
    maker(library, requested=('hair',))
    fail(library, MAKER)
    assert listed(library)['unavailable'] == []


def test_the_body_is_never_listed_as_unavailable(library):
    maker(library)
    fail(library, MAKER, {'slot': 'body', 'available': False, 'fit_status': 'failed'}, slot='body')
    assert listed(library)['unavailable'] == []


def test_unavailable_parts_are_listed_newest_first(library):
    maker(library, MAKER, created_at='2026-09-21T00:00:00+00:00', name='오래된 옷')
    maker(library, OTHER, created_at='2026-09-22T00:00:00+00:00', name='새 옷')
    fail(library, MAKER)
    fail(library, OTHER)
    assert [(part['job_id'], part['name']) for part in listed(library)['unavailable']] == [(OTHER, '새 옷'), (MAKER, '오래된 옷')]
