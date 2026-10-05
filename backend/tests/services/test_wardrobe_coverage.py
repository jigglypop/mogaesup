from __future__ import annotations

import base64

import numpy as np
import pytest

from src.services import avatar_wardrobe_coverage as cov
from wardrobe_fixture import Library, put

BODY, BODY_VERSION, PART, V1 = 'b' * 24, '1' * 24, 'c' * 24, 'a' * 24


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


@pytest.fixture
def closet(tmp_path):
    library = Library(tmp_path)
    library.job(BODY)
    library.assembly(BODY, BODY_VERSION, slots=())
    library.current(BODY, BODY_VERSION)
    library.register((BODY, BODY_VERSION))
    library.job(PART, base=(BODY, BODY_VERSION), requested=['top'])
    library.assembly(PART, V1, slots=('top',))
    library.current(PART, V1)
    return library


def describe(library, text):
    put(library.directory(PART)/'pipeline.json', {'parts': [{'slot': 'top', 'description': text}]})


def reaching_the_legs(library):
    """The coverage a long top has once computed: it reaches the lower thighs, so it would take the bottom off."""
    body_sha = library.file_sha(BODY, BODY_VERSION, 'body')
    put(library.wardrobe.library.root/'wardrobe-coverage'/f"{body_sha[:20]}-{library.file_sha(PART, V1, 'top')[:20]}-v12.json",
        {'slot': 'top', 'covers_bottom': True})


@pytest.mark.parametrize('text, outerwear', [
    ('긴 코트', True), ('점퍼', True), ('Cardigan', True),
    ('롱 후드 집업', True), ('후디', True), ('집업 후드티', True), ('oversized zip-up hoodie', True),
    ('long hooded zip up', True), ('hoodie', True), ('Zip-Up Jacket', True),
    ('점퍼스커트', False), ('체크 점퍼 스커트', False), ('navy jumper skirt', False), ('Jumper-Dress', False),
    ('pinafore', False),
    ('후드 원피스', False), ('hoodie dress', False), ('롱 코트 드레스', False), ('원피스', False),
    ('흰색 긴 티셔츠', False), ('', False),
])
def test_outerwear_is_told_from_a_dress_by_the_description(closet, text, outerwear):
    describe(closet, text)
    assert closet.wardrobe._outerwear(PART, 'top') is outerwear


def test_a_long_hooded_zip_up_stays_over_the_bottom_but_a_jumper_skirt_takes_it_off(closet):
    reaching_the_legs(closet)
    describe(closet, '롱 후드 집업')
    assert closet.wardrobe.coverage(BODY, PART, 'top', V1)['covers_bottom'] is False
    describe(closet, '체크 점퍼스커트')
    assert closet.wardrobe.coverage(BODY, PART, 'top', V1)['covers_bottom'] is True


@pytest.mark.parametrize('prefix', ['', 'mixamorig:'])
def test_boots_are_found_on_the_shins_of_a_prefixed_skeleton(monkeypatch, prefix):
    shin, shin_faces = sphere(.08, (0, .3, 0))
    body = [primitive('0:0', shin, shin_faces, prefix + 'LeftLeg')]
    boot, _ = sphere(.095, (0, .3, 0))
    monkeypatch.setattr(cov, 'skinned_primitives', lambda content: [primitive('1:0', boot, np.zeros((0, 3), np.int64), 'LeftFoot')])
    assert cov.coverage(body, b'', 'shoes')['boot'] is True


def test_a_dress_is_found_over_the_thighs_of_a_prefixed_skeleton(monkeypatch):
    thigh, thigh_faces = sphere(.12, (0, .6, 0))
    body = [primitive('0:0', thigh, thigh_faces, 'mixamorig:LeftUpLeg')]
    dress, _ = sphere(.135, (0, .6, 0))
    monkeypatch.setattr(cov, 'skinned_primitives', lambda content: [primitive('1:0', dress, np.zeros((0, 3), np.int64), 'Spine')])
    assert cov.coverage(body, b'', 'top')['covers_bottom'] is True


def test_bone_names_are_compared_without_their_rig_prefix():
    assert list(cov.bone_keys(['mixamorig:LeftLeg', 'LeftUpLeg', 'a:b:Head'])) == ['leftleg', 'leftupleg', 'head']
    assert list(cov.bone_keys([])) == []
