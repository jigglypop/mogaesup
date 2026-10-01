import pytest

from src.services.avatar_native_parts import AvatarNativeParts
from src.services.avatar_production_progress import ready_version
from wardrobe_fixture import OWNER, Library

BODY, PART = 'b' * 24, 'c' * 24
BODY_VERSION, V1, V2, V3 = '1' * 24, 'a' * 24, 'e' * 24, 'f' * 24


@pytest.fixture
def library(tmp_path):
    library = Library(tmp_path)
    library.job(BODY)
    library.assembly(BODY, BODY_VERSION, slots=())
    library.current(BODY, BODY_VERSION)
    library.register((BODY, BODY_VERSION))
    library.job(PART, base=(BODY, BODY_VERSION), requested=['hair'], created_at='2026-09-21T00:00:00+00:00')
    library.assembly(PART, V1, created_at='2026-09-21T01:00:00+00:00')
    return library


def offered(library):
    return [(version, sha) for job, version, _, sha in library.listed(BODY) if job == PART]


@pytest.mark.parametrize('status', ['accepted', 'running', 'failed', 'qc_failed'])
def test_a_part_stays_listed_at_its_sealed_version_while_a_newer_one_is_not_sealed(library, status):
    library.assembly(PART, V2, status=status, created_at='2026-09-21T02:00:00+00:00')
    library.current(PART, V2)
    library.ready(PART, V1)
    assert offered(library) == [(V1, library.file_sha(PART, V1, 'hair'))]
    job = library.factory.get(OWNER, PART)
    # The job itself still reports no sealed current assembly; only the wardrobe looks further back.
    assert job['assembly_version'] is None and job['ready_version'] == V1


def test_sealing_the_new_version_switches_the_listing_and_its_hash(library):
    library.assembly(PART, V2, status='running', created_at='2026-09-21T02:00:00+00:00')
    library.current(PART, V2)
    library.ready(PART, V1)
    assert offered(library) == [(V1, library.file_sha(PART, V1, 'hair'))]
    library.assembly(PART, V2, created_at='2026-09-21T02:00:00+00:00')
    assert offered(library) == [(V2, library.file_sha(PART, V2, 'hair'))]
    assert library.factory.get(OWNER, PART)['ready_version'] == V2


def test_a_sealed_current_version_wins_over_an_older_pointer(library):
    library.assembly(PART, V2, created_at='2026-09-21T02:00:00+00:00')
    library.current(PART, V2)
    library.ready(PART, V1)
    assert offered(library) == [(V2, library.file_sha(PART, V2, 'hair'))]


def test_a_job_from_before_the_pointer_offers_its_newest_sealed_version(library):
    library.assembly(PART, V2, created_at='2026-09-21T02:00:00+00:00')
    library.assembly(PART, V3, status='failed', created_at='2026-09-21T03:00:00+00:00')
    library.current(PART, V3)
    assert offered(library) == [(V2, library.file_sha(PART, V2, 'hair'))]


def test_a_pointer_to_a_version_that_is_no_longer_sealed_is_not_followed(library):
    library.assembly(PART, V2, status='failed', created_at='2026-09-21T02:00:00+00:00')
    library.current(PART, V2)
    library.ready(PART, V3)
    assert offered(library) == [(V1, library.file_sha(PART, V1, 'hair'))]


def test_a_job_that_was_never_sealed_offers_nothing(library):
    library.assembly(PART, V1, status='failed')
    library.current(PART, V1)
    assert offered(library) == []
    assert library.factory.get(OWNER, PART)['ready_version'] is None


def test_the_body_job_stays_pinned_to_the_registered_version(library):
    library.assembly(BODY, V2, status='running', slots=())
    library.current(BODY, V2)
    library.ready(BODY, BODY_VERSION)
    assert library.wardrobe.parts(BODY)['body']['version'] == BODY_VERSION


def test_ready_version_reads_the_pointer_only_while_current_is_not_sealed(library):
    root = library.directory(PART)/'native-parts'
    sealed = {'status': 'review_required'}
    assert ready_version(root, {'version': V1}, sealed) == V1
    assert ready_version(root, {}, {}) is None
    library.assembly(PART, V2, status='accepted', created_at='2026-09-21T02:00:00+00:00')
    assert ready_version(root, {'version': V2}, {'status': 'accepted'}) == V1


def test_moving_the_current_pointer_off_a_sealed_version_keeps_that_version_offered(library):
    root = library.directory(PART)/'native-parts'
    library.current(PART, V1)
    library.assembly(PART, V2, status='accepted', created_at='2026-09-21T02:00:00+00:00')
    library.assembly(PART, V3, status='accepted', created_at='2026-09-21T03:00:00+00:00')
    native = AvatarNativeParts(library.factory)
    native._move_current(root, V2)
    assert (root/'current.json').read_text().count(V2) == 1
    assert (root/'ready.json').read_text().count(V1) == 1
    # Off a version that was never sealed, the sealed one stays the one offered.
    native._move_current(root, V3)
    assert (root/'ready.json').read_text().count(V1) == 1 and (root/'current.json').read_text().count(V3) == 1
