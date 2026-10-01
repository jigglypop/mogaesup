"""Preflight decodes each distinct embedded image once, and no file can make it decode without bound."""

import base64
import io

from PIL import Image, ImageFile

from api.test_characters import rigged_glb
from src.services import asset_delivery
from src.services.asset_delivery import DeliveryPolicy, inspect_glb
from src.services.glb import build_glb, parse_glb


def png(color, size=8):
    stream = io.BytesIO()
    Image.new('RGB', (size, size), color).save(stream, format='PNG')
    return stream.getvalue()


def glb_with_images(pictures, entries):
    """A rigged GLB whose buffer holds `pictures`; `entries` are the images[] items, as buffer view indexes or URIs."""
    doc, binary = parse_glb(rigged_glb(), strict=True)
    first = len(doc['bufferViews'])
    for picture in pictures:
        doc['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(picture)})
        binary += picture
    doc['buffers'][0]['byteLength'] = len(binary)
    doc['images'] = [{'uri': entry} if isinstance(entry, str) else {'bufferView': first + entry, 'mimeType': 'image/png'}
                     for entry in entries]
    doc['textures'] = [{'source': 0}]
    return build_glb(doc, binary)


class Decodes:
    """Counts the images preflight opens and decodes."""

    def __init__(self, monkeypatch):
        self.opened = self.loaded = 0
        opened, loaded = asset_delivery.Image.open, ImageFile.ImageFile.load
        decodes = self

        def counting_open(*args, **kwargs):
            decodes.opened += 1
            return opened(*args, **kwargs)

        def counting_load(image, *args, **kwargs):
            decodes.loaded += 1
            return loaded(image, *args, **kwargs)

        monkeypatch.setattr(asset_delivery.Image, 'open', counting_open)
        monkeypatch.setattr(ImageFile.ImageFile, 'load', counting_load)


def test_entries_sharing_a_buffer_view_are_decoded_once_and_counted_each(monkeypatch):
    decodes = Decodes(monkeypatch)
    report = inspect_glb(glb_with_images([png('blue')], [0] * 40))
    assert report['errors'] == []
    assert decodes.opened == 1 and decodes.loaded == 1
    # The texture budget still sees every entry: each one is a texture a viewer uploads.
    assert report['metrics']['texture_pixels'] == 40 * 8 * 8


def test_entries_sharing_a_uri_are_decoded_once(monkeypatch):
    uri = 'data:image/png;base64,' + base64.b64encode(png('red')).decode()
    decodes = Decodes(monkeypatch)
    report = inspect_glb(glb_with_images([], [uri] * 12))
    assert report['errors'] == []
    assert decodes.opened == 1 and decodes.loaded == 1
    assert report['metrics']['texture_pixels'] == 12 * 8 * 8


def test_distinct_images_are_each_decoded(monkeypatch):
    decodes = Decodes(monkeypatch)
    report = inspect_glb(glb_with_images([png('blue'), png('red')], [0, 1, 0, 1]))
    assert report['errors'] == []
    assert decodes.opened == 2 and decodes.loaded == 2
    assert report['metrics']['texture_pixels'] == 4 * 8 * 8


def test_a_file_cannot_make_preflight_decode_without_bound(monkeypatch):
    monkeypatch.setattr(asset_delivery, 'MAX_DECODED_PIXELS', 100)
    decodes = Decodes(monkeypatch)
    content = glb_with_images([png('blue'), png('red')], [0, 1])
    report = inspect_glb(content)
    assert report['errors'] == ['image decode budget exceeded'] and report['status'] == 'rejected'
    # The second image is refused from its header, before a pixel of it is decoded.
    assert decodes.opened == 2 and decodes.loaded == 1
    # The cap guards the process, so the factory's warn-only texture budgets do not lift it.
    assert inspect_glb(content, budget_warnings=True)['errors'] == ['image decode budget exceeded']


def test_the_texture_budget_still_rejects_before_decoding(monkeypatch):
    decodes = Decodes(monkeypatch)
    report = inspect_glb(glb_with_images([png('blue')], [0, 0]), DeliveryPolicy(max_texture_pixels=100))
    assert report['errors'] == ['texture budget exceeded']
    assert decodes.loaded == 1
    warned = inspect_glb(glb_with_images([png('blue')], [0, 0]), DeliveryPolicy(max_texture_pixels=100), budget_warnings=True)
    assert warned['errors'] == [] and warned['warnings'] == ['texture budget exceeded']


def test_a_buffer_view_and_a_uri_on_one_image_are_still_refused():
    uri = 'data:image/png;base64,' + base64.b64encode(png('red')).decode()
    doc, binary = parse_glb(glb_with_images([png('blue')], [0]), strict=True)
    doc['images'] = [{'uri': uri, 'bufferView': len(doc['bufferViews']) - 1}] * 2
    report = inspect_glb(build_glb(doc, binary))
    assert report['errors'] == ['only embedded PNG/JPEG images are supported by preflight']
