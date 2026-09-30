from __future__ import annotations

import base64

import numpy as np

from src.services import avatar_wardrobe_coverage as cov


def sphere(radius, centre, rows=18, columns=24):
    """A UV sphere (Y up): positions and outward-facing triangles."""
    points = [(centre[0], centre[1] + radius, centre[2])]
    for row in range(1, rows):
        polar = np.pi*row/rows
        for column in range(columns):
            azimuth = 2*np.pi*column/columns
            points.append((centre[0] + radius*np.sin(polar)*np.cos(azimuth), centre[1] + radius*np.cos(polar),
                           centre[2] + radius*np.sin(polar)*np.sin(azimuth)))
    points.append((centre[0], centre[1] - radius, centre[2]))
    ring = lambda row, column: 1 + (row - 1)*columns + column % columns
    triangles = [(0, ring(1, c + 1), ring(1, c)) for c in range(columns)]
    for row in range(1, rows - 1):
        for c in range(columns):
            a, b, d, e = ring(row, c), ring(row, c + 1), ring(row + 1, c), ring(row + 1, c + 1)
            triangles += [(a, b, e), (a, e, d)]
    bottom = len(points) - 1
    triangles += [(ring(rows - 1, c), ring(rows - 1, c + 1), bottom) for c in range(columns)]
    return np.array(points, np.float32), np.array(triangles, np.int64)


def primitive(key, positions, triangles, joint):
    return {'key': key, 'positions': positions, 'triangles': triangles,
            'linear': np.repeat(np.eye(3, dtype=np.float32)[None], len(positions), axis=0),
            'joints': np.array([joint]*len(positions))}


def fraction(bits, count):
    return np.unpackbits(np.frombuffer(base64.b64decode(bits), np.uint8), bitorder='little')[:count].mean()


def test_a_hood_hides_the_torso_under_it_but_never_the_scalp(monkeypatch):
    head, head_faces = sphere(.3, (0, 1.2, 0))
    chest, chest_faces = sphere(.3, (0, .5, 0))
    body = [primitive('0:0', head, head_faces, 'Head'), primitive('0:1', chest, chest_faces, 'Spine')]
    # A hoodie standing 2 cm off the upper head and the chest.
    hood, _ = sphere(.32, (0, 1.2, 0))
    shirt, _ = sphere(.32, (0, .5, 0))
    garment = [primitive('1:0', np.concatenate([hood[hood[:, 1] > 1.1], shirt]), np.zeros((0, 3), np.int64), 'Spine')]
    monkeypatch.setattr(cov, 'skinned_primitives', lambda content: garment)
    value = cov.coverage(body, b'', 'top')
    assert fraction(value['hidden']['0:1'], len(chest_faces)) > .8
    assert fraction(value['hidden']['0:0'], len(head_faces)) == 0
    # Hair still tucks under the raised hood.
    assert value['covers_head']
    assert fraction(value['over']['0:0'], len(head_faces)) > .3
