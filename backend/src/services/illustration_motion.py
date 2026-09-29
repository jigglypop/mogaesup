"""Looping 2D motions for a rigged illustration, rendered to GIF, APNG and animated WebP.

A template gives each bone a rotation, scale and offset at phase t in [0, 1). Bones move the mesh by
linear blend skinning; triangles are drawn back to front by layer (legs, body, head, arms) at twice the
output size and averaged down for smooth edges. Everything is deterministic for the same inputs.
"""
import io
import math

import numpy as np
from PIL import Image

from src.services.character_pipeline import PipelineError
from src.services.illustration_rig import BONES, BONE_NAMES, skin

MOTION_REVISION = 'illustration-motion-v2'
TEMPLATES = {'idle': 2.0, 'wave': 1.2, 'jump': 1.0, 'nod': 1.0, 'shake': .8, 'sway': 1.6}
FORMATS = {'gif': 'gif', 'webp': 'webp', 'apng': 'png'}
_SUPERSAMPLE = 2
_TILE = 12


def _wave(t, cycles=1, phase=0.0):
    return math.sin(2 * math.pi * (cycles * t + phase))


def _keys(t, points):
    """Cosine-eased value between (time, value) keys covering [0, 1]."""
    for (t0, v0), (t1, v1) in zip(points, points[1:]):
        if t0 <= t <= t1:
            u = 0 if t1 == t0 else (t - t0) / (t1 - t0)
            return v0 + (v1 - v0) * (1 - math.cos(math.pi * u)) / 2
    return points[-1][1]


def _angle(vector):
    return math.degrees(math.atan2(vector[1], vector[0]))


def _turn(target, rest):
    """Smallest rotation in degrees (clockwise on screen) from the rest direction to the target."""
    return (target - rest + 180) % 360 - 180


def pose(template, t, strength, joints, height):
    """{bone: (degrees, scale x, scale y, dx, dy)} for one frame. `_r` bones are on the image's left."""
    k = strength
    p = {name: [0.0, 1.0, 1.0, 0.0, 0.0] for name in ('root',) + BONE_NAMES}
    direction = {name: _angle(np.subtract(joints[tail], joints[pivot])) for name, _, pivot, tail, _ in BONES}
    outward = {'r': 1, 'l': -1}   # clockwise on screen swings the image-left arm away from the body
    if template == 'idle':
        breath = _wave(t)
        p['root'][1:3] = [1 - .012 * k * breath, 1 + .025 * k * breath]
        p['head'][0] = 2.5 * k * _wave(t, phase=.1)
        for side, sign in outward.items():
            p[f'arm_upper_{side}'][0] = sign * 3 * k * breath
    elif template == 'wave':
        # The character's right arm goes up and out; the forearm waves from the elbow.
        up = _turn(-90 - 65, direction['arm_upper_r'])
        p['arm_upper_r'][0] = up * min(1, .75 + .25 * k)
        forearm = _turn(-90 - 15, direction['arm_lower_r'] + p['arm_upper_r'][0])
        p['arm_lower_r'][0] = forearm + 25 * k * _wave(t, 2)
        p['body'][0] = -2 * k * _wave(t)
        p['head'][0] = 4 * k * _wave(t, phase=.25)
        p['root'][4] = -.01 * height * k * abs(_wave(t))
    elif template == 'jump':
        crouch = _keys(t, [(0, 0), (.18, 1), (.3, -.4), (.55, 0), (.78, 0), (.88, .8), (1, 0)])
        lift = _keys(t, [(0, 0), (.28, 0), (.53, 1), (.78, 0), (1, 0)])
        p['root'][1:3] = [1 + .06 * k * crouch, 1 - .12 * k * crouch]
        p['root'][4] = -.18 * height * k * lift
        for side, sign in outward.items():
            p[f'arm_upper_{side}'][0] = sign * (10 + 40 * lift) * k
            p[f'leg_lower_{side}'][0] = -sign * 8 * k * lift
    elif template == 'nod':
        dip = _keys(t, [(0, 0), (.25, 1), (.5, 0), (.75, 1), (1, 0)])
        p['head'][2] = 1 - .03 * k * dip
        p['head'][4] = .025 * height * k * dip
        p['body'][2] = 1 - .015 * k * dip
    elif template == 'shake':
        turn = _wave(t, 2)
        p['head'][0] = 9 * k * turn
        p['head'][3] = .012 * height * k * turn
        p['body'][0] = -1.5 * k * turn
    elif template == 'sway':
        swing = _wave(t)
        p['body'][0] = 7 * k * swing
        p['head'][0] = -3 * k * swing
        p['root'][3] = .012 * height * k * swing
        for side, sign in outward.items():
            p[f'arm_upper_{side}'][0] = sign * 6 * k * _wave(t, phase=.2)
    else:
        raise PipelineError('invalid_template', '모션 종류를 다시 선택하세요.', 422)
    return {name: tuple(value) for name, value in p.items()}


def _affine(pivot, degrees, sx, sy, dx, dy):
    """3x3 matrix: scale and rotate about the pivot, then move by (dx, dy)."""
    c, s = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    px, py = pivot
    rotate = np.array([[c * sx, -s * sy, 0], [s * sx, c * sy, 0], [0, 0, 1]])
    to, back = np.array([[1, 0, px], [0, 1, py], [0, 0, 1]]), np.array([[1, 0, -px], [0, 1, -py], [0, 0, 1]])
    return np.array([[1, 0, dx], [0, 1, dy], [0, 0, 1]]) @ to @ rotate @ back


def bone_matrices(frame_pose, joints, ground):
    world = {'root': _affine(ground, *frame_pose['root'])}
    for name, parent, pivot, _, _ in BONES:
        world[name] = world[parent] @ _affine(joints[pivot], *frame_pose[name])
    return np.stack([world[name] for name in BONE_NAMES])


def _bilinear(image, x, y):
    height, width = image.shape[:2]
    x = np.clip(x - .5, 0, width - 1.001)
    y = np.clip(y - .5, 0, height - 1.001)
    x0, y0 = x.astype(np.int64), y.astype(np.int64)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    top = image[y0, x0] * (1 - fx) + image[y0, x0 + 1] * fx
    bottom = image[y0 + 1, x0] * (1 - fx) + image[y0 + 1, x0 + 1] * fx
    return top * (1 - fy) + bottom * fy


def _raster(canvas, size, points, sources, texture):
    """Draw triangles (canvas points, source points) into a premultiplied canvas, later ones on top."""
    lo = np.floor(points.min(1)).astype(np.int64)
    span = np.ceil(points.max(1)).astype(np.int64) - lo + 1
    small = (span <= _TILE).all(1)
    batches = [np.flatnonzero(small)] + [[i] for i in np.flatnonzero(~small)]
    for batch in batches:
        if not len(batch):
            continue
        tile = int(max(_TILE, span[batch].max()))
        oy, ox = np.mgrid[0:tile, 0:tile]
        px = (lo[batch, 0, None, None] + ox)[..., None].reshape(len(batch), -1) + .5
        py = (lo[batch, 1, None, None] + oy)[..., None].reshape(len(batch), -1) + .5
        a, b, c = (points[batch, i] for i in range(3))
        det = (b[:, 1] - c[:, 1]) * (a[:, 0] - c[:, 0]) + (c[:, 0] - b[:, 0]) * (a[:, 1] - c[:, 1])
        det = np.where(np.abs(det) < 1e-9, 1e-9, det)[:, None]
        l1 = ((b[:, 1, None] - c[:, 1, None]) * (px - c[:, 0, None]) + (c[:, 0, None] - b[:, 0, None]) * (py - c[:, 1, None])) / det
        l2 = ((c[:, 1, None] - a[:, 1, None]) * (px - c[:, 0, None]) + (a[:, 0, None] - c[:, 0, None]) * (py - c[:, 1, None])) / det
        l3 = 1 - l1 - l2
        inside = (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6) & (px >= 0) & (py >= 0) & (px < size) & (py < size)
        if not inside.any():
            continue
        rows = np.nonzero(inside)[0]
        s = sources[batch]
        sx = l1[inside] * s[rows, 0, 0] + l2[inside] * s[rows, 1, 0] + l3[inside] * s[rows, 2, 0]
        sy = l1[inside] * s[rows, 0, 1] + l2[inside] * s[rows, 1, 1] + l3[inside] * s[rows, 2, 1]
        colour = _bilinear(texture, sx, sy)
        seen = colour[:, 3] > 1e-4
        index = (py[inside].astype(np.int64) * size + px[inside].astype(np.int64))[seen]
        canvas.reshape(-1, 4)[index] = colour[seen]


def render_frames(png, joints, template, strength, speed, fps, size):
    """RGBA frames (uint8, size x size) of one loop of the motion."""
    if template not in TEMPLATES:
        raise PipelineError('invalid_template', '모션 종류를 다시 선택하세요.', 422)
    skinned = skin(png, joints)
    ys, xs = np.nonzero(skinned['mask'])
    left, right, top, bottom = xs.min(), xs.max(), ys.min(), ys.max()
    height = bottom - top + 1
    ground = ((left + right) / 2, float(bottom))
    # One framing for every frame: room above for jumps and at the sides for swings, feet on a fixed line.
    full = size * _SUPERSAMPLE
    margin = .06 * full
    scale = min((full - 2 * margin) / (1.24 * height), (full - 2 * margin) / (1.16 * (right - left + 1)))
    offset = np.array([full / 2 - ground[0] * scale, full - margin - ground[1] * scale])
    frames = max(8, min(96, int(round(TEMPLATES[template] / speed * fps))))
    vertices = np.c_[skinned['vertices'], np.ones(len(skinned['vertices']))]
    weights, triangles, parts, layers = skinned['weights'], skinned['triangles'], skinned['parts'], skinned['layers']
    textures = skinned['textures']
    sources = skinned['vertices'][triangles]
    # Back to front by layer; each part samples its own texture (its pixels plus the fill under the front).
    order = [[(bone, np.flatnonzero(parts == bone)) for bone in sorted(set(parts[layers == level].tolist()))]
             for level in sorted(set(layers.tolist()))]
    images = []
    for index in range(frames):
        matrices = bone_matrices(pose(template, index / frames, strength, joints, height), joints, ground)
        moved = np.einsum('bij,vj->vbi', matrices, vertices)[..., :2]
        placed = (moved * weights[..., None]).sum(1) * scale + offset
        canvas = np.zeros((full, full, 4), np.float32)
        for level in order:
            layer = np.zeros_like(canvas)
            for bone, group in level:
                x0, y0, texture = textures[bone]
                _raster(layer, full, placed[triangles[group]], sources[group] - (x0, y0), texture)
            canvas = layer + canvas * (1 - layer[..., 3:])
        small = canvas.reshape(size, _SUPERSAMPLE, size, _SUPERSAMPLE, 4).mean((1, 3))
        alpha = small[..., 3:]
        colour = np.where(alpha > 1e-4, small[..., :3] / np.maximum(alpha, 1e-4), 0)
        images.append(np.clip(np.dstack([colour, alpha]) * 255 + .5, 0, 255).astype(np.uint8))
    return images


def _gif(frames, duration):
    """One shared palette for every frame (no flicker), index 255 transparent below half alpha."""
    stack = np.concatenate(frames, axis=1)
    opaque = stack[..., 3] >= 128
    filler = stack[opaque][0, :3] if opaque.any() else np.zeros(3, np.uint8)
    rgb = np.where(opaque[..., None], stack[..., :3], filler)
    palette_image = Image.fromarray(rgb, 'RGB').quantize(colors=255, method=Image.Quantize.MEDIANCUT,
                                                         dither=Image.Dither.NONE)
    palette = (palette_image.getpalette() or [])[:255 * 3]
    palette += [0] * (255 * 3 - len(palette)) + [0, 0, 0]
    out = []
    for frame in frames:
        solid = frame[..., 3] >= 128
        rgb = np.where(solid[..., None], frame[..., :3], filler)
        index = np.array(Image.fromarray(rgb, 'RGB').quantize(palette=palette_image, dither=Image.Dither.NONE))
        index[~solid] = 255
        image = Image.fromarray(index.astype(np.uint8), 'P')
        image.putpalette(palette)
        out.append(image)
    buffer = io.BytesIO()
    out[0].save(buffer, 'GIF', save_all=True, append_images=out[1:], duration=duration, loop=0,
                transparency=255, disposal=2, optimize=False)
    return buffer.getvalue()


def encode(frames, fps):
    """{format: bytes} for GIF, animated WebP and APNG of the same frames."""
    duration = int(round(1000 / fps))
    images = [Image.fromarray(frame, 'RGBA') for frame in frames]
    result = {'gif': _gif(frames, duration)}
    buffer = io.BytesIO()
    images[0].save(buffer, 'WEBP', save_all=True, append_images=images[1:], duration=duration, loop=0,
                   quality=90, method=4)
    result['webp'] = buffer.getvalue()
    buffer = io.BytesIO()
    images[0].save(buffer, 'PNG', save_all=True, append_images=images[1:], duration=duration, loop=0,
                   disposal=1, blend=0)
    result['apng'] = buffer.getvalue()
    return result
