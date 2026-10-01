from collections import deque
import io
import tracemalloc

import numpy as np
from PIL import Image
import pytest

from src.services import avatar_part_batches
from src.services.avatar_blueprints import AvatarBlueprints
from src.services.avatar_factory import AvatarFactory
from src.services.avatar_hair_sheet import _crop_views, crop_rows
from src.services.avatar_part_batches import isolate_hair, split_sheet
from src.services.character_pipeline import PipelineError

# The reference below is the old code, which reads every pixel with Image.getdata.
pytestmark = pytest.mark.filterwarnings('ignore:Image.Image.getdata:DeprecationWarning')


def reference_isolate_hair(tile):
    """The filter as it was written before it ran on numpy: Python tuples for every pixel."""
    tile = tile.convert('RGBA'); pixels = list(tile.getdata()); w, h = tile.size
    mask = bytearray(w*h)
    for i, (r, g, b, a) in enumerate(pixels):
        skin = r-b > 12 and r-g > 4 and g-b > -6
        matte = max(r, g, b)-min(r, g, b) > 100
        mask[i] = int(a > 24 and not skin and not matte and min(r, g, b) <= 245)
    kept = bytearray(w*h)
    for start in range(w*h):
        if not mask[start]:
            continue
        mask[start] = 0; queue = deque([start]); component = []
        while queue:
            index = queue.popleft(); component.append(index); x, y = index % w, index // w
            for other in (index-1 if x else -1, index+1 if x+1 < w else -1,
                          index-w if y else -1, index+w if y+1 < h else -1):
                if other >= 0 and mask[other]:
                    mask[other] = 0; queue.append(other)
        if len(component) >= 12:
            for index in component:
                kept[index] = 1
    tile.putdata([(r, g, b, a if kept[i] else 0) for i, (r, g, b, a) in enumerate(pixels)])
    return tile


def blobs(width, height, seed):
    """Hair, skin, matte, near-white and semi-transparent regions, specks of 1 to 13 pixels, and shapes on the borders."""
    rng = np.random.default_rng(seed)
    pixels = np.zeros((height, width, 4), np.uint8)
    colours = [(60, 40, 30, 255), (200, 150, 120, 255), (255, 0, 0, 255), (250, 250, 250, 255), (90, 90, 90, 25),
               (90, 90, 90, 24), (40, 60, 90, 200), (120, 100, 100, 255)]
    for _ in range(max(6, width*height//300)):
        w, h = rng.integers(1, 9, 2)
        x, y = rng.integers(0, max(1, width-w+1)), rng.integers(0, max(1, height-h+1))
        pixels[y:y+h, x:x+w] = colours[rng.integers(len(colours))]
    pixels[0, :5] = pixels[-1, -14:] = (30, 30, 30, 255)
    pixels[:12, 0] = (30, 30, 30, 255)
    return Image.fromarray(pixels, 'RGBA')


def noise(width, height, seed):
    return Image.fromarray(np.random.default_rng(seed).integers(0, 256, (height, width, 4), dtype=np.uint8), 'RGBA')


@pytest.mark.parametrize('tile', [
    blobs(64, 64, 1), blobs(120, 70, 2), blobs(40, 700, 3), blobs(700, 40, 4), noise(40, 30, 5), noise(33, 513, 6),
    Image.new('RGBA', (1, 1), (10, 10, 10, 255)), Image.new('RGBA', (1, 9), (10, 10, 10, 255)),
    Image.new('RGBA', (9, 1), (10, 10, 10, 255)), Image.new('RGBA', (12, 1), (10, 10, 10, 255)),
    Image.new('RGBA', (11, 1), (10, 10, 10, 255)), Image.new('RGBA', (30, 30), (0, 0, 0, 0)),
    Image.new('RGB', (30, 30), (10, 20, 30)), Image.new('L', (30, 30), 40)])
def test_isolating_hair_gives_the_same_pixels_as_the_tuple_version(tile):
    expected, actual = reference_isolate_hair(tile.copy()), isolate_hair(tile.copy())
    assert actual.mode == expected.mode == 'RGBA' and actual.size == expected.size
    assert actual.tobytes() == expected.tobytes()


def test_isolating_a_large_tile_does_not_build_python_objects_for_every_pixel():
    tile = Image.new('RGBA', (1600, 1600), (0, 0, 0, 0))
    tile.paste(Image.new('RGBA', (300, 300), (50, 40, 30, 255)), (100, 100))
    tracemalloc.start()
    try:
        isolate_hair(tile)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    # The tuple version takes some 600 MB here.
    assert peak < 100*1024*1024


def test_a_view_boundary_on_the_first_pixel_is_a_grid_error_not_a_crash():
    image = Image.new('RGBA', (12, 4), (0, 0, 0, 255))
    for call in (lambda: _crop_views(image, [0, 0, 12]), lambda: _crop_views(image, [0, 12, 12]),
                 lambda: crop_rows(image, [0, 0, 4], [[0, 12]]*2)):
        with pytest.raises(PipelineError) as error:
            call()
        assert error.value.code == 'invalid_grid' and error.value.status == 422


def sheet(tmp_path, monkeypatch, name='sheet'):
    monkeypatch.setenv('ASSET_S3_BUCKET', 'offline-fixture-bucket')
    # Records go to object storage, which has no directories; on a local disk they have to be made.
    real = avatar_part_batches._write_json
    monkeypatch.setattr(avatar_part_batches, '_write_json', lambda path, value: (path.parent.mkdir(parents=True, exist_ok=True), real(path, value))[1])
    factory = AvatarFactory(tmp_path)
    image = Image.new('RGBA', (300, 100), (0, 0, 0, 0))
    for index in range(3):
        image.paste(Image.new('RGBA', (60, 70), (40, 40, 60, 255)), (20 + index*100, 15))
    content = io.BytesIO()
    image.save(content, 'PNG')
    return factory, AvatarBlueprints(factory.data).upload(1, content.getvalue())['id']


def test_sheet_items_are_named_by_number_whatever_the_body(tmp_path, monkeypatch):
    factory, asset_id = sheet(tmp_path, monkeypatch)
    record = split_sheet(factory, 1, {'asset_id': asset_id, 'rows': 1, 'columns': 1, 'view_order': ['front', 'back', 'side'],
                                      'remove_skin': True, 'detect_view_seams': False})
    assert [item['name'] for item in record['items']] == ['헤어 01']
