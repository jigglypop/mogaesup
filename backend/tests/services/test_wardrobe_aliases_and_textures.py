"""Wardrobe body aliases written before their geometry was compared, colour regions of large textures, and Mixamo bone
names exported with an underscore prefix."""
import io
import threading
import time

from botocore.exceptions import ClientError
import numpy as np
from PIL import Image, ImageDraw
import pytest

from src.services import avatar_wardrobe, avatar_wardrobe_colors, keyed_lock
from src.services.asset_editor import _write_json
from src.services.avatar_fitting_management import FittingManagement
from src.services.avatar_wardrobe_coverage import bone_keys
from src.services.character_pipeline import PipelineError
from src.services.object_storage import ArtifactChanged
from src.services.record_store import RecordStoreUnavailable
from wardrobe_fixture import Library, sha, textured_glb

BODY, VERSION, NEXT_VERSION, PART, PART_VERSION = 'b' * 24, '1' * 24, '4' * 24, 'd' * 24, '3' * 24


@pytest.fixture
def library(tmp_path, storage_configured):
    library = Library(tmp_path)
    library.job(BODY)
    library.assembly(BODY, VERSION, slots=())
    library.assembly(BODY, NEXT_VERSION, slots=())
    library.current(BODY, NEXT_VERSION)
    # A part made on the first version of the body.
    library.job(PART, base=(BODY, VERSION), requested=['hair'])
    library.assembly(PART, PART_VERSION, slots=('hair',))
    library.current(PART, PART_VERSION)
    library.catalog()
    return library


def shapes(monkeypatch, geometries):
    calls = []

    def body_entry(management, job, version):
        calls.append(version)
        return ({'job_id': job, 'version': version, 'profile_id': f'body-{job[:8]}',
                 'geometry_sha256': sha(geometries[version]), 'body_sha256': sha(job + version)},
                {'character_name': '몸', 'base_body': {'body_type': 'male'}})
    monkeypatch.setattr(FittingManagement, 'body_entry', body_entry)
    return calls


def legacy_list(library, geometry):
    """A list written before aliases were compared: NEXT_VERSION carries VERSION as an alias, unchecked."""
    _write_json(library.wardrobe.path, {'revision': 'old', 'updated_at': 'then', 'bodies': [
        {'job_id': BODY, 'version': NEXT_VERSION, 'profile_id': f'body-{BODY[:8]}', 'geometry_sha256': sha(geometry),
         'body_sha256': sha(BODY + NEXT_VERSION), 'aliases': [VERSION], 'name': '몸', 'body_type': 'male',
         'registered_at': 'then'}]})


def test_an_alias_nobody_compared_does_not_bring_its_parts(library):
    legacy_list(library, 'second shape')
    assert library.listed(BODY) == []
    # Nor is it answered as a version the body is worn at.
    assert library.wardrobe.bodies()['bodies'][0]['aliases'] == []
    with pytest.raises(PipelineError) as error:
        library.wardrobe.member_file(PART, PART_VERSION, 'hair.glb')
    assert error.value.status == 404


def test_registering_the_same_version_again_compares_the_old_aliases(library, monkeypatch):
    # VERSION had another shape: registering NEXT_VERSION again drops it for good.
    legacy_list(library, 'second shape')
    calls = shapes(monkeypatch, {VERSION: 'first shape', NEXT_VERSION: 'second shape'})
    library.wardrobe.register(BODY, NEXT_VERSION, 'old')
    assert sorted(calls) == sorted([VERSION, NEXT_VERSION])
    [body] = library.wardrobe._stored()['bodies']
    assert body['version'] == NEXT_VERSION and 'aliases' not in body
    assert library.listed(BODY) == []
    # Registered once more, the checked list is answered as it is: nothing is parsed.
    calls.clear()
    library.wardrobe.register(BODY, NEXT_VERSION, library.wardrobe.bodies()['revision'])
    assert calls == []


def test_an_old_alias_of_the_same_shape_comes_back_once_compared(library, monkeypatch):
    legacy_list(library, 'one shape')
    assert library.listed(BODY) == []
    shapes(monkeypatch, {VERSION: 'one shape', NEXT_VERSION: 'one shape'})
    library.wardrobe.register(BODY, NEXT_VERSION, 'old')
    [body] = library.wardrobe._stored()['bodies']
    assert body['aliases'] == [VERSION] and body['aliases_verified'] is True
    assert [part[:3] for part in library.listed(BODY)] == [(PART, PART_VERSION, 'hair')]


def fresh_list(library, geometry):
    """NEXT_VERSION registered afresh (no version replaced, so register() kept no alias)."""
    _write_json(library.wardrobe.path, {'revision': 'fresh', 'updated_at': 'then', 'bodies': [
        {'job_id': BODY, 'version': NEXT_VERSION, 'profile_id': f'body-{BODY[:8]}', 'geometry_sha256': sha(geometry),
         'body_sha256': sha(BODY + NEXT_VERSION), 'name': '몸', 'body_type': 'male', 'registered_at': 'then'}]})


def test_parts_made_on_an_earlier_version_of_the_same_shape_are_listed(library, monkeypatch):
    fresh_list(library, 'one shape')
    calls = shapes(monkeypatch, {VERSION: 'one shape', NEXT_VERSION: 'one shape'})
    assert [part[:3] for part in library.listed(BODY)] == [(PART, PART_VERSION, 'hair')]
    [body] = library.wardrobe._stored()['bodies']
    assert body['aliases'] == [VERSION] and body['aliases_verified'] is True
    assert library.wardrobe._member_record(PART, PART_VERSION, 'hair', 'missing')['status'] == 'review_required'
    [listed] = library.wardrobe.bodies()['bodies']
    assert listed['part_jobs'] == 1 and listed['aliases'] == [VERSION]
    assert calls == [VERSION]


def test_parts_made_on_an_earlier_version_of_another_shape_stay_out(library, monkeypatch):
    fresh_list(library, 'second shape')
    calls = shapes(monkeypatch, {VERSION: 'first shape', NEXT_VERSION: 'second shape'})
    assert library.listed(BODY) == []
    assert library.listed(BODY) == []
    library.wardrobe.bodies()
    [body] = library.wardrobe._stored()['bodies']
    assert 'aliases' not in body and calls == [VERSION]


def test_an_earlier_version_whose_body_cannot_be_read_stays_out(library, monkeypatch):
    fresh_list(library, 'one shape')

    def body_entry(management, job, version):
        raise PipelineError('body_incomplete', 'gone', 409)
    monkeypatch.setattr(FittingManagement, 'body_entry', body_entry)
    assert library.listed(BODY) == []
    assert 'aliases' not in library.wardrobe._stored()['bodies'][0]


def test_a_stale_revision_still_refuses_the_comparison(library, monkeypatch):
    legacy_list(library, 'one shape')
    shapes(monkeypatch, {VERSION: 'one shape', NEXT_VERSION: 'one shape'})
    with pytest.raises(PipelineError) as error:
        library.wardrobe.register(BODY, NEXT_VERSION, 'other')
    assert error.value.code == 'revision_conflict'


def listed_parts(library):
    return [part[:3] for part in library.listed(BODY)]


def failing_once(monkeypatch, geometries, error):
    """body_entry answering each version with its geometry, except that the first read of VERSION raises `error`."""
    calls = shapes(monkeypatch, geometries)
    answer = FittingManagement.body_entry

    def body_entry(management, job, version):
        if version == VERSION and calls.count(VERSION) == 0:
            calls.append(version)
            raise error
        return answer(management, job, version)
    monkeypatch.setattr(FittingManagement, 'body_entry', body_entry)
    return calls


class Clock:
    """The wardrobe's clock, moved on by hand."""

    def __init__(self):
        self.now = 1000.

    def __call__(self):
        return self.now


@pytest.fixture
def clock(monkeypatch):
    clock = Clock()
    monkeypatch.setattr(avatar_wardrobe, '_clock', clock)
    return clock


TRANSIENT = [OSError('timed out'), TimeoutError(), RecordStoreUnavailable('pool exhausted'), RuntimeError('lost'),
             ClientError({'Error': {'Code': 'SlowDown'}, 'ResponseMetadata': {'HTTPStatusCode': 503}}, 'GetObject'),
             PipelineError('storage_unavailable', 'later', 503), ArtifactChanged('changed while read'),
             PipelineError('artifact_changed', 'body.glb gone', 404), PipelineError('body_deleted', 'archived', 409)]


@pytest.mark.parametrize('error', TRANSIENT, ids=lambda error: getattr(error, 'code', type(error).__name__))
def test_a_body_version_that_cannot_be_read_for_now_is_read_again_after_a_pause(library, monkeypatch, clock, error):
    fresh_list(library, 'one shape')
    calls = failing_once(monkeypatch, {VERSION: 'one shape', NEXT_VERSION: 'one shape'}, error)
    # The member's read does not fail, and the part made on that version is not offered yet.
    library.refresh()
    assert library.wardrobe.parts(BODY, operator=False)['parts'] == []
    assert 'aliases' not in library.wardrobe._stored()['bodies'][0]
    # Nor is it read again by every request until the pause is over.
    assert listed_parts(library) == [] and calls == [VERSION]
    clock.now += avatar_wardrobe._RETRY_S[0] + 1
    assert listed_parts(library) == [(PART, PART_VERSION, 'hair')]
    assert calls == [VERSION, VERSION]
    assert library.wardrobe._stored()['bodies'][0]['aliases'] == [VERSION]


def test_a_body_version_that_keeps_failing_is_read_again_less_and_less_often(library, monkeypatch, clock):
    fresh_list(library, 'one shape')
    calls = shapes(monkeypatch, {VERSION: 'one shape', NEXT_VERSION: 'one shape'})

    def body_entry(management, job, version):
        calls.append(version)
        raise PipelineError('artifact_changed', 'body.glb is not the sealed one', 404)
    monkeypatch.setattr(FittingManagement, 'body_entry', body_entry)
    pauses = []
    for _ in range(9):
        before, waited = len(calls), 0.
        while len(calls) == before:
            library.refresh()
            library.wardrobe.parts(BODY, operator=False)
            clock.now += 5.
            waited += 5.
        pauses.append(waited)
    # Read at once, then after 15 s, twice as long each time after that, never more than 15 minutes apart.
    assert pauses[:4] == [5., 15., 30., 60.]
    assert pauses[-1] == pauses[-2] == avatar_wardrobe._RETRY_S[1]


def test_a_body_restored_after_its_job_was_archived_brings_its_parts_back(library, monkeypatch, clock):
    fresh_list(library, 'one shape')
    shapes(monkeypatch, {VERSION: 'one shape', NEXT_VERSION: 'one shape'})
    answer = FittingManagement.body_entry
    archived = [True]

    def body_entry(management, job, version):
        if version == VERSION and archived[0]:
            raise PipelineError('body_deleted', 'archived', 409)
        return answer(management, job, version)
    monkeypatch.setattr(FittingManagement, 'body_entry', body_entry)
    assert listed_parts(library) == []
    archived[0] = False
    clock.now += avatar_wardrobe._RETRY_S[0] + 1
    assert listed_parts(library) == [(PART, PART_VERSION, 'hair')]


@pytest.mark.parametrize('error', [PipelineError('body_incomplete', 'unsealed', 409), PipelineError('not_found', 'gone', 404),
                                   ValueError('not a GLB'), KeyError('body.glb')],
                         ids=lambda error: getattr(error, 'code', type(error).__name__))
def test_a_body_version_with_no_body_is_read_once(library, monkeypatch, clock, error):
    fresh_list(library, 'one shape')
    calls = failing_once(monkeypatch, {VERSION: 'one shape', NEXT_VERSION: 'one shape'}, error)
    assert listed_parts(library) == [] and listed_parts(library) == []
    clock.now += avatar_wardrobe._RETRY_S[1] + 1
    assert listed_parts(library) == []
    assert calls == [VERSION]


def test_a_body_registered_again_answers_to_its_earlier_versions_again(library, monkeypatch):
    third = '5' * 24
    library.assembly(BODY, third, slots=())
    fresh_list(library, 'one shape')
    calls = shapes(monkeypatch, {VERSION: 'one shape', NEXT_VERSION: 'one shape', third: 'another shape'})
    assert listed_parts(library) == [(PART, PART_VERSION, 'hair')]
    # Moved to a version of another shape, the parts of the first shape leave the wardrobe...
    library.wardrobe.register(BODY, third, library.wardrobe.bodies()['revision'])
    assert listed_parts(library) == []
    # ...and come back with a version of that shape, without parsing the earlier one again.
    library.wardrobe.register(BODY, NEXT_VERSION, library.wardrobe.bodies()['revision'])
    before = calls.count(VERSION)
    assert listed_parts(library) == [(PART, PART_VERSION, 'hair')]
    # Unregistered and registered afresh, the same.
    library.wardrobe.unregister(BODY, library.wardrobe.bodies()['revision'])
    library.wardrobe.register(BODY, NEXT_VERSION, library.wardrobe.bodies()['revision'])
    assert listed_parts(library) == [(PART, PART_VERSION, 'hair')]
    assert calls.count(VERSION) == before


def test_an_alias_dropped_by_a_passing_failure_comes_back(library, monkeypatch):
    third = '5' * 24
    library.assembly(BODY, third, slots=())
    fresh_list(library, 'one shape')
    shapes(monkeypatch, {VERSION: 'one shape', NEXT_VERSION: 'one shape', third: 'one shape'})
    assert listed_parts(library) == [(PART, PART_VERSION, 'hair')]
    answer = FittingManagement.body_entry

    def body_entry(management, job, version):
        if version == VERSION:
            raise OSError('timed out')
        return answer(management, job, version)
    monkeypatch.setattr(FittingManagement, 'body_entry', body_entry)
    # register() reads the aliases again and cannot read VERSION now; what was read of it before still holds.
    library.wardrobe.register(BODY, third, library.wardrobe.bodies()['revision'])
    [body] = library.wardrobe._stored()['bodies']
    assert body['version'] == third and sorted(body['aliases']) == sorted([NEXT_VERSION, VERSION])
    assert listed_parts(library) == [(PART, PART_VERSION, 'hair')]


def test_versions_adopted_on_a_members_read_keep_the_revision_operators_hold(library, monkeypatch):
    fresh_list(library, 'one shape')
    shapes(monkeypatch, {VERSION: 'one shape', NEXT_VERSION: 'one shape'})
    revision = library.wardrobe._stored()['revision']
    library.refresh()
    assert [part['job_id'] for part in library.wardrobe.parts(BODY, operator=False)['parts']] == [PART]
    stored = library.wardrobe._stored()
    assert stored['bodies'][0]['aliases'] == [VERSION] and stored['revision'] == revision
    # Known from the stored list alone, as after a restart: a member's file request reads no listing.
    avatar_wardrobe._shapes.clear()
    assert library.wardrobe._member_record(PART, PART_VERSION, 'hair', 'missing')['status'] == 'review_required'
    # The operator's unregister sent with the revision read before the adoption still applies.
    library.wardrobe.unregister(BODY, revision)
    assert library.wardrobe._stored()['bodies'] == []


def test_a_list_that_cannot_be_written_does_not_fail_the_read(library, monkeypatch):
    fresh_list(library, 'one shape')
    calls = shapes(monkeypatch, {VERSION: 'one shape', NEXT_VERSION: 'one shape'})
    real = avatar_wardrobe._write_json

    def refuse(path, value):
        raise OSError('read-only')
    monkeypatch.setattr(avatar_wardrobe, '_write_json', refuse)
    assert listed_parts(library) == [(PART, PART_VERSION, 'hair')]
    assert 'aliases' not in library.wardrobe._stored()['bodies'][0]
    # Answered all the same: a look saved on that version is worn on the body.
    assert library.wardrobe.bodies()['bodies'][0]['aliases'] == [VERSION]
    monkeypatch.setattr(avatar_wardrobe, '_write_json', real)
    assert listed_parts(library) == [(PART, PART_VERSION, 'hair')]
    assert library.wardrobe._stored()['bodies'][0]['aliases'] == [VERSION] and calls == [VERSION]


@pytest.mark.parametrize('fails', [False, True], ids=['read', 'failed read'])
def test_requests_waiting_for_one_read_of_a_body_version_take_its_answer(library, monkeypatch, clock, fails):
    fresh_list(library, 'one shape')
    calls = shapes(monkeypatch, {VERSION: 'one shape', NEXT_VERSION: 'one shape'})
    answer = FittingManagement.body_entry
    reading, release = threading.Event(), threading.Event()

    def body_entry(management, job, version):
        if version == VERSION and not release.is_set():
            reading.set()
            release.wait(10)
            if fails:
                calls.append(version)
                raise OSError('timed out')
        return answer(management, job, version)
    monkeypatch.setattr(FittingManagement, 'body_entry', body_entry)
    library.refresh()
    results = []

    def read():
        results.append([part['job_id'] for part in library.wardrobe.parts(BODY, operator=False)['parts']])
    first = threading.Thread(target=read)
    first.start()
    assert reading.wait(10)
    second = threading.Thread(target=read)
    second.start()
    # The second request waits for the first one's read of the same body version.
    key = ('wardrobe-shape', (1, BODY, VERSION))
    deadline = time.monotonic() + 10
    while keyed_lock._locks.get(key, [None, 0])[1] < 2 and time.monotonic() < deadline:
        time.sleep(.01)
    release.set()
    first.join(10)
    second.join(10)
    assert calls == [VERSION]
    assert results == ([[], []] if fails else [[PART], [PART]])
    if fails:
        # A request after the pause reads it again.
        clock.now += avatar_wardrobe._RETRY_S[0] + 1
        assert listed_parts(library) == [(PART, PART_VERSION, 'hair')]
        assert calls == [VERSION, VERSION]


def png_glb(size):
    """A textured part whose texture is a PNG (decoded whole, unlike a JPEG) of `size` px a side."""
    return textured_glb(size=size)


def test_a_texture_too_large_to_decode_is_refused_before_decoding(monkeypatch):
    decoded = []
    real = Image.Image.convert
    monkeypatch.setattr(Image.Image, 'convert', lambda self, *a, **k: (decoded.append(self.size), real(self, *a, **k))[1])
    monkeypatch.setattr(avatar_wardrobe_colors, 'MAX_DECODED_PIXELS', 64*64)
    with pytest.raises(avatar_wardrobe_colors.TextureTooLarge):
        avatar_wardrobe_colors.color_regions(png_glb(65))
    assert decoded == []
    assert avatar_wardrobe_colors.color_regions(png_glb(64)) is not None


def test_a_too_large_texture_is_a_clear_refusal_of_the_colour_screen(library, monkeypatch):
    library.job(PART, base=(BODY, NEXT_VERSION), requested=['hair'])
    library.assembly(PART, PART_VERSION, slots=('hair',), contents={'hair': png_glb(65)})
    library.register((BODY, NEXT_VERSION))
    monkeypatch.setattr(avatar_wardrobe_colors, 'MAX_DECODED_PIXELS', 64*64)
    with pytest.raises(PipelineError) as error:
        library.wardrobe.colors(PART, 'hair', PART_VERSION)
    assert (error.value.code, error.value.status) == ('texture_too_large', 422)


def test_the_used_texels_are_the_ones_the_polygon_fill_marks():
    rng = np.random.default_rng(3)
    triangles = rng.uniform(0, 64, (1, 3, 2)) + rng.normal(0, 4, (400, 3, 2))
    triangles[5, 1, 0] = np.nan  # a broken UV is skipped
    expected = Image.new('L', (64, 64), 0)
    draw = ImageDraw.Draw(expected)
    for triangle in np.delete(triangles, 5, axis=0):
        draw.polygon([tuple(point) for point in triangle], fill=255)
    found = Image.new('L', (64, 64), 0)
    avatar_wardrobe_colors._fill(ImageDraw.Draw(found), triangles)
    assert np.array_equal(np.asarray(found), np.asarray(expected))


@pytest.mark.parametrize('name, key', [
    ('mixamorig:LeftLeg', 'leftleg'), ('mixamorig_LeftLeg', 'leftleg'), ('mixamorig1_RightUpLeg', 'rightupleg'),
    ('Armature:mixamorig_Head', 'head'), ('LeftLeg', 'leftleg'), ('a:b:Head', 'head'),
    ('Left_Leg', 'left_leg'), ('mixamorigLeftLeg', 'mixamorigleftleg'),
])
def test_bone_names_lose_their_rig_prefix(name, key):
    assert list(bone_keys([name])) == [key]


def test_bone_keys_keep_the_shape_of_a_per_vertex_array():
    names = np.array(['mixamorig_LeftLeg', 'Hips', 'mixamorig_LeftLeg', 'mixamorig:Head'])
    assert list(bone_keys(names)) == ['leftleg', 'hips', 'leftleg', 'head']
    assert list(bone_keys([])) == []
