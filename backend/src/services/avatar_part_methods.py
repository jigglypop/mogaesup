"""How each part slot is produced, frozen per accepted request.

isolated    one provider model of the part alone, fitted to the body (legacy path)
body_shell  garment made from the frozen body surface and the canvas views; no provider model
worn        one provider model of the part worn on the key-coloured mannequin; the body is removed
"""
import io
import re

import numpy as np
from PIL import Image

from src.services.character_pipeline import PipelineError

METHODS = ('isolated', 'body_shell', 'worn')
ALLOWED = {
    'top': ('body_shell', 'worn', 'isolated'),
    'bottom': ('body_shell', 'worn', 'isolated'),
    'hair': ('worn', 'isolated'),
    'hat': ('isolated', 'worn'),
}
# Loose, long or hooded garments (common in SD outfits) exceed a body shell; it stays a
# per-request choice for fitted garments on a clean base body.
DEFAULTS = {'top': 'worn', 'bottom': 'worn', 'hair': 'worn'}
KEY_COLORS = {'magenta': (1., 0., 1.), 'green': (0., 1., 0.), 'blue': (0., .35, 1.)}
KEY_HUES = {'magenta': 300., 'green': 120., 'blue': 219.}
# What the removal of the mannequin (avatar_worn_part, run inside Blender, which cannot import this module)
# may erase from a garment: colours this close to the key's hue, at least this saturated and this bright.
# tests/services/test_key_color_choice.py keeps them equal to the removal's own limits.
REMOVAL_HUE_DEG = 60.
REMOVAL_SATURATION = .15
REMOVAL_VALUE = .2
# Share of the art's pixels below which a colour near a key is a speck (a lip, a blush), not a garment.
NEGLIGIBLE_SHARE = .01
PINK_FAMILY = re.compile(
    r'pink|magenta|purple|violet|fuchsia|lavender|lilac|mauve|orchid|\bplums?\b'
    r'|핑크|분홍|보라|자주|자홍|마젠타|라벤더|라일락|퍼플')


def needs_provider(method):
    return method != 'body_shell'


def needs_key_render(method):
    return method in ('body_shell', 'worn')


def resolve(slots, requested=None, *, uploaded_views=False, uploaded_model=False, worn_redraw=False):
    """Method per slot. Uploaded isolated drawings and models keep the isolated path."""
    requested = requested or {}
    if not isinstance(requested, dict) or any(method not in METHODS for method in requested.values()):
        raise PipelineError('invalid_part_method', '파츠 생성 방식을 다시 선택하세요.', 422)
    unknown = set(requested) - set(slots)
    if unknown:
        raise PipelineError('invalid_part_method', '선택한 파츠의 생성 방식만 지정하세요.', 422)
    result = {}
    for slot in slots:
        if uploaded_model or (uploaded_views and not worn_redraw):
            method = 'isolated'
        elif uploaded_views and worn_redraw:
            method = 'worn'
        else:
            method = requested.get(slot) or DEFAULTS.get(slot, 'isolated')
        if method != 'isolated' and method not in ALLOWED.get(slot, ('isolated',)):
            raise PipelineError('invalid_part_method', f'{slot}에는 이 생성 방식을 사용할 수 없습니다.', 422)
        result[slot] = method
    return result


def choose_key_color(content=None, text=''):
    """Key colour whose hue is farthest from the colours of the art that the mannequin removal could erase.

    Those are the colours the removal itself matches (REMOVAL_*): pale ones too, not only saturated ones.
    A key the art barely touches (NEGLIGIBLE_SHARE) counts as untouched, and magenta wins ties.
    Without art, a design brief that asks for pink, purple or lavender moves the key to green.
    """
    if content is None:
        if PINK_FAMILY.search((text or '').lower()):
            return 'green'
        return 'magenta'
    try:
        with Image.open(io.BytesIO(content)) as image:
            rgba = np.asarray(image.convert('RGBA').resize((128, 128)), dtype=np.float32)/255.
    except (OSError, ValueError):
        return 'magenta'
    rgb, alpha = rgba[..., :3].reshape(-1, 3), rgba[..., 3].reshape(-1)
    high, low = rgb.max(axis=1), rgb.min(axis=1)
    chroma = high - low
    saturation = np.divide(chroma, high, out=np.zeros_like(high), where=high > 1e-6)
    opaque = alpha > .5
    erasable = opaque & (saturation > REMOVAL_SATURATION) & (high > REMOVAL_VALUE)
    if erasable.sum() < 20:
        return 'magenta'
    r, g, b = rgb[erasable].T
    c = chroma[erasable]; h = high[erasable]
    hue = np.where(h == r, np.mod((g - b)/c, 6), np.where(h == g, (b - r)/c + 2, (r - g)/c + 4))*60.
    speck = NEGLIGIBLE_SHARE*int(opaque.sum())
    scores = {}
    for name, key_hue in KEY_HUES.items():
        distance = np.abs((hue - key_hue + 180) % 360 - 180)
        # Art pixels that a key-colour mask could swallow.
        swallowed = int((distance < REMOVAL_HUE_DEG).sum())
        scores[name] = swallowed if swallowed >= speck else 0
    return min(scores, key=lambda name: (scores[name], name != 'magenta'))
