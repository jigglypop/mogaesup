from __future__ import annotations

import numpy as np

from src.services.avatar_hood_room import ROOM_M, hood_room


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
