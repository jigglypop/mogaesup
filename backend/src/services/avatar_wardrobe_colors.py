"""Colour regions of a part texture, so the viewer can recolour clothing per region.

Only texels the mesh actually uses are clustered. Clustering works on Lab colour with
lightness weighted down, so shading of one fabric stays one region while white and
black fabrics still separate. The mask stores region i in channel i (up to four). The
fourth region is stored inverted in alpha so the PNG stays opaque: decoders that
premultiply alpha would otherwise erase the other regions wherever alpha is zero.
"""
import io

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from src.services.avatar_wardrobe_coverage import _accessor
from src.services.glb import parse_glb

MAX_REGIONS = 4
MASK_EDGE = 1024
LIGHTNESS_WEIGHT = .35
MERGE_DISTANCE = 14.     # Lab units (lightness weighted) below which two regions are one colour
MIN_SHARE = .03


def _linear(srgb):
    return np.where(srgb <= .04045, srgb/12.92, ((srgb + .055)/1.055)**2.4)


def _lab(srgb):
    linear = _linear(srgb)
    xyz = linear @ np.array([[.4124, .3576, .1805], [.2126, .7152, .0722], [.0193, .1192, .9505]]).T
    xyz /= np.array([.95047, 1., 1.08883])
    f = np.where(xyz > .008856, np.cbrt(xyz), 7.787*xyz + 16/116)
    return np.stack([116*f[:, 1] - 16, 500*(f[:, 0] - f[:, 1]), 200*(f[:, 1] - f[:, 2])], axis=1)


def _kmeans(points, count, seed=7, iterations=25):
    rng = np.random.default_rng(seed)
    centers = [points[rng.integers(len(points))]]
    for _ in range(1, count):
        distance = np.min(((points[:, None, :] - np.array(centers)[None])**2).sum(axis=2), axis=1)
        centers.append(points[rng.choice(len(points), p=distance/distance.sum())] if distance.sum() > 0 else points[0])
    centers = np.array(centers)
    for _ in range(iterations):
        labels = np.argmin(((points[:, None, :] - centers[None])**2).sum(axis=2), axis=1)
        moved = np.array([points[labels == i].mean(axis=0) if (labels == i).any() else centers[i] for i in range(count)])
        if np.allclose(moved, centers, atol=.05):
            break
        centers = moved
    return centers


def _texture(doc, binary):
    """(material index, texCoord set, RGB image) of the first material with a base colour texture."""
    for index, material in enumerate(doc.get('materials', [])):
        reference = (material.get('pbrMetallicRoughness') or {}).get('baseColorTexture')
        if not reference:
            continue
        image = doc['images'][doc['textures'][reference['index']]['source']]
        if 'bufferView' not in image:
            continue
        view = doc['bufferViews'][image['bufferView']]
        start = view.get('byteOffset', 0)
        with Image.open(io.BytesIO(binary[start:start + view['byteLength']])) as picture:
            return index, reference.get('texCoord', 0), picture.convert('RGB')
    return None


def color_regions(part_content):
    """(mask PNG bytes, [{index, color, share, light}], glTF material index) or None when the part has no texture.
    The mask follows that material's UV layout only."""
    doc, binary = parse_glb(part_content)
    found = _texture(doc, binary)
    if not found:
        return None
    material, channel, picture = found
    width, height = picture.size
    used = Image.new('L', (width, height), 0)
    draw = ImageDraw.Draw(used)
    for mesh in doc.get('meshes', []):
        for primitive in mesh.get('primitives', []):
            attribute = primitive.get('attributes', {}).get(f'TEXCOORD_{channel}')
            if primitive.get('material') != material or attribute is None:
                continue
            uv = _accessor(doc, binary, attribute)*np.array([width, height])
            triangles = (_accessor(doc, binary, primitive['indices']).astype(np.int64).reshape(-1, 3)
                         if 'indices' in primitive else np.arange(len(uv)).reshape(-1, 3))
            for triangle in uv[triangles]:
                draw.polygon([tuple(point) for point in triangle], fill=255)
    used = np.asarray(used) > 0
    pixels = np.asarray(picture, dtype=np.float64)/255.
    if used.sum() < 100:
        used = np.ones(used.shape, bool)
    colors = pixels[used]
    features = _lab(colors)*np.array([LIGHTNESS_WEIGHT, 1, 1])
    sample = features[np.random.default_rng(0).choice(len(features), min(len(features), 30000), replace=False)]
    centers = _kmeans(sample, min(MAX_REGIONS, max(1, len(sample)//50)))
    # Merge near-identical colours, then fold tiny regions into their nearest neighbour.
    merged = []
    for center in centers[np.argsort(-np.bincount(np.argmin(((sample[:, None] - centers[None])**2).sum(axis=2), axis=1), minlength=len(centers)))]:
        if all(np.linalg.norm(center - other) >= MERGE_DISTANCE for other in merged):
            merged.append(center)
    centers = np.array(merged)
    labels = np.argmin(((features[:, None] - centers[None])**2).sum(axis=2), axis=1)
    shares = np.bincount(labels, minlength=len(centers))/len(labels)
    keep = np.flatnonzero(shares >= MIN_SHARE)
    centers = centers[keep] if len(keep) else centers[:1]
    labels = np.argmin(((features[:, None] - centers[None])**2).sum(axis=2), axis=1)
    order = np.argsort(-np.bincount(labels, minlength=len(centers)))
    remap = np.empty_like(order); remap[order] = np.arange(len(order))
    labels = remap[labels]
    regions = []
    for index in range(len(order)):
        members = colors[labels == index]
        mean = members.mean(axis=0)
        light = float((_linear(members) @ np.array([.2126, .7152, .0722])).mean())
        regions.append({'index': index, 'color': '#' + ''.join(f'{int(round(v*255)):02x}' for v in mean),
                        'share': round(float((labels == index).mean()), 4), 'light': round(light, 5)})
    region_map = np.full(used.shape, -1, np.int64); region_map[used] = labels
    if max(width, height) > MASK_EDGE:
        size = ((MASK_EDGE, round(MASK_EDGE*height/width)) if width >= height
                else (round(MASK_EDGE*width/height), MASK_EDGE))
        region_map = np.asarray(Image.fromarray((region_map + 1).astype(np.uint8), 'L')
                                .resize(size, Image.Resampling.NEAREST)).astype(np.int64) - 1
    mask = np.zeros(region_map.shape + (4,), np.uint8)
    for index in range(len(order)):
        mask[..., index] = np.where(region_map == index, 255, 0)
    # Spread regions into unused texels so filtering at UV seams keeps full weight.
    channels = [channel.filter(ImageFilter.MaxFilter(5)) for channel in Image.fromarray(mask, 'RGBA').split()]
    channels[3] = channels[3].point(lambda value: 255 - value)
    image = Image.merge('RGBA', channels)
    buffer = io.BytesIO()
    image.save(buffer, format='PNG', optimize=True)
    return buffer.getvalue(), regions, material
