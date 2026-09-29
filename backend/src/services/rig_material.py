"""Put a body's own material back on the provider-rigged copy of the same mesh.

Meshy's rigging returns the mesh with one re-baked base colour (the original mixed with grey),
no normal or ORM maps, emission 1 and the glTF default metallic 1. The UV layout is unchanged,
so the source material and its textures apply to the rigged mesh as they are.
"""
from copy import deepcopy
import io

import numpy as np
from PIL import Image

from src.services.glb import build_glb, parse_glb

# Minimum per-channel R² between the two base colours: the rigged texture must be a linear
# remap (grey mix) of the source texture on the same UV layout. Measured on the common female
# body: 0.89 for the same layout (JPEG re-encoding noise), 0.00–0.03 for flipped or shifted ones.
MIN_LAYOUT_FIT = .6


def _embedded_images(doc):
    """True when every image is stored in a buffer view of this GLB (no uri, data or external)."""
    views = len(doc.get('bufferViews', []))
    return all(isinstance(image, dict) and 'uri' not in image and isinstance(image.get('bufferView'), int)
               and 0 <= image['bufferView'] < views for image in doc.get('images', []))


def _image_bytes(doc, binary, index):
    view = doc['bufferViews'][doc['images'][index]['bufferView']]
    start = view.get('byteOffset', 0)
    return binary[start:start + view['byteLength']]


def _base_colour(doc, binary):
    """The first material's base-colour texture as a 256² RGB array, or None when unreadable."""
    texture = (doc['materials'][0].get('pbrMetallicRoughness') or {}).get('baseColorTexture')
    if not isinstance(texture, dict):
        return None
    try:
        source = doc['textures'][texture['index']]['source']
        with Image.open(io.BytesIO(_image_bytes(doc, binary, source))) as image:
            return np.asarray(image.convert('RGB').resize((256, 256), Image.Resampling.BILINEAR), dtype=float)
    except (KeyError, IndexError, TypeError, ValueError, OSError, Image.DecompressionBombError):
        # Extension-only textures (no core source) or undecodable bytes: nothing to compare.
        return None


def layout_fit(rigged, source):
    """Lowest per-channel R² of rigged ≈ a·source + b over the whole texture."""
    fits = []
    for channel in range(3):
        x, y = source[..., channel].ravel(), rigged[..., channel].ravel()
        if x.std() < 1e-6:
            return 0.0
        a, b = np.polyfit(x, y, 1)
        residual = y - (a * x + b)
        fits.append(1 - residual.var() / max(y.var(), 1e-9))
    return float(min(fits))


def restore_source_material(rigged: bytes, source: bytes) -> tuple[bytes, dict]:
    doc, binary = parse_glb(rigged, strict=True)
    src, src_binary = parse_glb(source, strict=True)
    if len(doc.get('materials', [])) != 1 or len(src.get('materials', [])) != 1:
        return rigged, {'restored': False, 'reason': 'material_count'}
    if not _embedded_images(doc) or not _embedded_images(src):
        # A uri image (data: or external) is not repacked here; keep the provider rig as delivered.
        return rigged, {'restored': False, 'reason': 'image_not_embedded'}
    rigged_colour, source_colour = _base_colour(doc, binary), _base_colour(src, src_binary)
    if rigged_colour is None or source_colour is None:
        return rigged, {'restored': False, 'reason': 'base_colour_missing'}
    fit = layout_fit(rigged_colour, source_colour)
    if fit < MIN_LAYOUT_FIT:
        return rigged, {'restored': False, 'reason': 'texture_layout', 'fit': round(fit, 3)}

    # Keep every non-image buffer view of the rigged file, then append the source images.
    image_views = {image['bufferView'] for image in doc.get('images', []) if 'bufferView' in image}
    packed, remap = bytearray(), {}
    views = []
    for index, view in enumerate(doc.get('bufferViews', [])):
        if index in image_views:
            continue
        start = view.get('byteOffset', 0)
        packed.extend(b'\0' * (-len(packed) % 4))
        remap[index] = len(views)
        views.append({**view, 'buffer': 0, 'byteOffset': len(packed)})
        packed.extend(binary[start:start + view['byteLength']])
    for accessor in doc.get('accessors', []):
        if 'bufferView' in accessor:
            accessor['bufferView'] = remap[accessor['bufferView']]
        sparse = accessor.get('sparse')
        if sparse:
            sparse['indices']['bufferView'] = remap[sparse['indices']['bufferView']]
            sparse['values']['bufferView'] = remap[sparse['values']['bufferView']]
    images = []
    for index, image in enumerate(src.get('images', [])):
        content = _image_bytes(src, src_binary, index)
        packed.extend(b'\0' * (-len(packed) % 4))
        views.append({'buffer': 0, 'byteOffset': len(packed), 'byteLength': len(content)})
        packed.extend(content)
        images.append({key: value for key, value in image.items() if key != 'bufferView'} | {'bufferView': len(views) - 1})
    doc['bufferViews'] = views
    doc['images'] = images
    doc['textures'] = deepcopy(src.get('textures', []))
    doc['samplers'] = deepcopy(src.get('samplers', []))
    if not doc['samplers']:
        doc.pop('samplers')
    material = deepcopy(src['materials'][0])
    material['name'] = doc['materials'][0].get('name', material.get('name'))
    doc['materials'] = [material]
    used = set(src.get('extensionsUsed', []))
    for key in ('extensionsUsed', 'extensionsRequired'):
        kept = [name for name in doc.get(key, []) if not name.startswith('KHR_materials_')]
        merged = kept + [name for name in src.get(key, []) if name not in kept and (key != 'extensionsUsed' or name in used)]
        if merged:
            doc[key] = merged
        else:
            doc.pop(key, None)
    doc['buffers'] = [{'byteLength': len(packed)}]
    return build_glb(doc, bytes(packed)), {'restored': True, 'fit': round(fit, 3), 'images': len(images)}
