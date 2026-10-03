"""The native-parts Blender worker's run() against stand-in Blender modules (tests/fake_blender.py).

The geometry steps that need a real Blender (fitting shapes, renders, the glTF exporter) are replaced in the worker's
namespace; the slot bookkeeping, the real bind() and the seal the server accepts (avatar_native_parts.accepted_seal)
run as they are. A slot that fails, during its fit or in a later step of the assembly, is withdrawn alone: it is
reported unavailable and incomplete, its file is not sealed, and the other slots are.
"""
import hashlib
import json
import types

import pytest

import fake_blender
from fake_blender import Vector, armature, bone, mesh
from src.services.avatar_native_parts import accepted_seal
from src.services.glb import build_glb

SPEC = {'sha256': 'f'*64, 'body_height_m': 1.6, 'frozen_body': True,
        'anchors': {'neck': [0, 1.3, 0], 'shoulder_left': [.2, 1.25, 0], 'crown': [0, 1.6, 0]},
        'fitting': {'revision': 'fixture-fit', 'part_fit': 'uniform-slot-v1',
                    'bounds': {'hair': [[-.2, 1.3, -.2], [.2, 1.7, .2]], 'top': [[-.3, .8, -.2], [.3, 1.35, .2]],
                               'shoes': [[-.2, 0, -.2], [.2, .1, .2]]},
                    'shoe_bounds': {}},
        'tolerances': {'clearance_m': .003, 'max_surface_adjustment_m': .015}}
# Where each part's stand-in mesh sits: just in front of the body column (y = 0, z from 0 to 1.6).
PLACES = {'hair': [(0., -.02, 1.45), (.1, -.02, 1.55), (-.1, -.02, 1.5)],
          'top': [(0., -.02, 1.), (.1, -.02, 1.2), (-.1, -.02, 1.1)],
          'shoes': [(0., -.02, .02), (.1, -.02, .05), (-.1, -.02, .04)]}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Assembly:
    """One run of the worker on a frozen body with hair, a top and shoes, and what it handed the stand-ins."""

    def __init__(self, tmp_path, monkeypatch):
        monkeypatch.delenv('ASSET_DETAIL_RENDERS', raising=False)
        monkeypatch.delenv('ASSET_SAVE_MASTER_BLEND', raising=False)
        self.bpy, modules = fake_blender.install(monkeypatch, 'avatar_native_parts_blender')
        self.worker = worker = modules['avatar_native_parts_blender']
        self.scene, self.monkeypatch = self.bpy.context.scene, monkeypatch
        self.output = tmp_path/'version'; self.output.mkdir()
        (tmp_path/'body.glb').write_bytes(b'frozen body')
        parts = []
        for slot in ('hair', 'top', 'shoes'):
            path = tmp_path/f'generated-{slot}.glb'
            path.write_bytes(f'raw {slot}'.encode())
            parts.append({'slot': slot, 'path': str(path), 'sha256': sha(path), 'part_method': 'isolated',
                          'garment_kind': 'source', 'fit_profile': None, 'preserve_generated_detail': True})
        self.payload = {'source': str(tmp_path/'body.glb'), 'source_sha256': sha(tmp_path/'body.glb'), 'parts': parts,
                        'prefit_parts': [], 'unavailable_parts': [], 'output': str(self.output),
                        'contract': {}, 'production_spec': SPEC}
        (self.output/'input.json').write_text(json.dumps(self.payload), encoding='utf8')
        self.coverage_calls, self.exports = [], []
        paths = {part['path']: part['slot'] for part in parts}

        def load(path):
            if path == self.payload['source']:
                self.metric = fake_blender.Object(self.scene, 'FactoryMetricFrame', 'EMPTY')
                self.rig = armature(self.scene, 'Armature', [bone('Hips', (0, 0, .5)), bone('Spine', (0, 0, 1.)),
                                                             bone('Head', (0, 0, 1.4))])
                points = [(-.2, 0, z) for z in (0., .8, 1.6)] + [(.2, 0, z) for z in (0., .8, 1.6)]
                weights = [{'Hips': 1.}, {'Spine': 1.}, {'Head': 1.}]*2
                body = mesh(self.scene, 'Body', points, [(0, 3, 4), (0, 4, 1), (1, 4, 5), (1, 5, 2)],
                            rig=self.rig, weights=weights)
                return [self.metric, self.rig, body]
            slot = paths[path]
            return [mesh(self.scene, f'{slot}-import', PLACES[slot])]

        def export(path, objects):
            rig = next(obj for obj in objects if obj.type == 'ARMATURE')
            meshes = [obj for obj in objects if obj.type == 'MESH']
            nodes = [{'name': obj.name, 'mesh': 0, **({'skin': 0} if any(
                modifier.type == 'ARMATURE' and modifier.object is rig for modifier in obj.modifiers) else {})}
                for obj in meshes]
            doc = {'asset': {'version': '2.0'}, 'nodes': nodes, 'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}],
                   'accessors': [{'count': 3}], 'skins': [{'joints': [0]}]}
            path.write_bytes(build_glb(doc, b''))
            self.exports.append((path.name, sorted(obj.name for obj in meshes)))

        def render(path, camera, center, direction, size):
            path.write_bytes(f'render {path.name}'.encode())

        def bind_shoes_rigid(meshes, rig, regions):
            for obj in meshes:
                obj.modifiers.new('Feet', 'ARMATURE').object = rig
                obj.vertex_groups.new(name='Hips').add([v.index for v in obj.data.vertices], 1., 'REPLACE')
            return {'binding': 'rigid_feet'}

        def mark_body_coverage(body, garments, rig, spec, profiles, shell_slots=()):
            self.coverage_calls.append(sorted(slot for slot, meshes in garments.items() if meshes))
            return [], {}, []
        identity = lambda *args, **kwargs: (worker.Matrix.Identity(4), [], {})
        nothing = lambda *args, **kwargs: None
        for name, value in {
                'load': load, 'export': export, 'render': render, 'bind_shoes_rigid': bind_shoes_rigid,
                'mark_body_coverage': mark_body_coverage,
                'measure_body_profile': lambda *args: {'revision': 'fixture'},
                'head_region': lambda *args: (Vector((-.1, -.1, 1.3)), Vector((.1, .1, 1.6)), 1.3),
                'hair_target': lambda body, rig, spec, slot: SPEC['fitting']['bounds']['hair'],
                'headwear_palette': nothing, 'fit_hair': identity, 'fit_reference_frame': identity,
                'place': nothing, 'fit_hair_cavity': lambda *args: {}, 'fit_hair_scalp_bounded': lambda *args: {},
                'clearance': lambda *args: {}, 'add_scalp_cap': nothing,
                'fit_shoes_rigid': lambda meshes, targets: ({}, 'regions'),
                'prepare_expression_uv': lambda body: {'available': False}, 'matte_materials': lambda objects: {},
                'finish_shoes_after_pose': lambda shoes, rig: {'method': 'fixture'},
                'crop_regions': lambda garments, rig, spec, profiles=None: ({}, []),
                'hide_covered_materials': lambda materials: [], 'restore_covered_materials': nothing,
                'pressed_under': lambda fitted, body, rig: (nothing, nothing),
                'camera_setup': lambda height: (types.SimpleNamespace(data=types.SimpleNamespace(ortho_scale=2048*height/1500)),
                                                Vector((0, 0, height*(.5+26/1500)))),
                'soft_lighting': nothing, 'strip_covered_primitives': nothing}.items():
            monkeypatch.setattr(worker, name, value)

    def run(self):
        self.worker.run(self.payload)
        seal = json.loads((self.output/'complete.json').read_text(encoding='utf8'))
        # Exactly what the server checks before it seals the version.
        files, result = accepted_seal(self.output, seal)
        self.files, self.result = files, result
        self.reports = {part['slot']: part for part in result['parts']}
        return self


@pytest.fixture
def assembly(tmp_path, monkeypatch):
    return Assembly(tmp_path, monkeypatch)


def offered(assembly):
    return sorted(slot for slot, report in assembly.reports.items() if report.get('available', True))


def incomplete(assembly):
    return {part['slot']: part for part in assembly.result['incomplete_parts']}


def test_every_slot_is_bound_with_the_contract_bind_reads_and_sealed(assembly):
    assembly.run()
    assert offered(assembly) == ['body', 'hair', 'shoes', 'top'] and assembly.result['fit_status'] == 'complete'
    assert {'hair.glb', 'top.glb', 'shoes.glb', 'body.glb', 'model.glb', 'front.png'} <= assembly.files.keys()
    # The real bind(): hair rigidly on the head bone, the top on the body's weights.
    assert assembly.reports['hair']['weights'] == 'single_canonical_bone'
    assert assembly.reports['top']['weights'] == 'body_surface_barycentric'
    assert assembly.result['render_frame'] == {'ortho_scale_m': pytest.approx(2048*1.6/1500),
                                               'center_gltf_m': [0., pytest.approx(1.6*(.5+26/1500)), 0.]}
    assert assembly.coverage_calls == [['hair', 'shoes', 'top']]


def test_a_slot_whose_fit_raises_is_withdrawn_with_its_path_cut_to_a_file_name(assembly, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError(r'C:\Users\someone\AppData\Local\Temp\tmpq1\top.blend cannot be read; see /srv/data/x/log.txt')
    monkeypatch.setattr(assembly.worker, 'fit_reference_frame', broken)
    assembly.run()
    assert offered(assembly) == ['body', 'hair', 'shoes'] and 'top.glb' not in assembly.files
    [error] = assembly.reports['top']['errors']
    assert error == {'code': 'fit_exception', 'message': 'RuntimeError: top.blend cannot be read; see log.txt'}
    assert incomplete(assembly)['top']['available'] is False


def test_shoes_that_fail_their_final_pose_are_withdrawn_and_the_rest_sealed(assembly, monkeypatch):
    def broken(shoes, rig):
        raise ValueError('Shoe soles left the floor')
    monkeypatch.setattr(assembly.worker, 'finish_shoes_after_pose', broken)
    assembly.run()
    assert offered(assembly) == ['body', 'hair', 'top'] and 'shoes.glb' not in assembly.files
    shoes = assembly.reports['shoes']
    assert (shoes['available'], shoes['unavailable_reason'], shoes['fit_status']) == (False, 'post_fit_exception', 'failed')
    assert shoes['errors'] == [{'code': 'post_fit_exception', 'message': 'ValueError: Shoe soles left the floor'}]
    assert incomplete(assembly)['shoes']['status'] == 'failed'
    # The body is cut for the top (and hair) alone, and no export carries the shoes.
    assert assembly.coverage_calls == [['hair', 'top']]
    assert all(not any(name.startswith('shoes') for name in names) for _, names in assembly.exports)


def test_a_garment_whose_body_crop_cannot_be_measured_is_withdrawn(assembly, monkeypatch):
    def crop_regions(garments, rig, spec, profiles=None):
        if 'top' in garments:
            raise KeyError('hem_m')
        return {}, []
    monkeypatch.setattr(assembly.worker, 'crop_regions', crop_regions)
    assembly.run()
    assert offered(assembly) == ['body', 'hair', 'shoes']
    assert assembly.reports['top']['unavailable_reason'] == 'body_crop_failed'
    assert assembly.coverage_calls == [['hair', 'shoes']]


def test_a_crop_that_is_not_finite_withdraws_its_garment(assembly, monkeypatch):
    nan = float('nan')
    monkeypatch.setattr(assembly.worker, 'crop_regions', lambda garments, rig, spec, profiles=None: (
        {}, [('top_hem', Vector((0, 0, nan)), Vector((0, 0, 1)))] if 'top' in garments else []))
    assembly.run()
    assert assembly.reports['top']['unavailable_reason'] == 'body_crop_failed' and 'shoes' in offered(assembly)


def test_a_slot_exported_without_its_skin_is_withdrawn_and_the_model_exported_again(assembly, monkeypatch):
    def unbound_shoes(meshes, rig, regions):
        return {'binding': 'rigid_feet'}   # no armature modifier: the exporter writes no skin
    monkeypatch.setattr(assembly.worker, 'bind_shoes_rigid', unbound_shoes)
    assembly.run()
    assert offered(assembly) == ['body', 'hair', 'top']
    assert assembly.reports['shoes']['unavailable_reason'] == 'export_check_failed'
    assert 'shoes.glb' not in assembly.files and not (assembly.output/'shoes.glb').exists()
    # The body is cut again without the shoes; the composed model and the body are exported again without them.
    assert assembly.coverage_calls == [['hair', 'shoes', 'top'], ['hair', 'top']]
    model = [names for name, names in assembly.exports if name == 'model.glb']
    assert len(model) == 2 and not any(name.startswith('shoes') for name in model[-1])
    assert [name for name, _ in assembly.exports][-2:] == ['body.glb', 'model.glb']


def test_a_body_exported_without_its_skin_ends_the_assembly(assembly, monkeypatch):
    real = assembly.worker.export

    def export(path, objects):
        real(path, objects)
        if path.name == 'model.glb':
            doc = {'asset': {'version': '2.0'}, 'nodes': [], 'meshes': [], 'accessors': []}
            path.write_bytes(build_glb(doc, b''))
    monkeypatch.setattr(assembly.worker, 'export', export)
    with pytest.raises(ValueError, match='Missing skinned part'):
        assembly.worker.run(assembly.payload)
    assert not (assembly.output/'complete.json').exists()
