"""Key-mannequin image requests: prompts, garment registration and 3D inputs.

A part is drawn worn on the frozen body rendered in one flat key colour. The
mannequin that stays visible is the registration target: a body-shell garment
is moved back onto the exact canvas and separated from the key colour, and a
worn 3D part keeps the whole figure so the body can be removed in 3D.
"""
import io

import numpy as np
from PIL import Image

from src.services.avatar_part_methods import KEY_COLORS

REVISION = 'worn-parts-v1'
VIEW_TEXT = {
    'front': 'FRONT view: the camera faces the figure.',
    'side': "LEFT view: the camera is at the figure's left side; the figure faces image-left.",
    'back': "BACK view: the camera is behind the figure; the figure's left side is on image-left.",
    'opposite': "RIGHT view: the camera is at the figure's right side; the figure faces image-right.",
}
CONTENT = {
    'hair': ('one complete hairstyle on the bald head: bangs, side locks, crown, back and nape. '
             'Hair covers the whole scalp including the back of the head; no scalp shows through'),
    'hat': 'the head accessory, seated on the head',
    'top': 'the upper garment with its collar, sleeves and hem',
    'bottom': 'the lower garment with its waistband and leg openings',
    'skirt': 'a skirt hanging from the waist as one open tube',
}


def key_hex(key_name):
    r, g, b = KEY_COLORS[key_name]
    return '#{:02X}{:02X}{:02X}'.format(round(r*255), round(g*255), round(b*255))


def reference_roles(view, *, has_appearance, has_front):
    roles = ['MANNEQUIN in this view: exact pose, size, position and camera. Draw the part on it.']
    if has_appearance:
        roles.append('ORIGINAL ART: colours and design of the requested part only.')
    if has_front and view != 'front':
        roles.append('SAME PART, FRONT VIEW, already drawn: keep its design and colours; only the camera moves.')
    return roles


def build_prompt(slot, view, *, key_name, notes='', kind='source', has_appearance=True, has_front=False,
                 hair_length=''):
    """A short request: the mannequin is the layout; the brief is the design."""
    content = CONTENT['skirt' if slot == 'bottom' and kind == 'skirt' else slot]
    roles = '\n'.join(f'Input {i}: {role}' for i, role in enumerate(
        reference_roles(view, has_appearance=has_appearance, has_front=has_front), 1))
    colour = f'{key_name} {key_hex(key_name)}'
    lines = [
        f'{REVISION}: edit input 1, a flat {colour} T-pose mannequin.',
        roles,
        f'Dress the mannequin in {content}.' + (f' {hair_length}' if hair_length else ''),
        'Keep the mannequin pose, size, position and camera exactly. The part is worn on it and hides the '
        'mannequin only where it covers the body.',
        f'Every uncovered area of the mannequin stays pure flat {colour}: no shading, outline, texture, face or skin.',
        VIEW_TEXT[view] + ' Orthographic, no perspective.',
        'Transparent background. No text, cast shadow, floor, extra objects or inset views. One image.',
    ]
    if notes:
        lines.append('Design brief: ' + notes.strip()[:1200])
    return '\n'.join(lines)


def _rgba(content, size=None):
    with Image.open(io.BytesIO(content)) as image:
        image = image.convert('RGBA')
        if size and image.size != size:
            contained = image.copy(); contained.thumbnail(size, Image.Resampling.LANCZOS)
            canvas = Image.new('RGBA', size, (0, 0, 0, 0))
            canvas.alpha_composite(contained, ((size[0]-contained.width)//2, (size[1]-contained.height)//2))
            image = canvas
        return np.asarray(image, dtype=np.float32)/255.


def key_mask(rgba, key_name, *, tolerance=30.):
    """Pixels in the key colour's hue family that are saturated and lit."""
    rgb = rgba[..., :3]
    high, low = rgb.max(axis=-1), rgb.min(axis=-1)
    chroma = high - low
    safe = np.where(chroma > 1e-6, chroma, 1.)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    hue = np.where(high == r, np.mod((g - b)/safe, 6), np.where(high == g, (b - r)/safe + 2, (r - g)/safe + 4))*60.
    from src.services.avatar_part_methods import KEY_HUES
    distance = np.abs((hue - KEY_HUES[key_name] + 180) % 360 - 180)
    saturation = np.where(high > 1e-6, chroma/np.maximum(high, 1e-6), 0.)
    return (rgba[..., 3] > .5) & (chroma > 1e-6) & (distance < tolerance) & (saturation > .35) & (high > .2)


def _shift(mask, dy, dx):
    out = np.zeros_like(mask)
    h, w = mask.shape
    ys, yd = (slice(0, h-dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h+dy))
    xs, xd = (slice(0, w-dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w+dx))
    out[yd, xd] = mask[ys, xs]
    return out


def _box_any(mask, radius, axis):
    """True where any pixel within `radius` along `axis` is True (cumulative sums, O(n))."""
    count = mask.shape[axis]
    cumulative = np.cumsum(mask, axis=axis, dtype=np.int32)
    padded = np.concatenate([np.zeros_like(np.take(cumulative, [0], axis=axis)), cumulative], axis=axis)
    index = np.arange(count)
    upper = np.clip(index + radius + 1, 0, count)
    lower = np.clip(index - radius, 0, count)
    window = np.take(padded, upper, axis=axis) - np.take(padded, lower, axis=axis)
    return window > 0


def dilate(mask, radius):
    if radius <= 0:
        return mask.copy()
    return _box_any(_box_any(mask, radius, 0), radius, 1)


def erode(mask, radius):
    if radius <= 0:
        return mask.copy()
    return ~dilate(~mask, radius)


def _scaled(mask, scale, center):
    """Mask resampled so that points move to center + scale*(p - center)."""
    h, w = mask.shape
    image = Image.fromarray((mask*255).astype(np.uint8))
    inverse = 1/scale
    transformed = image.transform((w, h), Image.Transform.AFFINE,
        (inverse, 0, center[0]*(1-inverse), 0, inverse, center[1]*(1-inverse)),
        resample=Image.Resampling.BILINEAR, fillcolor=0)
    return np.asarray(transformed, dtype=np.float32)/255.


def _edge_reward(edge, radii):
    """Reward that falls off with distance from a silhouette edge (1 on it, 0 beyond the largest radius)."""
    return sum(dilate(edge, radius).astype(np.float32) for radius in radii)/len(radii)


def _best_shift(moving, target, limit):
    """Integer translation maximising correlation, within +-limit pixels."""
    h, w = target.shape
    spectrum = np.fft.rfft2(target)*np.conj(np.fft.rfft2(moving))
    correlation = np.fft.irfft2(spectrum, s=(h, w))
    best, where = -np.inf, (0, 0)
    for dy in range(-limit, limit+1):
        row = correlation[dy % h]
        for dx in range(-limit, limit+1):
            value = row[dx % w]
            if value > best:
                best, where = value, (dy, dx)
    return where, float(best)


def register_garment(generated, key_render, key_name, *, search_scale=.15, search_px=128, keep_mannequin=False):
    """Move a dressed-mannequin image back onto the body canvas; keep only the part.

    Returns (RGBA PNG bytes of the part on the exact canvas, report). keep_mannequin
    returns the whole aligned figure instead, so every view of a worn request has
    the frozen body's size and position.
    """
    body_rgba = _rgba(key_render)
    h, w = body_rgba.shape[:2]
    image = _rgba(generated, (w, h))
    body = body_rgba[..., 3] > .5
    keyed = key_mask(image, key_name)
    # Only the mannequin's outer outline is evidence of its size and place; where the
    # part covers it, the key region ends at an occlusion, not at the body outline.
    outline = keyed & dilate(image[..., 3] < .5, 2)
    body_edge = body & ~erode(body, 1)
    report = {'method': 'key_mannequin_registration_v2', 'revision': REVISION, 'key': key_name,
              'key_pixels': int(keyed.sum()), 'body_pixels': int(body.sum()), 'outline_pixels': int(outline.sum())}
    if keyed.sum() < .02*body.sum() or outline.sum() < 400:
        # The mannequin colour did not survive: keep the canvas as returned.
        report['registration'] = 'key_colour_missing'
        scale, dy, dx = 1., 0, 0
    else:
        factor = 4
        small = (w//factor, h//factor)

        def reduced(mask):
            return np.asarray(Image.fromarray((mask*255).astype(np.uint8)).resize(small, Image.Resampling.BOX)) > 0
        outline_small = reduced(outline).astype(np.float32)
        target = _edge_reward(reduced(body_edge), (1, 2, 4, 8))
        center = (small[0]/2, small[1]/2)
        best = (-np.inf, 1., 0, 0)
        # GPT redraws views up to ~15% larger or smaller and ~8 cm off; 1% steps. The
        # score is per outline pixel, so a larger figure is not favoured for its area.
        for scale in np.linspace(1-search_scale, 1+search_scale, int(round(2*search_scale/.01))+1):
            moved = _scaled(outline_small, scale, center)
            (sy, sx), value = _best_shift(moved, target, search_px//factor)
            value /= max(float(moved.sum()), 1.)
            if value > best[0]:
                best = (value, float(scale), sy, sx)
        _, scale, sy, sx = best
        # Refine the translation at full resolution around the coarse answer.
        ys, xs = np.nonzero(_scaled(outline.astype(np.float32), scale, (w/2, h/2)) > .5)
        reward = _edge_reward(body_edge, (1, 2, 4))
        coarse = (sy*factor, sx*factor)
        window = factor + 2
        best_value, dy, dx = -np.inf, coarse[0], coarse[1]
        for ry in range(coarse[0]-window, coarse[0]+window+1):
            for rx in range(coarse[1]-window, coarse[1]+window+1):
                y, x = ys + ry, xs + rx
                inside = (y >= 0) & (y < h) & (x >= 0) & (x < w)
                value = float(reward[y[inside], x[inside]].sum())/max(len(ys), 1)
                if value > best_value:
                    best_value, dy, dx = value, ry, rx
        report.update(registration='fitted', outline_score=round(best_value, 4))
    inverse = 1/scale
    cx, cy = w/2, h/2
    # Output pixel p comes from input (p - t - c)/s + c.
    source = Image.fromarray((image*255).astype(np.uint8), 'RGBA')
    warped = source.transform((w, h), Image.Transform.AFFINE,
        (inverse, 0, cx - (cx + dx)*inverse, 0, inverse, cy - (cy + dy)*inverse),
        resample=Image.Resampling.BICUBIC, fillcolor=(0, 0, 0, 0))
    warped_rgba = np.asarray(warped, dtype=np.float32)/255.
    warped_key = key_mask(warped_rgba, key_name)
    report.update(scale=round(scale, 4), translation_px=[int(dx), int(dy)])
    if keep_mannequin:
        buffer = io.BytesIO()
        warped.save(buffer, format='PNG', compress_level=2)
        return buffer.getvalue(), report
    figure = warped_rgba[..., 3] > .5
    garment = figure & ~dilate(warped_key, 1)
    garment = dilate(erode(garment, 2), 2)          # drop thin outlines and speckle
    garment &= dilate(body, 160)                    # nothing floating far from the body
    alpha = np.where(garment, warped_rgba[..., 3], 0.)
    out = warped_rgba.copy(); out[..., 3] = alpha
    buffer = io.BytesIO()
    Image.fromarray((out*255).astype(np.uint8), 'RGBA').save(buffer, format='PNG', compress_level=2)
    inside = (warped_key & body).sum()/max(warped_key.sum(), 1)
    visible = (warped_key & body).sum()/max(body.sum(), 1)
    report.update(key_inside_body=round(float(inside), 4), body_left_uncovered=round(float(visible), 4),
                  garment_pixels=int(garment.sum()))
    return buffer.getvalue(), report


def ensure_alpha(content):
    """Keep provider alpha; remove a flat border background only when there is none."""
    with Image.open(io.BytesIO(content)) as image:
        rgba = image.convert('RGBA')
        low, _ = rgba.getchannel('A').getextrema()
    if low < 250:
        return content, {'background': 'provider_alpha'}
    from src.services.avatar_reference_preparation import _remove_edge_white
    cleaned, report = _remove_edge_white(content)
    return cleaned, {'background': 'border_removed', **report}


def shared_crop(images, *, margin=.08, size=1024):
    """Crop every view with one square box so the figure fills the provider input.

    images: {view: PNG bytes on the shared canvas}. Relative scale between views
    is preserved because all views use the same box. Returns ({view: bytes}, box).
    """
    arrays = {view: _rgba(content) for view, content in images.items()}
    boxes = []
    for rgba in arrays.values():
        ys, xs = np.nonzero(rgba[..., 3] > .06)
        if len(xs):
            boxes.append((xs.min(), ys.min(), xs.max()+1, ys.max()+1))
    if not boxes:
        raise ValueError('Views have no visible content')
    left = min(b[0] for b in boxes); top = min(b[1] for b in boxes)
    right = max(b[2] for b in boxes); bottom = max(b[3] for b in boxes)
    side = max(right-left, bottom-top)*(1+2*margin)
    cx, cy = (left+right)/2, (top+bottom)/2
    box = (int(round(cx-side/2)), int(round(cy-side/2)), int(round(cx+side/2)), int(round(cy+side/2)))
    result = {}
    for view, rgba in arrays.items():
        image = Image.fromarray((rgba*255).astype(np.uint8), 'RGBA')
        cropped = Image.new('RGBA', (box[2]-box[0], box[3]-box[1]), (0, 0, 0, 0))
        cropped.alpha_composite(image, (-box[0], -box[1]))
        cropped = cropped.resize((size, size), Image.Resampling.LANCZOS)
        buffer = io.BytesIO(); cropped.save(buffer, format='PNG', compress_level=2)
        result[view] = buffer.getvalue()
    return result, {'box_px': list(box), 'size': size, 'margin': margin}

def key_mannequin(body_render, key_name):
    """Key-coloured mannequin from a lit body render: same alpha, gently shaded key hue.

    The shading keeps arms and legs readable where they overlap in profile, and
    stays inside the key mask (hue and saturation are unchanged).
    """
    rgba = _rgba(body_render)
    luminance = rgba[..., :3] @ np.array([.2126, .7152, .0722], dtype=np.float32)
    inside = rgba[..., 3] > .02
    if inside.any():
        low, high = np.percentile(luminance[inside], [2, 98])
        shade = np.clip((luminance - low)/max(high - low, 1e-6), 0, 1)
    else:
        shade = np.ones_like(luminance)
    factor = .62 + .38*shade
    key = np.array(KEY_COLORS[key_name], dtype=np.float32)
    out = np.zeros_like(rgba)
    out[..., :3] = key[None, None, :]*factor[..., None]
    out[..., 3] = np.where(rgba[..., 3] >= .5, 1., 0.)
    buffer = io.BytesIO()
    Image.fromarray((out*255).round().astype(np.uint8), 'RGBA').save(buffer, format='PNG', compress_level=2)
    return buffer.getvalue()
