"""Validate native hair skin/bind preservation without Blender, providers or AWS."""
from copy import deepcopy
import ast
import hashlib
import io
import math
from pathlib import Path
import struct
from types import SimpleNamespace

import numpy as np
from PIL import Image
import pytest

from src.services.avatar_factory import AvatarFactory
from src.services.avatar_glb_bodies import AvatarGlbBodies
from src.services.avatar_native_parts import uploaded_native_hair
from src.services.glb import build_glb, parse_glb
from src.services.native_hair_upload import _Reader, validate_native_hair


def native_fixture(*, role='hair', texture_edge=None):
    doc = {'asset': {'version': '2.0'}, 'buffers': [{'byteLength': 0}],
        'bufferViews': [], 'accessors': [], 'materials': [],
        'nodes': [{'name': 'Hips', 'children': [1]}, {'name': 'Head', 'translation': [0, 1, 0]},
                  {'name': 'hair' if role == 'hair' else 'body', 'mesh': 0, 'skin': 0,
                   'extras': {'standard_slot': role, 'part_role': role}}],
        'scenes': [{'nodes': [0, 2]}], 'scene': 0}
    binary = bytearray()
    def accessor(code, count, shape, values, **extras):
        binary.extend(b'\0'*(-len(binary)%4))
        formats = {5121: 'B', 5123: 'H', 5126: 'f'}
        raw = struct.pack('<'+formats[code]*len(values), *values)
        doc['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(raw)})
        binary.extend(raw)
        doc['accessors'].append({'bufferView': len(doc['bufferViews'])-1, 'componentType': code,
            'count': count, 'type': shape, **extras})
        return len(doc['accessors'])-1
    position = accessor(5126, 3, 'VEC3', [0, 1, 0, .1, 1, 0, 0, 1.1, 0], min=[0, 1, 0], max=[.1, 1.1, 0])
    joints = accessor(5121, 3, 'VEC4', [1, 0, 0, 0]*3)
    weights = accessor(5126, 3, 'VEC4', [1, 0, 0, 0]*3)
    indices = accessor(5123, 3, 'SCALAR', [0, 1, 2])
    identity = [1 if i%5 == 0 else 0 for i in range(16)]
    head_bind = list(identity); head_bind[13] = -1
    binds = accessor(5126, 2, 'MAT4', identity+head_bind)
    doc['skins'] = [{'joints': [0, 1], 'inverseBindMatrices': binds}]
    doc['meshes'] = [{'primitives': [{'attributes': {'POSITION': position, 'JOINTS_0': joints, 'WEIGHTS_0': weights},
                                    'indices': indices}]}]
    time = accessor(5126, 2, 'SCALAR', [0, 1], min=[0], max=[1])
    rotation = accessor(5126, 2, 'VEC4', [0, 0, 0, 1]*2)
    doc['animations'] = [{'name': 'walk', 'samplers': [{'input': time, 'output': rotation}],
        'channels': [{'sampler': 0, 'target': {'node': 1, 'path': 'rotation'}}]}]
    if texture_edge:
        encoded = io.BytesIO(); Image.new('RGB', (texture_edge, 1)).save(encoded, format='PNG')
        raw = encoded.getvalue(); binary.extend(b'\0'*(-len(binary)%4))
        doc['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(raw)})
        binary.extend(raw)
        doc['images'] = [{'bufferView': len(doc['bufferViews'])-1, 'mimeType': 'image/png'}]
        doc['textures'] = [{'source': 0}]
        doc['materials'] = [{'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}}}]
        doc['meshes'][0]['primitives'][0]['material'] = 0
    doc['buffers'][0]['byteLength'] = len(binary)
    return build_glb(doc, bytes(binary))


def edit_values(doc, binary, accessor, code, values):
    item = doc['accessors'][accessor]; view = doc['bufferViews'][item['bufferView']]
    binary = bytearray(binary)
    raw = struct.pack('<'+code*len(values), *values)
    offset = view.get('byteOffset', 0)+item.get('byteOffset', 0)
    binary[offset:offset+len(raw)] = raw
    return binary


def test_native_hair_accepts_identical_frozen_body_and_preserves_source_bytes():
    hair, body = native_fixture(), native_fixture(role='body')
    before = bytes(hair)
    report = validate_native_hair(hair, body_content=body)
    assert hair == before
    assert report['runtime_triangles'] == 1 and report['budget_met'] is True
    assert report['optimization'] == 'native_upload_preserved'
    assert validate_native_hair(hair, body_content=body, inspect=False) == report


@pytest.mark.parametrize('change', ['untagged', 'body_tag', 'unskinned', 'hidden_mesh', 'duplicate_mesh',
    'empty_weights', 'negative_weights', 'nonfinite_weights', 'sum_weights', 'body_weights', 'joint_range',
    'nonfinite_position', 'index_range', 'changing_rest', 'nonfinite_rest', 'changing_bind', 'nonfinite_bind',
    'changing_parent', 'duplicate_names', 'clip_changed', 'sparse', 'normalized_joints',
    'singular_mesh_matrix', 'projective_mesh_matrix'])
def test_invalid_native_hair_cannot_enter_prefit_path(change):
    source = native_fixture(); doc, binary = parse_glb(source, strict=True)
    if change == 'untagged': doc['nodes'][2].pop('extras')
    if change == 'body_tag': doc['nodes'][2]['extras']['standard_slot'] = 'body'
    if change == 'unskinned': doc['nodes'][2].pop('skin')
    if change == 'hidden_mesh': doc['meshes'].append(deepcopy(doc['meshes'][0]))
    if change == 'duplicate_mesh': doc['nodes'].append(deepcopy(doc['nodes'][2])); doc['scenes'][0]['nodes'].append(3)
    if change == 'empty_weights': binary = edit_values(doc, binary, 2, 'f', [0, 0, 0, 0])
    if change == 'negative_weights': binary = edit_values(doc, binary, 2, 'f', [1.1, -.1, 0, 0])
    if change == 'nonfinite_weights': binary = edit_values(doc, binary, 2, 'f', [float('nan'), 0, 0, 0])
    if change == 'sum_weights': binary = edit_values(doc, binary, 2, 'f', [.5, 0, 0, 0])
    if change == 'body_weights': binary = edit_values(doc, binary, 1, 'B', [0, 1, 0, 0])
    if change == 'joint_range': binary = edit_values(doc, binary, 1, 'B', [2, 0, 0, 0])
    if change == 'nonfinite_position': binary = edit_values(doc, binary, 0, 'f', [float('nan'), 1, 0])
    if change == 'index_range': binary = edit_values(doc, binary, 3, 'H', [0, 1, 100])
    if change == 'changing_rest': doc['nodes'][1]['translation'][1] += .1
    if change == 'nonfinite_rest': doc['nodes'][1]['translation'][1] = float('nan')
    if change == 'changing_bind': binary = edit_values(doc, binary, 4, 'f', [2.])
    if change == 'nonfinite_bind': binary = edit_values(doc, binary, 4, 'f', [float('nan')])
    if change == 'changing_parent': doc['nodes'][0].pop('children'); doc['scenes'][0]['nodes'].append(1)
    if change == 'duplicate_names': doc['nodes'][1]['name'] = 'Hips'
    if change == 'clip_changed': binary = edit_values(doc, binary, 6, 'f', [0, 0, .1, .99])
    if change == 'sparse': doc['accessors'][2]['sparse'] = {'count': 1}
    if change == 'normalized_joints': doc['accessors'][1]['normalized'] = True
    if change in ('singular_mesh_matrix', 'projective_mesh_matrix'):
        matrix = [1 if i%5 == 0 else 0 for i in range(16)]
        matrix[0 if change == 'singular_mesh_matrix' else 3] = 0 if change == 'singular_mesh_matrix' else .1
        doc['nodes'][2]['matrix'] = matrix
    for inspect in (True, False):
        with pytest.raises(ValueError): validate_native_hair(build_glb(doc, binary), body_content=native_fixture(role='body'), inspect=inspect)


def test_native_hair_rejects_two_k_texture_and_forty_k_triangle_overages():
    with pytest.raises(ValueError, match='budget'): validate_native_hair(native_fixture(texture_edge=2049))
    source = native_fixture(texture_edge=2048)
    assert validate_native_hair(source)['texture_max_edge'] == 2048
    doc, binary = parse_glb(source, strict=True)
    doc['meshes'][0]['primitives'] *= 40001
    with pytest.raises(ValueError, match='budget'): validate_native_hair(build_glb(doc, binary))


def test_clip_channel_and_aliased_accessor_traversal_budgets_are_bounded(monkeypatch):
    from src.services import native_hair_upload
    doc, binary = parse_glb(native_fixture(), strict=True)
    doc['animations'][0]['channels'] *= 1025
    with pytest.raises(ValueError, match='channel budget'):
        validate_native_hair(build_glb(doc, binary))
    doc, binary = parse_glb(native_fixture(), strict=True)
    reader = _Reader(doc, binary)
    monkeypatch.setattr(native_hair_upload, 'MAX_VALUES', 12)
    first = reader(0)
    assert first is reader.cache[0] and reader.values == 9
    with pytest.raises(ValueError, match='traversal budget'): reader(0)
    # An alias cannot turn one small decoded buffer into unlimited repeated work.
    assert len(reader.cache) == 1


def test_joint_table_order_can_differ_without_changing_skin_binding():
    doc, binary = parse_glb(native_fixture(), strict=True)
    doc['skins'][0]['joints'] = [1, 0]
    item = doc['accessors'][4]; start = doc['bufferViews'][item['bufferView']]['byteOffset']
    binary = bytearray(binary)
    old = bytes(binary[start:start+128]); binary[start:start+128] = old[64:]+old[:64]
    binary = edit_values(doc, binary, 1, 'B', [0, 1, 1, 1]*3)
    assert validate_native_hair(build_glb(doc, binary), body_content=native_fixture(role='body'))['budget_met']


def test_centimetre_body_mesh_node_is_not_a_false_bind_mismatch():
    doc, binary = parse_glb(native_fixture(role='body'), strict=True)
    doc['nodes'][2]['scale'] = [.01, .01, .01]
    assert validate_native_hair(native_fixture(), body_content=build_glb(doc, binary))['preserved']


def test_only_owned_rigged_upload_receipts_enable_native_reuse(tmp_path, storage_configured):
    factory = AvatarFactory(tmp_path)
    uploads = AvatarGlbBodies(factory)
    content = native_fixture(); info = uploads.upload(1, content)
    model = tmp_path/'generated.glb'; model.write_bytes(content)
    body = tmp_path/'body.glb'; body.write_bytes(native_fixture(role='body'))
    part = {'provenance': {'origin': 'uploaded_glb', 'asset_id': info['id']}}
    result = uploaded_native_hair(factory, 1, part, model, body)
    assert result['uploaded_native_hair'] is True and result['native_hair_budget']['budget_met']
    assert uploaded_native_hair(factory, 1, {'provenance': {'origin': 'meshy'}}, model, body) == {}
    assert uploaded_native_hair(factory, 2, part, model, body)['native_upload_error']
    for missing in (None, 'invalid', '0'*64):
        assert uploaded_native_hair(factory, 1, {'provenance': {'origin': 'uploaded_glb', 'asset_id': missing}}, model, body)['native_upload_error']
    doc, binary = parse_glb(content, strict=True); doc['nodes'][2]['extras']['part_role'] = 'body'
    bad = uploads.upload(1, build_glb(doc, binary)); model.write_bytes(build_glb(doc, binary))
    part['provenance']['asset_id'] = bad['id']
    result = uploaded_native_hair(factory, 1, part, model, body)
    assert result == {'uploaded_native_hair': True, 'native_upload_error': 'Uploaded native hair validation failed'}


def test_changed_uploaded_source_is_not_fitted_as_a_generated_unrigged_part(tmp_path, storage_configured):
    factory = AvatarFactory(tmp_path); uploads = AvatarGlbBodies(factory)
    content = native_fixture(); info = uploads.upload(1, content)
    model = tmp_path/'generated.glb'; model.write_bytes(content)
    body = tmp_path/'body.glb'; body.write_bytes(native_fixture(role='body'))
    part = {'provenance': {'origin': 'uploaded_glb', 'asset_id': info['id']}}
    original = uploads._asset_root(1, info['id'])/'source.glb'; original.write_bytes(content+b'changed')
    assert uploaded_native_hair(factory, 1, part, model, body)['native_upload_error']


def blender_prefit_functions():
    """Run the real boundary helpers with Blender objects replaced by small stand-ins."""
    source = Path(__file__).parents[2]/'src/services/avatar_native_parts_blender.py'
    tree = ast.parse(source.read_text(encoding='utf-8'))
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
        and node.name in ('rig_signature', 'compatible_rig', 'load_prefit_part')]
    namespace = {'math': math, 'Path': Path, 'deepcopy': deepcopy,
                 'sha': lambda file: hashlib.sha256(Path(file).read_bytes()).hexdigest()}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), namespace)
    return namespace


def fake_rig():
    hips = SimpleNamespace(name='Hips', parent=None, matrix_local=np.eye(4))
    head = SimpleNamespace(name='Head', parent=hips, matrix_local=np.eye(4))
    head.matrix_local[1, 3] = 1
    return SimpleNamespace(type='ARMATURE', matrix_world=np.eye(4), data=SimpleNamespace(bones=[hips, head]))


def test_blender_compatible_rig_refuses_nonfinite_changed_or_reparented_rest():
    helper = blender_prefit_functions()
    source, target = fake_rig(), fake_rig()
    assert helper['compatible_rig'](source, target)
    source.data.bones[1].matrix_local[0, 0] = float('nan')
    assert not helper['compatible_rig'](source, target)
    source = fake_rig(); source.data.bones[1].matrix_local[0, 3] = .1
    assert not helper['compatible_rig'](source, target)
    source = fake_rig(); source.data.bones[1].parent = None
    assert not helper['compatible_rig'](source, target)


@pytest.mark.parametrize('weight', [1., 0., -1., float('nan'), .5])
def test_blender_prefit_rechecks_bind_and_preserves_mesh_coordinates(tmp_path, weight):
    helper = blender_prefit_functions()
    source_rig, target_rig = fake_rig(), fake_rig()
    modifier = SimpleNamespace(type='ARMATURE', object=source_rig)
    mesh = SimpleNamespace(type='MESH', name='hair', matrix_world=np.eye(4), parent=source_rig,
        modifiers=[modifier], vertex_groups=[SimpleNamespace(index=0, name='Head')],
        data=SimpleNamespace(vertices=[SimpleNamespace(groups=[SimpleNamespace(group=0, weight=weight)])]))
    class TaggedMesh(SimpleNamespace):
        def __setitem__(self, key, value): setattr(self, key, value)
    mesh = TaggedMesh(**mesh.__dict__)
    removed = []
    helper.update(load=lambda _: [source_rig, mesh], body_meshes=lambda *_: [mesh],
        bpy=SimpleNamespace(data=SimpleNamespace(objects=SimpleNamespace(remove=lambda obj, **_: removed.append(obj)))))
    path, body = tmp_path/'hair.glb', tmp_path/'body.glb'
    path.write_bytes(native_fixture()); body.write_bytes(native_fixture(role='body'))
    part = {'slot': 'hair', 'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'uploaded_native_hair': True,
            'report': {'runtime_budget': validate_native_hair(path.read_bytes())}}
    before = mesh.matrix_world.copy()
    if weight != 1.:
        with pytest.raises(ValueError, match='binding changed'):
            helper['load_prefit_part'](part, target_rig, body_source=body)
        assert modifier.object is source_rig
    else:
        meshes, report = helper['load_prefit_part'](part, target_rig, body_source=body)
        assert meshes == [mesh] and modifier.object is target_rig and mesh.parent is target_rig
        assert np.array_equal(mesh.matrix_world, before)
        assert removed == [source_rig] and report['runtime_budget']['optimization'] == 'native_upload_preserved'


def test_legacy_sealed_prefit_hair_does_not_gain_new_upload_restrictions(tmp_path, monkeypatch):
    from src.services import native_hair_upload
    helper = blender_prefit_functions()
    source_rig, target_rig = fake_rig(), fake_rig()
    class Mesh(SimpleNamespace):
        def __setitem__(self, key, value): setattr(self, key, value)
    modifier = SimpleNamespace(type='ARMATURE', object=source_rig)
    mesh = Mesh(type='MESH', name='legacy-hair', matrix_world=np.eye(4), parent=source_rig, modifiers=[modifier])
    helper.update(load=lambda _: [source_rig, mesh], body_meshes=lambda *_: [mesh],
        bpy=SimpleNamespace(data=SimpleNamespace(objects=SimpleNamespace(remove=lambda *a, **kw: None))))
    def forbidden(*a, **kw): pytest.fail('Strict eligibility is exclusive to uploaded native hair.')
    monkeypatch.setattr(native_hair_upload, 'validate_native_hair', forbidden)
    path = tmp_path/'legacy.glb'; path.write_bytes(b'legacy sealed source represented by the fake importer')
    part = {'slot': 'hair', 'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'report': {'runtime_budget': {'runtime_triangles': 41000, 'target_triangles': 50000}}}
    meshes, report = helper['load_prefit_part'](part, target_rig, body_source=tmp_path/'unused-body.glb')
    assert meshes == [mesh] and report['runtime_budget']['runtime_triangles'] == 41000
