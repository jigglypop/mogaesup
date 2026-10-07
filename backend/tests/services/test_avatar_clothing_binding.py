"""What a top or a bottom is (avatar_clothing_binding): a raised hood, a skirt or trousers, and the hood's head binding.
Plain numpy shapes in Blender's frame (Z up, the front at -Y), and stand-in Blender objects for the binding."""
import numpy as np
import pytest

import fake_blender
from fake_blender import armature, bone, mesh
from src.services.avatar_clothing_binding import (
    HOOD_ROUND, HOOD_TALL, SKIRT_MAX_BETWEEN, bottom_kind, fabric_between_legs, head_torso_bounds, hood_shape,
    raised_hood,
)

# Hip joints 12 cm apart at z .4, knees at .23, ankles at .05; the legs' axes 5 cm behind x = 0's plane.
LEGS = {side: ((sign*.06, .05, .4), (sign*.06, .05, .23), (sign*.06, .05, .05)) for side, sign in (('left', 1), ('right', -1))}


def tube(x, y, radius, low, high, *, count=24, rings=8):
    """A closed-around, open-ended tube: (points, triangles)."""
    angles = np.arange(count)*2*np.pi/count
    points = [(x + radius*np.cos(a), y + radius*np.sin(a), z) for z in np.linspace(low, high, rings) for a in angles]
    triangles = []
    for ring in range(rings - 1):
        for i in range(count):
            a, b = ring*count + i, ring*count + (i + 1) % count
            triangles += [(a, b, b + count), (a, b + count, a + count)]
    return points, triangles


def joined(*parts):
    points, triangles = [], []
    for part_points, part_triangles in parts:
        offset = len(points)
        points += part_points
        triangles += [tuple(index + offset for index in triangle) for triangle in part_triangles]
    return np.array(points), np.array(triangles)


def test_a_skirt_has_no_fabric_between_the_legs():
    skirt = joined(tube(0, .05, .16, .12, .45))
    assert bottom_kind('source', 'source', *skirt, LEGS) == ('skirt', {'method': 'fabric_between_legs_v1', 'rays': 120,
                                                                         'between_share': 0.})


@pytest.mark.parametrize('trousers', [
    # Each leg in its own tube, the two touching at the middle (shorts and slim trousers on the SD legs).
    joined(tube(.06, .05, .06, .05, .3), tube(-.06, .05, .06, .05, .3), tube(0, .05, .14, .3, .45)),
    # Wide legs centred outside the leg axes, meeting at the middle.
    joined(tube(.09, .05, .09, .0, .3), tube(-.09, .05, .09, .0, .3), tube(0, .05, .19, .3, .45)),
], ids=['touching legs', 'wide legs'])
def test_trousers_have_fabric_between_the_legs_even_where_their_legs_touch(trousers):
    kind, receipt = bottom_kind('source', None, *trousers, LEGS)
    assert kind == 'pants' and receipt['between_share'] > .9


def test_the_saved_contract_wins_and_an_unmeasurable_bottom_stays_source():
    skirt = joined(tube(0, .05, .16, .12, .45))
    assert bottom_kind('pants', 'skirt', *skirt, LEGS)[0] == 'pants'
    assert bottom_kind(None, 'skirt', *joined(tube(.06, .05, .06, .05, .3)), LEGS)[0] == 'skirt'
    assert bottom_kind('source', 'source', *skirt, None) == ('source', {'method': 'fabric_between_legs_v1',
                                                                         'reason': 'not_measurable'})
    assert bottom_kind('source', 'source', np.zeros((0, 3)), np.zeros((0, 3), int), LEGS)[0] == 'source'


def test_the_audited_margin_holds_for_a_skirt_with_a_lining_close_around_both_legs():
    # A narrow pencil skirt still passes both legs together: its rays reach past the middle.
    share, rays = fabric_between_legs(*joined(tube(0, .05, .1, .1, .42)), LEGS)
    assert rays == 120 and share <= SKIRT_MAX_BETWEEN


def test_a_bottom_is_measured_on_the_rig_it_is_worn_on(monkeypatch):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_clothing_binding')
    binding = modules['avatar_clothing_binding']
    rig = armature(bpy.context.scene, 'rig', [bone(f'mixamorig:{side}{part}', joint)
                                              for side in ('Left', 'Right')
                                              for part, joint in zip(('UpLeg', 'Leg', 'Foot'), LEGS[side.lower()])])
    points, triangles = joined(tube(0, .05, .16, .12, .45))
    skirt = mesh(bpy.context.scene, 'skirt', points.tolist(), triangles.tolist())
    assert binding.mesh_bottom_kind({'garment_kind': 'source', 'fit_profile': None}, [skirt], rig)[0] == 'skirt'
    # Without the legs' bones nothing is measured.
    bare = armature(bpy.context.scene, 'bare', [bone('mixamorig:Hips', (0, .05, .45))])
    assert binding.mesh_bottom_kind({'garment_kind': 'source'}, [skirt], bare)[0] == 'source'


def top_points(hood):
    """A T-pose top (sleeves across X) with its hood raised around a head, lying on the back or absent."""
    rng = np.random.default_rng(0)
    torso = rng.uniform((-.15, -.1, .4), (.15, .1, .7), (400, 3))
    sleeves = rng.uniform((-.42, -.05, .62), (.42, .05, .7), (300, 3))
    parts = [torso, sleeves]
    if hood == 'raised':
        angle = rng.uniform(0, 2*np.pi, 600); height = rng.uniform(0, 1, 600)
        radius = .25*np.sqrt(1 - height**2)
        parts.append(np.stack([radius*np.cos(angle), radius*np.sin(angle), .72 + .55*height], axis=1))
    elif hood == 'down':
        parts.append(rng.uniform((-.12, .1, .62), (.12, .2, .74), (200, 3)))
    return np.concatenate(parts)


def test_only_a_described_hood_that_stands_around_the_head_is_raised():
    raised, down = top_points('raised'), top_points('down')
    tall, round_ = hood_shape(raised)
    assert tall >= HOOD_TALL and round_ >= HOOD_ROUND
    assert raised_hood('oversized hoodie', raised) and raised_hood('후드티', raised)
    assert raised_hood('sweatshirt with the hood up', raised)
    # The studio draws hoodies with the hood down: said so, or seen lying on the back, it is a plain top.
    assert not raised_hood('hoodie', down) and not raised_hood('hoodie', top_points(None))
    assert not raised_hood('long sleeved tee', raised)


@pytest.mark.parametrize('description', [
    'Oversized pullover hoodie with the hood DOWN, lying flat on the upper back and shoulders',
    'olive hooded parka, the hood folded down behind the neck', 'lowered hood sweatshirt', '후드티 모자 내림',
    '후드를 벗은 집업'])
def test_a_lowered_hood_keeps_the_torso_frame_whatever_its_shape(description):
    assert not raised_hood(description, top_points('raised'))


def test_a_dress_is_tall_but_its_bodice_is_not_a_hood_around_a_head():
    rng = np.random.default_rng(1)
    bodice = rng.uniform((-.12, -.07, .45), (.12, .07, .72), (300, 3))
    flare = rng.uniform((-.2, -.18, .2), (.2, .18, .45), (300, 3))
    assert not raised_hood('hooded dress', np.concatenate([bodice, flare]))


def test_a_raised_hood_uses_the_union_of_head_and_torso_without_changing_them():
    torso = [[-.4, .22, -.128], [.4, .48, .148]]
    head = [[-.39, 1.03, -.27], [.39, 1.27, .29]]
    assert head_torso_bounds(torso, head) == [[-.4, .22, -.27], [.4, 1.27, .29]]
    assert torso == [[-.4, .22, -.128], [.4, .48, .148]] and head == [[-.39, 1.03, -.27], [.39, 1.27, .29]]


@pytest.mark.parametrize('prefix', ['mixamorig:', 'mixamorig_', ''])
def test_a_raised_hood_follows_the_head_above_the_collar_and_keeps_its_weights_below(monkeypatch, prefix):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_clothing_binding')
    binding = modules['avatar_clothing_binding']
    hips, head = f'{prefix}Hips', f'{prefix}Head'
    rig = armature(bpy.context.scene, 'rig', [bone(hips), bone(head)])
    hood = mesh(bpy.context.scene, 'hood', [(0, 0, .4), (0, 0, .5), (0, 0, .52), (0, 0, .6)],
                rig=rig, weights=[{hips: 1.}]*4)
    report = binding.bind_hood_head([hood], rig, .5)
    names = {group.index: group.name for group in hood.vertex_groups}
    rows = [{names[entry.group]: entry.weight for entry in vertex.groups} for vertex in hood.data.vertices]
    assert rows[:2] == [{hips: 1.}]*2
    assert rows[2][hips] == pytest.approx(.5) and rows[2][head] == pytest.approx(.5)
    assert rows[3] == {head: 1.}
    assert all(sum(row.values()) == pytest.approx(1.) for row in rows)
    assert report == {'method': 'head_above_collar', 'bone': head, 'vertices': 2, 'collar_m': .5, 'blend_m': .04}


def test_a_hood_without_a_head_bone_is_refused(monkeypatch):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_clothing_binding')
    rig = armature(bpy.context.scene, 'rig', [bone('Hips')])
    hood = mesh(bpy.context.scene, 'hood', [(0, 0, .6)], rig=rig, weights=[{'Hips': 1.}])
    with pytest.raises(ValueError, match='head bone'):
        modules['avatar_clothing_binding'].bind_hood_head([hood], rig, .5)
