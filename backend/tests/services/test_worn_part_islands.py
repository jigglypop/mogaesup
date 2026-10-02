"""Small-fragment removal of a worn part: the distance to the main piece is computed in bounded blocks.

`avatar_worn_part` imports Blender's modules at load time. The tests install stand-ins for them, import
the module fresh and take it (and `avatar_shell_garment`) out of `sys.modules` again.
"""
from __future__ import annotations

import importlib
import sys
import tracemalloc
import types

import numpy as np
import pytest

IMPORTED = ('src.services.avatar_worn_part', 'src.services.avatar_shell_garment')


@pytest.fixture
def worn(monkeypatch):
    stubs = {name: types.ModuleType(name) for name in ('bpy', 'bmesh', 'mathutils', 'mathutils.bvhtree', 'mathutils.kdtree')}
    stubs['mathutils'].Vector = type('Vector', (), {})
    stubs['mathutils.bvhtree'].BVHTree = type('BVHTree', (), {})
    stubs['mathutils.kdtree'].KDTree = type('KDTree', (), {})
    for name, module in stubs.items():
        monkeypatch.setitem(sys.modules, name, module)
    services = importlib.import_module('src.services')
    for name in IMPORTED:   # put back (or removed) when the test ends, with the package attribute
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
        monkeypatch.setattr(services, name.rsplit('.', 1)[1], None, raising=False)
        del sys.modules[name]
    module = importlib.import_module('src.services.avatar_worn_part')
    module.stub_bmesh = stubs['bmesh']
    return module


def all_pairs(points, others):
    """The gap as it was computed: every pair at once."""
    return float(np.sqrt(((points[:, None, :] - others[None, :, :])**2).sum(axis=2).min()))


@pytest.mark.parametrize('block_bytes', [1, 56*53, 56*53*7, 56*53*37, 56*53*38, 10**9])
def test_the_gap_is_the_same_whatever_the_block_size(worn, block_bytes):
    rng = np.random.default_rng(11)
    for rows, columns in ((37, 53), (1, 53), (37, 1), (1, 1), (64, 64)):
        points = rng.normal(size=(rows, 3))*.3
        others = rng.normal(size=(columns, 3))*.3 + .1
        assert worn.nearest_gap(points, others, block_bytes=block_bytes) == all_pairs(points, others)


def test_the_gap_of_touching_and_separate_sets(worn):
    line = np.c_[np.linspace(0, 1, 50), np.zeros(50), np.zeros(50)]
    assert worn.nearest_gap(line[:10], line[9:], block_bytes=1) == 0.
    assert worn.nearest_gap(line[:10] + [0, 0, .3], line[20:], block_bytes=1) == pytest.approx(
        np.hypot(line[20, 0] - line[9, 0], .3))


def test_thousands_of_points_never_need_the_whole_distance_matrix(worn):
    rng = np.random.default_rng(5)
    points, others = rng.normal(size=(1500, 3)), rng.normal(size=(1500, 3)) + 4.
    block = 4 << 20                       # the whole matrix of offsets alone would be 54 MB
    tracemalloc.start()
    try:
        gap = worn.nearest_gap(points, others, block_bytes=block)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak <= block
    assert gap == pytest.approx(min(np.sqrt(((others - point)**2).sum(axis=1).min()) for point in points), rel=1e-12)
    assert worn.GAP_BLOCK_BYTES == 64 << 20


class Rows(list):
    def ensure_lookup_table(self):
        pass


class Polygon:
    def __init__(self, vertices):
        self.vertices = vertices


class Buffer:
    """The part of a Blender mesh's collection API that mesh_arrays reads."""
    def __init__(self, rows):
        self.rows = rows

    def __len__(self):
        return len(self.rows)

    def foreach_get(self, name, out):
        out[:] = np.asarray(self.rows, dtype=out.dtype).reshape(-1)


class Mesh:
    def __init__(self, points, triangles):
        self.vertices = Buffer(points)
        self.polygons = [Polygon(list(t)) for t in triangles]
        self.loop_triangles = Buffer(triangles)

    def calc_loop_triangles(self):
        pass

    def update(self):
        pass


def grid(columns, rows, origin):
    """Vertices and triangles of a flat grid with its corner at `origin`."""
    points = [(origin[0] + x*.01, origin[1] + y*.01, origin[2]) for y in range(rows) for x in range(columns)]
    triangles = []
    for y in range(rows - 1):
        for x in range(columns - 1):
            a, b, c, d = y*columns + x, y*columns + x + 1, (y+1)*columns + x + 1, (y+1)*columns + x
            triangles += [(a, b, c), (a, c, d)]
    return points, triangles


def mesh_with_fragment(fragment_at):
    """A 20x20 grid (722 triangles) and one 2x2 fragment (2 triangles) `fragment_at` metres above its corner."""
    main_points, main_triangles = grid(20, 20, (0., 0., 0.))
    piece_points, piece_triangles = grid(2, 2, (0., 0., fragment_at))
    offset = len(main_points)
    points = main_points + piece_points
    triangles = main_triangles + [tuple(i + offset for i in t) for t in piece_triangles]
    return types.SimpleNamespace(data=Mesh(points, triangles)), len(main_triangles)


@pytest.fixture
def deleted(worn):
    """Faces handed to bmesh.ops.delete, per call."""
    calls = []

    class Edit:
        def __init__(self):
            self.faces = Rows()
            self.verts = []

        def from_mesh(self, mesh):
            self.faces = Rows(range(len(mesh.polygons)))

        def to_mesh(self, mesh):
            pass

        def free(self):
            pass

    worn.stub_bmesh.new = Edit
    worn.stub_bmesh.ops = types.SimpleNamespace(delete=lambda edit, geom, context: calls.append((sorted(geom), context)))
    return calls


def hugging_nothing(points):
    return np.full(len(points), .5)      # far from the body: only the distance to the main piece decides


def test_a_fragment_beside_the_main_piece_stays_and_a_detached_one_goes(worn, deleted):
    obj, main_faces = mesh_with_fragment(fragment_at=.03)       # .03 m: within detached_m
    assert worn.remove_small_islands(obj, hugging=hugging_nothing) == {'islands': 2, 'removed_islands': 0}
    assert deleted == []
    obj, main_faces = mesh_with_fragment(fragment_at=.2)        # .2 m: a speck away from it
    assert worn.remove_small_islands(obj, hugging=hugging_nothing) == {'islands': 2, 'removed_islands': 1}
    assert deleted == [([main_faces, main_faces + 1], 'FACES')]


def test_the_five_centimetre_threshold_is_unchanged(worn, deleted):
    # The fragment's nearest vertex is fragment_at straight above the grid's corner vertex.
    near, _ = mesh_with_fragment(fragment_at=.049)
    far, _ = mesh_with_fragment(fragment_at=.051)
    assert worn.remove_small_islands(near, hugging=hugging_nothing)['removed_islands'] == 0
    assert worn.remove_small_islands(far, hugging=hugging_nothing)['removed_islands'] == 1
