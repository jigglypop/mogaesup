"""The seal's quality gate (avatar_part_gate) on small skinned GLBs written here: a body of boxes and parts made to pass
or to fail each check."""
import json

import numpy as np
import pytest

from src.services import avatar_part_gate as gate
from src.services.glb import build_glb

# Joints in the rest pose, glTF frame (Y up, +Z the front).
JOINTS = {'Hips': (0, .44, 0), 'Spine': (0, .5, 0), 'neck': (0, .58, 0), 'Head': (0, .63, 0),
          'LeftArm': (.107, .65, 0), 'LeftHand': (.4, .65, 0), 'RightArm': (-.107, .65, 0), 'RightHand': (-.4, .65, 0),
          'LeftUpLeg': (.06, .4, 0), 'LeftLeg': (.06, .23, 0), 'LeftFoot': (.06, .07, 0), 'LeftToeBase': (.06, .025, .1),
          'RightUpLeg': (-.06, .4, 0), 'RightLeg': (-.06, .23, 0), 'RightFoot': (-.06, .07, 0),
          'RightToeBase': (-.06, .025, .1)}
NAMES = list(JOINTS)


def box(low, high, n=6, faces=('x-', 'x+', 'y-', 'y+', 'z-', 'z+')):
    """A box surface of n x n quads a side (faces may be left out): (points, triangles), normals outward."""
    low, high = np.asarray(low, float), np.asarray(high, float)
    points, triangles = [], []
    for face in faces:
        axis, side = 'xyz'.index(face[0]), face[1] == '+'
        u, v = [a for a in range(3) if a != axis]
        start = len(points)
        for i in range(n + 1):
            for j in range(n + 1):
                p = low.copy()
                p[axis] = high[axis] if side else low[axis]
                p[u] = low[u] + (high[u] - low[u])*i/n
                p[v] = low[v] + (high[v] - low[v])*j/n
                points.append(p)
        for i in range(n):
            for j in range(n):
                a, b, c, d = (start + i*(n + 1) + j, start + (i + 1)*(n + 1) + j,
                              start + (i + 1)*(n + 1) + j + 1, start + i*(n + 1) + j + 1)
                # Counter-clockwise seen from outside.
                flip = (axis == 1) != side
                triangles += [(a, b, c), (a, c, d)] if flip else [(a, c, b), (a, d, c)]
    return np.array(points), np.array(triangles)


def pieces(*items):
    """[(points, triangles, joint)] joined: (points, triangles, joint per vertex)."""
    points, triangles, joints, offset = [], [], [], 0
    for item_points, item_triangles, joint in items:
        points.append(item_points); triangles.append(item_triangles + offset)
        joints += [joint]*len(item_points); offset += len(item_points)
    return np.concatenate(points), np.concatenate(triangles), joints


def glb(*meshes):
    """A GLB whose skinned meshes are `meshes`: (points, triangles, joint names per vertex[, node extras])."""
    blob, views, accessors = bytearray(), [], []

    def add(array, kind, component, count, target=None):
        data = np.ascontiguousarray(array).tobytes()
        blob.extend(b'\0'*(-len(blob) % 4))
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data), **({'target': target} if target else {})})
        blob.extend(data)
        accessors.append({'bufferView': len(views) - 1, 'componentType': component, 'count': count, 'type': kind})
        return len(accessors) - 1
    nodes = [{'name': name, 'translation': list(position)} for name, position in JOINTS.items()]
    inverse = np.stack([np.linalg.inv(np.block([[np.eye(3), np.array(p, float)[:, None]], [np.zeros((1, 3)), np.ones((1, 1))]]))
                        for p in JOINTS.values()]).transpose(0, 2, 1).astype(np.float32)
    skin = {'joints': list(range(len(NAMES))), 'inverseBindMatrices': add(inverse, 'MAT4', 5126, len(NAMES))}
    doc_meshes = []
    for mesh in meshes:
        points, triangles, joints = mesh[:3]
        extras = mesh[3] if len(mesh) > 3 else None
        index = np.zeros((len(points), 4), np.uint8)
        index[:, 0] = [NAMES.index(joint) for joint in joints]
        weights = np.zeros((len(points), 4), np.float32); weights[:, 0] = 1.
        primitive = {'attributes': {'POSITION': add(np.asarray(points, np.float32), 'VEC3', 5126, len(points)),
                                    'JOINTS_0': add(index, 'VEC4', 5121, len(points)),
                                    'WEIGHTS_0': add(weights, 'VEC4', 5126, len(points))},
                     'indices': add(np.asarray(triangles, np.uint32), 'SCALAR', 5125, len(triangles)*3)}
        doc_meshes.append({'primitives': [primitive]})
        nodes.append({'name': f'mesh_{len(doc_meshes)}', 'mesh': len(doc_meshes) - 1, 'skin': 0,
                      **({'extras': extras} if extras else {})})
    doc = {'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}], 'nodes': nodes,
           'meshes': doc_meshes, 'skins': [skin], 'accessors': accessors, 'bufferViews': views,
           'buffers': [{'byteLength': len(blob)}]}
    return build_glb(doc, bytes(blob))


def foot(side):
    x = .06 if side == 'Left' else -.06
    return [(*box((x - .03, 0, -.04), (x + .03, .07, .06)), f'{side}Foot'),
            (*box((x - .03, 0, .06), (x + .03, .04, .12)), f'{side}ToeBase')]


BODY = glb(pieces(
    (*box((-.27, .6, -.25), (.27, 1.2, .25), 8), 'Head'),
    (*box((-.1, .44, -.08), (.1, .6, .08)), 'Spine'),
    (*box((.03, .07, -.03), (.09, .44, .03)), 'LeftLeg'), (*box((-.09, .07, -.03), (-.03, .44, .03)), 'RightLeg'),
    *foot('Left'), *foot('Right')))


@pytest.fixture(scope='module')
def body():
    return gate.Body(BODY)


def check(slot, part, body):
    return gate.gate_part(slot, part, body=body)


def code(receipt):
    return (receipt['refusal'] or {}).get('code')


def shoe(side, *, toe=True, front=.13):
    x = .06 if side == 'Left' else -.06
    upper = box((x - .035, -.005, -.045), (x + .035, .085, front - .06 if not toe else .07))
    items = [(*upper, f'{side}Foot')]
    if toe:
        items.append((*box((x - .035, -.005, .07), (x + .035, .05, front)), f'{side}Foot'))
    return items


def test_a_pair_that_covers_both_feet_passes(body):
    receipt = check('shoes', glb(pieces(*shoe('Left'), *shoe('Right'))), body)
    assert code(receipt) is None and receipt['measured']['main_piece_ratio'] == pytest.approx(1.)
    assert min(receipt['measured']['foot_cover'].values()) > .9 and min(receipt['measured']['toe_tip_cover'].values()) > .9


def test_a_pair_with_one_shoe_missing_is_incomplete(body):
    receipt = check('shoes', glb(pieces(*shoe('Left'))), body)
    assert code(receipt) == 'shoes_incomplete' and receipt['measured']['foot_cover']['right'] == 0.


def test_shoes_the_toes_come_out_of_are_refused(body):
    receipt = check('shoes', glb(pieces(*shoe('Left', toe=False), *shoe('Right', toe=False))), body)
    assert code(receipt) == 'shoes_toes_exposed'
    assert receipt['measured']['toe_tip_cover']['left'] < gate.SHOE_MIN_TOE_COVER


def test_a_pair_with_one_shoe_in_pieces_is_broken(body):
    # The left shoe's toe box lies apart from its upper: two pieces, while the right shoe is one.
    left = [(*box((.025, -.005, -.045), (.095, .085, .06)), 'LeftFoot'),
            (*box((.025, -.005, .065), (.095, .05, .13)), 'LeftFoot')]
    receipt = check('shoes', glb(pieces(*left, *shoe('Right'))), body)
    assert code(receipt) == 'shoes_broken' and receipt['measured']['main_piece_ratio'] < gate.SHOE_MIN_PIECE_RATIO


def cap(low_front):
    """A cap over the head: its front (over the eyes) down to `low_front`, its back to the neck."""
    crown = box((-.29, .95, -.27), (.29, 1.27, .27), 6, faces=('x-', 'x+', 'y+', 'z-'))
    front = box((-.29, low_front, .27), (.29, 1.27, .29), 6)
    return glb(pieces((*crown, 'Head'), (*front, 'Head')))


def test_a_hat_above_the_eyes_passes_and_one_over_them_is_refused(body):
    line = .6 + gate.HAT_MIN_EYE_LINE*.6
    assert code(check('hat', cap(line + .03), body)) is None
    receipt = check('hat', cap(line - .03), body)
    assert code(receipt) == 'hat_covers_eyes' and receipt['measured']['eye_line'] < gate.HAT_MIN_EYE_LINE


def test_hair_in_front_of_the_eyes_is_refused_and_bangs_above_them_pass(body):
    scalp = (*box((-.28, .9, -.26), (.28, 1.21, .26), 6), 'Head')
    low, high = .6 + .25*.6, .6 + .49*.6
    bangs = (*box((-.2, high + .01, .26), (.2, .95, .28), 4), 'Head')
    curtain = (*box((-.2, low - .02, .26), (.2, .95, .28), 6), 'Head')
    assert code(check('hair', glb(pieces(scalp, bangs)), body)) is None
    receipt = check('hair', glb(pieces(scalp, curtain)), body)
    assert code(receipt) == 'hair_covers_eyes' and min(receipt['measured']['eye_cover']) > .9


def test_a_rear_backing_hanging_below_the_knees_is_refused(body):
    scalp = pieces((*box((-.28, .9, -.26), (.28, 1.21, .26), 6), 'Head'))
    short = pieces((*box((-.2, .4, -.3), (.2, 1., -.28), 4), 'Head'))
    long = pieces((*box((-.2, .05, -.3), (.2, 1., -.28), 4), 'Head'))
    assert code(check('hair', glb(scalp, (*short, {'scalp_backing': True})), body)) is None
    receipt = check('hair', glb(scalp, (*long, {'scalp_backing': True})), body)
    assert code(receipt) == 'hair_backing_overhang'
    assert receipt['measured']['backing_below_knees_m'] == pytest.approx(.23 - .05, abs=1e-6)
    # The same sheet as part of the hair itself (long locks) is not a backing.
    assert code(check('hair', glb(scalp, long), body)) is None


def tube(low, high, n=6):
    """A sleeveless top: the torso's four sides, open at the neck and the hem."""
    return box(low, high, n, faces=('x-', 'x+', 'z-', 'z+'))


def test_a_sound_top_passes(body):
    receipt = check('top', glb(pieces((*tube((-.12, .42, -.1), (.12, .62, .1)), 'Spine'))), body)
    assert code(receipt) is None and receipt['measured'] == {'torn_edges': 0., 'hole_share': 0.,
                                                             'head_beyond_shoulders': 0.}


def test_a_shredded_top_is_torn(body):
    points, triangles = tube((-.12, .42, -.1), (.12, .62, .1))
    # Flaps hanging off the front's edges: each edge then borders three faces.
    front = np.flatnonzero(np.isclose(points[:, 2], .1))
    flaps = [(a, b, len(points) + k) for k, (a, b) in enumerate(zip(front[:-1], front[1:]))]
    extra = points[front[:-1]] + (0, 0, .02)
    receipt = check('top', glb(pieces((np.concatenate([points, extra]), np.concatenate([triangles, flaps]), 'Spine'))),
                    body)
    assert code(receipt) == 'torn_surface' and receipt['measured']['torn_edges'] > gate.TORN_EDGES


def test_a_top_with_holes_through_it_is_refused(body):
    points, triangles = tube((-.12, .42, -.1), (.12, .62, .1), 8)
    centres = points[triangles].mean(axis=1)
    # A window cut out of the front and one out of the back.
    window = (np.abs(centres[:, 2]) > .09) & (np.abs(centres[:, 0]) < .06) & (centres[:, 1] > .47) & (centres[:, 1] < .57)
    receipt = check('top', glb(pieces((points, triangles[~window], 'Spine'))), body)
    assert code(receipt) == 'holes' and receipt['measured']['hole_share'] > gate.HOLE_SHARE


def test_a_sleeve_top_that_follows_the_head_is_stray_geometry(body):
    torso = (*tube((-.12, .42, -.1), (.12, .62, .1)), 'Spine')
    plank = (*box((.2, .66, -.02), (.3, .72, .02), 4), 'Head')
    receipt = check('top', glb(pieces(torso, plank)), body)
    assert code(receipt) == 'stray_geometry'
    # A hood follows the head over the head's middle and is not measured.
    hood = (*box((-.29, .95, -.27), (.29, 1.25, -.25), 4), 'Head')
    assert code(check('top', glb(pieces(torso, plank, hood)), body)) is None


def test_a_slot_without_checks_or_an_unreadable_file_is_skipped(body):
    assert gate.gate_part('glasses', b'', body=body)['skipped'] == 'slot'
    receipt = gate.gate_part('top', b'not a glb', BODY)
    assert receipt['skipped'] == 'unreadable' and receipt['refusal'] is None
    receipt = gate.gate_part('hat', cap(1.), glb(pieces((*box((-.1, .4, -.1), (.1, .6, .1)), 'Spine'))))
    assert receipt['skipped'] == 'no_head'


def test_a_refusal_is_a_part_refusal_with_its_code(body):
    refusal = gate.refusal(check('shoes', glb(pieces(*shoe('Left'))), body))
    assert isinstance(refusal, gate.PartRefusal) and isinstance(refusal, ValueError)
    assert refusal.code == 'shoes_incomplete' and 'foot bare' in str(refusal)
    assert gate.refusal({'refusal': None}) is None


def test_the_receipt_is_plain_json(body):
    receipt = check('shoes', glb(pieces(*shoe('Left'), *shoe('Right'))), body)
    assert json.loads(json.dumps(receipt)) == receipt and receipt['revision'] == gate.REVISION
