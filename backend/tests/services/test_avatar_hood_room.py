from __future__ import annotations

import tracemalloc

import numpy as np

from src.services.avatar_hood_room import BLOCK_BYTES, NEAREST, REACH_SCALP_M, ROOM_M, _nearest, hood_room


def sphere(radius, centre, count=1600):
    """Points and outward normals of a sphere (Fibonacci lattice), and each point's nearest neighbours."""
    index = np.arange(count) + .5
    polar = np.arccos(1 - 2*index/count)
    azimuth = np.pi*(1 + 5**.5)*index
    normals = np.c_[np.cos(azimuth)*np.sin(polar), np.sin(azimuth)*np.sin(polar), np.cos(polar)]
    points = np.asarray(centre) + radius*normals
    distance = ((points[:, None, :] - points[None, :, :])**2).sum(axis=2)
    neighbours = [list(np.argsort(row)[1:7]) for row in distance]
    return points, normals, neighbours


def test_a_tight_hood_gets_room_over_the_crown_and_keeps_its_neck():
    scalp, normals, neighbours = sphere(.2, (0, 0, 1))
    collar = .85
    # A hood 3 mm off the upper head, and a band of collar below the head that must not move.
    upper = scalp[:, 2] > .95
    hood = np.concatenate([scalp[upper] + .003*normals[upper],
                           np.c_[np.cos(np.linspace(0, 6, 40))*.12, np.sin(np.linspace(0, 6, 40))*.12, np.full(40, .8)]])
    moves, report = hood_room(hood, scalp, normals, neighbours, np.zeros((0, 3)), collar)
    lifted = hood + moves
    crown = np.argmax(hood[:, 2])
    assert np.linalg.norm(lifted[crown] - (0, 0, 1)) - .2 >= ROOM_M[1]*.9
    assert np.allclose(moves[-40:], 0)
    assert report['lifted_vertices'] > 0


def test_inner_and_outer_hood_surfaces_move_together():
    scalp, normals, neighbours = sphere(.2, (0, 0, 1))
    upper = scalp[:, 2] > 1.1
    inner, outer = scalp[upper] + .003*normals[upper], scalp[upper] + .008*normals[upper]
    moves, _ = hood_room(np.concatenate([inner, outer]), scalp, normals, neighbours, np.zeros((0, 3)), .85)
    half = len(inner)
    thickness = np.linalg.norm((outer + moves[half:]) - (inner + moves[:half]), axis=1)
    assert np.allclose(thickness, .005, atol=.002)


def test_a_sleeve_nearer_the_shoulder_than_the_scalp_stays():
    scalp, normals, neighbours = sphere(.2, (0, 0, 1))
    shoulder = np.array([[.3, 0, .9]])
    sleeve = shoulder + (0, 0, .01)
    moves, _ = hood_room(sleeve, scalp, normals, neighbours, shoulder, .85)
    assert np.allclose(moves, 0)


def test_a_hood_with_room_already_is_left_as_it_is():
    scalp, normals, neighbours = sphere(.2, (0, 0, 1))
    upper = scalp[:, 2] > .95
    hood = scalp[upper] + .08*normals[upper]
    moves, _ = hood_room(hood, scalp, normals, neighbours, np.zeros((0, 3)), .85)
    assert np.abs(moves).max() < 1e-6


def test_the_nearest_scalp_points_come_nearest_first_whatever_the_block_size():
    rng = np.random.default_rng(7)
    points, targets = rng.uniform(-.2, .2, (700, 3)), rng.uniform(-.3, .3, (3000, 3))
    pairs = np.sqrt(((points[:, None, :] - targets[None, :, :])**2).sum(axis=2))
    expected = np.sort(pairs, axis=1)[:, :NEAREST]
    expected[expected > REACH_SCALP_M] = np.inf
    # One block for a whole chunk, and blocks of only NEAREST targets.
    for block_bytes in (BLOCK_BYTES, 1):
        distance, index = _nearest(points, targets, NEAREST, 2, block_bytes=block_bytes)
        # The gate reads column 0 as the nearest scalp point.
        assert np.array_equal(distance, expected)
        found = np.isfinite(distance)
        assert np.array_equal(np.take_along_axis(pairs, index, axis=1)[found], distance[found])


def test_a_detailed_body_does_not_take_more_memory_to_lift_the_hood():
    scalp, normals, neighbours = sphere(.2, (0, 0, 1))
    upper = scalp[:, 2] > .95
    hood = scalp[upper] + .003*normals[upper]
    # Shoulders and arms of a body of many vertices, all within reach of the hood.
    rng = np.random.default_rng(3)
    rest = np.c_[rng.uniform(-.4, .4, (20000, 2)), rng.uniform(.7, .8, 20000)]
    tracemalloc.start()
    try:
        hood_room(hood, scalp, normals, neighbours, rest, .85)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    # Every hood vertex of a chunk against every body vertex at once took some 300 MB here, and grew with the body.
    assert peak < 100*1024*1024
