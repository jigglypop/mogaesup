"""Which triangles of a wardrobe body one garment covers, so the viewer can hide skin under it.

Parts of one wardrobe body share its skeleton and export frame, so a garment GLB and the
body GLB are compared directly in rest-pose glTF space. A body vertex is covered when the
garment surface lies just outside it along its normal; a triangle is hidden only when all
three vertices are covered, so openings (cuffs, hems, collars) never show a gap.

Garments generated in different jobs overlap by centimetres (a waistband above a tee's hem).
An inner garment carries, per vertex, the body vertex under it and the move that presses it
onto the skin; where an outer garment worn with it covers those body vertices, the viewer
presses the inner garment under it. Nothing is hidden, so a flared hem never shows a gap.
"""
import base64
import re

import numpy as np

from src.services.glb import parse_glb

GARMENT_SLOTS = ('top', 'bottom', 'shoes', 'hat', 'hair')
OUTSIDE_M = (-.005, .06)   # garment distance along the skin normal that counts as covering
SIDEWAYS_M = .02           # a garment point farther sideways belongs to a neighbouring area
DRESS_LEG_SHARE = .5       # a top covering this share of the lower thighs takes the bottom's place (a jacket to mid-thigh does not)
UNDER = {'bottom': ('top', 'shoes'), 'hair': ('top', 'hat'), 'shoes': ('bottom',)}   # inner slot: the outer slots it may tuck under
HEAD_SHARE = .3            # a top or hat covering this share of the upper head (a raised hood) presses hair
BOOT_SHIN_SHARE = .5       # shoes covering this share of the shins are boots, which a bottom tucks into
ANCHOR_M = .08             # a garment vertex farther than this from the skin never tucks under
HEAD_OUTSIDE_M = (-.005, .15)   # a hat's crown or a hood's peak stands this far off the scalp
HAIR_ANCHOR_M = .15        # hair this far off the scalp still tucks under a hat or raised hood
TUCK_M = .001              # a tucked garment lies this far outside the skin (fitted parts keep 3 mm)
VERTEX_BITS = 20           # anchor = body primitive ordinal << VERTEX_BITS | body vertex
_COMPONENTS = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_WIDTH = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def _accessor(doc, binary, index):
    item = doc['accessors'][index]
    view = doc['bufferViews'][item['bufferView']]
    dtype = np.dtype(_COMPONENTS[item['componentType']])
    width = _WIDTH[item['type']]
    start = view.get('byteOffset', 0) + item.get('byteOffset', 0)
    stride = view.get('byteStride') or dtype.itemsize*width
    raw = np.frombuffer(binary, dtype=np.uint8, count=stride*(item['count']-1) + dtype.itemsize*width, offset=start)
    rows = np.lib.stride_tricks.as_strided(raw, shape=(item['count'], dtype.itemsize*width), strides=(stride, 1))
    values = np.ascontiguousarray(rows).view(dtype).reshape(item['count'], width).astype(np.float64)
    if item.get('normalized'):
        values /= np.iinfo(dtype).max
    return values


def _local(node):
    if 'matrix' in node:
        return np.array(node['matrix'], dtype=float).reshape(4, 4).T
    x, y, z, w = node.get('rotation', [0, 0, 0, 1])
    matrix = np.eye(4)
    matrix[:3, :3] = np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                               [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                               [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])*np.array(node.get('scale', [1, 1, 1]), dtype=float)
    matrix[:3, 3] = node.get('translation', [0, 0, 0])
    return matrix


def skinned_primitives(content):
    """Rest-pose positions (glTF world), triangles and dominant joint names per skinned primitive."""
    doc, binary = parse_glb(content)
    nodes = doc.get('nodes', [])
    parent = {child: index for index, node in enumerate(nodes) for child in node.get('children', [])}
    world = {}

    def world_of(index):
        if index not in world:
            world[index] = (world_of(parent[index]) if index in parent else np.eye(4)) @ _local(nodes[index])
        return world[index]
    result = []
    for index, node in enumerate(nodes):
        if 'mesh' not in node or 'skin' not in node:
            continue
        skin = doc['skins'][node['skin']]
        names = np.array([nodes[j].get('name', '') for j in skin['joints']])
        inverse = _accessor(doc, binary, skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)
        matrices = np.stack([world_of(j) for j in skin['joints']]) @ inverse
        for number, primitive in enumerate(doc['meshes'][node['mesh']]['primitives']):
            attributes = primitive.get('attributes', {})
            if not {'POSITION', 'JOINTS_0', 'WEIGHTS_0'} <= set(attributes):
                continue
            positions = _accessor(doc, binary, attributes['POSITION'])
            joints = _accessor(doc, binary, attributes['JOINTS_0']).astype(np.int64)
            weights = _accessor(doc, binary, attributes['WEIGHTS_0'])
            weights /= np.maximum(weights.sum(axis=1, keepdims=True), 1e-12)
            homogeneous = np.c_[positions, np.ones(len(positions))]
            rest = np.zeros((len(positions), 3))
            for k in range(joints.shape[1]):
                rest += weights[:, k:k+1]*np.einsum('nij,nj->ni', matrices[joints[:, k]], homogeneous)[:, :3]
            indices = (_accessor(doc, binary, primitive['indices']).astype(np.int64).reshape(-1)
                       if 'indices' in primitive else np.arange(len(positions)))
            # Blended skin matrix per vertex: turns a rest-space move into the primitive's vertex space.
            linear = sum(weights[:, k, None, None]*matrices[joints[:, k], :3, :3] for k in range(joints.shape[1]))
            result.append({'key': f"{node['mesh']}:{number}", 'positions': rest.astype(np.float32),
                           'triangles': indices.reshape(-1, 3), 'linear': linear.astype(np.float32),
                           'joints': names[joints[np.arange(len(joints)), weights.argmax(axis=1)]]})
    return result


def _normals(positions, triangles):
    normals = np.zeros_like(positions, dtype=np.float64)
    a, b, c = (positions[triangles[:, i]].astype(np.float64) for i in range(3))
    face = np.cross(b - a, c - a)
    for i in range(3):
        np.add.at(normals, triangles[:, i], face)
    return (normals/np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)).astype(np.float32)


def _covered(positions, normals, garment, chunk=256, outside=OUTSIDE_M):
    """Body vertices with garment surface just outside them. Chunks follow height (glTF Y),
    and each chunk only meets the garment points inside its own padded box."""
    covered = np.zeros(len(positions), dtype=bool)
    reach = max(-outside[0], outside[1]) + SIDEWAYS_M
    order = np.argsort(positions[:, 1], kind='stable')
    for start in range(0, len(order), chunk):
        index = order[start:start+chunk]
        points, directions = positions[index], normals[index]
        low, high = points.min(axis=0) - reach, points.max(axis=0) + reach
        near = garment[np.all((garment >= low) & (garment <= high), axis=1)]
        if not len(near):
            continue
        offset = near[None, :, :] - points[:, None, :]
        along = np.einsum('cgk,ck->cg', offset, directions)
        sideways = np.linalg.norm(offset - along[:, :, None]*directions[:, None, :], axis=2)
        covered[index] = ((along > outside[0]) & (along < outside[1]) & (sideways < SIDEWAYS_M)).any(axis=1)
    return covered


def nearest(points, targets, reach):
    """Per point, the index of the nearest target within reach, or -1. Chunks follow height (glTF Y)."""
    points, targets = np.asarray(points, np.float64), np.asarray(targets, np.float64)
    found = np.full(len(points), -1, dtype=np.int64)
    order = np.argsort(points[:, 1], kind='stable')
    for start in range(0, len(order), 256):
        index = order[start:start+256]
        chunk = points[index]
        low, high = chunk.min(axis=0) - reach, chunk.max(axis=0) + reach
        near = np.flatnonzero(np.all((targets >= low) & (targets <= high), axis=1))
        if not len(near):
            continue
        distance = ((chunk[:, None, :] - targets[near][None, :, :])**2).sum(axis=2)
        best = distance.argmin(axis=1)
        close = distance[np.arange(len(index)), best] <= reach**2
        found[index[close]] = near[best[close]]
    return found


def press(points, skin, normals, index, allowed=None, rounds=3):
    """Moves pressing each point with a skin vertex (index >= 0) to TUCK_M outside the skin.

    The skin vertex nearest a loose garment centimetres off the skin can lie to one side of where
    the pressed point lands. Each later round anchors the point again to the skin vertex now
    nearest it (within `allowed`) and presses along that normal, so the point ends TUCK_M off the
    skin beneath it, not off a neighbour's tangent plane. Points never move outward."""
    points = np.asarray(points, np.float64)
    target, current = points.copy(), index.copy()
    found = np.flatnonzero(index >= 0)
    for round_ in range(rounds if len(found) else 0):
        if round_:
            again = nearest(target[found], skin, ANCHOR_M)
            keep = again >= 0
            if allowed is not None:
                keep &= allowed[np.maximum(again, 0)]
            current[found[keep]] = again[keep]
        normal = normals[current[found]]
        along = ((target[found] - skin[current[found]])*normal).sum(axis=1)
        target[found] -= np.maximum(along - TUCK_M, 0.)[:, None]*normal
    return target - points


# A Mixamo rig exported through some tools names its bones 'mixamorig_LeftLeg' or 'mixamorig1_LeftLeg' instead of
# 'mixamorig:LeftLeg'.
_RIG_PREFIX = re.compile(r'^(?:.*[:])?(?:mixamorig\d*_)?')


def bone_keys(names):
    """Bone names compared across skeletons: lower case, without a rig prefix ('mixamorig:LeftLeg' and
    'mixamorig_LeftLeg' are 'leftleg'). Each distinct name is matched once: a body passes one name per vertex."""
    names = np.char.lower(np.asarray(names).astype(str))
    if not names.size:
        return names
    distinct, index = np.unique(names, return_inverse=True)
    keys = np.array([_RIG_PREFIX.sub('', name, count=1) for name in distinct.tolist()], dtype=distinct.dtype)
    return keys[index].reshape(names.shape)


def _driven(primitive, *names):
    """Body vertices whose dominant bone name contains one of `names`."""
    joints = bone_keys(primitive['joints'])
    return np.any([np.char.find(joints, name) >= 0 for name in names], axis=0)


def _head(primitive):
    return _driven(primitive, 'head')


def tuck_region(slot, primitive):
    """Body vertices an inner slot may tuck over: hair only on the head (locks on the shoulders stay
    over the garment). A bottom tucks anywhere it is covered: under a top, into boots (coverage over)."""
    if slot == 'hair':
        return _head(primitive)
    return np.ones(len(primitive['positions']), bool)


def _shins(primitive):
    return np.isin(bone_keys(primitive['joints']), ('leftleg', 'rightleg'))


def tucks(body, part, slot):
    """Per part primitive key: (anchor, move). anchor: int32 per vertex, the nearest body vertex
    within ANCHOR_M as ordinal << VERTEX_BITS | vertex (ordinal: position in `body`), or -1.
    move: float32 (vertex, 3) in the primitive's own vertex space, along that body vertex's
    normal down to TUCK_M outside the skin (zero where the vertex is already that close).
    Only vertices over tuck_region(slot) tuck."""
    skin = np.concatenate([p['positions'] for p in body]).astype(np.float64)
    allowed = np.concatenate([tuck_region(slot, p) for p in body])
    normals = np.concatenate([_normals(p['positions'], p['triangles']) for p in body]).astype(np.float64)
    labels = np.concatenate([(np.int64(i) << VERTEX_BITS) + np.arange(len(p['positions']))
                             for i, p in enumerate(body)])
    result = {}
    for primitive in part:
        positions = primitive['positions'].astype(np.float64)
        index = nearest(positions, skin, HAIR_ANCHOR_M if slot == 'hair' else ANCHOR_M)
        index[index >= 0] = np.where(allowed[index[index >= 0]], index[index >= 0], -1)
        anchor = np.where(index >= 0, labels[np.maximum(index, 0)], -1)
        move = press(positions, skin, normals, index, allowed)
        pressed = np.flatnonzero(np.abs(move).sum(axis=1) > 0)
        if len(pressed):
            move[pressed] = np.linalg.solve(primitive['linear'][pressed].astype(np.float64), move[pressed, :, None])[..., 0]
        result[primitive['key']] = anchor.astype(np.int32), move.astype(np.float32)
    return result


def coverage(body, part_content, slot):
    """{hidden: {primitive key: base64 bitset of triangles}, triangles: {key: count}, covers_bottom,
    covers_head}. A part covering the head also gets over: hidden plus the head a longer reach
    finds under it, which hair tucks under. Shoes get boot and over: a bottom tucks into boots
    (covering BOOT_SHIN_SHARE of the shins; over is all of them), while low shoes (over empty)
    tuck under the bottom's hem instead, so the hem falls over a sandal strap or a sneaker collar.

    An inner slot (UNDER) also gets, per part primitive key, anchors (base64 int32 per vertex) and
    tucks (base64 float32 x, y, z per vertex) from tucks(), anchor_keys (body primitive keys by
    ordinal) and under (the outer slots). Hair hides no skin: the scalp shows between strands.
    covers_head: the part covers the upper head (a hat, a raised hood); only then does hair tuck under it.
    body: skinned_primitives() of the wardrobe body GLB (parse once, reuse for every part).
    """
    part = skinned_primitives(part_content)
    garment = np.concatenate([p['positions'] for p in part] or [np.zeros((0, 3), np.float32)])
    if len(garment) > 20000:
        garment = garment[np.random.default_rng(0).choice(len(garment), 20000, replace=False)]
    hidden, over, counts, thighs, heads, shins = {}, {}, {}, [], [], []
    for primitive in body:
        positions, triangles = primitive['positions'], primitive['triangles']
        normals = _normals(positions, triangles)
        covered = _covered(positions, normals, garment) if len(garment) else np.zeros(len(positions), bool)
        head = _head(primitive)
        # The scalp stays under a hood or hat: it stands off the head, so skin cannot show through it,
        # and a hidden scalp shows as a ragged hole through the face opening when no hair is worn.
        faces = covered[triangles].all(axis=1) & (slot != 'hair') & ~head[triangles].all(axis=1)
        counts[primitive['key']] = int(len(triangles))
        hidden[primitive['key']] = base64.b64encode(np.packbits(faces, bitorder='little').tobytes()).decode()
        legs = np.isin(bone_keys(primitive['joints']), ('leftupleg', 'rightupleg'))
        thighs.append((positions[legs, 1], covered[legs]))
        # Over the head a hat's crown or a hood's peak stands well off the scalp: a longer reach
        # decides what hair tucks under, never which skin is hidden.
        reached = covered.copy()
        if slot in ('top', 'hat') and head.any() and len(garment):
            reached[head] |= _covered(positions[head], normals[head], garment, outside=HEAD_OUTSIDE_M)
        over[primitive['key']] = base64.b64encode(np.packbits(reached[triangles].all(axis=1), bitorder='little').tobytes()).decode()
        heads.append((positions[head, 1], reached[head]))
        shins.append(covered[_shins(primitive)])
    # The lower half of the thighs: a hip-length sweater reaches the top of them, a dress the rest.
    heights = np.concatenate([height for height, _ in thighs]) if thighs else np.zeros(0)
    lower = heights < np.median(heights) if len(heights) else heights.astype(bool)
    under = np.concatenate([flags for _, flags in thighs]) if thighs else lower
    share = float(under[lower].mean()) if lower.any() else 0.
    # The upper half of the head: a raised hood or a hat covers it, a hood lying on the back does not.
    head_heights = np.concatenate([height for height, _ in heads]) if heads else np.zeros(0)
    upper = head_heights >= np.median(head_heights) if len(head_heights) else head_heights.astype(bool)
    head_covered = np.concatenate([flags for _, flags in heads]) if heads else upper
    head_share = float(head_covered[upper].mean()) if upper.any() else 0.
    value = {'slot': slot, 'hidden': hidden, 'triangles': counts,
             'covers_bottom': bool(slot == 'top' and share >= DRESS_LEG_SHARE), 'thigh_share': round(share, 3),
             'covers_head': bool(slot in ('top', 'hat') and head_share >= HEAD_SHARE), 'head_share': round(head_share, 3)}
    if value['covers_head']:
        value['over'] = over
    if slot == 'shoes':
        shin = np.concatenate(shins) if shins else np.zeros(0, bool)
        value['boot'] = bool(shin.any() and shin.mean() >= BOOT_SHIN_SHARE)
        value['over'] = hidden if value['boot'] else {}
    if slot in UNDER and not value.get('boot'):
        pressed = tucks(body, part, slot)
        value.update(under=list(UNDER[slot]), anchor_keys=[p['key'] for p in body],
                     anchors={key: base64.b64encode(anchor.astype('<i4').tobytes()).decode() for key, (anchor, _) in pressed.items()},
                     tucks={key: base64.b64encode(move.astype('<f4').tobytes()).decode() for key, (_, move) in pressed.items()})
    return value
