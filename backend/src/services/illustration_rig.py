"""Whole-illustration 2D rig: proposed joints, rigid part regions with blended joints, and a grid mesh.

No part is cut out of the drawing. Each pixel belongs to one bone by the joint lines (head above the
neck, legs below the hips, arms against the torso by capsule distance); weights are those regions
blurred across their borders, so parts stay rigid and joints bend smoothly.
"""
import io
import math

import numpy as np
from PIL import Image

from src.services.character_pipeline import PipelineError

RIG_REVISION = 'illustration-rig-v2'
SKELETON = 'emoticon-2d-v1'
JOINTS = ('head_top', 'neck', 'pelvis', 'shoulder_r', 'elbow_r', 'wrist_r', 'shoulder_l', 'elbow_l', 'wrist_l',
          'hip_r', 'knee_r', 'ankle_r', 'hip_l', 'knee_l', 'ankle_l')
# name, parent, pivot joint, tail joint, draw layer (higher is in front). `_r` is the character's right,
# which is the image's left in a front view.
BONES = (('body', 'root', 'pelvis', 'neck', 1), ('head', 'body', 'neck', 'head_top', 2),
         ('arm_upper_r', 'body', 'shoulder_r', 'elbow_r', 3), ('arm_lower_r', 'arm_upper_r', 'elbow_r', 'wrist_r', 4),
         ('arm_upper_l', 'body', 'shoulder_l', 'elbow_l', 3), ('arm_lower_l', 'arm_upper_l', 'elbow_l', 'wrist_l', 4),
         ('leg_upper_r', 'root', 'hip_r', 'knee_r', 0), ('leg_lower_r', 'leg_upper_r', 'knee_r', 'ankle_r', 0),
         ('leg_upper_l', 'root', 'hip_l', 'knee_l', 0), ('leg_lower_l', 'leg_upper_l', 'knee_l', 'ankle_l', 0))
BONE_NAMES = tuple(bone[0] for bone in BONES)
_REGION_STEP = 4   # px per cell of the region grid


def load_alpha(png):
    image = Image.open(io.BytesIO(png)).convert('RGBA')
    rgba = np.array(image)
    mask = rgba[..., 3] >= 128
    if not mask.any():
        raise PipelineError('empty_illustration', '원화에 보이는 영역이 없습니다.', 422)
    if mask.mean() > .9:
        raise PipelineError('opaque_background', '배경이 투명한 원화만 리깅할 수 있습니다.', 422)
    return rgba, mask


def _run(row, x):
    """(start, end) of the opaque run at or nearest to column x, or None for an empty row."""
    columns = np.flatnonzero(row)
    if not len(columns):
        return None
    if not row[x]:
        x = int(columns[np.argmin(np.abs(columns - x))])
    breaks = np.flatnonzero(np.diff(columns) > 1)
    starts, ends = np.r_[columns[0], columns[breaks + 1]], np.r_[columns[breaks], columns[-1]]
    index = int(np.searchsorted(ends, x))
    return int(starts[index]), int(ends[index])


def propose_joints(mask):
    """Joints for a front-view figure standing on its feet, from the silhouette alone."""
    ys, xs = np.nonzero(mask)
    top, bottom, left, right = int(ys.min()), int(ys.max()), int(xs.min()), int(xs.max())
    height, width = bottom - top + 1, right - left + 1
    cx = int(np.median(xs))
    band = range(top + int(.22 * height), top + int(.62 * height) + 1)
    runs = [_run(mask[y], cx) for y in band]
    widths = np.array([run[1] - run[0] + 1 if run else width for run in runs], float)
    if len(widths) > 9:
        # Smoothed central-run width; the narrowest row between head and torso is the neck.
        widths = np.convolve(widths, np.ones(9) / 9, mode='same')
        neck_y = band.start + 4 + int(np.argmin(widths[4:-4]))
    else:
        neck_y = band.start + int(np.argmin(widths))
    run = _run(mask[neck_y], cx)
    neck_x = (run[0] + run[1]) / 2 if run else cx
    feet = np.flatnonzero(mask[max(top, bottom - int(.1 * height)):bottom + 1].any(0))
    legs_x = int(np.median(feet)) if len(feet) else cx
    lower = range(neck_y + int(.3 * (bottom - neck_y)), bottom + 1)
    gap = [y for y in lower if not mask[y, legs_x]]
    # The gap between the legs marks the crotch; legs drawn together keep it within SD proportions.
    crotch_y = (min(gap) - 1) if gap else neck_y + .55 * (bottom - neck_y)
    crotch_y = min(max(crotch_y, neck_y + .4 * (bottom - neck_y)), neck_y + .65 * (bottom - neck_y))
    pelvis_y = neck_y + .72 * (crotch_y - neck_y)
    run = _run(mask[int(pelvis_y)], legs_x)
    pelvis_x = (run[0] + run[1]) / 2 if run else legs_x
    half = min(((run[1] - run[0]) / 2) if run else .2 * width, .35 * width)
    hip_y = (pelvis_y + crotch_y) / 2
    ankle_y = bottom - .08 * (bottom - crotch_y)
    joints = {'head_top': (neck_x, top + .03 * height), 'neck': (neck_x, neck_y), 'pelvis': (pelvis_x, pelvis_y)}
    torso = neck_y, crotch_y + .15 * (bottom - crotch_y)
    for side, sign in (('r', -1), ('l', 1)):
        row = mask[int(ankle_y)]
        columns = np.flatnonzero(row[:legs_x] if sign < 0 else row[legs_x:])
        ankle_x = float(columns.mean()) + (0 if sign < 0 else legs_x) if len(columns) else pelvis_x + sign * .5 * half
        hip = (pelvis_x + sign * .5 * half, hip_y)
        joints[f'hip_{side}'], joints[f'ankle_{side}'] = hip, (ankle_x, ankle_y)
        joints[f'knee_{side}'] = ((hip[0] + ankle_x) / 2, (hip_y + ankle_y) / 2)
        shoulder = (neck_x + sign * .8 * half, neck_y + .18 * (crotch_y - neck_y))
        rows = slice(int(torso[0]), int(torso[1]) + 1)
        region = mask[rows]
        columns = np.flatnonzero(region.any(0))
        reach = columns.min() if sign < 0 else columns.max()
        if abs(reach - shoulder[0]) < .5 * half:
            wrist = (shoulder[0] + sign * .1 * half, shoulder[1] + .55 * (crotch_y - neck_y))
        else:
            ys_at = np.flatnonzero(region[:, reach]) + rows.start
            tip = (float(reach), float(ys_at.mean()))
            wrist = (tip[0] + .12 * (shoulder[0] - tip[0]), tip[1] + .12 * (shoulder[1] - tip[1]))
        joints[f'shoulder_{side}'], joints[f'wrist_{side}'] = shoulder, wrist
        joints[f'elbow_{side}'] = ((shoulder[0] + wrist[0]) / 2, (shoulder[1] + wrist[1]) / 2)
    return {name: [round(float(joints[name][0]), 1), round(float(joints[name][1]), 1)] for name in JOINTS}


def check_joints(joints, width, height):
    if not isinstance(joints, dict) or set(joints) != set(JOINTS):
        raise PipelineError('invalid_joints', '관절 목록이 맞지 않습니다.', 422)
    clean = {}
    for name in JOINTS:
        x, y = joints[name]
        if not (math.isfinite(x) and math.isfinite(y) and -width * .25 <= x <= width * 1.25 and -height * .25 <= y <= height * 1.25):
            raise PipelineError('invalid_joints', '관절이 원화 범위를 벗어났습니다.', 422)
        clean[name] = [round(float(x), 1), round(float(y), 1)]
    return clean


def _segment_distance(px, py, a, b):
    ax, ay = a; bx, by = b
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy or 1e-9
    u = np.clip(((px - ax) * dx + (py - ay) * dy) / length, 0, 1)
    return np.hypot(px - (ax + u * dx), py - (ay + u * dy)), u


def _half_thickness(mask, a, b, positions=(.2, .35, .5, .65, .8)):
    """Median half-width of the silhouette across a bone, sampled at points along it."""
    height, width = mask.shape
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy) or 1.0
    nx, ny = -dy / length, dx / length
    samples = []
    for t in positions:
        cx, cy = a[0] + t * dx, a[1] + t * dy
        reach = []
        for sign in (1, -1):
            step = 0
            while step < max(width, height):
                x, y = int(round(cx + sign * step * nx)), int(round(cy + sign * step * ny))
                if not (0 <= x < width and 0 <= y < height) or not mask[y, x]:
                    break
                step += 1
            reach.append(step)
        samples.append(sum(reach) / 2)
    return float(np.median(samples))


def radii(mask, joints):
    """Half-thickness per bone. Sleeves joined to the torso would inflate both the torso and the upper
    arm, so the torso is measured low and the arms from the free forearm."""
    j = {name: tuple(value) for name, value in joints.items()}
    radius = {'body': _half_thickness(mask, j['pelvis'], j['neck'], (.1, .2, .3))}
    for side in ('r', 'l'):
        forearm = _half_thickness(mask, j[f'elbow_{side}'], j[f'wrist_{side}'], (.3, .5, .7))
        radius[f'arm_upper_{side}'], radius[f'arm_lower_{side}'] = 1.35 * forearm, 1.15 * forearm
        for part in ('upper', 'lower'):
            name = f'leg_{part}_{side}'
            bone = next(bone for bone in BONES if bone[0] == name)
            radius[name] = _half_thickness(mask, j[bone[2]], j[bone[3]])
    return radius


def torso_sides(joints, px, py, margin=0.0):
    """{side: points more than `margin` px beyond the torso's side line (that shoulder to that hip)."""
    j = {name: tuple(value) for name, value in joints.items()}
    outside = {}
    for side in ('r', 'l'):
        shoulder, hip = np.array(j[f'shoulder_{side}']), np.array(j[f'hip_{side}'])
        normal = np.array([hip[1] - shoulder[1], shoulder[0] - hip[0]])
        if np.dot(normal, np.subtract(j['neck'], shoulder)) > 0:
            normal = -normal
        normal = normal / (np.hypot(*normal) or 1)
        outside[side] = (px - shoulder[0]) * normal[0] + (py - shoulder[1]) * normal[1] > margin
    return outside


def regions(mask, joints):
    """Bone index per region cell (-1 outside the drawing) on a grid of _REGION_STEP pixels."""
    height, width = mask.shape
    step = _REGION_STEP
    rows, cols = -(-height // step), -(-width // step)
    padded = np.zeros((rows * step, cols * step), bool)
    padded[:height, :width] = mask
    cells = padded.reshape(rows, step, cols, step).any((1, 3))
    py, px = (np.mgrid[0:rows, 0:cols] + .5) * step
    j = {name: tuple(value) for name, value in joints.items()}
    index = {name: i for i, name in enumerate(BONE_NAMES)}
    label = np.full((rows, cols), index['body'], np.int16)
    # Each bone is a capsule: beside the bone the distance is signed against its half-thickness (deeper
    # inside wins), past its ends it is plain distance.
    radius = radii(mask, joints)
    reach = {}
    for name, _, head, tail, _ in BONES:
        if name == 'head':
            continue
        distance, u = _segment_distance(px, py, j[head], j[tail])
        inside = (u > 0) & (u < 1)
        reach[name] = np.where(inside, distance - radius[name], distance)
    names = [name for name in BONE_NAMES if name != 'head']
    stack = np.array([reach[name] for name in names])
    # The line from each shoulder to its hip is the torso's side: arms only outside it, the torso only
    # inside both, each leg anywhere but beyond the other side's line.
    outside = torso_sides(joints, px, py)
    # An arm takes only what lies beyond its torso side and within its own capsule; the rest beyond the
    # line (a hem beside the hand) stays with the torso instead of travelling with the arm.
    claimed = {side: outside[side] & ((reach[f'arm_upper_{side}'] <= .15 * radius[f'arm_upper_{side}'])
                                      | (reach[f'arm_lower_{side}'] <= .15 * radius[f'arm_lower_{side}']))
               for side in ('r', 'l')}
    for k, name in enumerate(names):
        side = name[-1]
        allowed = (~claimed['r'] & ~claimed['l'] if name == 'body' else claimed[side] if name.startswith('arm')
                   else ~outside['l' if side == 'r' else 'r'])
        stack[k][~allowed] = np.inf
    stack = np.where(np.isinf(stack).all(0), np.array([reach[name] for name in names]), stack)
    label[:] = np.array([index[name] for name in names])[np.argmin(stack, axis=0)]
    # Above the neck line (perpendicular to the body at the neck) is head, apart from raised hands.
    axis = np.subtract(j['neck'], j['pelvis'])
    axis = axis / (np.hypot(*axis) or 1)
    above = (px - j['neck'][0]) * axis[0] + (py - j['neck'][1]) * axis[1] > 0
    hands = np.isin(label, [index['arm_lower_r'], index['arm_lower_l']]) \
        & (np.minimum(reach['arm_lower_r'], reach['arm_lower_l']) < 1.5 * step)
    label[above & ~hands] = index['head']
    label[~cells] = -1
    return _drop_islands(label)


def _drop_islands(label):
    """Keep each part's largest connected piece; smaller pieces take the part around them."""
    rows, cols = label.shape
    seen = np.zeros(label.shape, bool)
    pieces = {}
    for start in zip(*np.nonzero(label >= 0)):
        if seen[start]:
            continue
        bone, stack, piece = label[start], [start], []
        seen[start] = True
        while stack:
            r, c = stack.pop()
            piece.append((r, c))
            for nr, nc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
                if 0 <= nr < rows and 0 <= nc < cols and not seen[nr, nc] and label[nr, nc] == bone:
                    seen[nr, nc] = True
                    stack.append((nr, nc))
        pieces.setdefault(int(bone), []).append(piece)
    cleaned = label.copy()
    for bone, found in pieces.items():
        found.sort(key=len, reverse=True)
        for piece in found[1:]:
            cells = np.array(piece)
            neighbours = []
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                r, c = np.clip(cells[:, 0] + dr, 0, rows - 1), np.clip(cells[:, 1] + dc, 0, cols - 1)
                around = label[r, c]
                neighbours += around[(around >= 0) & (around != bone)].tolist()
            if neighbours:
                cleaned[cells[:, 0], cells[:, 1]] = max(set(neighbours), key=neighbours.count)
    return cleaned


# Neighbouring parts share mesh points only near the joint between them; elsewhere (a sleeve along the
# torso, legs side by side) the mesh is cut and each part moves on its own.
# Per link: the joint, the bone whose thickness sizes it, how far from the joint the two parts share mesh
# points, and how far from it their weights blend (both in multiples of that thickness).
LINKS = {('body', 'head'): ('neck', 'body', 3.0, .4),
         ('body', 'arm_upper_r'): ('shoulder_r', 'arm_upper_r', 1.2, .8), ('arm_upper_r', 'arm_lower_r'): ('elbow_r', 'arm_lower_r', 1.6, .8),
         ('body', 'arm_upper_l'): ('shoulder_l', 'arm_upper_l', 1.2, .8), ('arm_upper_l', 'arm_lower_l'): ('elbow_l', 'arm_lower_l', 1.6, .8),
         ('body', 'leg_upper_r'): ('hip_r', 'leg_upper_r', 1.5, .8), ('leg_upper_r', 'leg_lower_r'): ('knee_r', 'leg_lower_r', 1.6, .8),
         ('body', 'leg_upper_l'): ('hip_l', 'leg_upper_l', 1.5, .8), ('leg_upper_l', 'leg_lower_l'): ('knee_l', 'leg_lower_l', 1.6, .8)}
_UNDER = .05   # share of the drawing's size a part is filled in under the parts drawn in front of it


def _joined(joints, radius):
    """{(bone a, bone b): (joint x, joint y, share reach, blend reach)} for both orders of each link."""
    index = {name: i for i, name in enumerate(BONE_NAMES)}
    joined = {}
    for (a, b), (joint, sized, share, blend) in LINKS.items():
        value = (joints[joint][0], joints[joint][1], share * radius[sized], max(4.0, blend * radius[sized]))
        joined[index[a], index[b]] = joined[index[b], index[a]] = value
    return joined


def _weights(group, x, y, joined):
    """Weights of a mesh point owned by `group`: each owner is rigid except near a joint it links to,
    where up to half its weight passes to the linked part, fading out with distance from the joint."""
    total = np.zeros(len(BONE_NAMES))
    for part in group:
        weights = np.zeros(len(BONE_NAMES))
        shares = {}
        for other in range(len(BONE_NAMES)):
            link = joined.get((part, other))
            if link is None:
                continue
            t = min(1.0, math.hypot(x - link[0], y - link[1]) / link[3])
            share = .5 * (1 - (3 * t * t - 2 * t ** 3))
            if share > 1e-4:
                shares[other] = share
        scale = min(1.0, .5 / sum(shares.values())) if shares else 1.0
        for other, share in shares.items():
            weights[other] += share * scale
        weights[part] += 1 - weights.sum()
        total += weights
    return total / len(group)


def _shift(array, dr, dc):
    out = np.zeros_like(array)
    h, w = array.shape[:2]
    out[max(dr, 0):h + min(dr, 0), max(dc, 0):w + min(dc, 0)] = array[max(-dr, 0):h + min(-dr, 0), max(-dc, 0):w + min(-dc, 0)]
    return out


def part_textures(rgba, label, joints):
    """{bone: (x0, y0, premultiplied RGBA crop)}: the part's own pixels and, under the parts drawn in front
    of it, its colours carried inward from its edge. A part that moves away then uncovers a plausible
    continuation of what was behind it instead of a hole or a smear."""
    height, width = rgba.shape[:2]
    full = np.repeat(np.repeat(label, _REGION_STEP, 0), _REGION_STEP, 1)[:height, :width]
    alpha = rgba[..., 3].astype(np.float32) / 255
    colour = rgba[..., :3].astype(np.float32) / 255
    layer_of = np.array([bone[4] for bone in BONES])
    depth = np.where(full >= 0, layer_of[np.clip(full, 0, None)], -1)
    # Only the torso is filled deep under what lies in front of it (the arms swing away from it); a limb
    # under its own next segment only closes the seam, or its fill would show past a bent joint.
    deep, seam = max(8, int(round(_UNDER * max(height, width)))), max(3, int(round(.006 * max(height, width))))
    # The torso is filled only a few pixels past its side lines, enough to close the seam under an arm
    # that moves a little, so a raised arm leaves the torso's own outline.
    py, px = np.mgrid[0:height, 0:width] + .5
    sides = torso_sides(joints, px, py, margin=float(seam))
    torso = ~sides['r'] & ~sides['l']
    body = BONE_NAMES.index('body')
    textures = {}
    for bone in range(len(BONE_NAMES)):
        own = (full == bone) & (alpha > 0)
        if not own.any():
            continue
        steps = deep if bone == body else seam
        ys, xs = np.nonzero(own)
        y0, y1 = max(0, ys.min() - steps), min(height, ys.max() + steps + 1)
        x0, x1 = max(0, xs.min() - steps), min(width, xs.max() + steps + 1)
        own_c, a_c, c_c = own[y0:y1, x0:x1], alpha[y0:y1, x0:x1], colour[y0:y1, x0:x1]
        front = (depth[y0:y1, x0:x1] > layer_of[bone]) & (a_c > 0)
        if bone == body:
            front &= torso[y0:y1, x0:x1]
        have = own_c & (a_c > .5)
        fill = np.where(have[..., None], c_c, 0)
        for _ in range(steps):
            grow = front & ~have
            if not grow.any():
                break
            total, count = np.zeros_like(fill), np.zeros(have.shape, np.float32)
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                seen = _shift(have, dr, dc)
                total += _shift(fill, dr, dc) * seen[..., None]
                count += seen
            new = grow & (count > 0)
            if not new.any():
                break
            fill[new] = total[new] / count[new][:, None]
            have |= new
        coverage = np.where(own_c | (have & front), a_c, 0)
        rgb = np.where(own_c[..., None], c_c, fill)
        textures[bone] = (int(x0), int(y0), np.dstack([rgb * coverage[..., None], coverage]).astype(np.float32))
    return textures


def cut_mesh(shape, textures, joints, radius, cell):
    """Vertices (x, y), triangles, the part of each triangle, and per-vertex bone weights.

    Every part gets its own cells wherever its texture reaches; mesh points are shared between two parts
    only within reach of the joint that links them.
    """
    height, width = shape
    rows, cols = -(-height // cell), -(-width // cell)
    cover = {}
    for bone, (x0, y0, texture) in textures.items():
        full = np.zeros((rows * cell, cols * cell), bool)
        h, w = texture.shape[:2]
        full[y0:y0 + h, x0:x0 + w] = texture[..., 3] > 1e-3
        cover[bone] = full.reshape(rows, cell, cols, cell).any((1, 3))
    joined = _joined(joints, radius)

    def near(a, b, x, y):
        link = joined.get((a, b))
        return link is not None and math.hypot(x - link[0], y - link[1]) <= link[2]


    corners = {}
    for bone, kept in cover.items():
        for r, c in zip(*np.nonzero(kept)):
            for corner in ((r, c), (r, c + 1), (r + 1, c), (r + 1, c + 1)):
                corners.setdefault(corner, set()).add(bone)
    vertex, positions, weights = {}, [], []
    for (r, c), parts in corners.items():
        x, y = c * cell, r * cell
        groups = []
        for bone in sorted(parts):
            linked = [group for group in groups if any(near(bone, other, x, y) for other in group)]
            groups = [group for group in groups if group not in linked] + [{bone}.union(*linked)]
        for group in groups:
            for bone in group:
                vertex[r, c, bone] = len(positions)
            positions.append((x, y))
            weights.append(_weights(sorted(group), x, y, joined))
    triangles, parts_of = [], []
    for bone, kept in cover.items():
        for r, c in zip(*np.nonzero(kept)):
            a, b, d, e = vertex[r, c, bone], vertex[r, c + 1, bone], vertex[r + 1, c, bone], vertex[r + 1, c + 1, bone]
            triangles += [(a, b, e), (a, e, d)]
            parts_of += [bone, bone]
    return (np.array(positions, np.float64), np.array(triangles, np.int64), np.array(parts_of),
            np.array(weights, np.float32).reshape(-1, len(BONE_NAMES)))


def skin(png, joints):
    """Mesh, per-vertex weights, per-triangle part and layer, and per-part textures for a drawing."""
    rgba, mask = load_alpha(png)
    height, width = mask.shape
    label = regions(mask, joints)
    textures = part_textures(rgba, label, joints)
    cell = max(8, _REGION_STEP * int(round(max(height, width) / 128 / _REGION_STEP)))
    vertices, triangles, parts, weights = cut_mesh(mask.shape, textures, joints, radii(mask, joints), cell)
    layer_of = np.array([bone[4] for bone in BONES])
    return {'rgba': rgba, 'mask': mask, 'label': label, 'vertices': vertices, 'triangles': triangles,
            'weights': weights, 'parts': parts, 'layers': layer_of[parts], 'textures': textures}


def region_preview(rgba, label, size=512):
    """The drawing tinted by the bone each part follows, for checking joints."""
    palette = np.array([[182, 165, 237], [247, 196, 120], [120, 200, 170], [90, 170, 150], [120, 170, 235],
                        [90, 140, 220], [235, 140, 150], [210, 110, 125], [240, 170, 200], [215, 140, 175]], np.float32)
    height, width = rgba.shape[:2]
    rows = np.clip(np.arange(height) // _REGION_STEP, 0, label.shape[0] - 1)
    cols = np.clip(np.arange(width) // _REGION_STEP, 0, label.shape[1] - 1)
    full = label[rows][:, cols]
    tint = palette[np.clip(full, 0, len(palette) - 1)]
    base = rgba[..., :3].astype(np.float32)
    mixed = np.where((full >= 0)[..., None], base * .45 + tint * .55, base)
    out = np.dstack([np.clip(mixed, 0, 255).astype(np.uint8), rgba[..., 3]])
    image = Image.fromarray(out, 'RGBA')
    image.thumbnail((size, size), Image.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, 'PNG', optimize=True)
    return buffer.getvalue()


def build_rig(png, joints=None):
    """Rig record and region preview for a drawing: proposed joints when none are given."""
    rgba, mask = load_alpha(png)
    height, width = mask.shape
    proposed = propose_joints(mask)
    chosen = proposed if joints is None else check_joints(joints, width, height)
    skinned = skin(png, chosen)
    ys, xs = np.nonzero(mask)
    rig = {'revision': RIG_REVISION, 'skeleton': SKELETON, 'width': width, 'height': height,
           'bounds': [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
           'joints': chosen, 'proposed': proposed, 'adjusted': chosen != proposed,
           'bones': [{'name': name, 'parent': parent, 'pivot': pivot, 'tail': tail, 'layer': layer}
                     for name, parent, pivot, tail, layer in BONES],
           'vertices': int(len(skinned['vertices'])), 'triangles': int(len(skinned['triangles']))}
    return rig, region_preview(rgba, skinned['label'])
