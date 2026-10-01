import io
import json
from threading import Barrier, Thread
import time

import numpy as np
from PIL import Image
import pytest

from src.services import avatar_wardrobe, avatar_wardrobe_colors, avatar_wardrobe_coverage, avatar_worn_images, keyed_lock
from wardrobe_fixture import Library, Overlap, put, sha, textured_glb

BODY, BODY_VERSION = 'b' * 24, '1' * 24
PART, V1 = 'c' * 24, 'a' * 24
SLOTS = ('hair', 'hat', 'top', 'bottom', 'shoes')


@pytest.fixture
def library(tmp_path):
    library = Library(tmp_path)
    library.job(BODY)
    library.assembly(BODY, BODY_VERSION, slots=(), contents={'body': b'body glb'})
    library.current(BODY, BODY_VERSION)
    library.register((BODY, BODY_VERSION))
    library.job(PART, base=(BODY, BODY_VERSION), requested=list(SLOTS))
    library.assembly(PART, V1, slots=SLOTS, contents={slot: f'{slot} glb'.encode() for slot in SLOTS})
    library.current(PART, V1)
    # Derived files go to object storage, where there are no directories to make; a local disk needs them.
    for name in ('wardrobe-colors', 'wardrobe-previews', 'wardrobe-coverage'):
        (library.wardrobe.library.root/name).mkdir(parents=True)
    return library


def together(count, call):
    """`call` on `count` threads released at once: their results, or the exception each raised."""
    start, results = Barrier(count), [None]*count

    def work(index):
        start.wait()
        try:
            results[index] = call(index)
        except BaseException as exc:
            results[index] = exc
    threads = [Thread(target=work, args=(index,)) for index in range(count)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    return results


def regions():
    return [{'index': 0, 'color': '#ff0000', 'share': 1., 'light': .2}]


def test_colours_of_one_part_are_computed_once_for_requests_that_arrive_together(library, monkeypatch):
    calls = []

    def fake(content):
        calls.append(content)
        time.sleep(.3)
        return b'mask png', regions(), 0
    monkeypatch.setattr(avatar_wardrobe_colors, 'color_regions', fake)
    real = avatar_wardrobe._write_json
    written = []

    def write(path, value):
        # A reader that finds the json must find the mask it describes.
        if path.parent.name == 'wardrobe-colors':
            assert path.with_suffix('.png').is_file()
            written.append(path.name)
        return real(path, value)
    monkeypatch.setattr(avatar_wardrobe, '_write_json', write)
    results = together(6, lambda index: library.wardrobe.colors(PART, 'hair', V1))
    assert not [result for result in results if isinstance(result, BaseException)], results
    assert len(calls) == 1 and len(written) == 1
    assert len({json.dumps(value) for value, _ in results}) == 1 and {mask.name for _, mask in results} == {written[0].replace('.json', '.png')}
    assert results[0][1].read_bytes() == b'mask png'


def test_a_preview_is_drawn_once_for_requests_that_arrive_together(library, monkeypatch):
    drawing = io.BytesIO()
    Image.new('RGBA', (64, 64), (200, 40, 40, 255)).save(drawing, 'PNG')
    (library.directory(PART)/'output').mkdir(parents=True)
    (library.directory(PART)/'output/front.png').write_bytes(drawing.getvalue())
    put(library.directory(PART)/'pipeline.json', {'parts': [{'slot': 'hair', 'views': {'front': {'file': 'front.png', 'sha256': sha('drawing')}}}]})
    calls, real = [], avatar_worn_images._rgba

    def counting(content, size=None):
        calls.append(1)
        time.sleep(.3)
        return real(content, size)
    monkeypatch.setattr(avatar_worn_images, '_rgba', counting)
    results = together(6, lambda index: library.wardrobe.preview(PART, 'hair', V1))
    assert not [result for result in results if isinstance(result, BaseException)], results
    assert len(calls) == 1 and len({str(result) for result in results}) == 1
    assert Image.open(io.BytesIO(results[0].read_bytes())).format == 'PNG'


def test_coverage_of_one_part_is_computed_once_for_requests_that_arrive_together(library, monkeypatch):
    calls = []

    def fake(body, content, slot):
        calls.append(slot)
        time.sleep(.3)
        return {'slot': slot, 'covers_bottom': False}
    monkeypatch.setattr(avatar_wardrobe_coverage, 'coverage', fake)
    monkeypatch.setattr(avatar_wardrobe.Wardrobe, '_body_geometry', lambda self, native, body: [])
    results = together(6, lambda index: library.wardrobe.coverage(BODY, PART, 'hair', V1))
    assert not [result for result in results if isinstance(result, BaseException)], results
    assert calls == ['hair'] and all(result == {'slot': 'hair', 'covers_bottom': False} for result in results)


def test_the_body_glb_is_parsed_once_for_parts_asked_for_together(library, monkeypatch):
    calls = []

    def fake(content):
        calls.append(content)
        time.sleep(.3)
        return [{'key': '0:0'}]
    monkeypatch.setattr(avatar_wardrobe_coverage, 'skinned_primitives', fake)
    from src.services.avatar_native_parts import AvatarNativeParts
    native, body = AvatarNativeParts(library.factory), library.wardrobe._body(BODY)
    results = together(6, lambda index: library.wardrobe._body_geometry(native, body))
    assert calls == [b'body glb'] and all(result == [{'key': '0:0'}] for result in results)


def test_only_a_few_derived_files_are_computed_at_a_time(library, monkeypatch):
    inside = Overlap()

    def fake(content):
        with inside:
            time.sleep(.05)
        return b'mask', regions(), 0
    monkeypatch.setattr(avatar_wardrobe_colors, 'color_regions', fake)
    results = together(len(SLOTS), lambda index: library.wardrobe.colors(PART, SLOTS[index], V1))
    assert not [result for result in results if isinstance(result, BaseException)], results
    assert inside.peak == 2


def test_clustering_the_texture_in_chunks_labels_every_texel_as_one_pass_does():
    rng = np.random.default_rng(3)
    points, centers = rng.random((5003, 3))*100, rng.random((4, 3))*100
    expected = np.argmin(((points[:, None] - centers[None])**2).sum(axis=2), axis=1)
    for chunk in (1, 7, 1000, 5003, 200_000):
        assert np.array_equal(avatar_wardrobe_colors._nearest(points, centers, chunk), expected)


def test_colour_regions_do_not_depend_on_the_chunk_size(monkeypatch):
    content = textured_glb()
    whole = avatar_wardrobe_colors.color_regions(content)
    nearest = avatar_wardrobe_colors._nearest
    monkeypatch.setattr(avatar_wardrobe_colors, '_nearest', lambda points, centers: nearest(points, centers, 100))
    assert avatar_wardrobe_colors.color_regions(content) == whole
    png, found, material = whole
    assert material == 0 and len(found) == 3 and abs(sum(region['share'] for region in found) - 1) < 1e-3


def test_one_lock_per_key_and_none_left_behind():
    together_in = Overlap(wait=.3)
    inside, overlap, order = [0], [], []

    def work(key):
        with keyed_lock.keyed_lock(key):
            inside[0] += 1
            overlap.append(inside[0])
            time.sleep(.03)
            inside[0] -= 1
    together(4, lambda index: work('same'))
    assert overlap == [1, 1, 1, 1]

    def other(index):
        with keyed_lock.keyed_lock(('different', index)):
            with together_in:
                time.sleep(.01)
    together(4, other)
    assert together_in.peak > 1
    assert keyed_lock._locks == {}
    for index in range(1000):
        with keyed_lock.keyed_lock(index):
            assert len(keyed_lock._locks) == 1
    assert keyed_lock._locks == {}
    # The same thread may take its own lock again.
    with keyed_lock.keyed_lock('again'), keyed_lock.keyed_lock('again'):
        order.append('nested')
    assert order == ['nested']
