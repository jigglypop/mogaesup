"""Mannequin key colour: the choice avoids every garment colour the removal would erase, pastel ones too.

The removal (`avatar_worn_part`, `avatar_shell_garment`) runs inside Blender and imports its modules at
load time; the tests that compare the choice with it install stand-ins for them, import the modules
fresh and take them out of `sys.modules` again.
"""
from __future__ import annotations

import colorsys
import importlib
import io
import sys
import types

import numpy as np
from PIL import Image
import pytest

from src.services import avatar_part_methods as methods
from src.services.avatar_part_methods import KEY_COLORS, KEY_HUES, choose_key_color

IMPORTED = ('src.services.avatar_worn_part', 'src.services.avatar_shell_garment')


@pytest.fixture
def removal(monkeypatch):
    """(avatar_worn_part, avatar_shell_garment) with Blender's modules stubbed."""
    stubs = {name: types.ModuleType(name) for name in ('bpy', 'bmesh', 'mathutils', 'mathutils.bvhtree', 'mathutils.kdtree')}
    stubs['mathutils'].Vector = type('Vector', (), {})
    stubs['mathutils.bvhtree'].BVHTree = type('BVHTree', (), {})
    stubs['mathutils.kdtree'].KDTree = type('KDTree', (), {})
    for name, module in stubs.items():
        monkeypatch.setitem(sys.modules, name, module)
    services = importlib.import_module('src.services')
    for name in IMPORTED:   # put back (or removed) when the test ends, with the package attribute
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
        monkeypatch.setattr(services, name.rsplit('.', 1)[1], None, raising=False)
        del sys.modules[name]
    return tuple(importlib.import_module(name) for name in IMPORTED)


def hsv(hue, saturation=1., value=1.):
    return colorsys.hsv_to_rgb(hue/360., saturation, value)


def art(*patches, size=128):
    """PNG bytes: transparent, with each (rgb, (x0, y0, x1, y1)) patch opaque."""
    canvas = np.zeros((size, size, 4), dtype=np.uint8)
    for rgb, (x0, y0, x1, y1) in patches:
        canvas[y0:y1, x0:x1] = (*[round(channel*255) for channel in rgb], 255)
    buffer = io.BytesIO()
    Image.fromarray(canvas).save(buffer, format='PNG')
    return buffer.getvalue()


def garment(rgb):
    return art((rgb, (30, 20, 100, 110)))


def legacy_choice(content):
    """The choice before the removal's own limits were used: saturated art pixels only, 35 degrees."""
    with Image.open(io.BytesIO(content)) as image:
        rgba = np.asarray(image.convert('RGBA').resize((128, 128)), dtype=np.float32)/255.
    rgb, alpha = rgba[..., :3].reshape(-1, 3), rgba[..., 3].reshape(-1)
    high, low = rgb.max(axis=1), rgb.min(axis=1)
    chroma = high - low
    saturated = (alpha > .5) & (chroma > .25) & (high > .25)
    if saturated.sum() < 20:
        return 'magenta'
    r, g, b = rgb[saturated].T
    c = chroma[saturated]; h = high[saturated]
    hue = np.where(h == r, np.mod((g - b)/c, 6), np.where(h == g, (b - r)/c + 2, (r - g)/c + 4))*60.
    scores = {name: float((np.abs((hue - key_hue + 180) % 360 - 180) < 35).mean()) for name, key_hue in KEY_HUES.items()}
    return min(scores, key=lambda name: (scores[name], name != 'magenta'))


@pytest.mark.parametrize('rgb', [hsv(262, .26, .95), hsv(330, .2, 1.), hsv(300, .17, 1.), hsv(285, .22, .9)],
                         ids=['lavender', 'pale pink', 'blush magenta', 'wisteria'])
def test_a_pastel_garment_in_the_magenta_family_does_not_get_a_magenta_mannequin(rgb):
    content = garment(rgb)
    assert legacy_choice(content) == 'magenta'     # the defect: pale colours were never counted
    assert choose_key_color(content) == 'green'


@pytest.mark.parametrize('rgb, expected', [(hsv(135, .25, .95), 'magenta'), (hsv(215, .2, 1.), 'magenta'),
                                           (hsv(20, .2, 1.), 'magenta')],
                         ids=['mint', 'powder blue', 'cream'])
def test_other_pastel_garments_keep_the_default_key_they_do_not_touch(rgb, expected):
    assert choose_key_color(garment(rgb)) == expected


def test_a_pastel_garment_is_avoided_with_the_art_around_it():
    content = art((hsv(20, .35, .9), (50, 5, 80, 30)),       # skin
                  (hsv(30, .8, .3), (45, 5, 85, 14)),        # brown hair
                  (hsv(268, .22, .96), (35, 30, 95, 90)),    # lavender top
                  (hsv(220, .9, .35), (40, 90, 90, 120)))    # navy trousers
    assert choose_key_color(content) == 'green'


@pytest.mark.parametrize('hue', [20, 45, 120, 180, 219, 270, 300, 330])
def test_a_vivid_garment_keeps_the_key_it_always_had(hue):
    content = garment(hsv(hue))
    assert choose_key_color(content) == legacy_choice(content)


@pytest.mark.parametrize('hue, expected', [(20, 'magenta'), (120, 'magenta'), (219, 'magenta'),
                                           (270, 'green'), (300, 'green'), (330, 'green')])
def test_the_vivid_choices(hue, expected):
    assert choose_key_color(garment(hsv(hue))) == expected


def test_a_colour_within_the_removal_window_but_beyond_the_old_one_is_avoided():
    # Crimson is 48 degrees from magenta: out of the old 35 degree window, inside the removal's 60.
    content = garment(hsv(348))
    assert legacy_choice(content) == 'magenta'
    assert choose_key_color(content) == 'green'


def test_art_without_colour_or_a_few_specks_keeps_magenta():
    assert choose_key_color(garment((.6, .6, .6))) == 'magenta'
    assert choose_key_color(art(((1., 0., 1.), (0, 0, 3, 3)))) == 'magenta'
    assert choose_key_color(b'not an image') == 'magenta'


def test_a_speck_of_a_key_colour_does_not_move_the_key_but_a_patch_does():
    body = ((hsv(20, .9, 1.), (30, 20, 100, 110)),)
    assert choose_key_color(art(*body, (hsv(330, .9, 1.), (60, 30, 63, 33)))) == 'magenta'      # a lip
    assert choose_key_color(art(*body, (hsv(330, .9, 1.), (60, 30, 80, 50)))) == 'green'        # a ribbon


@pytest.mark.parametrize('text, expected', [
    ('a lavender cardigan', 'green'), ('lilac pleated skirt', 'green'), ('Plum velvet coat', 'green'),
    ('orchid dress', 'green'), ('mauve scarf', 'green'), ('라벤더 원피스', 'green'), ('연보라 니트', 'green'),
    ('퍼플 후드', 'green'), ('라일락색 치마', 'green'),
    ('pink hoodie', 'green'), ('분홍 치마', 'green'), ('보라색 바지', 'green'), ('violet cape', 'green'),
    ('navy blazer', 'magenta'), ('a plumber in overalls', 'magenta'), ('', 'magenta'), (None, 'magenta')])
def test_a_brief_that_names_a_magenta_family_colour_moves_the_key_to_green(text, expected):
    assert choose_key_color(None, text) == expected


def test_the_choice_uses_the_limits_the_removal_matches_with(removal):
    worn, shell = removal
    assert methods.REMOVAL_HUE_DEG == worn.ANCHOR_HUE_DEG
    assert methods.REMOVAL_SATURATION == worn.FAINT_SATURATION
    assert methods.REMOVAL_VALUE == worn.KEY_VALUE
    # The mannequin-sized windows that remove pixels are inside the one the choice avoids.
    assert worn.FRINGE_HUE_DEG <= methods.REMOVAL_HUE_DEG
    assert shell.key_pixels.__kwdefaults__['hue_deg'] <= methods.REMOVAL_HUE_DEG


def test_every_colour_the_removal_matches_is_a_colour_the_choice_avoids(removal):
    worn, shell = removal
    rng = np.random.default_rng(3)
    rgb = np.concatenate([rng.random((6000, 3)), hsv_samples(rng, 3000)])
    high, low = rgb.max(axis=1), rgb.min(axis=1)
    saturation = np.divide(high - low, high, out=np.zeros_like(high), where=high > 1e-6)
    hue = worn._hue(rgb)
    for name, key in KEY_COLORS.items():
        avoided = ((np.abs((hue - KEY_HUES[name] + 180) % 360 - 180) < methods.REMOVAL_HUE_DEG)
                   & (saturation > methods.REMOVAL_SATURATION) & (high > methods.REMOVAL_VALUE))
        # observed_key collects exactly these (faint, 60 degrees); the later steps match inside them.
        assert np.array_equal(worn.key_likelihood(rgb, key, faint=True, hue_deg=worn.ANCHOR_HUE_DEG) > .5, avoided)
        for faint, hue_deg in ((False, 28.), (True, 28.), (True, worn.FRINGE_HUE_DEG)):
            assert not ((worn.key_likelihood(rgb, key, faint=faint, hue_deg=hue_deg) > .5) & ~avoided).any()
        rgba = np.concatenate([rgb, np.ones((len(rgb), 1))], axis=1)
        assert not (shell.key_pixels(rgba, key, fringe=0) & ~avoided).any()


def hsv_samples(rng, count):
    """Pale and dim colours, where a saturation or value limit decides."""
    return np.array([colorsys.hsv_to_rgb(h, s, v) for h, s, v in
                     zip(rng.random(count), rng.uniform(.05, .4, count), rng.uniform(.1, 1., count))])
