"""Worn hair is seated on the frozen scalp, unless its crown was removed with the provider's mannequin head.

seat_worn_hair decides; the seat itself is tested with hair_seating's fake Blender. Here the decision is run against the
stand-in modules (tests/fake_blender.py), with the head and the seat replaced by what they would return.
"""
from types import SimpleNamespace

import pytest

import fake_blender

SEATS = {'method': 'two_way_inner_hair_seat_v1', 'rounds': 2}


class Identity:
    """A world matrix that leaves the vertex as it is."""

    def __matmul__(self, co):
        return co


def extracted_hair(top):
    """One object of extracted hair whose highest vertex is at `top` metres."""
    return SimpleNamespace(matrix_world=Identity(), data=SimpleNamespace(vertices=[SimpleNamespace(co=SimpleNamespace(z=top))]))


@pytest.fixture
def worn(monkeypatch):
    _, modules = fake_blender.install(monkeypatch, 'avatar_native_parts_blender')
    module = modules['avatar_native_parts_blender']
    # The frozen head's top is at 1.2 m.
    monkeypatch.setattr(module, 'head_region', lambda body, rig, spec: (None, SimpleNamespace(z=1.2), 1.0))
    calls = []
    monkeypatch.setattr(module, 'seat_hair_cavity', lambda meshes, body, rig, spec: calls.append(meshes) or dict(SEATS))
    return module, calls


SPEC = {'fitting': {'hair_cavity_seat': 'two-way-v1'}}


def test_worn_hair_with_its_crown_is_seated_on_the_frozen_scalp(worn):
    module, calls = worn
    hair = [extracted_hair(1.19)]
    assert module.seat_worn_hair(hair, None, None, SPEC) == SEATS
    assert calls == [hair]


def test_worn_hair_whose_crown_was_removed_is_left_as_extracted(worn):
    module, calls = worn
    report = module.seat_worn_hair([extracted_hair(1.10)], None, None, SPEC)
    assert report['reason'] == 'crown_missing' and report['method'] == 'two_way_inner_hair_seat_v1'
    assert report['top_below_head_m'] == pytest.approx(0.1)
    assert calls == []


def test_only_a_spec_that_seats_hair_seats_worn_hair(worn):
    module, calls = worn
    assert module.seat_worn_hair([extracted_hair(1.19)], None, None, {'fitting': {}}) is None
    assert calls == []
