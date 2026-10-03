"""Guards in the Blender-side geometry helpers, run against stand-in Blender modules (tests/fake_blender.py): a face
pointing past its material slots, a sleeve ramp that would run backwards, and the drawing silhouette read with numpy."""
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
