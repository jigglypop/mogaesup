from __future__ import annotations

import json
import struct

import pytest

from src.services import avatar_fitting_management
from src.services.avatar_variants import AvatarVariants
from src.services.glb import build_glb

BASE = {'base_job_id': 'a'*24, 'base_version': 'b'*24, 'slot': 'top'}


def accepted(monkeypatch, payload):
    service = AvatarVariants(factory=None)
    captured = {}

    def create(owner, key, variant, frozen_context=None):
        captured.update(variant)
        return {'id': 'job'}, True
    monkeypatch.setattr(service, 'create', create)
    service.create_single_part('owner', 'request-key-1', payload)
    return captured


def test_a_single_part_takes_its_own_design_brief_and_name(monkeypatch):
    variant = accepted(monkeypatch, {**BASE, 'description': '  Lavender oversized hoodie, hood down.  ',
                                     'part_name': '라벤더 후드티'})
    assert variant['descriptions'] == {'top': 'Lavender oversized hoodie, hood down.'}
    assert variant['part_name'] == '라벤더 후드티'


def test_without_a_brief_the_prompt_library_describes_the_part(monkeypatch):
    variant = accepted(monkeypatch, {**BASE, 'description': '   '})
    assert variant['descriptions'] == {}
    assert 'part_name' not in variant


def skinned_body():
    """A skinned body whose accessors cover what the identity reads: an interleaved float position, unsigned joints,
    normalized weights, a signed normalized attribute, 16-bit indices and an inverse bind matrix."""
    rows = 5
    positions = b''.join(struct.pack('<3f', row*.5, .1-row, .25*row) + bytes(4) for row in range(rows))
    joints = b''.join(struct.pack('<4H', row % 2, 0, 0, 0) for row in range(rows))
    weights = b''.join(struct.pack('<4B', 255-row*40, row*40, 0, 0) for row in range(rows))
    signed = b''.join(struct.pack('<2h', -32768, row*1000-2000) for row in range(rows))
    indices = struct.pack('<6H', 0, 1, 2, 2, 3, 4)
    inverse = struct.pack('<16f', 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, .5, -1.25, .1, 1)
    views, binary = [], b''
    for data, stride in ((positions, 16), (joints, None), (weights, None), (signed, None), (indices, None), (inverse, None)):
        views.append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(data), **({'byteStride': stride} if stride else {})})
        binary += data + bytes(-len(data) % 4)
    doc = {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': len(binary)}], 'bufferViews': views,
           'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': rows, 'type': 'VEC3'},
                         {'bufferView': 1, 'componentType': 5123, 'count': rows, 'type': 'VEC4'},
                         {'bufferView': 2, 'componentType': 5121, 'count': rows, 'type': 'VEC4', 'normalized': True},
                         {'bufferView': 3, 'componentType': 5122, 'count': rows, 'type': 'VEC2', 'normalized': True},
                         {'bufferView': 4, 'componentType': 5123, 'count': 6, 'type': 'SCALAR'},
                         {'bufferView': 5, 'componentType': 5126, 'count': 1, 'type': 'MAT4'}],
           'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'JOINTS_0': 1, 'WEIGHTS_0': 2}, 'indices': 4},
                                      {'attributes': {'POSITION': 0, 'WEIGHTS_0': 3}}]}],
           'nodes': [{'name': 'body', 'mesh': 0, 'skin': 0}, {'name': 'hips', 'translation': [0, .5, 0]}],
           'skins': [{'joints': [1], 'inverseBindMatrices': 5}], 'scenes': [{'nodes': [0, 1]}], 'scene': 0}
    return build_glb(doc, binary)


class Encoder:
    """json as the identity uses it, noting the length of every list it encodes."""

    def __init__(self):
        self.lists = []

    def dumps(self, value, **options):
        if isinstance(value, list):
            self.lists.append(len(value))
        return json.dumps(value, **options)


@pytest.mark.parametrize('rows', [1, 2, 4, 65536])
def test_the_body_identity_is_hashed_a_slice_at_a_time_and_keeps_its_value(monkeypatch, rows):
    encoder = Encoder()
    monkeypatch.setattr(avatar_fitting_management, 'json', encoder)
    monkeypatch.setattr(avatar_fitting_management, 'IDENTITY_ROWS', rows)
    # The digest geometry_identity gave this body when it encoded every accessor's whole value list at once: saved
    # common bodies and wardrobe registrations are compared with it.
    assert avatar_fitting_management.geometry_identity(skinned_body()) == '7f97e4abe4f96087056a67b2b33fb372fb8b6a3313ee3855bb7314f9fc80e44e'
    assert encoder.lists and max(encoder.lists) <= rows
