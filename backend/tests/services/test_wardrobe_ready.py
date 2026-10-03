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


def test_part_requests_build_on_the_version_the_wardrobe_offers(library):
    native = AvatarNativeParts(library.factory)
    library.current(PART, V1)
    assert native.ready_version(OWNER, PART) == V1
    library.assembly(PART, V2, status='running', created_at='2026-09-21T02:00:00+00:00')
    library.current(PART, V2)
    library.ready(PART, V1)
    assert native.ready_version(OWNER, PART) == V1
    assert native.ready_version(OWNER, 'd' * 24) is None


def test_a_rig_source_is_the_sealed_body_version_the_wardrobe_offers(library):
    from src.services.avatar_rig_transfer import AvatarRigTransfer
    library.assembly(BODY, V2, status='running', slots=())
    library.current(BODY, V2)
    library.ready(BODY, BODY_VERSION)
    unsealed = 'd' * 24
    library.job(unsealed)
    library.assembly(unsealed, V1, status='failed', slots=())
    library.current(unsealed, V1)
    items = AvatarRigTransfer(library.factory).sources(OWNER)['items']
    assert [(item['job_id'], item['version']) for item in items] == [(BODY, BODY_VERSION)]


class Writes:
    """Which records were written, and whether the process lock was held for each."""

    def __init__(self, monkeypatch):
        from src.services import avatar_native_parts
        from src.services.avatar_factory import _LOCK
        self.rows, real = [], avatar_native_parts._write_json
        monkeypatch.setattr(avatar_native_parts, '_write_json',
                            lambda path, value: (self.rows.append((path.name, _LOCK._is_owned())), real(path, value))[1])


def test_moving_the_current_pointer_writes_both_pointers_under_the_process_lock(library, monkeypatch):
    root = library.directory(PART)/'native-parts'
    library.current(PART, V1)
    library.assembly(PART, V2, status='accepted', created_at='2026-09-21T02:00:00+00:00')
    writes = Writes(monkeypatch)
    AvatarNativeParts(library.factory)._move_current(root, V2)
    assert writes.rows == [('ready.json', True), ('current.json', True)]


def test_resuming_a_version_moves_its_pointers_and_record_under_the_process_lock(library, monkeypatch):
    from wardrobe_fixture import put
    root = library.directory(PART)/'native-parts'
    library.current(PART, V1)
    library.assembly(PART, V2, status='failed', created_at='2026-09-21T02:00:00+00:00')
    put(root/V2/'input.json', {'base_version': V1, 'parts': [], 'contract': {}})
    put(library.directory(PART)/'pipeline.json', {'native_assembly_version': V2})
    writes = Writes(monkeypatch)
    state, resumed = AvatarNativeParts(library.factory)._resume_version(OWNER, PART, V2)
    assert resumed and state['version'] == V2 and state['status'] == 'accepted'
    assert {name for name, _ in writes.rows} == {'ready.json', 'current.json', 'record.json'}
    assert all(held for _, held in writes.rows)


def test_parsed_bodies_are_cached_apart_from_records_and_only_the_last_few(library, monkeypatch, tmp_path):
    from types import SimpleNamespace
    from src.services import avatar_wardrobe, avatar_wardrobe_coverage
    monkeypatch.setattr(avatar_wardrobe_coverage, 'skinned_primitives', lambda content: ['parsed', content])
    files = {}

    def artifact(owner, job, version, name):
        files[job] = tmp_path/f'{job}.glb'
        files[job].write_bytes(job.encode())
        return files[job]
    native = SimpleNamespace(artifact=artifact)
    bodies = [{'job_id': str(index)*24, 'version': V1, 'body_sha256': str(index)*64} for index in range(6)]
    for body in bodies:
        assert library.wardrobe._body_geometry(native, body) == ['parsed', body['job_id'].encode()]
    assert len(avatar_wardrobe._geometries) == avatar_wardrobe._GEOMETRIES == 4
    assert not any(key[0] == 'body' for key in avatar_wardrobe._records)
    # The newest are kept: asking again parses nothing.
    files.clear()
    library.wardrobe._body_geometry(native, bodies[-1])
    assert files == {}
