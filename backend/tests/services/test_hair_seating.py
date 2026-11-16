"""An isolated hairstyle seated on the scalp, run against stand-in Blender modules (tests/fake_blender.py).

fit_hair puts the outer crown of a generated hairstyle a fixed 7 cm over the measured head; the production spec's
two-way seat then brings the inner surface down (or out) onto the scalp, unless the hair closes round the head centre.
"""
import math

import numpy as np
import pytest

import fake_blender
from fake_blender import Matrix, armature, bone, mesh
from src.services.avatar_production_spec import production_spec

# The 1.2 m SD body's head: a 0.21 m ball whose crown is at 1.2 m.
CENTER, RADIUS = (0., 0., .99), .21


def cap(radius, lowest=-25., rings=8, segments=20):
    """A sphere round the head centre from latitude `lowest` (degrees) up to its pole, wound outward."""
    points = [(CENTER[0]+radius*math.cos(math.radians(lat))*math.cos(2*math.pi*s/segments),
               CENTER[1]+radius*math.cos(math.radians(lat))*math.sin(2*math.pi*s/segments),
               CENTER[2]+radius*math.sin(math.radians(lat)))
              for lat in np.linspace(lowest, 90, rings+1)[:-1] for s in range(segments)]
    triangles = []
    for ring in range(rings-1):
        for s in range(segments):
            a, b = ring*segments+s, ring*segments+(s+1) % segments
            triangles += [(a, b, b+segments), (a, b+segments, a+segments)]
    pole, last = len(points), (rings-1)*segments
    points.append((CENTER[0], CENTER[1], CENTER[2]+radius))
    triangles += [(last+s, last+(s+1) % segments, pole) for s in range(segments)]
    return points, triangles


def wig(inner, thickness, segments=20):
    """A closed wig: an inner and an outer cap joined at their rim, its cavity facing the head."""
    inside, inner_faces = cap(inner, segments=segments)
    outside, outer_faces = cap(inner+thickness, segments=segments)
    count = len(inside)
    triangles = [face[::-1] for face in inner_faces] + [tuple(i+count for i in face) for face in outer_faces]
    triangles += [face for s in range(segments) for face in
                  (((s+1) % segments, s, s+count), ((s+1) % segments, s+count, (s+1) % segments+count))]
    return inside+outside, triangles


def sd_body(scene):
    rig = armature(scene, 'rig', [bone('Hips', (0, 0, .3)), bone('Spine', (0, 0, .5)), bone('Head', (0, 0, .78))])
    head, faces = cap(RADIUS, lowest=-80., rings=12)
    torso = [(x, y, z) for z in (0., .8) for x, y in ((-.1, -.07), (.1, -.07), (.1, .07), (-.1, .07))]
    sides = [(0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    body = mesh(scene, 'body', head+torso, faces+[tuple(len(head)+i for i in face) for face in sides], rig=rig,
                weights=[{'Head': 1.}]*len(head)+[{'Spine': 1.}]*len(torso))
    return rig, body


def spec():
    """The production spec, as a new hairstyle on the SD body is fitted with it (no runtime reduction here)."""
    return {**production_spec(), 'runtime': None}


def provider_frame(worker, hair):
    """A provider returns the part at its own scale and place."""
    worker.place([hair], Matrix.Translation((.2, .1, .4)) @ Matrix.Scale(1.9, 4))


def crown_over_scalp(hair):
    """How far the hair's lowest point over the crown (its inner surface there) and its top are above the head."""
    points = [hair.matrix_world @ vertex.co for vertex in hair.data.vertices]
    over = [point.z for point in points
            if math.hypot(point.x-CENTER[0], point.y-CENTER[1]) < .03 and point.z > CENTER[2]]
    return min(over)-(CENTER[2]+RADIUS), max(point.z for point in points)-(CENTER[2]+RADIUS)


@pytest.mark.parametrize('kind', ['closed wig', 'single sheet'])
def test_an_isolated_hairstyle_is_seated_on_the_scalp_not_its_outer_crown_7_cm_over_the_head(monkeypatch, kind):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_native_parts_blender')
    worker = modules['avatar_native_parts_blender']
    monkeypatch.setattr(worker, 'add_scalp_cap', lambda *args: None)
    monkeypatch.setattr(worker, 'bind', lambda *args, **kwargs: {})
    scene = bpy.context.scene
    rig, body = sd_body(scene)
    # A 2.5 cm wig made for this head, its cavity 3 mm off the scalp; or one sheet of hair 1.1 cm off it, as a game
    # hairstyle's cards are (an open surface whose normals face out).
    hair = mesh(scene, 'hair', *(wig(RADIUS+.003, .025) if kind == 'closed wig' else cap(RADIUS+.011)))
    provider_frame(worker, hair)
    fitting = spec()
    report = worker.fit_uniform_part({'slot': 'hair', 'sha256': 'f'*64}, [hair], [body], rig, fitting,
                                     {'hair': worker.hair_target([body], rig, fitting)}, {})
    inner, top = crown_over_scalp(hair)
    # The inner surface rests on the scalp, a few millimetres off it and never inside it; the top follows.
    assert .002 <= inner <= .01
    assert top <= inner+(.025 if kind == 'closed wig' else 0)+.005
    seat = report['measurement']['cavity_fitting']
    assert seat['method'] == 'two_way_inner_hair_seat_v1' and seat['scale'] < 1 and not seat['limited']
    assert seat['crown_gap_before_m'] > .04 and 0 <= seat['crown_gap_m'] <= .01


def test_hair_closed_round_the_head_centre_has_no_cavity_and_keeps_its_place(monkeypatch):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_hair_geometry')
    seat_hair_cavity = modules['avatar_hair_geometry'].seat_hair_cavity
    scene = bpy.context.scene
    rig, body = sd_body(scene)
    # A solid mass of hair round the whole head: its first surface along every ray is its outside.
    mass = mesh(scene, 'hair', *cap(RADIUS+.05, lowest=-90., rings=12))
    before = [tuple(vertex.co) for vertex in mass.data.vertices]
    report = seat_hair_cavity([mass], [body], rig, spec())
    assert (report['reason'], report['scale'], report['rounds']) == ('hair_encloses_head_centre', 1., 0)
    assert [tuple(vertex.co) for vertex in mass.data.vertices] == before


def test_the_seat_fit_leaves_out_rays_that_meet_locks_inside_the_head(monkeypatch):
    _, modules = fake_blender.install(monkeypatch, 'avatar_hair_geometry')
    seat_step = modules['avatar_hair_geometry'].seat_step
    rng = np.random.default_rng(7)
    rays = rng.normal(size=(80, 3))
    rays[:, 2] = np.abs(rays[:, 2])
    rays /= np.linalg.norm(rays, axis=1)[:, None]
    wanted = .213+.01*rng.random(80)
    # A cavity 1.25 times too large and lifted: scaled by 0.8 and moved down it comes onto the scalp.
    move = np.array([.01, -.02, -.06])
    found = (wanted-rays @ move)/.8
    # A quarter of the rays meet locks hanging inside the head first.
    found[:20] *= .6
    scale, shift = seat_step(found, rays, wanted)
    assert scale == pytest.approx(.8) and shift == pytest.approx(move)
