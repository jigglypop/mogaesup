"""Wardrobe previews of parts that came without a drawing (an uploaded GLB): the part as it is worn, cropped from the
assembly's front render, and `preview_missing` when nothing can be shown."""
import io
import hashlib

import numpy as np
from PIL import Image
import pytest

import fake_blender
from src.services import avatar_wardrobe
from src.services.character_pipeline import PipelineError, read_json
from src.services.object_storage import StoredPath
from wardrobe_fixture import Library, put

BODY, BODY_VERSION, PART, V1 = 'b' * 24, '1' * 24, 'c' * 24, 'a' * 24
HEIGHT = 1.6
FRAME = avatar_wardrobe.legacy_render_frame(HEIGHT)
HAIR_BOX = [[-.12, 1.35, -.1], [.12, 1.62, .1]]
RED, BLUE = (220, 40, 40, 255), (40, 40, 220, 255)


def pixel(x, y, size=800):
    """Pixel of a glTF point in a front render framed by FRAME."""
    scale = size/FRAME['ortho_scale_m']
    return round(size/2 + (x - FRAME['center_gltf_m'][0])*scale), round(size/2 - (y - FRAME['center_gltf_m'][1])*scale)


def front_render():
    """A transparent 800 px render: red where the hair sits, blue at the feet."""
    image = Image.new('RGBA', (800, 800), (0, 0, 0, 0))
    left, top = pixel(-.08, 1.58); right, bottom = pixel(.08, 1.4)
    image.paste(RED, (left, top, right, bottom))
    image.paste(BLUE, (370, 700, 430, 780))
    content = io.BytesIO(); image.save(content, 'PNG')
    return content.getvalue(), (right - left, bottom - top)


@pytest.fixture
def wardrobe(tmp_path):
    library = Library(tmp_path)
    library.job(BODY)
    library.assembly(BODY, BODY_VERSION, slots=())
    library.current(BODY, BODY_VERSION)
    library.register((BODY, BODY_VERSION))
    library.job(PART, base=(BODY, BODY_VERSION), requested=['hair'])
    # An uploaded GLB hair: no drawing in the pipeline.
    put(library.directory(PART)/'pipeline.json', {'parts': [{'slot': 'hair', 'views': {}, 'image': {'status': 'not_required'}}]})
    return library


def seal(library, *, report=None, result=None, renders=None, spec_height=HEIGHT):
    render, size = front_render()
    library.assembly(PART, V1, contents={'hair': b'uploaded hair', 'front': render, **(renders or {})})
    path = library.directory(PART)/'native-parts'/V1/'record.json'
    record = read_json(path)
    # The fixture names files by slot: the renders are PNGs.
    for name in ('front', *(renders or {})):
        record['files'][f'{name}.png'] = record['files'].pop(f'{name}.glb')
        (path.parent/f'{name}.glb').rename(path.parent/f'{name}.png')
    record['result']['parts'] = [{'slot': 'body'}, {'slot': 'hair', **(report or {})}]
    record['result'].update(result or {})
    put(path, record)
    put(path.parent/'input.json', {'production_spec': {'body_height_m': spec_height}})
    library.current(PART, V1)
    avatar_wardrobe._records.clear()
    return size


def colours(path):
    image = np.asarray(Image.open(path).convert('RGBA'))
    return {tuple(int(v) for v in row) for row in image.reshape(-1, 4) if row[3]}, Image.open(path).size


def test_an_uploaded_part_is_shown_as_it_is_worn_cropped_from_the_front_render(wardrobe):
    size = seal(wardrobe, report={'fitted_bounds_gltf': HAIR_BOX}, result={'render_frame': FRAME})
    found, shown = colours(wardrobe.wardrobe.preview(PART, 'hair', V1))
    assert found == {RED} and shown == size


def test_a_version_sealed_before_the_frame_was_recorded_uses_the_camera_it_had(wardrobe):
    size = seal(wardrobe, report={'fitted_bounds_gltf': HAIR_BOX})
    found, shown = colours(wardrobe.wardrobe.preview(PART, 'hair', V1))
    assert found == {RED} and shown == size


def test_without_fitted_bounds_the_slot_target_says_where_the_part_sits(wardrobe):
    seal(wardrobe, result={'fitting_targets': {'hair': HAIR_BOX}})
    found, _ = colours(wardrobe.wardrobe.preview(PART, 'hair', V1))
    assert found == {RED}


def test_a_head_parts_own_render_is_shown_when_the_version_has_one(wardrobe):
    own = Image.new('RGBA', (600, 600), (0, 0, 0, 0)); own.paste(BLUE, (100, 100, 200, 160))
    content = io.BytesIO(); own.save(content, 'PNG')
    seal(wardrobe, renders={'hair-front': content.getvalue()})
    found, shown = colours(wardrobe.wardrobe.preview(PART, 'hair', V1))
    assert found == {BLUE} and shown == (100, 60)


@pytest.mark.parametrize('report, result, height', [
    ({}, {}, HEIGHT),                                        # nothing says where the part sits
    ({'fitted_bounds_gltf': [[0, 1, 0], [0, 1, 0]]}, {}, HEIGHT),   # an empty box
    ({'fitted_bounds_gltf': HAIR_BOX}, {}, None),            # no frame and no body height
])
def test_preview_missing_when_no_picture_can_be_made(wardrobe, report, result, height):
    seal(wardrobe, report=report, result=result, spec_height=height)
    with pytest.raises(PipelineError) as error:
        wardrobe.wardrobe.preview(PART, 'hair', V1)
    assert (error.value.code, error.value.status) == ('preview_missing', 404)


def test_a_drawing_that_is_gone_falls_back_to_the_worn_preview(wardrobe):
    put(wardrobe.directory(PART)/'pipeline.json', {'parts': [{'slot': 'hair', 'views': {'front': {'file': 'hair-front.png', 'sha256': 'd'*64}}}]})
    seal(wardrobe, report={'fitted_bounds_gltf': HAIR_BOX}, result={'render_frame': FRAME})
    found, _ = colours(wardrobe.wardrobe.preview(PART, 'hair', V1))
    assert found == {RED}


def test_the_legacy_frame_is_the_frame_the_product_camera_renders_with(monkeypatch):
    """avatar_blender_common.camera_setup, run against stand-in Blender modules, frames the body as the wardrobe
    assumes for versions that did not record their frame."""
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_blender_common')
    scene = bpy.context.scene
    scene.render = type('Render', (), {'image_settings': type('Settings', (), {})()})()
    scene.collection = type('Collection', (), {'objects': type('Linked', (), {'link': staticmethod(lambda obj: None)})()})()
    data = type('Data', (), {})
    bpy.data.cameras = type('Cameras', (), {'new': staticmethod(lambda name: data())})()
    bpy.data.lights = type('Lights', (), {'new': staticmethod(lambda name, kind: data())})()
    bpy.data.objects.new = lambda name, value: type('Placed', (), {'data': value, 'location': None})()
    camera, center = modules['avatar_blender_common'].camera_setup(HEIGHT)
    assert camera.data.ortho_scale == pytest.approx(FRAME['ortho_scale_m'])
    assert [center.x, center.z, -center.y] == pytest.approx(FRAME['center_gltf_m'])


def test_a_cached_file_is_written_whole_or_left_as_it_was(tmp_path, monkeypatch):
    target = StoredPath(tmp_path/'preview.png')
    avatar_wardrobe._write_file(target, b'complete picture')
    assert target.read_bytes() == b'complete picture' and [p.name for p in tmp_path.iterdir()] == ['preview.png']
    real = StoredPath.write_bytes

    def torn(self, data):
        real(self, data[:4])
        raise OSError('disk full')
    monkeypatch.setattr(StoredPath, 'write_bytes', torn)
    with pytest.raises(OSError):
        avatar_wardrobe._write_file(target, b'replacement picture')
    assert target.read_bytes() == b'complete picture' and [p.name for p in tmp_path.iterdir()] == ['preview.png']


def native_seal(library, **kwargs):
    return seal(library, report={'fit_method': 'uploaded-native-hair-v1', 'available': True,
                                **kwargs.pop('report', {})}, **kwargs)


def test_uploaded_native_hair_without_bounds_shows_the_actual_whole_assembly(wardrobe):
    native_seal(wardrobe, spec_height=None)
    target = wardrobe.wardrobe.preview(PART, 'hair', V1)
    found, shown = colours(target)
    assert RED in found and BLUE in found  # Both the hair and feet: this is the assembly, not an isolated hair view.
    assert max(shown) <= 384
    record = read_json(wardrobe.directory(PART)/'native-parts'/V1/'record.json')
    assert target.name == f"{V1}-{record['files']['front.png']}-native-v1.png"


def test_uploaded_native_hair_prefers_its_sealed_own_render(wardrobe):
    image = Image.new('RGBA', (80, 40), BLUE)
    png = io.BytesIO(); image.save(png, 'PNG')
    native_seal(wardrobe, renders={'hair-front': png.getvalue()})
    found, shown = colours(wardrobe.wardrobe.preview(PART, 'hair', V1))
    assert found == {BLUE} and shown == (80, 40)


def test_uploaded_native_hair_keeps_the_existing_drawing_first(wardrobe):
    native_seal(wardrobe)
    png = io.BytesIO(); Image.new('RGBA', (30, 20), RED).save(png, 'PNG')
    output = wardrobe.directory(PART)/'output'; output.mkdir()
    (output/'hair-front.png').write_bytes(png.getvalue())
    drawing_sha = hashlib.sha256(png.getvalue()).hexdigest()
    put(wardrobe.directory(PART)/'pipeline.json', {'parts': [
        {'slot': 'hair', 'views': {'front': {'file': 'hair-front.png', 'sha256': drawing_sha}}}]})
    target = wardrobe.wardrobe.preview(PART, 'hair', V1)
    assert target.name == f'{drawing_sha[:32]}-plain-v2.png'
    assert colours(target) == ({RED}, (30, 20))


@pytest.mark.parametrize('changed', ['front.png', 'hair.glb'])
@pytest.mark.parametrize('operation', ['change', 'remove'])
def test_cached_native_preview_does_not_hide_changed_or_missing_artifacts(wardrobe, changed, operation):
    native_seal(wardrobe)
    target = wardrobe.wardrobe.preview(PART, 'hair', V1)
    assert target.is_file()
    source = wardrobe.directory(PART)/'native-parts'/V1/changed
    if operation == 'change':
        source.write_bytes(b'changed source')
    else:
        source.unlink()
    with pytest.raises(PipelineError) as error:
        wardrobe.wardrobe.preview(PART, 'hair', V1)
    assert error.value.status == 404


def test_an_unverified_own_render_is_not_replaced_with_the_assembly(wardrobe):
    native_seal(wardrobe, renders={'hair-front': front_render()[0]})
    (wardrobe.directory(PART)/'native-parts'/V1/'hair-front.png').write_bytes(b'changed')
    with pytest.raises(PipelineError) as error:
        wardrobe.wardrobe.preview(PART, 'hair', V1)
    assert (error.value.code, error.value.status) == ('artifact_changed', 404)


@pytest.mark.parametrize('available', [False, None, 1])
def test_native_thumbnail_requires_an_available_part(wardrobe, available):
    native_seal(wardrobe, report={'available': available})
    with pytest.raises(PipelineError) as error:
        wardrobe.wardrobe.preview(PART, 'hair', V1)
    assert error.value.status == 404


@pytest.mark.parametrize('metadata', [
    {'items': {PART: {'archived': True}}},
    {'parts': {f'{PART}:hair': {'deleted': True}}},
    {'characters': {PART: {'deleted': True}}},
])
def test_native_thumbnail_cache_does_not_bypass_visibility(wardrobe, metadata):
    native_seal(wardrobe)
    assert wardrobe.wardrobe.preview(PART, 'hair', V1).is_file()
    wardrobe.catalog(**metadata)
    with pytest.raises(PipelineError) as error:
        wardrobe.wardrobe.preview(PART, 'hair', V1)
    assert (error.value.code, error.value.status) == ('not_found', 404)


def test_native_thumbnail_requires_the_offered_sealed_version(wardrobe):
    native_seal(wardrobe)
    path = wardrobe.directory(PART)/'native-parts'/V1/'record.json'
    record = read_json(path); record['status'] = 'running'; put(path, record)
    avatar_wardrobe._records.clear()
    with pytest.raises(PipelineError) as error:
        wardrobe.wardrobe.preview(PART, 'hair', V1)
    assert error.value.status == 404
