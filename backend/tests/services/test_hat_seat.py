"""A hat kept above the eyes (avatar_head_geometry.seat_hat_above_brows) against stand-in Blender modules
(tests/fake_blender.py): taken in about its crown, never lifted off the head."""
import numpy as np
import pytest

import fake_blender

SPEC = {'anchors': {'neck': [0, 1.3, 0], 'shoulder_left': [.2, 1.25, 0]}, 'body_height_m': 1.6}
# The head's skin: chin at z .6, crown at 1.2, its front toward -Y. The eyes' line (HAT_EYE_LINE of its height) is
# at .6 + .62*.6 = .972.
LINE = .6 + .62*.6


@pytest.fixture
def scene(monkeypatch):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_head_geometry')
    head = modules['avatar_head_geometry']
    rig = fake_blender.armature(bpy.context.scene, 'Armature', [fake_blender.bone('Head', (0, 0, .62))])
    skin = [(x, y, z) for x in (-.25, 0, .25) for y in (-.2, 0, .2) for z in np.linspace(.6, 1.2, 7)]
    body = fake_blender.mesh(bpy.context.scene, 'Body', skin, rig=rig, weights=[{'Head': 1.}]*len(skin))
    return bpy, head, rig, [body]


def hat(bpy, front_low, back_low=.75, top=1.3):
    """A cap: a crown over the head, its front (over the eyes) down to `front_low`, its back to `back_low`."""
    points = [(x, y, top) for x in (-.2, 0, .2) for y in (-.15, 0, .15)]
    points += [(x, -.22, front_low) for x in (-.15, -.05, .05, .15)]
    points += [(x, .22, back_low) for x in (-.15, 0, .15)]
    points += [(x, y, (top + max(front_low, back_low))/2) for x in (-.26, .26) for y in (-.1, .1)]
    return [fake_blender.mesh(bpy.context.scene, 'Hat', points)]


def lowest_over_eyes(meshes):
    points = np.array([tuple(vertex.co) for obj in meshes for vertex in obj.data.vertices])
    over = (points[:, 1] < 0) & (np.abs(points[:, 0]) <= .62*.25)
    return points[over, 2].min(), points[:, 2].max()


def test_a_hat_over_the_eyes_is_taken_in_about_its_crown(scene):
    bpy, head, rig, body = scene
    meshes = hat(bpy, front_low=.8)
    report = head.seat_hat_above_brows(meshes, body, rig, SPEC)
    low, top = lowest_over_eyes(meshes)
    assert low == pytest.approx(LINE) and top == pytest.approx(1.3)
    assert report['height_scale'] == pytest.approx((1.3 - LINE)/(1.3 - .8)) and report['scale'] == 1.
    assert report['clear'] is True and report['lift_m'] == 0.


def test_a_deep_hat_is_made_smaller_about_its_crown_not_lifted(scene):
    bpy, head, rig, body = scene
    meshes = hat(bpy, front_low=.62)
    report = head.seat_hat_above_brows(meshes, body, rig, SPEC)
    low, top = lowest_over_eyes(meshes)
    assert report['height_scale'] == pytest.approx(head.HAT_HEIGHT_LIMIT)
    assert head.HAT_MIN_SCALE <= report['scale'] < 1.
    # Its crown stays on the head: the top does not move; its front clears the eyes.
    assert top == pytest.approx(1.3) and low == pytest.approx(LINE) and report['clear'] is True


def test_a_hat_too_deep_to_seat_is_left_over_the_eyes_for_the_gate(scene):
    bpy, head, rig, body = scene
    meshes = hat(bpy, front_low=.3)
    report = head.seat_hat_above_brows(meshes, body, rig, SPEC)
    low, top = lowest_over_eyes(meshes)
    assert report['scale'] == pytest.approx(head.HAT_MIN_SCALE) and report['clear'] is False
    assert top == pytest.approx(1.3) and low < LINE and report['lift_m'] == 0.


def test_a_hat_above_the_eyes_is_left_as_it_is(scene):
    bpy, head, rig, body = scene
    meshes = hat(bpy, front_low=1.)
    before = [tuple(vertex.co) for vertex in meshes[0].data.vertices]
    report = head.seat_hat_above_brows(meshes, body, rig, SPEC)
    assert [tuple(vertex.co) for vertex in meshes[0].data.vertices] == before
    assert report['height_scale'] == 1. and report['scale'] == 1. and report['eye_low_before_m'] == pytest.approx(1.)
