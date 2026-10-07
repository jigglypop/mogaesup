"""The local hair repair's colour, alpha, length and rear-backing contracts, without a Blender process or providers."""
from types import SimpleNamespace as NS

import numpy as np
import pytest

import fake_blender
from fake_blender import armature, bone


class Values(list):
    def foreach_get(self, name, target):
        target[:] = np.array([getattr(value, name) for value in self]).reshape(-1)


class Pixels(list):
    def foreach_get(self, target):
        target[:] = self


def image(alpha=.6, gray=.5):
    return NS(size=(8, 8), channels=4, pixels=Pixels([gray, gray, gray, alpha] * 64),
              is_float=False, colorspace_settings=NS(name='sRGB'))


def flat(colour):
    """A material with a flat base colour and no texture."""
    return NS(node_tree=NS(nodes=[NS(type='BSDF_PRINCIPLED', inputs={'Base Color': NS(links=[], default_value=(*colour, 1))})]))


class Layers(list):
    active = None


def hair_object(material_slots, polygons, uv_layers=()):
    mesh = NS(uv_layers=Layers(uv_layers), loops=[None]*sum(p.loop_total for p in polygons), polygons=Values(polygons))
    return NS(data=mesh, material_slots=[NS(material=material) for material in material_slots], get=lambda key: False)


def test_a_rear_reference_keeps_strands_visible_at_the_exported_mask_cutoff(monkeypatch):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_hair_geometry')
    reference = image()
    # Keep transparent padding so this is a silhouette, rather than an opaque rectangle.
    reference.pixels[:4] = [0, 0, 0, 0]
    bpy.data.images.load = lambda *args, **kwargs: reference
    bpy.data.images.remove = lambda img: pytest.fail('A visible rear silhouette was discarded')
    decoded, mask, bounds = modules['avatar_hair_geometry']._reference('back.png')
    assert decoded is reference
    assert mask.sum() == 63 and not mask[0, 0]
    assert bounds == (0, 0, 7, 7)


def test_cap_colour_uses_render_uv_when_blender_has_no_active_editing_uv(monkeypatch):
    _, modules = fake_blender.install(monkeypatch, 'avatar_hair_geometry')
    texture = NS(type='TEX_IMAGE', image=image(alpha=1))
    shader = NS(type='BSDF_PRINCIPLED', inputs={'Base Color': NS(links=[NS(from_node=texture)], default_value=(.8, .8, .8, 1))})
    material = NS(node_tree=NS(nodes=[shader, texture]))
    uv = NS(active_render=True, data=Values([NS(uv=(.5, .5))] * 3))
    obj = hair_object([material, flat((1, 1, 1))], [NS(material_index=0, loop_start=0, loop_total=3)], [uv])
    colour = modules['avatar_hair_geometry'].hair_colour([obj])
    expected = ((.5 + .055) / 1.055) ** 2.4
    assert colour == pytest.approx([expected] * 3)


def test_a_material_slot_no_face_uses_does_not_colour_the_cap(monkeypatch):
    _, modules = fake_blender.install(monkeypatch, 'avatar_hair_geometry')
    obj = hair_object([flat((.1, .1, .1)), flat((.9, .9, .9))], [NS(material_index=0, loop_start=0, loop_total=3)])
    assert modules['avatar_hair_geometry'].hair_colour([obj]) == pytest.approx([.1]*3)


@pytest.mark.parametrize('bottom', [.6, -.2])
def test_requested_length_moves_only_hanging_strands_and_keeps_the_attachment_frame(monkeypatch, bottom):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_head_geometry')
    obj = fake_blender.mesh(bpy.scene, 'Hair', [(-.2, .1, 1.2), (.2, -.1, 1.2), (.1, .1, .8), (.1, -.1, .2)])
    before = [tuple(vertex.co) for vertex in obj.data.vertices]
    spec = {'fitting': {'hair_length_head_ratio': 1.0 if bottom > 0 else 1.7,
                        'hair_surface_fit': 'cavity-reference-v4'}}
    report = modules['avatar_head_geometry'].fit_hair_length([obj], [[-.2, bottom, -.2], [.2, 1.2, .2]], spec, .8)
    after = [tuple(vertex.co) for vertex in obj.data.vertices]
    assert after[:3] == before[:3]
    assert [point[:2] for point in after] == [point[:2] for point in before]
    assert after[3][2] == pytest.approx(bottom)
    assert report['width_and_depth_preserved'] and report['strand_scale'] > 0


def legs(scene, prefix='mixamorig:'):
    return armature(scene, 'rig', [bone(f'{prefix}Hips', (0, 0, .44)), bone(f'{prefix}LeftUpLeg', (.06, 0, .4)),
                                   bone(f'{prefix}RightUpLeg', (-.06, 0, .394))])


@pytest.mark.parametrize('prefix', ['mixamorig:', 'mixamorig1_', ''])
def test_a_rear_backing_never_hangs_below_the_hip_joints(monkeypatch, prefix):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_hair_geometry')
    hair = modules['avatar_hair_geometry']
    rig = legs(bpy.context.scene, prefix)
    assert hair.hip_height(rig) == pytest.approx(.397)
    # A rear drawing registered past the floor (the audited bun) or past the strands' own ends stops at the hips.
    assert hair.backing_floor(.221, -.019, rig, .593) == pytest.approx((.397, .397))
    assert hair.backing_floor(.16, .102, rig, .593) == pytest.approx((.397, .397))
    # A bob's outline ending above them is followed as before, below the strands' own ends.
    assert hair.backing_floor(.62, .55, rig, .593) == pytest.approx((.55, .397))


def test_without_hip_joints_a_rear_backing_stops_at_the_head(monkeypatch):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_hair_geometry')
    rig = armature(bpy.context.scene, 'rig', [bone('Hips', (0, 0, .44)), bone('Head', (0, 0, .63))])
    hair = modules['avatar_hair_geometry']
    assert hair.hip_height(rig) is None
    assert hair.backing_floor(.16, -.02, rig, .593) == pytest.approx((.593, .593))
