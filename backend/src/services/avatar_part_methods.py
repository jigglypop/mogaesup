"""How each part slot is produced, frozen per accepted request.

isolated    one provider model of the part alone, fitted to the body (legacy path)
body_shell  garment made from the frozen body surface and the canvas views; no provider model
worn        one provider model of the part worn on the key-coloured mannequin; the body is removed
"""
import io

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
    """Key colour whose hue is farthest from the saturated colours of the art.

    Without art, a design brief that asks for pink or purple moves the key to green.
    """
    if content is None:
        import re
        lowered = (text or '').lower()
        if re.search(r'pink|magenta|purple|violet|fuchsia|핑크|분홍|보라|자주|자홍|마젠타', lowered):
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
    saturated = (alpha > .5) & (chroma > .25) & (high > .25)
    if saturated.sum() < 20:
        return 'magenta'
    r, g, b = rgb[saturated].T
    c = chroma[saturated]; h = high[saturated]
    hue = np.where(h == r, np.mod((g - b)/c, 6), np.where(h == g, (b - r)/c + 2, (r - g)/c + 4))*60.
    scores = {}
    for name, key_hue in KEY_HUES.items():
        distance = np.abs((hue - key_hue + 180) % 360 - 180)
        # Fraction of saturated art pixels that a key-colour mask could swallow.
        scores[name] = float((distance < 35).mean())
    return min(scores, key=lambda name: (scores[name], name != 'magenta'))
