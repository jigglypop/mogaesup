"""What a top or a bottom is beyond its slot, and how that binds it: plain numpy over its points, used by the fitting
worker (avatar_native_parts_blender) and by tests without Blender.

A raised hood belongs to the top's mesh but sits where a hat does: such a top is fitted in the head's and the torso's
space together, and the hood above the collar follows the head bone. An open skirt is one garment, not two trouser legs:
a bottom whose saved contract names neither is told apart by the fabric between the legs, and a skirt is bound to the
pelvis and the thighs (avatar_blender_common.bind_skirt), never leg by leg.
"""
import re

import numpy as np

from src.services.avatar_part_gate import bone_key

_HOOD = re.compile(r'\b(?:hood(?:ie|ed)?|cowl)\b|후드')
_HOOD_DOWN = re.compile(r'\bhood\s+(?:is\s+)?(?:down|lowered|folded)|\blowered\s+hood|후드\s*(?:를\s*)?(?:내림|내린|벗은)'
                        r'|모자\s*(?:를\s*)?(?:내림|내린|벗은)')
# A T-pose top with its hood down is about half as tall as it is wide (the audited ones .31-.53); one with a raised hood
# around the SD head about as tall as wide (1.08). The hood is the top's upper 35%: around the head it is as deep as
# it is wide (1.0-1.05), where a dress's bodice or a plain top's shoulders are shallow (.84 at most, mostly .2-.47).
HOOD_TALL = .8
HOOD_UPPER = .35
HOOD_ROUND = .9


def hood_shape(points, *, up=2, depth=1):
    """(height/width, depth/width of the upper HOOD_UPPER) of a top's points (n, 3), across X."""
    points = np.asarray(points, float).reshape(-1, 3)
    if len(points) < 4 or not np.isfinite(points).all():
        return 0., 0.
    low, high = points.min(axis=0), points.max(axis=0)
    width = high[0] - low[0]
    if width <= 1e-8:
        return 0., 0.
    upper = points[points[:, up] >= high[up] - HOOD_UPPER*(high[up] - low[up])]
    upper_width = np.ptp(upper[:, 0])
    return (float((high[up] - low[up])/width),
            float(np.ptp(upper[:, depth])/upper_width) if upper_width > 1e-8 else 0.)


def raised_hood(description, points, *, up=2, depth=1):
    """Whether a top (its saved description, its points in any frame of its own) has a raised hood: its description
    names a hood and does not lower it, and its shape has a hood standing around a head. A described hood alone is not
    enough: the studio's hoodies are drawn with the hood down."""
    text = (description or '').lower()
    if not _HOOD.search(text) or _HOOD_DOWN.search(text):
        return False
    tall, round_ = hood_shape(points, up=up, depth=depth)
    return tall >= HOOD_TALL and round_ >= HOOD_ROUND


def head_torso_bounds(torso, head):
    """glTF bounds ((low, high)) of one top containing a raised hood, without changing either input."""
    return [np.minimum(torso[0], head[0]).tolist(), np.maximum(torso[1], head[1]).tolist()]


# A ray from a leg's axis toward the other leg meets trouser fabric before the middle between the legs, and meets a
# skirt only beyond it. Over the audited bottoms, the share of such rays (at 20, 35 and 50 degrees, in front and behind,
# over the lower BAND of the garment) was 0-.02 for skirts and .5-1 for trousers, shorts and wide trousers whose legs
# touch.
SKIRT_RAYS = (20., 35., 50.)
SKIRT_BAND = (.04, .24)
SKIRT_HEIGHTS = 10
SKIRT_MAX_BETWEEN = .25
SKIRT_MIN_RAYS = 24


def _slice(points, triangles, height, up):
    """(k, 2, 2): the segments of the triangles crossing the plane at `height`, in the two other axes."""
    across = [axis for axis in range(3) if axis != up]
    corners = points[np.asarray(triangles, np.int64).reshape(-1, 3)]
    rise = corners[:, :, up] - height
    rise = np.where(rise == 0, 1e-9, rise)
    ends = []
    for i, j in ((0, 1), (1, 2), (2, 0)):
        crossing = rise[:, i]*rise[:, j] < 0
        share = rise[:, i]/np.where(crossing, rise[:, i] - rise[:, j], 1.)
        point = corners[:, i] + (corners[:, j] - corners[:, i])*share[:, None]
        ends.append(np.where(crossing[:, None], point[:, across], np.nan))
    ends = np.stack(ends, axis=1)
    found = ~np.isnan(ends[:, :, 0])
    keep = found.sum(axis=1) == 2
    order = np.argsort(~found[keep], axis=1, kind='stable')[:, :2]
    return np.take_along_axis(ends[keep], order[:, :, None], axis=1)


def _first_hit(origin, direction, segments):
    start, edge = segments[:, 0], segments[:, 1] - segments[:, 0]
    across = direction[0]*edge[:, 1] - direction[1]*edge[:, 0]
    offset = start - origin
    usable = np.abs(across) > 1e-12
    across = np.where(usable, across, 1.)
    along = (offset[:, 0]*edge[:, 1] - offset[:, 1]*edge[:, 0])/across
    on = (offset[:, 0]*direction[1] - offset[:, 1]*direction[0])/across
    hit = usable & (along > 1e-6) & (on >= 0) & (on <= 1)
    return float(along[hit].min()) if hit.any() else np.inf


def _leg_axis(chain, height, up):
    """A leg's axis at `height`: along hip, knee and ankle; straight up and down beyond them."""
    if height >= chain[0][up]:
        point = chain[0].copy()
    elif height <= chain[-1][up]:
        point = chain[-1].copy()
    else:
        point = chain[-1].copy()
        for top, bottom in zip(chain, chain[1:]):
            if bottom[up] <= height <= top[up]:
                point = top + (bottom - top)*(top[up] - height)/max(top[up] - bottom[up], 1e-9)
                break
    point[up] = height
    return point


def fabric_between_legs(points, triangles, legs, *, up=2):
    """(share, rays): of the rays from each leg's axis toward the other leg, over the garment's lower SKIRT_BAND, the
    share that meets the garment before the middle between the legs. legs: {'left'/'right': (hip, knee, ankle)} in
    the points' frame."""
    points = np.asarray(points, float).reshape(-1, 3)
    chains = {side: [np.asarray(tuple(joint), float) for joint in legs[side]] for side in ('left', 'right')}
    across = [axis for axis in range(3) if axis != up]
    low, high = points[:, up].min(), points[:, up].max()
    met = rays = 0
    for height in np.linspace(low + SKIRT_BAND[0]*(high - low), low + SKIRT_BAND[1]*(high - low), SKIRT_HEIGHTS):
        segments = _slice(points, triangles, height, up)
        if not len(segments):
            continue
        axes = {side: _leg_axis(chain, height, up)[across] for side, chain in chains.items()}
        for side, other in (('left', 'right'), ('right', 'left')):
            inward = axes[other] - axes[side]
            half = float(np.linalg.norm(inward))/2
            if half <= 1e-6:
                continue
            inward /= 2*half
            aside = np.array([-inward[1], inward[0]])
            for angle in np.radians(SKIRT_RAYS):
                for sign in (1., -1.):
                    direction = np.cos(angle)*inward + sign*np.sin(angle)*aside
                    met += _first_hit(axes[side], direction, segments) < half/np.cos(angle)
                    rays += 1
    return (met/rays if rays else 0.), rays


def bottom_kind(profile_kind, garment_kind, points, triangles, legs, *, up=2):
    """(kind, receipt) of a bottom: the saved contract's 'pants' or 'skirt', else what its geometry on the body shows,
    else 'source' when it cannot be measured (no legs, too few rays)."""
    for kind in (profile_kind, garment_kind):
        if kind in ('pants', 'skirt'):
            return kind, {'method': 'saved_contract'}
    points = np.asarray(points, float).reshape(-1, 3)
    if legs is None or len(points) < 3 or not len(triangles) or not np.isfinite(points).all():
        return 'source', {'method': 'fabric_between_legs_v1', 'reason': 'not_measurable'}
    share, rays = fabric_between_legs(points, triangles, legs, up=up)
    receipt = {'method': 'fabric_between_legs_v1', 'rays': rays, 'between_share': round(share, 3)}
    if rays < SKIRT_MIN_RAYS:
        return 'source', {**receipt, 'reason': 'not_measurable'}
    return ('skirt' if share <= SKIRT_MAX_BETWEEN else 'pants'), receipt


def _bone(rig, key):
    return next((bone.name for bone in rig.data.bones if bone_key(bone.name) == key), None)


def leg_joints(rig):
    """{'left'/'right': (hip, knee, ankle)} of a rig in world space (Blender, Z up), or None without them."""
    legs = {}
    for side in ('left', 'right'):
        names = [_bone(rig, side + part) for part in ('upleg', 'leg', 'foot')]
        if not all(names):
            return None
        legs[side] = tuple(tuple(rig.matrix_world @ rig.data.bones[name].head_local) for name in names)
    return legs


def mesh_bottom_kind(part, meshes, rig):
    """bottom_kind of a fitted bottom's Blender meshes, on the rig it is worn on."""
    points, triangles = [], []
    for obj in meshes:
        offset = len(points)
        points.extend(tuple(obj.matrix_world @ vertex.co) for vertex in obj.data.vertices)
        obj.data.calc_loop_triangles()
        triangles.extend(tuple(offset + index for index in triangle.vertices) for triangle in obj.data.loop_triangles)
    return bottom_kind((part.get('fit_profile') or {}).get('kind'), part.get('garment_kind'),
                       np.array(points, float).reshape(-1, 3), np.array(triangles, np.int64).reshape(-1, 3),
                       leg_joints(rig))


def bind_hood_head(meshes, rig, collar, *, blend=.04):
    """A raised hood follows the head: above the collar (Blender Z) a top's weights pass to the head bone over `blend`
    metres; below, the weights it was given stay. Each changed row still sums to 1. Returns the receipt."""
    head = _bone(rig, 'head')
    if head is None:
        raise ValueError('The skeleton has no head bone for a raised hood')
    changed = 0
    for obj in meshes:
        group = next((group for group in obj.vertex_groups if group.name == head), None) or obj.vertex_groups.new(name=head)
        for vertex in obj.data.vertices:
            amount = float(np.clip(((obj.matrix_world @ vertex.co).z - collar)/blend, 0., 1.))
            if amount <= 0:
                continue
            amount = amount*amount*(3 - 2*amount)
            previous = [(entry.group, entry.weight) for entry in vertex.groups]
            total = max(sum(weight for _, weight in previous), 1e-8)
            on_head = sum(weight for index, weight in previous if index == group.index)/total
            for index, _ in previous:
                obj.vertex_groups[index].remove([vertex.index])
            for index, weight in previous:
                if index != group.index and weight*(1 - amount) > 1e-8:
                    obj.vertex_groups[index].add([vertex.index], weight/total*(1 - amount), 'REPLACE')
            group.add([vertex.index], amount + on_head*(1 - amount), 'REPLACE')
            changed += 1
    return {'method': 'head_above_collar', 'bone': head, 'vertices': changed, 'collar_m': float(collar),
            'blend_m': blend}
