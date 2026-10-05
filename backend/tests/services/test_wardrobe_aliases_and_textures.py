"""Wardrobe body aliases written before their geometry was compared, colour regions of large textures, and Mixamo bone
names exported with an underscore prefix."""
import io

import numpy as np
from PIL import Image, ImageDraw
import pytest

from src.services import avatar_wardrobe, avatar_wardrobe_colors
from src.services.asset_editor import _write_json
from src.services.avatar_fitting_management import FittingManagement
from src.services.avatar_wardrobe_coverage import bone_keys
from src.services.character_pipeline import PipelineError
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
    assert library.wardrobe.bodies()['bodies'][0]['part_jobs'] == 1
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
