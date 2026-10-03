"""bind() and the rig-transfer worker against stand-in Blender modules (tests/fake_blender.py).

A transferred binding (a garment, or the body the rig-transfer worker moves onto a saved skeleton) names no bone;
only a rigid binding does, and a prefixed skeleton ('mixamorig:Head') still answers to the plain name.
"""
import hashlib
import json

import pytest

import fake_blender
from fake_blender import armature, bone, mesh
from src.services.glb import build_glb


@pytest.fixture
def blender(monkeypatch):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_blender_common', 'avatar_rig_transfer_blender')
    return bpy, modules['avatar_blender_common'], modules['avatar_rig_transfer_blender']


def body_quad(scene, rig, name='body', bones=('Hips', 'Head')):
    """A 1 m square in the XZ plane weighted from the first bone at the bottom to the second at the top."""
    low, high = bones
    points = [(0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)]
    weights = [{low: 1.}, {low: 1.}, {high: 1.}, {high: 1.}]
    return mesh(scene, name, points, [(0, 1, 2), (0, 2, 3)], rig=rig, weights=weights)


def weights_of(obj):
    names = {group.index: group.name for group in obj.vertex_groups}
    return [{names[entry.group]: round(entry.weight, 6) for entry in vertex.groups} for vertex in obj.data.vertices]


def test_a_transferred_binding_needs_no_bone(blender):
    bpy, common, _ = blender
    scene = bpy.context.scene
    rig = armature(scene, 'rig', [bone('Hips'), bone('Head', (0, 0, 1))])
    body = body_quad(scene, rig)
    # Points 1 cm in front of the body: the bottom edge, the middle and the top edge.
    garment = mesh(scene, 'garment', [(.5, -.01, 0.), (.5, -.01, .5), (.5, -.01, 1.)])
    report = common.bind([garment], [body], rig, {'slot': 'body', 'binding': 'transfer', 'max_transfer_distance_m': None},
                         transform=common.Matrix.Identity(4))
    assert report['binding'] == 'transfer' and report['weights'] == 'body_surface_barycentric'
    rows = weights_of(garment)
    assert rows[0] == {'Hips': 1.} and rows[2] == {'Head': 1.}
    assert rows[1].keys() == {'Hips', 'Head'} and sum(rows[1].values()) == pytest.approx(1.)
    assert [(modifier.type, modifier.object) for modifier in garment.modifiers] == [('ARMATURE', rig)]
    assert garment['standard_slot'] == 'body'


def test_a_rigid_binding_finds_its_bone_on_a_prefixed_skeleton(blender):
    bpy, common, _ = blender
    scene = bpy.context.scene
    rig = armature(scene, 'rig', [bone('mixamorig:Hips'), bone('mixamorig:Head', (0, 0, 1))])
    body = body_quad(scene, rig, bones=('mixamorig:Hips', 'mixamorig:Head'))
    hair = mesh(scene, 'hair', [(.5, -.02, .9), (.6, -.02, 1.)])
    report = common.bind([hair], [body], rig, {'slot': 'hair', 'binding': 'rigid', 'bone': 'Head', 'anchors': [],
                                                'max_anchor_error_m': .0001, 'max_transfer_distance_m': None},
                         transform=common.Matrix.Identity(4))
    assert report['weights'] == 'single_canonical_bone'
    assert weights_of(hair) == [{'mixamorig:Head': 1.}]*2


@pytest.mark.parametrize('contract', [{'binding': 'rigid'}, {'binding': 'rigid', 'bone': 'Tail'}])
def test_a_rigid_binding_without_a_bone_of_the_skeleton_is_refused(blender, contract):
    bpy, common, _ = blender
    scene = bpy.context.scene
    rig = armature(scene, 'rig', [bone('Hips'), bone('Head', (0, 0, 1))])
    body = body_quad(scene, rig)
    hat = mesh(scene, 'hat', [(.5, -.02, 1.)])
    with pytest.raises(ValueError, match='bone'):
        common.bind([hat], [body], rig, {'slot': 'hat', **contract}, transform=common.Matrix.Identity(4))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_the_rig_transfer_worker_binds_the_body_with_the_contract_it_writes(blender, tmp_path, monkeypatch):
    """The worker's own bind() call, which names no bone, on a saved donor rig and an unrigged generated body."""
    bpy, common, worker = blender
    scene = bpy.context.scene
    (tmp_path/'body.glb').write_bytes(b'generated body'); (tmp_path/'donor.glb').write_bytes(b'donor body and rig')
    output = tmp_path/'out'; output.mkdir()
    payload = {'body': str(tmp_path/'body.glb'), 'body_sha256': sha(tmp_path/'body.glb'),
               'donor': str(tmp_path/'donor.glb'), 'donor_sha256': sha(tmp_path/'donor.glb'), 'output': str(output)}
    (output/'input.json').write_text(json.dumps(payload), encoding='utf8')

    def load(path):
        if path == payload['donor']:
            rig = armature(scene, 'rig', [bone('Hips'), bone('Head', (0, 0, 1))])
            return [rig, body_quad(scene, rig, 'donor_body')]
        # Half the donor's height, beside it: the worker scales and moves it onto the donor first.
        return [mesh(scene, 'generated', [(3., 0, 0), (3.5, 0, 0), (3.5, 0, .5), (3., 0, .5)], [(0, 1, 2), (0, 2, 3)])]

    def export(path, objects):
        rig = next(obj for obj in objects if obj.type == 'ARMATURE')
        meshes = [obj for obj in objects if obj.type == 'MESH']
        assert all(any(m.type == 'ARMATURE' and m.object is rig for m in obj.modifiers) for obj in meshes)
        doc = {'asset': {'version': '2.0'}, 'nodes': [{'name': obj.name, 'mesh': 0, 'skin': 0} for obj in meshes],
               'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}], 'skins': [{'joints': [0]}],
               'accessors': [{'count': 3}], 'animations': [{'name': 'idle', 'channels': [], 'samplers': []}]}
        path.write_bytes(build_glb(doc, b''))
    monkeypatch.setattr(worker, 'load', load)
    monkeypatch.setattr(worker, 'export', export)
    monkeypatch.setattr(worker.bpy.ops.wm, 'save_as_mainfile', lambda filepath: open(filepath, 'wb').close())
    worker.run(payload)
    seal = json.loads((output/'complete.json').read_text(encoding='utf8'))
    assert seal['input_sha256'] == sha(output/'input.json')
    assert seal['result']['binding']['binding'] == 'transfer' and seal['result']['uniform_scale'] == pytest.approx(2.)
    assert seal['result']['clips'] == [{'slot': 'idle', 'source': 'transferred_meshy_rig', 'action_id': None}]
    body = next(obj for obj in scene.objects if obj.type == 'MESH' and obj.get('part_role') == 'body')
    # Scaled onto the donor: its top now takes the donor's top weights.
    assert weights_of(body)[2] == {'Head': 1.} and weights_of(body)[0] == {'Hips': 1.}
