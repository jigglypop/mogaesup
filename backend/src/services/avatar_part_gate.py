"""Seal-time quality gate of fitted wardrobe parts.

Plain numpy over the exported GLBs, so the Blender worker runs it on the files it is about to seal and anyone can run it
on sealed ones (gate_part). A refused part is withdrawn from its assembly like any slot that fails a later step: it is
reported available false with the refusal's code, which operators see in the wardrobe's unavailable list, and members
never get it. The checks and their limits were measured on the 153 parts the wardrobe offered on 2026-10-06, labelled
by looking at each worn in the island's own clips (.data/models-audit/labels.json): none of the 133 sound ones is
refused, with room to spare on every limit (the nearest sound value is given beside each).

Positions are glTF's (Y up, +Z the front), metres, in the rest pose the parts are bound in.
"""
import math
import re

import numpy as np

from src.services.glb import parse_glb

REVISION = 'part-gate-v1'
GATED_SLOTS = ('top', 'bottom', 'shoes', 'hat', 'hair')

# Shoes. The wardrobe hides the skin under a part (avatar_wardrobe_coverage); a shoe has to hide its foot.
SHOE_MIN_COVER = .5        # of either foot's skin (sound pairs: 78% and up)
SHOE_MAX_COVER_GAP = .2    # between the two feet (sound pairs: 3 points at most)
TOE_TIP_SHARE = .3         # the toes' foremost skin ...
SHOE_MIN_TOE_COVER = .7    # ... a closed shoe hides (sound pairs: 94% and up; toes out through the front: 35-42%)
SHOE_MIN_PIECE_RATIO = .8  # the smaller shoe's main piece against the other's (sound pairs: .976 and up; a sandal
                           # broken into three pieces .62)
# Head parts, as shares of the head's height (its skin, chin to crown) and half its width.
EYE_BAND = (.25, .49)      # the eyes, measured on the bodies' face textures
EYE_COLUMNS = (.25, .62)   # each eye's span from the face's middle line
HAT_MIN_EYE_LINE = .6      # a hat's lowest point over the eyes (sound hats: .684 and up; over the brows .554)
HAIR_MAX_EYE_COVER = .4    # of either eye hidden by hair in front of it (sound hair: .17 at most; bangs over the
                           # eyes .63)
RASTER_M = .003
# Garments.
TORN_EDGES = .014          # edges of more than two faces, per edge (sound tops and bottoms: .0094 at most)
HOLE_SHARE = .06           # area of the holes in the garment against the garment (sound: .025 at most)
HOLE_PERIMETER_M = .5      # a loop longer than this is an opening (a hem, a waist) however it lies
# A top without a hood whose vertices out past the shoulders, low beside the jaw, follow the head: the top of a puffy
# sleeve that took the overhanging SD head's weights stands up as a plank when the arms come down. Share of the top's
# vertices out past the shoulder joints by SHOULDER_PAST_M and under HEAD_LOW of the head's height (sound tops: .0006
# at most; the plank .0037). A top with a hood (head-bound vertices over the head's middle) is not measured.
TOP_HEAD_BEYOND = .002
SHOULDER_PAST_M = .05
HEAD_LOW = .25
# A hair's rear backing (the sheet avatar_hair_geometry.repair_hair_backing adds behind the head along the rear
# drawing's outline) reaching below the knees hangs behind the body as a stepped curtain down to the floor (sound
# backings ended 14 cm or more above the knees, the two broken ones 13 and 25 cm below them).

_COMPONENTS = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_WIDTH = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
_RIG_PREFIX = re.compile(r'^(?:.*[:])?(?:mixamorig\d*_)?')


class PartRefusal(ValueError):
    """A fitted part that is not offered: `code` names why, for the operator (the part's unavailable_reason)."""
    code = 'quality_refused'

    def __init__(self, message, code=None):
        super().__init__(message)
        if code:
            self.code = code


def bone_key(name):
    """A bone name as compared across skeletons (avatar_blender_common.bone_key)."""
    return _RIG_PREFIX.sub('', str(name).lower(), count=1)


# Reading a skinned GLB ------------------------------------------------------------------------------------------------

def _accessor(doc, binary, index):
    item = doc['accessors'][index]
    view = doc['bufferViews'][item['bufferView']]
    dtype = np.dtype(_COMPONENTS[item['componentType']])
    width = _WIDTH[item['type']]
    start = view.get('byteOffset', 0) + item.get('byteOffset', 0)
    stride = view.get('byteStride') or dtype.itemsize*width
    raw = np.frombuffer(binary, dtype=np.uint8, count=stride*(item['count'] - 1) + dtype.itemsize*width, offset=start)
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
    matrix[:3, :3] = np.array([[1 - 2*(y*y + z*z), 2*(x*y - z*w), 2*(x*z + y*w)],
                               [2*(x*y + z*w), 1 - 2*(x*x + z*z), 2*(y*z - x*w)],
                               [2*(x*z - y*w), 2*(y*z + x*w), 1 - 2*(x*x + y*y)]])*np.array(node.get('scale', [1, 1, 1]))
    matrix[:3, 3] = node.get('translation', [0, 0, 0])
    return matrix


class Skinned:
    """The skinned meshes of a GLB in their rest pose: per primitive its points, triangles, dominant bone keys and the
    extras of its node; and every joint's rest position by bone key."""

    def __init__(self, content):
        doc, binary = parse_glb(content)
        nodes = doc.get('nodes', [])
        parent = {child: index for index, node in enumerate(nodes) for child in node.get('children', [])}
        world = {}

        def world_of(index, depth=0):
            if index not in world:
                if depth > len(nodes):
                    raise ValueError('The node tree has a cycle')
                above = world_of(parent[index], depth + 1) if index in parent else np.eye(4)
                world[index] = above @ _local(nodes[index])
            return world[index]
        self.joints, self.primitives = {}, []
        for index, node in enumerate(nodes):
            if 'mesh' not in node or 'skin' not in node:
                continue
            skin = doc['skins'][node['skin']]
            names = [nodes[joint].get('name', '') for joint in skin['joints']]
            keys = np.array([bone_key(name) for name in names] or [''])
            for joint, key in zip(skin['joints'], keys.tolist()):
                self.joints.setdefault(key, world_of(joint)[:3, 3].copy())
            inverse = _accessor(doc, binary, skin['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)
            matrices = np.stack([world_of(joint) for joint in skin['joints']]) @ inverse
            for number, primitive in enumerate(doc['meshes'][node['mesh']]['primitives']):
                attributes = primitive.get('attributes', {})
                if primitive.get('mode', 4) != 4 or not {'POSITION', 'JOINTS_0', 'WEIGHTS_0'} <= set(attributes):
                    continue
                positions = _accessor(doc, binary, attributes['POSITION'])
                joints = _accessor(doc, binary, attributes['JOINTS_0']).astype(np.int64)
                weights = _accessor(doc, binary, attributes['WEIGHTS_0'])
                weights /= np.maximum(weights.sum(axis=1, keepdims=True), 1e-12)
                homogeneous = np.c_[positions, np.ones(len(positions))]
                rest = np.zeros((len(positions), 3))
                for k in range(joints.shape[1]):
                    rest += weights[:, k:k + 1]*np.einsum('nij,nj->ni', matrices[joints[:, k]], homogeneous)[:, :3]
                triangles = (_accessor(doc, binary, primitive['indices']).astype(np.int64).reshape(-1, 3)
                             if 'indices' in primitive else np.arange(len(positions) - len(positions) % 3).reshape(-1, 3))
                dominant = keys[joints[np.arange(len(joints)), weights.argmax(axis=1)]]
                self.primitives.append({'points': rest, 'triangles': triangles, 'keys': dominant,
                                        'extras': node.get('extras') if isinstance(node.get('extras'), dict) else {}})
        if not self.primitives:
            raise ValueError('No skinned mesh')

    def points(self, select=lambda primitive: True):
        rows = [p['points'] for p in self.primitives if select(p)]
        return np.concatenate(rows) if rows else np.zeros((0, 3))

    def mesh(self, select=lambda primitive: True):
        """(points, triangles, dominant keys) of the chosen primitives as one mesh."""
        points, triangles, keys, offset = [], [], [], 0
        for primitive in self.primitives:
            if select(primitive):
                points.append(primitive['points']); keys.append(primitive['keys'])
                triangles.append(primitive['triangles'] + offset); offset += len(primitive['points'])
        if not points:
            return np.zeros((0, 3)), np.zeros((0, 3), np.int64), np.zeros(0, str)
        return np.concatenate(points), np.concatenate(triangles), np.concatenate(keys)


# Mesh measurements ----------------------------------------------------------------------------------------------------

def weld(points, triangles):
    """(welded points, triangles over them without degenerate ones, the source vertex of each welded one): vertices
    at one position are one (a UV seam splits a vertex into several)."""
    points = np.asarray(points, float).reshape(-1, 3)
    if not len(points):
        return points, np.zeros((0, 3), np.int64), np.zeros(0, np.int64)
    _, first, same = np.unique(np.round(points/1e-6).astype(np.int64), axis=0, return_index=True, return_inverse=True)
    same = np.asarray(same).reshape(-1)
    triangles = same[np.asarray(triangles, np.int64).reshape(-1, 3)]
    keep = ((triangles[:, 0] != triangles[:, 1]) & (triangles[:, 1] != triangles[:, 2])
            & (triangles[:, 0] != triangles[:, 2]))
    return points[first], triangles[keep], first


def edge_counts(triangles):
    """(unique edges (m, 2), how many triangles each borders)."""
    edges = np.sort(np.concatenate([triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]]), axis=1)
    if not len(edges):
        return np.zeros((0, 2), np.int64), np.zeros(0, np.int64)
    unique, counts = np.unique(edges, axis=0, return_counts=True)
    return unique, counts


def components(triangles, count):
    """Per vertex the label of its connected piece (vertices no triangle uses keep their own)."""
    label = np.arange(count)
    if not len(triangles):
        return label
    edges = np.concatenate([triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]])
    while True:
        low = np.minimum(label[edges[:, 0]], label[edges[:, 1]])
        merged = label.copy()
        np.minimum.at(merged, edges[:, 0], low)
        np.minimum.at(merged, edges[:, 1], low)
        merged = merged[merged]
        if np.array_equal(merged, label):
            return label
        label = merged


def triangle_areas(points, triangles):
    a, b, c = (points[triangles[:, i]] for i in range(3))
    return .5*np.linalg.norm(np.cross(b - a, c - a), axis=1)


def vertex_normals(points, triangles):
    normals = np.zeros_like(points)
    a, b, c = (points[triangles[:, i]] for i in range(3))
    face = np.cross(b - a, c - a)
    for i in range(3):
        np.add.at(normals, triangles[:, i], face)
    return normals/np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)


def nearest(points, targets, chunk=256):
    """(distance, index) of the nearest target of each point."""
    points, targets = np.asarray(points, float), np.asarray(targets, float)
    distance, index = np.empty(len(points)), np.zeros(len(points), np.int64)
    squares = (targets**2).sum(axis=1)
    for start in range(0, len(points), chunk):
        block = points[start:start + chunk]
        d = (block**2).sum(axis=1)[:, None] - 2*block @ targets.T + squares[None, :]
        index[start:start + chunk] = d.argmin(axis=1)
        distance[start:start + chunk] = np.sqrt(np.maximum(d[np.arange(len(block)), index[start:start + chunk]], 0))
    return distance, index


def boundary_loops(edges):
    """Vertex cycles of the boundary edges (a vertex where several loops meet is walked out of in edge order)."""
    neighbours = {}
    for a, b in edges.tolist():
        neighbours.setdefault(a, []).append(b)
        neighbours.setdefault(b, []).append(a)
    used, loops = set(), []
    for a, b in edges.tolist():
        if (min(a, b), max(a, b)) in used:
            continue
        loop = [a, b]
        used.add((min(a, b), max(a, b)))
        current = b
        while True:
            step = next((c for c in neighbours[current] if (min(current, c), max(current, c)) not in used), None)
            if step is None or step == loop[0]:
                if step is not None:
                    used.add((min(current, step), max(current, step)))
                break
            used.add((min(current, step), max(current, step)))
            loop.append(step)
            current = step
        loops.append(loop)
    return loops


def raster(points, triangles, low, high, step=RASTER_M):
    """The nearest-the-viewer Z (front view, looking along -Z) of triangles over the XY box low..high, -inf where
    none lies: each triangle sampled finer than `step`."""
    shape = (max(1, int(math.ceil((high[1] - low[1])/step))), max(1, int(math.ceil((high[0] - low[0])/step))))
    depth = np.full(shape, -np.inf)
    a, b, c = (points[triangles[:, i]] for i in range(3))
    lowest, highest = np.minimum(np.minimum(a, b), c), np.maximum(np.maximum(a, b), c)
    over = ((highest[:, 0] >= low[0]) & (lowest[:, 0] <= high[0]) & (highest[:, 1] >= low[1])
            & (lowest[:, 1] <= high[1]))
    a, b, c = a[over], b[over], c[over]
    if not len(a):
        return depth
    longest = np.maximum(np.maximum(np.linalg.norm(b - a, axis=1), np.linalg.norm(c - b, axis=1)),
                         np.linalg.norm(a - c, axis=1))
    steps = np.clip(np.ceil(longest/(step*.5)).astype(int), 1, 64)
    for n in np.unique(steps).tolist():
        chosen = steps == n
        i, j = np.meshgrid(np.arange(n + 1), np.arange(n + 1))
        inside = i + j <= n
        u, v = i[inside]/n, j[inside]/n
        samples = (a[chosen][:, None, :]*(1 - u - v)[None, :, None] + b[chosen][:, None, :]*u[None, :, None]
                   + c[chosen][:, None, :]*v[None, :, None]).reshape(-1, 3)
        column = ((samples[:, 0] - low[0])/step).astype(int)
        row = ((samples[:, 1] - low[1])/step).astype(int)
        inside = (column >= 0) & (column < shape[1]) & (row >= 0) & (row < shape[0])
        np.maximum.at(depth, (row[inside], column[inside]), samples[inside, 2])
    return depth


# The body ------------------------------------------------------------------------------------------------------------

class Body:
    """The wardrobe body a part is checked against."""

    def __init__(self, content):
        model = Skinned(content)
        self.points, self.triangles, self.keys = model.mesh()
        self.normals = vertex_normals(self.points, self.triangles)
        self.joints = model.joints
        head = self.points[self.keys == 'head']
        self.head = (head.min(axis=0), head.max(axis=0)) if len(head) else None

    def head_share(self, y):
        low, high = self.head
        return float((y - low[1])/max(high[1] - low[1], 1e-9))

    def eye_boxes(self):
        """The two eyes' boxes in the front view ((x, y) low, (x, y) high), from the head's proportions."""
        low, high = self.head
        height, half, middle = high[1] - low[1], (high[0] - low[0])/2, (high[0] + low[0])/2
        y0, y1 = low[1] + EYE_BAND[0]*height, low[1] + EYE_BAND[1]*height
        boxes = []
        for sign in (1, -1):
            inner, outer = middle + sign*EYE_COLUMNS[0]*half, middle + sign*EYE_COLUMNS[1]*half
            boxes.append((np.array([min(inner, outer), y0]), np.array([max(inner, outer), y1])))
        return boxes


# The checks ----------------------------------------------------------------------------------------------------------

def _covered(skin, normals, garment):
    from src.services.avatar_wardrobe_coverage import _covered as covered
    return covered(skin.astype(np.float32), normals.astype(np.float32), garment.astype(np.float32))


def _side(keys):
    return np.where(np.char.startswith(keys.astype(str), 'left'), 'left',
                    np.where(np.char.startswith(keys.astype(str), 'right'), 'right', ''))


def check_shoes(part, body):
    measured, refusals = {}, []
    points, triangles, keys = part.mesh()
    sides = _side(keys)
    cover, toes = {}, {}
    for side in ('left', 'right'):
        foot = np.isin(body.keys, (side + 'foot', side + 'toebase', side + 'toe_end'))
        toe = np.isin(body.keys, (side + 'toebase', side + 'toe_end'))
        shoe = points[sides == side]
        if not foot.any():
            continue
        if len(shoe) > 20000:
            shoe = shoe[np.linspace(0, len(shoe) - 1, 20000).astype(int)]
        covered = (_covered(body.points[foot], body.normals[foot], shoe) if len(shoe)
                   else np.zeros(int(foot.sum()), bool))
        cover[side] = float(covered.mean())
        if toe.any():
            forward = body.points[toe, 2]
            tip = np.flatnonzero(toe)[forward >= np.quantile(forward, 1 - TOE_TIP_SHARE)]
            toes[side] = float(_covered(body.points[tip], body.normals[tip], shoe).mean()) if len(shoe) else 0.
    measured.update(foot_cover=cover, toe_tip_cover=toes)
    detail = ', '.join(f'{side} {share:.0%}' for side, share in sorted(cover.items()))
    if cover and min(cover.values()) < SHOE_MIN_COVER:
        refusals.append(('shoes_incomplete', f'A shoe leaves its foot bare (covered skin: {detail})'))
    elif len(cover) == 2 and max(cover.values()) - min(cover.values()) > SHOE_MAX_COVER_GAP:
        refusals.append(('shoes_incomplete', f'One shoe of the pair is incomplete (covered skin: {detail})'))
    if toes and min(toes.values()) < SHOE_MIN_TOE_COVER:
        refusals.append(('shoes_toes_exposed', 'The toes come out of the shoes (covered toe tips: '
                         + ', '.join(f'{side} {share:.0%}' for side, share in sorted(toes.items())) + ')'))
    # Each shoe's main piece: a pair whose two shoes are not one piece alike has one shoe in fragments.
    welded, joined, first = weld(points, triangles)
    if len(joined):
        side_of = sides[first]
        label = components(joined, len(welded))
        area = triangle_areas(welded, joined)
        main = {}
        for piece in np.unique(label[joined[:, 0]]).tolist():
            faces = label[joined[:, 0]] == piece
            vertices = np.unique(joined[faces])
            left = float((side_of[vertices] == 'left').mean())
            side = 'left' if left >= .5 else 'right'
            main[side] = max(main.get(side, 0.), float(area[faces].sum()))
        if len(main) == 2:
            ratio = min(main.values())/max(max(main.values()), 1e-12)
            measured['main_piece_ratio'] = ratio
            if ratio < SHOE_MIN_PIECE_RATIO:
                refusals.append(('shoes_broken', f'One shoe is in pieces (its main piece is {ratio:.0%} of the other)'))
    return measured, refusals


def eye_cover(part_points, part_triangles, body):
    """Per eye, the share of it (front view) that the part hides in front of the face."""
    shares = []
    for low, high in body.eye_boxes():
        face = raster(body.points, body.triangles, low, high)
        worn = raster(part_points, part_triangles, low, high)
        skin = np.isfinite(face)
        shares.append(float(((worn > face + .001) & skin).sum()/max(int(skin.sum()), 1)))
    return shares


def check_hat(part, body):
    points, _, _ = part.mesh()
    low, high = body.head
    middle, half, centre_z = (low[0] + high[0])/2, (high[0] - low[0])/2, (low[2] + high[2])/2
    over_eyes = (points[:, 2] > centre_z) & (np.abs(points[:, 0] - middle) <= EYE_COLUMNS[1]*half)
    if not over_eyes.any():
        return {'eye_line': None}, []
    line = body.head_share(points[over_eyes, 1].min())
    refusals = []
    if line < HAT_MIN_EYE_LINE:
        refusals.append(('hat_covers_eyes', f'The hat comes down over the eyes (to {line:.0%} of the head\'s height)'))
    return {'eye_line': line}, refusals


def check_hair(part, body):
    measured, refusals = {}, []
    points, triangles, _ = part.mesh()
    shares = eye_cover(points, triangles, body)
    measured['eye_cover'] = shares
    if max(shares) > HAIR_MAX_EYE_COVER:
        refusals.append(('hair_covers_eyes', 'The hair hides the eyes ('
                         + ', '.join(f'{share:.0%}' for share in shares) + ')'))
    backing = part.points(lambda primitive: bool(primitive['extras'].get('scalp_backing')))
    knees = [body.joints[key][1] for key in ('leftleg', 'rightleg') if key in body.joints]
    if len(backing) and knees:
        below = float(sum(knees)/len(knees) - backing[:, 1].min())
        measured['backing_below_knees_m'] = below
        if below > 0:
            refusals.append(('hair_backing_overhang', f'The rear backing of the hair hangs {below*100:.0f} cm below '
                                                      'the knees'))
    return measured, refusals


def check_garment(part, body):
    measured, refusals = {}, []
    points, triangles, _ = weld(*part.mesh()[:2])
    edges, counts = edge_counts(triangles)
    if not len(edges):
        return measured, refusals
    torn = float((counts > 2).sum()/len(edges))
    measured['torn_edges'] = torn
    if torn > TORN_EDGES:
        refusals.append(('torn_surface', f'The surface is torn ({torn:.1%} of its edges join more than two faces)'))
    area = float(triangle_areas(points, triangles).sum())
    holes = 0.
    for loop in boundary_loops(edges[counts == 1]):
        if len(loop) < 3:
            continue
        ring = points[loop]
        perimeter = float(np.linalg.norm(np.roll(ring, -1, axis=0) - ring, axis=1).sum())
        if perimeter >= HOLE_PERIMETER_M:
            continue
        centre = ring.mean(axis=0)
        # An opening a limb, the neck or the waist passes through has its middle inside the body.
        _, index = nearest(centre[None], body.points)
        if float((centre - body.points[index[0]]) @ body.normals[index[0]]) <= 0:
            continue
        holes += .5*float(np.linalg.norm(np.cross(ring - centre, np.roll(ring, -1, axis=0) - centre).sum(axis=0)))
    measured['hole_share'] = holes/max(area, 1e-12)
    if measured['hole_share'] > HOLE_SHARE:
        refusals.append(('holes', f'The garment has holes ({measured["hole_share"]:.0%} of its area)'))
    return measured, refusals


def check_top(part, body):
    measured, refusals = check_garment(part, body)
    shoulders = [body.joints.get(key) for key in ('leftarm', 'rightarm')]
    if body.head is None or any(joint is None for joint in shoulders):
        return measured, refusals
    points, _, keys = part.mesh()
    low, high = body.head
    height = high[1] - low[1]
    middle, reach = (shoulders[0][0] + shoulders[1][0])/2, abs(shoulders[0][0] - shoulders[1][0])/2
    follows_head = np.isin(keys, ('head', 'neck'))
    if (follows_head & (points[:, 1] > low[1] + .5*height)).any():
        return measured, refusals   # a hood
    beyond = float((follows_head & (np.abs(points[:, 0] - middle) > reach + SHOULDER_PAST_M)
                    & (points[:, 1] < low[1] + HEAD_LOW*height)).mean()) if len(points) else 0.
    measured['head_beyond_shoulders'] = beyond
    if beyond > TOP_HEAD_BEYOND:
        refusals.append(('stray_geometry', 'Part of the top out past the shoulders follows the head (it stands up '
                                           'when the arms come down)'))
    return measured, refusals


CHECKS = {'shoes': check_shoes, 'hat': check_hat, 'hair': check_hair, 'top': check_top, 'bottom': check_garment}


def gate_part(slot, part_content, body_content=None, *, body=None):
    """The gate's receipt of one fitted part: {'revision', 'measured', 'refusal': {code, message} or None}, with
    'skipped' (and no refusal) when the slot has no checks or its files cannot be measured. `body`: a Body already
    read, for checking several parts of one body."""
    receipt = {'revision': REVISION, 'measured': {}, 'refusal': None}
    if slot not in CHECKS:
        return {**receipt, 'skipped': 'slot'}
    try:
        body = body or Body(body_content)
        if body.head is None and slot in ('hat', 'hair'):
            return {**receipt, 'skipped': 'no_head'}
        measured, refusals = CHECKS[slot](Skinned(part_content), body)
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        return {**receipt, 'skipped': 'unreadable', 'error': type(exc).__name__}
    receipt['measured'] = _rounded(measured)
    if refusals:
        code, message = refusals[0]
        receipt['refusal'] = {'code': code, 'message': message}
        receipt['refusals'] = [code for code, _ in refusals]
    return receipt


def refusal(receipt):
    """The PartRefusal a gate receipt carries, or None."""
    found = receipt.get('refusal') if isinstance(receipt, dict) else None
    return PartRefusal(found['message'], found['code']) if found else None


def _rounded(value):
    if isinstance(value, dict):
        return {key: _rounded(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_rounded(item) for item in value]
    if isinstance(value, float):
        return round(value, 4)
    return value

