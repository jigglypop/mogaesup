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


def test_objects_that_share_one_mesh_are_each_moved_once(blender):
    """The glTF importer gives the nodes of one unskinned mesh (two eyes, a pair of shoes) one Mesh datablock."""
    bpy, common, _ = blender
    scene = bpy.context.scene
    rig = armature(scene, 'rig', [bone('Hips'), bone('Head', (0, 0, 1))])
    body = body_quad(scene, rig)
    left = mesh(scene, 'left', [(.4, -.01, .4)])
    right = fake_blender.Object(scene, 'right', 'MESH', left.data, matrix_world=common.Matrix.Translation((.2, 0, 0)))
    left.data.users = 2
    common.bind([left, right], [body], rig, {'slot': 'shoes', 'binding': 'transfer', 'max_transfer_distance_m': None},
                transform=common.Matrix.Translation((0, 0, .1)))
    assert left.data is not right.data
    assert list(left.data.vertices[0].co) == pytest.approx([.4, -.01, .5])
    assert list(right.data.vertices[0].co) == pytest.approx([.6, -.01, .5])
    assert weights_of(left) == weights_of(right) and sum(weights_of(left)[0].values()) == pytest.approx(1.)


def test_the_wardrobe_worker_fits_each_object_of_a_shared_garment_mesh_once(monkeypatch):
    bpy, modules = fake_blender.install(monkeypatch, 'wardrobe_blender')
    scene = bpy.context.scene
    rig = armature(scene, 'rig', [bone('Hips')])
    rig.data.bones[0].use_deform = True
    # The baseline garment spans 4 x 2 x 4 m; the generated one, both of its objects together, 2 x 1 x 2 m.
    source = mesh(scene, 'baseline', [(0, 0, 0), (4, 2, 4)], rig=rig, weights=[{'Hips': 1.}]*2)
    source.find_armature = lambda: rig
    garments = []

    def import_garment(filepath):
        left = mesh(scene, 'left', [(0, 0, 0), (1, 1, 2)])
        right = fake_blender.Object(scene, 'right', 'MESH', left.data, matrix_world=fake_blender.Matrix.Translation((1, 0, 0)))
        left.data.users = 2
        for obj in (left, right):
            obj.hide_set = lambda value: None
            garments.append(obj)

    def transfer_weights(modifier):
        active = bpy.context.view_layer.objects.active
        hips = next(group for group in active.vertex_groups if group.name == 'Hips')
        hips.add([vertex.index for vertex in active.data.vertices], 1., 'REPLACE')

    bpy.ops.import_scene.gltf = import_garment
    bpy.ops.export_scene.gltf = lambda **kwargs: None
    bpy.ops.object.modifier_apply = transfer_weights
    modules['wardrobe_blender'].run({'stage': 'fit', 'source_object': 'baseline', 'garment': 'garment.glb', 'fit': 'bounds',
                                     'output_blend': 'fitted.blend', 'output_glb': 'fitted.glb'})
    left, right = garments
    assert left.data is not right.data
    assert [list(vertex.co) for vertex in left.data.vertices] == [pytest.approx([0, 0, 0]), pytest.approx([2, 2, 4])]
    assert [list(vertex.co) for vertex in right.data.vertices] == [pytest.approx([2, 0, 0]), pytest.approx([4, 2, 4])]


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
