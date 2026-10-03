"""Colour regions of a large part texture are found at the mask's size, in single precision."""
import io

import numpy as np
from PIL import Image

from src.services import avatar_wardrobe_colors
from wardrobe_fixture import textured_glb

STRIPES = ((200, 30, 30), (30, 30, 200), (240, 240, 240))


def test_a_large_texture_is_clustered_at_the_mask_size_in_single_precision(monkeypatch):
    content = textured_glb(STRIPES, size=2048)
    clustered, real = [], avatar_wardrobe_colors._lab
    monkeypatch.setattr(avatar_wardrobe_colors, '_lab', lambda srgb: (clustered.append((len(srgb), srgb.dtype)), real(srgb))[1])
    png, regions, material = avatar_wardrobe_colors.color_regions(content)
    # Every texel of a 2048 px texture is 4.2 million; the texture was reduced to 1024 px before any float array.
    assert clustered and all(count <= 1024*1024 and dtype == np.float32 for count, dtype in clustered)
    with Image.open(io.BytesIO(png)) as mask:
        assert mask.size == (1024, 1024)
    assert material == 0 and len(regions) == 3
    found = sorted(tuple(int(region['color'][i:i+2], 16) for i in (1, 3, 5)) for region in regions)
    assert all(max(abs(a-b) for a, b in zip(colour, expected)) <= 3 for colour, expected in zip(found, sorted(STRIPES)))
    assert abs(sum(region['share'] for region in regions) - 1) < 1e-3


def test_a_small_texture_keeps_its_size():
    png, regions, _ = avatar_wardrobe_colors.color_regions(textured_glb(STRIPES, size=96))
    with Image.open(io.BytesIO(png)) as mask:
        assert mask.size == (96, 96)
    assert len(regions) == 3
