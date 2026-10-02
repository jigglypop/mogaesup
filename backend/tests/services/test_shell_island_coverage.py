"""Body shell garment: body hidden under a removed sliver is uncovered, and an all-sliver shell fails.

`avatar_shell_garment` imports Blender's modules at load time. The tests install stand-ins for them,
import the module fresh and take it out of `sys.modules` again.
"""
from __future__ import annotations

import importlib
import sys
import types

import numpy as np
import pytest

MODULE = 'src.services.avatar_shell_garment'


@pytest.fixture
def shell(monkeypatch):
    stubs = {name: types.ModuleType(name) for name in ('bpy', 'bmesh', 'mathutils', 'mathutils.bvhtree', 'mathutils.kdtree')}
    stubs['mathutils'].Vector = type('Vector', (), {})
    stubs['mathutils.bvhtree'].BVHTree = type('BVHTree', (), {})
    stubs['mathutils.kdtree'].KDTree = type('KDTree', (), {})
    for name, module in stubs.items():
        monkeypatch.setitem(sys.modules, name, module)
    services = importlib.import_module('src.services')
    monkeypatch.setitem(sys.modules, MODULE, types.ModuleType(MODULE))   # put back (or removed) when the test ends
    monkeypatch.setattr(services, MODULE.rsplit('.', 1)[1], None, raising=False)
    del sys.modules[MODULE]
    return importlib.import_module(MODULE)


def body_grid(size):
    """A flat size x size grid of body vertices (z = 0) and its triangles, two to a cell."""
    positions = np.array([(x, y, 0.) for y in range(size) for x in range(size)])
    triangles = []
    for y in range(size - 1):
        for x in range(size - 1):
            a, b, c, d = y*size + x, y*size + x + 1, (y+1)*size + x + 1, (y+1)*size + x
            triangles += [(a, b, c), (a, c, d)]
    return positions, np.array(triangles)


def cut(shell, positions, triangles, inside):
    """iso_cut of the body at `inside` vertices, as build_shell_garment does it: (triangles, weld_like, parents, covered)."""
    boundary = np.where(inside, 1., -1.)
    cut_positions, cut_triangles, _, parents = shell.iso_cut(positions, boundary, triangles, [np.zeros((len(positions), 1))], level=0.)
    _, weld_like = np.unique(np.round(cut_positions/1e-5).astype(np.int64), axis=0, return_inverse=True)
    return cut_positions, cut_triangles, weld_like.reshape(-1), parents, (boundary >= 0).astype(float)


def inside_vertices(size, *, block, specks=()):
    mask = np.zeros(size*size, dtype=bool)
    x0, x1, y0, y1 = block
    for y in range(y0, y1):
        for x in range(x0, x1):
            mask[y*size + x] = True
    for x, y in specks:
        mask[y*size + x] = True
    return mask


def body_vertices_in(parents, triangles):
    return {int(parents[v][0]) for v in np.unique(triangles) if parents[v][0] == parents[v][1]}


def test_body_under_a_removed_sliver_is_no_longer_covered(shell):
    size = 24
    positions, body = body_grid(size)
    sliver = (21, 12)
    inside = inside_vertices(size, block=(2, 14, 2, 20), specks=[sliver])
    _, triangles, weld_like, parents, covered = cut(shell, positions, body, inside)
    sliver_index = sliver[1]*size + sliver[0]
    assert covered[sliver_index] == 1.
    kept, after, uncovered = shell.drop_small_islands(triangles, weld_like, parents, covered)
    assert uncovered == 1
    assert after[sliver_index] == 0.
    assert covered[sliver_index] == 1.                          # the input is not changed
    assert np.array_equal(np.delete(after, sliver_index), np.delete(covered, sliver_index))
    assert len(kept) == len(triangles) - 6                      # the six triangles around the sliver's vertex
    # Coverage is exactly the body vertices the kept shell stands on.
    assert set(np.flatnonzero(after >= .5).tolist()) == body_vertices_in(parents, kept)
    assert after.sum() == covered.sum() - 1


def test_nothing_changes_when_no_island_is_removed(shell):
    size = 24
    positions, body = body_grid(size)
    _, triangles, weld_like, parents, covered = cut(shell, positions, body, inside_vertices(size, block=(2, 14, 2, 20)))
    kept, after, uncovered = shell.drop_small_islands(triangles, weld_like, parents, covered)
    assert kept is triangles and after is covered and uncovered == 0


def test_a_shell_of_only_slivers_fails_instead_of_leaving_an_empty_garment(shell):
    size = 21
    positions, body = body_grid(size)
    specks = [(x, y) for x in range(1, size - 1, 2) for y in range(1, size - 1, 2)]      # 100 separate vertices
    _, triangles, weld_like, parents, covered = cut(shell, positions, body, inside_vertices(size, block=(0, 0, 0, 0), specks=specks))
    assert len(triangles) == 6*len(specks)
    assert not shell.component_mask(triangles, weld_like).any()
    with pytest.raises(ValueError, match='only small disconnected pieces'):
        shell.drop_small_islands(triangles, weld_like, parents, covered)


def test_a_seam_duplicate_of_a_covered_vertex_stays_with_its_island(shell):
    # Two body vertices at one position (a UV seam) in the removed island leave coverage together.
    size = 24
    positions, body = body_grid(size)
    duplicate = len(positions)
    positions = np.vstack([positions, positions[12*size + 21]])
    sliver = 12*size + 21
    rows = np.flatnonzero((body == sliver).any(axis=1))
    assert len(rows) == 6
    body = body.copy()
    for row in rows[:3]:                     # half of the vertex's triangles use the duplicate
        body[row][body[row] == sliver] = duplicate
    inside = np.append(inside_vertices(size, block=(2, 14, 2, 20), specks=[(21, 12)]), True)
    _, triangles, weld_like, parents, covered = cut(shell, positions, body, inside)
    _, after, uncovered = shell.drop_small_islands(triangles, weld_like, parents, covered)
    assert uncovered == 2
    assert after[sliver] == 0. and after[duplicate] == 0.
