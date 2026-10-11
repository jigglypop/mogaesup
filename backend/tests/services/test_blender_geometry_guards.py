"""Guards in the Blender-side geometry helpers, run against stand-in Blender modules (tests/fake_blender.py): a face
pointing past its material slots, a sleeve ramp that would run backwards, and the drawing silhouette read with numpy."""
import math
import types

import numpy as np
import pytest

import fake_blender
from fake_blender import Vector, armature, bone, mesh


def polygon(index, material_index, loops=(0, 1, 2)):
    return types.SimpleNamespace(index=index, material_index=material_index, loop_indices=list(loops),
                                 center=Vector((0, 0, 1.5)))


def test_a_face_past_its_material_slots_is_skipped_not_an_error(monkeypatch):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_head_geometry')
    head = modules['avatar_head_geometry']
    hair = mesh(bpy.context.scene, 'hair', [(0, 0, 1.4), (.1, 0, 1.5), (0, .1, 1.6)], [(0, 1, 2)])
    hair.data.uv_layers = types.SimpleNamespace(active=types.SimpleNamespace(data=[types.SimpleNamespace(uv=Vector((.5, .5)))]*3))
    hair.data.polygons = [polygon(0, 3)]
    assert head.face_samples([hair]) == []
    assert head.underlayer_faces([hair]) == {}
    # One slot that is not a node material is skipped the same way.
    hair.data.materials = [types.SimpleNamespace(use_nodes=False, get=lambda key, default=None: default)]
    hair.data.polygons = [polygon(0, 0), polygon(1, 5)]
    assert head.face_samples([hair]) == [] and head.underlayer_faces([hair]) == {}


def sleeveless_top(scene, extent):
    """A vest reaching `extent` metres to each side, its middle at x = 0."""
    points = [(0., 0, 1.35), (extent, 0, 1.3), (-extent, 0, 1.3), (extent-.01, 0, 1.), (-extent+.01, 0, 1.), (0., 0, 1.)]
    return mesh(scene, 'top', points)


def arm_rig(scene):
    return armature(scene, 'rig', [bone('LeftArm', (.2, 0, 1.3)), bone('LeftHand', (.6, 0, 1.3)),
                                   bone('RightArm', (-.2, 0, 1.3)), bone('RightHand', (-.6, 0, 1.3))])


@pytest.mark.parametrize('torso_half', [.72*.25, .2])
def test_a_garment_hardly_past_the_torso_keeps_its_middle_where_it_is(monkeypatch, torso_half):
    """With the vest's outer 28% inside the torso the ramp from the torso side to the sleeve had no length (a division
    by zero) or ran backwards (moving the vest's middle down the arms); it now runs outward over at least 1 cm."""
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_arm_geometry')
    arms = modules['avatar_arm_geometry']
    scene = bpy.context.scene
    top = sleeveless_top(scene, .25)
    before = [tuple(vertex.co) for vertex in top.data.vertices]
    report, masks = arms.fit_sleeves([top], arm_rig(scene), {'base_body': {'torso_width_m': 2*torso_half}})
    after = [tuple(vertex.co) for vertex in top.data.vertices]
    assert after[0] == before[0] and after[5] == before[5]
    assert 0 not in masks[top] and 5 not in masks[top]
    assert set(report['sides']) == {'left', 'right'}


def old_mask(image):
    """The silhouette as it was read before numpy: a Python list of every float of the image."""
    width, height = image.size; pixels = list(image.pixels)
    occupied = [(index % width, height-1-index//width) for index in range(width*height) if pixels[index*4+3] > .05]
    if not occupied or len(occupied) > width*height*.95:
        return None
    return width, height, occupied


def old_profile(points, horizontal_axis, bins=24):
    horizontal = [point[horizontal_axis] for point in points]; vertical = [point[2] for point in points]
    hlo, hhi, vlo, vhi = min(horizontal), max(horizontal), min(vertical), max(vertical)
    hs, vs = [0]*bins, [0]*bins
    for h, v in zip(horizontal, vertical):
        hs[min(bins-1, int((h-hlo)/max(hhi-hlo, 1e-8)*bins))] += 1
        vs[min(bins-1, int((v-vlo)/max(vhi-vlo, 1e-8)*bins))] += 1
    normalized = lambda row: [value/(max(row) or 1) for value in row]
    return normalized(hs), normalized(vs), (hhi-hlo)/max(vhi-vlo, 1e-8)


class Image:
    """A Blender image: RGBA floats, rows from the bottom up."""

    def __init__(self, alpha):
        self.size = (alpha.shape[1], alpha.shape[0]); self.channels = 4
        rgba = np.zeros(alpha.shape + (4,), np.float32); rgba[..., 3] = alpha
        flat = np.flipud(rgba).reshape(-1)
        self.pixels = types.SimpleNamespace(foreach_get=lambda out: out.__setitem__(slice(None), flat))
        self._flat = flat

    @property
    def pixels_list(self):
        return self._flat.tolist()


def drawing(seed):
    """A garment-like silhouette: a torso, two sleeves of different lengths, soft and noisy edges."""
    rng = np.random.default_rng(seed)
    alpha = np.zeros((60, 80), np.float32)
    alpha[10:50, 28:52] = 1.                      # torso
    alpha[14:22, 8:28] = .8; alpha[14:20, 52:75] = .6   # sleeves
    alpha += (rng.random(alpha.shape) < .03)*rng.random(alpha.shape).astype(np.float32)
    alpha[rng.random(alpha.shape) < .02] = 0.
    return np.clip(alpha, 0, 1)


@pytest.mark.parametrize('seed', [1, 2, 3])
def test_the_silhouette_and_its_profile_are_those_of_the_list_version(monkeypatch, seed):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_garment_geometry')
    garment = modules['avatar_garment_geometry']
    image = Image(drawing(seed))
    bpy.data.images.load = lambda path, check_existing=True: image
    reference = old_mask(types.SimpleNamespace(size=image.size, pixels=image.pixels_list))
    width, height, xs, ys = garment._image_mask('front.png')
    assert (width, height) == reference[:2]
    assert sorted(zip(xs.tolist(), ys.tolist())) == sorted(reference[2])
    assert garment._image_profile((width, height, xs, ys)) == old_profile([Vector((x, 0, -y)) for x, y in reference[2]], 0)


def test_the_drawing_heights_are_those_of_the_list_version(monkeypatch):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_garment_geometry')
    garment = modules['avatar_garment_geometry']
    image = Image(drawing(4))
    bpy.data.images.load = lambda path, check_existing=True: image
    canvas = {'center_x': 40, 'sole_y': 58, 'pixels_per_metre': 100.}
    top = mesh(bpy.context.scene, 'top', [(x, 0, z) for x in (-.3, 0, .3) for z in (1., 1.3)])
    report, _ = garment._silhouette_registration([top], {'front': '/work/job/output/top-front.png'}, canvas, 'top')
    # The heights as the list version measured them.
    _, _, occupied = old_mask(types.SimpleNamespace(size=image.size, pixels=image.pixels_list))
    band = [p for p in occupied if abs(p[0]-canvas['center_x']) <= image.size[0]*.08]
    ys = [p[1] for p in band or occupied]
    rows = {}
    for x, y in occupied:
        rows.setdefault(y, []).append(x)
    shoulder_y = min(rows, key=lambda y: (-max(rows[y])+min(rows[y]), y))
    span = max(max(ys)-min(ys), 1)
    landmarks = report['image_landmarks']
    assert landmarks.pop('relative_y') == {'neck': 0., 'shoulder': (shoulder_y-min(ys))/span, 'hem': 1.}
    assert landmarks == {'neck_height_m': (58-min(ys))/100., 'shoulder_height_m': (58-shoulder_y)/100.,
                         'hem_height_m': (58-max(ys))/100.}
    # The receipt names the drawing, not where the worker kept it.
    assert report['views']['front']['source'] == 'top-front.png'


# --- the head's skin binding beside T-pose arms -------------------------------------------------------------------------

# The production spec's 1.2 m SD body: shoulders and wrists at 0.43 m, the neck at 0.46 m, a head far wider than the
# shoulders above them.
SD_SPEC = {'anchors': {'neck': [0, .46, 0], 'shoulder_left': [.16, .43, 0]}, 'body_height_m': 1.2,
           'base_body': {'torso_width_m': .22, 'torso_depth_m': .13, 'arm_diameter_m': .036, 'leg_diameter_m': .044,
                         'wrist_diameter_m': .028, 'ankle_diameter_m': .032}}


def sd_rig(scene):
    joints = {'Hips': ((0, 0, .25), (0, 0, .33)), 'Spine': ((0, 0, .33), (0, 0, .44)), 'neck': ((0, 0, .44), (0, 0, .46)),
              'Head': ((0, 0, .46), (0, 0, 1.2))}
    for side, sign in (('Left', 1), ('Right', -1)):
        joints.update({side+'Shoulder': ((sign*.02, 0, .44), (sign*.16, 0, .43)),
                       side+'Arm': ((sign*.16, 0, .43), (sign*.28, 0, .43)),
                       side+'ForeArm': ((sign*.28, 0, .43), (sign*.39, 0, .43)),
                       side+'Hand': ((sign*.39, 0, .43), (sign*.47, 0, .43))})
    bones = []
    for name, (head, tail) in joints.items():
        bones.append(bone(name, head))
        bones[-1].tail_local = Vector(tail)
    return armature(scene, 'rig', bones)


def weights(obj):
    names = {group.index: group.name for group in obj.vertex_groups}
    return [{names[entry.group]: entry.weight for entry in vertex.groups if entry.weight} for vertex in obj.data.vertices]


def tube(xs, radius, height=.43, sides=8):
    """A T-pose arm's skin: a ring of `sides` points round the line y = 0, z = `height` at each of `xs`, joined by
    triangles, turned half a step so that a face, not an edge, is uppermost."""
    points = [(x, radius*math.cos(2*math.pi*(i+.5)/sides), height+radius*math.sin(2*math.pi*(i+.5)/sides))
              for x in xs for i in range(sides)]
    triangles = []
    for ring in range(len(xs)-1):
        for i in range(sides):
            a, b = ring*sides+i, ring*sides+(i+1) % sides
            triangles += [(a, b, b+sides), (a, b+sides, a+sides)]
    return points, triangles


def unchanged_binding(height):
    """The Head weight bind_body_head gave skin at `height` before it told the arms apart."""
    blend = max(0, min(1, (height-.42)/.04))
    return blend*blend*(3-2*blend)


def test_t_pose_arms_and_hands_keep_their_bones_beside_the_head(monkeypatch):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_fit_geometry')
    fit = modules['avatar_fit_geometry']
    scene = bpy.context.scene
    rig = sd_rig(scene)
    # The left arm's joints sit high in it, its upper side less than 1 cm above their line. The right arm is a
    # provider's before slimming, 4 cm round its line, with a big hand past its wrist.
    left, left_faces = tube((.12, .2, .28, .36), .024, height=.414)
    right, right_faces = tube((-.12, -.2, -.28, -.36), .04)
    rows = [((.22, 0, .44), {'LeftArm': 1.}),          # the head's lower side 1, 2.5 and 4 cm above the upper arm's
            ((.22, 0, .455), {'LeftArm': 1.}),         # line and beside the shoulder joint, which auto-rigging gave
            ((.22, 0, .47), {'LeftArm': 1.}),          # to the arm and the shoulder
            ((.14, -.02, .46), {'LeftShoulder': 1.}),
            ((-.22, 0, .475), {'RightArm': 1.}),       # 5 mm above the thick arm
            ((-.43, 0, .455), {'RightHand': 1.}),      # the back of the hand
            ((-.42, -.01, .48), {'RightHand': 1.}),    # a raised thumb 5 cm above the line
            ((.03, 0, .44), {'neck': 1.}),             # the neck and the chin blend into the head
            ((0, -.05, .455), {'neck': .5, 'Spine': .5}),
            ((0, -.25, .7), {'LeftShoulder': 1.}),     # the face auto-rigging gave a shoulder
            ((0, 0, 1.2), {'Head': 1.})]
    arms = left+right
    body = mesh(scene, 'body', arms+[point for point, _ in rows],
                left_faces+[tuple(len(left)+i for i in face) for face in right_faces], rig=rig,
                weights=[{'LeftArm': 1.}]*len(left)+[{'RightArm': 1.}]*len(right)+[row for _, row in rows])
    report = fit.bind_body_head([body], rig, SD_SPEC)
    bound = weights(body)
    assert report['collar_height_m'] == pytest.approx(.46)
    # The arms' own skin keeps its bones, its upper half in the band at shoulder height included.
    assert sum(point[2] > .42 for point in arms) == len(arms)//2
    assert bound[:len(arms)] == [{'LeftArm': 1.}]*len(left)+[{'RightArm': 1.}]*len(right)
    probes = bound[len(arms):]
    # However close the head comes, the arm's skin lies between: it is bound as before.
    assert [row['Head'] for row in probes[:5]] == pytest.approx([unchanged_binding(point[2]) for point, _ in rows[:5]])
    assert probes[5:7] == [{'RightHand': 1.}]*2
    assert 0 < probes[7]['Head'] < 1 and 0 < probes[8]['Head'] < 1
    assert probes[9:] == [{'Head': 1.}]*2
    assert all(sum(row.values()) == pytest.approx(1.) for row in bound)


def test_the_head_is_measured_without_arms_an_earlier_binding_gave_to_head(monkeypatch):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_fit_geometry')
    fit = modules['avatar_fit_geometry']
    scene = bpy.context.scene
    rig = sd_rig(scene)
    # A provider's thick arm whose upper side, hand and raised thumb an earlier binding gave to Head.
    arm, faces = tube((-.12, -.2, -.28, -.36), .04)
    head = [(-.3, 0, .8), (.3, 0, .8), (0, -.3, .8), (0, .3, .8), (0, 0, 1.2), (0, 0, .47),
            (-.22, 0, .475)]                           # the head's lower side just above the arm
    hand = [((-.43, 0, .455), {'Head': .96, 'RightHand': .04}), ((-.42, -.01, .48), {'Head': 1.})]
    body = mesh(scene, 'body', arm+head+[point for point, _ in hand], faces, rig=rig,
                weights=[{'Head': .78, 'RightArm': .22} if point[2] > .45 else {'RightArm': 1.} for point in arm]
                + [{'Head': 1.}]*len(head)+[row for _, row in hand])
    assert fit.head_weighted_vertices([body], rig) == {body: set(range(len(arm), len(arm)+len(head)))}
    lo, hi, _ = fit.head_region([body], rig, SD_SPEC)
    assert (lo.x, hi.x) == pytest.approx((-.3, .3))


def test_the_upper_side_of_a_t_pose_arm_is_slimmed_like_its_lower_side(monkeypatch):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_fit_geometry')
    fit = modules['avatar_fit_geometry']
    scene = bpy.context.scene
    rig = sd_rig(scene)
    # The underlayer round a provider's arm 4 cm from its line, the head's lower side above it and the blank head, all
    # as white as the underlayer.
    arm, faces = tube((.12, .22, .32), .04)
    heads = [(.22, 0, .48), (0, 0, 1.2)]
    body = mesh(scene, 'body', arm+heads, faces, rig=rig, weights=[{'LeftArm': 1.}]*(len(arm)+1)+[{'Head': 1.}])
    body.data.uv_layers = types.SimpleNamespace(active=None)
    body.data.materials = [types.SimpleNamespace(use_nodes=False, get=lambda key, default=None: key == 'base_underlayer')]
    body.data.polygons = [types.SimpleNamespace(index=index, material_index=0, vertices=list(face))
                          for index, face in enumerate(faces+[(len(arm), len(arm)+1)])]
    fit.slim_base_body([body], rig, SD_SPEC)
    slimmed = [vertex.co for vertex in body.data.vertices]
    # The ring round the upper arm, its upper side as its lower, is the slimmed arm's.
    assert [(point-Vector((.22, 0, .43))).length for point in slimmed[8:16]] == pytest.approx([.018]*8)
    assert [list(point) for point in slimmed[len(arm):]] == [pytest.approx(list(point)) for point in heads]
