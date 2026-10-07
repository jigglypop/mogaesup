"""The shoe fitting's own logic (avatar_shoe_geometry) against stand-in Blender modules (tests/fake_blender.py): which
pieces of a provider's pair belong to which foot, the stray fragments it drops, and the pairs it refuses."""
import types

import numpy as np
import pytest

import fake_blender


@pytest.fixture
def shoes(monkeypatch):
    _, modules = fake_blender.install(monkeypatch, 'avatar_shoe_geometry')
    return modules['avatar_shoe_geometry']


def box(low, high, count=6):
    """Points filling the box low..high."""
    axes = [np.linspace(a, b, count) for a, b in zip(low, high)]
    return np.array([(x, y, z) for x in axes[0] for y in axes[1] for z in axes[2]])


LEFT, RIGHT = box((.05, -.1, 0), (.15, .1, .08)), box((-.15, -.1, 0), (-.05, .1, .08))


def test_each_side_is_its_largest_piece_and_the_other_pieces_go_with_the_shoe_they_touch(shoes):
    # A long right shoe puts the pair's middle at x -.05: a strap of it reaching toward the left foot has its centre
    # past that middle, on the left foot's side, yet it is the right shoe's. A buckle sits on the left shoe.
    right = box((-.25, -.1, 0), (-.05, .1, .08))
    strap = box((-.06, -.02, .06), (0., .02, .07), 4)
    buckle = box((.15, 0, .02), (.17, .02, .04), 3)
    assert strap[:, 0].mean() > (-.25 + .15)/2
    sides, dropped = shoes.pair_pieces([LEFT, right, strap, buckle])
    assert sides == ['left', 'right', 'right', 'left'] and dropped == []


def test_a_small_piece_far_from_both_shoes_is_a_stray_fragment(shoes):
    # Flakes 6 cm under the pair, a few points each; a lace end right beside the left shoe stays.
    flake = box((.0, -.3, -.06), (.01, -.29, -.055), 2)
    lace = box((.15, .1, .07), (.16, .11, .08), 2)
    sides, dropped = shoes.pair_pieces([LEFT, RIGHT, flake, lace])
    assert dropped == [2] and sides == ['left', 'right', None, 'left']


def test_a_large_piece_is_kept_however_far_it_lies(shoes):
    sole = box((-.15, -.1, -.2), (.15, .1, -.18), 6)
    sides, dropped = shoes.pair_pieces([LEFT, RIGHT, sole])
    assert dropped == [] and sides[2] in ('left', 'right')


def test_a_pair_with_nothing_on_one_side_is_refused(shoes):
    with pytest.raises(ValueError, match='separate left and right'):
        shoes.pair_pieces([LEFT, LEFT + (0, .3, 0)])
    with pytest.raises(ValueError, match='Missing shoe geometry'):
        shoes.pair_pieces([])


def test_pieces_are_what_the_surface_joins_not_the_uv_islands(shoes):
    # Two triangles cut apart at a UV seam: their shared edge is two copies of the same two positions.
    points = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (1, 0, 0), (0, 1, 0), (1, 1, 0), (5, 5, 5), (6, 5, 5), (5, 6, 5)]
    faces = [(0, 1, 2), (3, 5, 4), (6, 7, 8)]
    obj = types.SimpleNamespace(data=types.SimpleNamespace(
        vertices=[types.SimpleNamespace(index=i, co=fake_blender.Vector(p)) for i, p in enumerate(points)],
        polygons=[types.SimpleNamespace(vertices=face) for face in faces]))
    pieces = sorted(sorted(piece) for piece in shoes._components(obj))
    assert pieces == [[0, 1, 2, 3, 4, 5], [6, 7, 8]]


def shoe_mesh(scene, name, pieces):
    """A stand-in mesh object of `pieces` (point arrays), each piece one fan of polygons."""
    points, polygons = [], []
    for piece in pieces:
        start = len(points)
        points += [tuple(point) for point in piece]
        polygons += [types.SimpleNamespace(vertices=(start, start + i, start + i + 1)) for i in range(1, len(piece) - 1)]
    obj = fake_blender.mesh(scene, name, points)
    obj.data.polygons = polygons
    return obj


def test_a_pair_is_fitted_per_foot_without_its_stray_fragment(shoes, monkeypatch):
    import bpy
    deleted = []

    def delete_pieces(components):
        # As bmesh would: the pieces' vertices leave their meshes and the rest are numbered again.
        for row in components:
            deleted.append(len(row['indices']))
            data = row['object'].data
            keep = [vertex for vertex in data.vertices if vertex.index not in row['indices']]
            renumber = {vertex.index: index for index, vertex in enumerate(keep)}
            for index, vertex in enumerate(keep):
                vertex.index = index
            data.vertices = keep
            data.polygons = [types.SimpleNamespace(vertices=tuple(renumber[v] for v in face.vertices))
                             for face in data.polygons if all(v in renumber for v in face.vertices)]
    monkeypatch.setattr(shoes, '_delete_pieces', delete_pieces)
    flake = box((-.01, -.4, -.3), (.0, -.39, -.29), 2)
    obj = shoe_mesh(bpy.context.scene, 'pair', [LEFT, RIGHT, flake])
    targets = {'left': [[.04, 0., -.12], [.16, .1, .12]], 'right': [[-.16, 0., -.12], [-.04, .1, .12]]}
    feet = {side: (fake_blender.Vector(low), fake_blender.Vector(high)) for side, low, high in (
        ('left', (.05, -.08, 0), (.14, .09, .05)), ('right', (-.14, -.08, 0), (-.05, .09, .05)))}
    measurement, regions = shoes.fit_shoes_rigid([obj], targets, feet=feet)
    assert deleted == [len(flake)] and measurement['fragments_dropped'] == 1
    assert len(obj.data.vertices) == len(LEFT) + len(RIGHT)
    assert sorted(regions[obj]) == list(range(len(obj.data.vertices)))
    assert {regions[obj][index] for index in range(len(LEFT))} == {'left'}
    assert {regions[obj][index] for index in range(len(LEFT), len(LEFT) + len(RIGHT))} == {'right'}
    # Each shoe sits on its own foot's target, sole down.
    left = np.array([tuple(v.co) for v in obj.data.vertices[:len(LEFT)]])
    right = np.array([tuple(v.co) for v in obj.data.vertices[len(LEFT):]])
    assert left[:, 0].min() > 0 > right[:, 0].max()
    assert left[:, 2].min() == pytest.approx(0, abs=1e-9) and right[:, 2].min() == pytest.approx(0, abs=1e-9)


@pytest.mark.parametrize('cover, message', [
    ({'left': .3, 'right': .9}, 'do not cover both feet'),
    ({'left': .99, 'right': .7}, 'One shoe of the pair is incomplete'),
])
def test_a_broken_pair_is_refused_with_its_own_code(shoes, cover, message):
    with pytest.raises(shoes.ShoeRefusal, match=message) as refused:
        shoes.check_shoe_coverage(cover)
    assert refused.value.code == 'shoes_incomplete' and isinstance(refused.value, ValueError)


def test_a_sound_pair_is_offered(shoes):
    shoes.check_shoe_coverage({'left': .81, 'right': .84})
    shoes.check_shoe_coverage({'left': .55, 'right': .6})
