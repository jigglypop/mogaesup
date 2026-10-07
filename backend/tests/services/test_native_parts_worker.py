"""The native-parts Blender worker's run() against stand-in Blender modules (tests/fake_blender.py).

The geometry steps that need a real Blender (fitting shapes, renders, the glTF exporter) are replaced in the worker's
namespace; the slot bookkeeping, the real bind() and the seal the server accepts (avatar_native_parts.accepted_seal)
run as they are. A slot that fails, during its fit or in a later step of the assembly, is withdrawn alone: it is
reported unavailable and incomplete, its file is not sealed, and the other slots are.
"""
import hashlib
import json
import math
import types

import pytest

import fake_blender
from fake_blender import Vector, armature, bone, mesh
from native_assembly_fixture import JOB, VERSION, seed_native_assembly
from src.services import avatar_native_parts as native, run_lock
from src.services.asset_editor import _write_json
from src.services.avatar_native_parts import accepted_seal
from src.services.character_pipeline import read_json
from src.services.glb import build_glb
from src.services.process_identity import identity

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
        # steps: ('export' | 'render', file name, the rig's pose position then), in order.
        self.coverage_calls, self.exports, self.steps = [], [], []
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
            self.steps.append(('export', path.name, self.rig.data.pose_position))

        def render(path, camera, center, direction, size):
            # A render names the meshes it shows, so the hash the seal records says what was drawn.
            shown = sorted(obj.name for obj in self.scene.objects if obj.type == 'MESH' and not obj.hide_render)
            path.write_bytes(f'render {path.name}: {" ".join(shown)}'.encode())
            self.steps.append(('render', path.name, self.rig.data.pose_position))

        def bind_shoes_rigid(meshes, rig, regions):
            for obj in meshes:
                obj.modifiers.new('Feet', 'ARMATURE').object = rig
                obj.vertex_groups.new(name='Hips').add([v.index for v in obj.data.vertices], 1., 'REPLACE')
            return {'binding': 'rigid_feet'}

        def mark_body_coverage(body, garments, rig, spec, profiles, shell_slots=()):
            self.coverage_calls.append(sorted(slot for slot, meshes in garments.items() if meshes))
            return [], {}, []

        def fit_shoes_rigid(meshes, targets, feet=None):
            # As the real one: every vertex of the pair on a side, and the measured feet it was sized to.
            self.shoe_feet = feet
            return {'method': 'fixture'}, {obj: {vertex.index: 'left' if vertex.co.x >= 0 else 'right'
                                                 for vertex in obj.data.vertices} for obj in meshes}

        # What the seal's quality gate was asked to measure (slot, part file, body file); each is passed unless a test
        # makes it refuse.
        self.gated, self.gate_refuses = [], {}

        def gate_part(slot, part_content, body_content=None, *, body=None):
            self.gated.append(slot)
            receipt = {'revision': 'fixture-gate', 'measured': {'slot': slot}, 'refusal': None}
            if slot in self.gate_refuses:
                receipt['refusal'] = {'code': self.gate_refuses[slot], 'message': f'{slot} refused'}
            return receipt
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
                'fit_shoes_rigid': fit_shoes_rigid,
                # The stand-in body has no feet: each shoe covers its foot as a sound pair does.
                'foot_skin': lambda body: {'left': 'left foot skin', 'right': 'right foot skin'},
                'foot_bounds': lambda skin: {side: f'{side} foot box' for side in skin},
                'shoe_coverage': lambda meshes, regions, skin: {'left': .97, 'right': .95},
                'GateBody': lambda content: 'gate body', 'gate_part': gate_part,
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

    def drawn(self, name):
        """The meshes the render `name` shows."""
        return (self.output/name).read_text(encoding='utf8').split(': ', 1)[1].split()


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


@pytest.mark.parametrize('failure', ['changed', 'unrigged'])
def test_a_sealed_slot_that_cannot_be_attached_again_is_withdrawn_alone(assembly, tmp_path, monkeypatch, failure):
    # A refit carries the top over from the sealed version it froze; that file cannot be attached this time.
    top = next(part for part in assembly.payload['parts'] if part['slot'] == 'top')
    assembly.payload['parts'].remove(top)
    sealed = tmp_path/'prefit-top.glb'
    sealed.write_bytes(b'sealed top')
    assembly.payload['prefit_parts'] = [{'slot': 'top', 'path': str(sealed),
                                         'sha256': 'e'*64 if failure == 'changed' else sha(sealed),
                                         'report': {'runtime_budget': {'preserved': True}}, 'garment_kind': 'source'}]
    (assembly.output/'input.json').write_text(json.dumps(assembly.payload), encoding='utf8')
    real = assembly.worker.load
    stray = []

    def load(path):
        if path == str(sealed):
            # A mesh without its armature: not a sealed rigged slot.
            imported = mesh(assembly.scene, 'prefit-top-import', PLACES['top'])
            stray.append(imported.name)
            return [imported]
        return real(path)
    monkeypatch.setattr(assembly.worker, 'load', load)
    assembly.run()
    assert offered(assembly) == ['body', 'hair', 'shoes'] and 'top.glb' not in assembly.files
    top = assembly.reports['top']
    assert (top['available'], top['unavailable_reason'], top['fit_status']) == (False, 'fit_exception', 'failed')
    assert top['errors'][0]['message'] == ('ValueError: Prefit part changed' if failure == 'changed'
                                           else 'ValueError: Expected one sealed rigged prefit part')
    assert incomplete(assembly)['top']['available'] is False
    # Nothing of it stays in the scene: no export or render carries it.
    assert stray == ([] if failure == 'changed' else ['prefit-top-import'])
    assert not set(stray) & set(assembly.scene.objects.keys())
    assert all(not any(name.startswith('prefit-top') or name.startswith('top') for name in names)
               for _, names in assembly.exports)


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


def test_shoes_are_sized_to_the_measured_feet_and_every_fitted_part_carries_the_gates_receipt(assembly):
    assembly.run()
    assert assembly.shoe_feet == {'left': 'left foot box', 'right': 'right foot box'}
    assert assembly.reports['shoes']['measurement']['foot_coverage'] == {'left': .97, 'right': .95}
    assert sorted(assembly.gated) == ['hair', 'shoes', 'top']
    assert all(assembly.reports[slot]['quality_gate'] == {'revision': 'fixture-gate', 'measured': {'slot': slot},
                                                          'refusal': None} for slot in ('hair', 'shoes', 'top'))


@pytest.mark.parametrize('cover', [{'left': .3, 'right': .9}, {'left': .97, 'right': .7}],
                         ids=['a bare foot', 'one shoe incomplete'])
def test_shoes_the_fitting_refuses_are_withdrawn_with_their_own_code(assembly, monkeypatch, cover):
    monkeypatch.setattr(assembly.worker, 'shoe_coverage', lambda meshes, regions, skin: cover)
    assembly.run()
    assert offered(assembly) == ['body', 'hair', 'top'] and 'shoes.glb' not in assembly.files
    shoes = assembly.reports['shoes']
    assert (shoes['available'], shoes['unavailable_reason'], shoes['fit_status']) == (False, 'shoes_incomplete', 'failed')
    assert shoes['errors'][0]['code'] == 'shoes_incomplete'
    assert shoes['errors'][0]['message'].startswith('ShoeRefusal: ')
    assert incomplete(assembly)['shoes']['available'] is False
    assert all(not any(name.startswith('shoes') for name in names) for _, names in assembly.exports)


def test_a_part_the_quality_gate_refuses_is_withdrawn_with_its_code_and_drawn_nowhere(assembly):
    assembly.gate_refuses['top'] = 'holes'
    assembly.run()
    assert offered(assembly) == ['body', 'hair', 'shoes'] and 'top.glb' not in assembly.files
    assert not (assembly.output/'top.glb').exists()
    top = assembly.reports['top']
    assert (top['available'], top['unavailable_reason'], top['fit_status']) == (False, 'holes', 'failed')
    assert top['errors'] == [{'code': 'holes', 'message': 'PartRefusal: top refused'}]
    assert top['quality_gate']['refusal'] == {'code': 'holes', 'message': 'top refused'}
    assert incomplete(assembly)['top']['status'] == 'failed'
    # Measured once, on the first export; the body is cut again and the model exported again without the top.
    assert sorted(assembly.gated) == ['hair', 'shoes', 'top']
    assert assembly.coverage_calls == [['hair', 'shoes', 'top'], ['hair', 'shoes']]
    model = [names for name, names in assembly.exports if name == 'model.glb']
    assert len(model) == 2 and not any(name.startswith('top') for name in model[-1])
    assert [name for name, _ in assembly.exports][-2:] == ['body.glb', 'model.glb']
    assert assembly.drawn('front.png') == ['body_0', 'hair_0', 'shoes_0']


def test_the_gate_measures_only_what_this_assembly_fitted(tmp_path, monkeypatch):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_native_parts_blender')
    worker = modules['avatar_native_parts_blender']
    for name in ('body', 'hair', 'top', 'shoes', 'glasses'):
        (tmp_path/f'{name}.glb').write_bytes(name.encode())
    measured = []

    def gate_part(slot, part_content, body_content=None, *, body=None):
        measured.append((slot, part_content, body))
        return {'revision': 'fixture-gate', 'measured': {}, 'refusal': None if slot != 'hair' else
                {'code': 'hair_covers_eyes', 'message': 'The hair hides the eyes'}}
    monkeypatch.setattr(worker, 'GateBody', lambda content: f'body from {content.decode()}')
    monkeypatch.setattr(worker, 'gate_part', gate_part)
    reports = [{'slot': 'body'}, {'slot': 'hair'}, {'slot': 'top'}, {'slot': 'glasses'},
               {'slot': 'shoes', 'available': False}]
    # The top was carried over sealed from the version a refit froze: a part once offered is not measured again.
    refused = worker.gate_fitted(tmp_path, reports, {'top': str(tmp_path/'prefit-top.glb')})
    assert measured == [('hair', b'hair', 'body from body')]
    assert [(slot, refusal.code, str(refusal)) for slot, refusal in refused] == [
        ('hair', 'hair_covers_eyes', 'The hair hides the eyes')]
    assert 'quality_gate' in reports[1] and not any('quality_gate' in report for report in reports[2:])


def test_a_body_the_gate_cannot_read_leaves_the_parts_as_fitted(tmp_path, monkeypatch):
    bpy, modules = fake_blender.install(monkeypatch, 'avatar_native_parts_blender')
    worker = modules['avatar_native_parts_blender']
    (tmp_path/'body.glb').write_bytes(b'not a glb')
    (tmp_path/'hair.glb').write_bytes(b'hair')
    reports = [{'slot': 'hair'}]
    assert worker.gate_fitted(tmp_path, reports, {}) == []
    assert reports[0]['quality_gate']['skipped'] == 'unreadable' and reports[0]['quality_gate']['refusal'] is None


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


# --- hair surfaces, a raised hood and a skirt ---------------------------------------------------------------------------

def only(assembly, *slots, spec=None):
    """The assembly fits only `slots`, with `spec` (default: the fixture's)."""
    assembly.payload['parts'] = [part for part in assembly.payload['parts'] if part['slot'] in slots]
    if spec is not None:
        assembly.payload['production_spec'] = spec
    (assembly.output/'input.json').write_text(json.dumps(assembly.payload), encoding='utf8')


@pytest.mark.parametrize('uniform', [True, False], ids=['uniform', 'measured'])
def test_a_hairs_surfaces_are_not_joined_before_it_is_fitted(assembly, monkeypatch, uniform):
    # Joined, a surface without UVs left the strands without an active UV layer and the scalp cap a flat grey.
    from copy import deepcopy
    spec = deepcopy(SPEC)
    spec['runtime'] = {'part_triangles': {'hair': 40000}, 'texture_max_edge': 2048, 'revision': 'fixture'}
    spec['fitting']['part_fit'] = 'uniform-slot-v1' if uniform else 'measured'
    only(assembly, 'hair', spec=spec)
    requested = []

    def optimize(meshes, slot, **options):
        requested.append((slot, options['merge']))
        return {'source_triangles': 1, 'runtime_triangles': 1, 'budget_met': True}
    monkeypatch.setattr(assembly.worker, 'optimize_part', optimize)
    monkeypatch.setattr(assembly.worker, 'clearance', lambda *args: {'adjusted_vertices': 0, 'maximum_adjustment_m': 0.})
    assembly.run()
    assert requested == [('hair', False)]
    assert assembly.result['fit_status'] == 'complete' and assembly.reports['hair']['weights'] == 'single_canonical_bone'


def test_uniform_hair_fitting_applies_the_requested_length_before_clearance(assembly, monkeypatch):
    from copy import deepcopy
    spec = deepcopy(SPEC)
    spec['fitting']['hair_length_head_ratio'] = 1.7
    assembly.payload['production_spec'] = spec
    steps = []

    def length(meshes, target, chosen, scalp_floor):
        steps.append(('length', chosen['fitting']['hair_length_head_ratio'], scalp_floor))
        return {'method': 'strands_below_fixed_crown', 'head_height_ratio': 1.7}

    def scalp(*args):
        steps.append(('clearance',))
        return {}
    monkeypatch.setattr(assembly.worker, 'fit_hair_length', length)
    monkeypatch.setattr(assembly.worker, 'fit_hair_scalp_bounded', scalp)
    assembly.run()
    assert steps == [('length', 1.7, 1.3), ('clearance',)]
    assert assembly.reports['hair']['measurement']['length_fitting']['head_height_ratio'] == 1.7


def hoodie_points():
    """A T-pose top whose hood stands around the head: sleeves at z 1, the hood up to z 1.5."""
    sleeves = [(x, y, z) for x in (-.3, -.15, .15, .3) for y in (-.03, .03) for z in (1., 1.05)]
    torso = [(x, y, z) for x in (-.1, .1) for y in (-.05, .05) for z in (.8, .9, 1.)]
    ring = [(.12*r*math.cos(a), .12*r*math.sin(a), z) for z, r in ((1.1, 1.), (1.3, 1.), (1.4, .8), (1.5, .3))
            for a in [i*math.pi/4 for i in range(8)]]
    return sleeves + torso + ring


def test_a_raised_hood_uses_head_and_torso_space_and_its_upper_vertices_follow_the_head(assembly, monkeypatch):
    top = next(part for part in assembly.payload['parts'] if part['slot'] == 'top')
    top['description'] = 'grey hoodie, hood up'
    monkeypatch.setitem(PLACES, 'top', hoodie_points())
    head = [[-.2, 1.3, -.2], [.2, 1.7, .2]]
    monkeypatch.setattr(assembly.worker, 'headwear_target', lambda *args: head)
    lifted = []
    monkeypatch.setattr(assembly.worker, 'lift_hood', lambda meshes, *args: lifted.append(len(meshes)) or {'lifted_vertices': 9})
    targets = []

    def fit(meshes, target, slot):
        targets.append((slot, target))
        return assembly.worker.Matrix.Identity(4), [], {}
    monkeypatch.setattr(assembly.worker, 'fit_reference_frame', fit)
    assembly.run()
    # The torso box and the bald head's hat seat together; any hair is pressed under the hood when worn.
    assert targets == [('top', [[-.3, .8, -.2], [.3, 1.7, .2]])]
    report = assembly.reports['top']
    assert report['measurement']['frame'] == 'head_and_torso_bounds'
    assert lifted == [1] and report['hood_room'] == {'lifted_vertices': 9}
    top_mesh = next(obj for obj in assembly.scene.objects if obj.name == 'top_0')
    groups = {group.index: group.name for group in top_mesh.vertex_groups}
    rows = [({groups[entry.group]: entry.weight for entry in vertex.groups}, vertex.co.z) for vertex in top_mesh.data.vertices]
    # Above the collar (z 1.3, blended over 4 cm) the hood is the head's; the sleeves and the torso keep the body's.
    assert all(weights == {'Head': 1.} for weights, z in rows if z >= 1.34)
    assert all('Head' not in weights or weights['Head'] < 1. for weights, z in rows if z <= 1.05)
    assert report['hood_binding']['vertices'] == sum(z > 1.3 for _, z in rows)


@pytest.mark.parametrize('description', ['grey hoodie with the hood DOWN, lying flat on the back', 'long sleeved tee'])
def test_a_top_without_a_raised_hood_keeps_the_torso_frame(assembly, monkeypatch, description):
    next(part for part in assembly.payload['parts'] if part['slot'] == 'top')['description'] = description
    monkeypatch.setitem(PLACES, 'top', hoodie_points())
    monkeypatch.setattr(assembly.worker, 'lift_hood', lambda *args: pytest.fail('A lowered hood was lifted'))
    targets = []
    monkeypatch.setattr(assembly.worker, 'fit_reference_frame',
                        lambda meshes, target, slot: targets.append(target) or (assembly.worker.Matrix.Identity(4), [], {}))
    assembly.run()
    assert targets == [SPEC['fitting']['bounds']['top']]
    assert assembly.reports['top']['measurement']['frame'] == 'body_slot_bounds' and 'hood_binding' not in assembly.reports['top']


def worn_stand_ins(monkeypatch, registration):
    """The worn method's extraction and limb checks, as stand-ins: the meshes come back as they were imported. The
    worker imports both modules when it extracts; imported here first, against the same stand-in Blender."""
    import importlib
    monkeypatch.setattr(importlib.import_module('src.services.avatar_worn_part'), 'extract_worn_part',
                        lambda meshes, body, rig, slot, **kwargs: (meshes, {'registration': registration}))
    limbs = importlib.import_module('src.services.avatar_limb_fit')
    monkeypatch.setattr(limbs, 'centre_limbs', lambda *args: {'method': 'fixture'})
    monkeypatch.setattr(limbs, 'check_limbs', lambda *args: {'status': 'pass'})
    return limbs


def test_a_worn_raised_hood_is_lifted_and_its_upper_vertices_follow_the_head(assembly, monkeypatch):
    top = next(part for part in assembly.payload['parts'] if part['slot'] == 'top')
    top['part_method'] = 'worn'
    monkeypatch.setitem(PLACES, 'top', hoodie_points())
    worn_stand_ins(monkeypatch, {'hood_vertices': 600})
    monkeypatch.setattr(assembly.worker, 'lift_hood', lambda *args: {'lifted_vertices': 9})
    assembly.run()
    report = assembly.reports['top']
    assert (report['fit_method'], report['hood_room']) == ('worn-extract-v1', {'lifted_vertices': 9})
    top_mesh = next(obj for obj in assembly.scene.objects if obj.name == 'top_0')
    groups = {group.index: group.name for group in top_mesh.vertex_groups}
    rows = [({groups[entry.group]: entry.weight for entry in vertex.groups}, vertex.co.z) for vertex in top_mesh.data.vertices]
    assert all(weights == {'Head': 1.} for weights, z in rows if z >= 1.34)
    assert report['hood_binding']['vertices'] == sum(z > 1.3 for _, z in rows)


def test_a_worn_bottom_is_measured_for_a_skirt_before_its_limbs(assembly, tmp_path, monkeypatch):
    from copy import deepcopy
    spec = deepcopy(SPEC)
    spec['fitting']['bounds']['bottom'] = [[-.2, .3, -.2], [.2, .8, .2]]
    raw = tmp_path/'generated-bottom.glb'
    raw.write_bytes(b'raw worn bottom')
    assembly.payload['parts'].append({'slot': 'bottom', 'path': str(raw), 'sha256': sha(raw), 'part_method': 'worn',
                                      'garment_kind': 'source', 'fit_profile': None, 'preserve_generated_detail': True})
    only(assembly, 'bottom', spec=spec)
    real = assembly.worker.load
    monkeypatch.setattr(assembly.worker, 'load', lambda path: (
        [mesh(assembly.scene, 'bottom-import', [(0., -.02, .4), (.1, -.02, .6), (-.1, -.02, .5)])]
        if path == str(raw) else real(path)))
    limbs = []
    monkeypatch.setattr(worn_stand_ins(monkeypatch, {}), 'check_limbs',
                        lambda objects, body, rig, slot, kind: limbs.append(kind) or {'status': 'pass'})
    monkeypatch.setattr(assembly.worker, 'mesh_bottom_kind', lambda part, meshes, rig: (
        'skirt', {'method': 'fabric_between_legs_v1', 'rays': 120, 'between_share': 0.}))

    def bind_skirt(meshes, body, rig, slot):
        for obj in meshes:
            obj.modifiers.new('Skirt', 'ARMATURE').object = rig
            obj.vertex_groups.new(name='Hips').add([vertex.index for vertex in obj.data.vertices], 1., 'REPLACE')
        return {'binding': 'skirt_legs'}
    monkeypatch.setattr(assembly.worker, 'bind_skirt', bind_skirt)
    assembly.run()
    report = assembly.reports['bottom']
    # The legs' checks are not a skirt's: they hear the kind measured, not the saved 'source'.
    assert limbs == ['skirt']
    assert (report['binding'], report['garment_kind'], report['garment_kind_check']['rays']) == ('skirt_legs', 'skirt', 120)


def test_a_bottom_its_contract_calls_source_is_bound_as_the_skirt_its_shape_shows(assembly, tmp_path, monkeypatch):
    from copy import deepcopy
    spec = deepcopy(SPEC)
    spec['fitting']['bounds']['bottom'] = [[-.2, .3, -.2], [.2, .8, .2]]
    raw = tmp_path/'generated-bottom.glb'
    raw.write_bytes(b'raw bottom')
    assembly.payload['parts'].append({'slot': 'bottom', 'path': str(raw), 'sha256': sha(raw), 'part_method': 'isolated',
                                      'garment_kind': 'source', 'fit_profile': None, 'preserve_generated_detail': True})
    only(assembly, 'bottom', spec=spec)
    real = assembly.worker.load
    monkeypatch.setattr(assembly.worker, 'load', lambda path: (
        [mesh(assembly.scene, 'bottom-import', [(0., -.02, .4), (.1, -.02, .6), (-.1, -.02, .5)])]
        if path == str(raw) else real(path)))
    measured = []

    def kind(part, meshes, rig):
        measured.append((part['garment_kind'], [obj.name for obj in meshes], rig.name))
        return 'skirt', {'method': 'fabric_between_legs_v1', 'rays': 120, 'between_share': 0.}
    skirts = []

    def bind_skirt(meshes, body, rig, slot):
        skirts.append(slot)
        for obj in meshes:
            obj.modifiers.new('Skirt', 'ARMATURE').object = rig
            obj.vertex_groups.new(name='Hips').add([vertex.index for vertex in obj.data.vertices], 1., 'REPLACE')
        return {'binding': 'skirt_legs'}
    monkeypatch.setattr(assembly.worker, 'mesh_bottom_kind', kind)
    monkeypatch.setattr(assembly.worker, 'bind_skirt', bind_skirt)
    assembly.run()
    assert measured == [('source', ['bottom-import'], 'Armature')] and skirts == ['bottom']
    report = assembly.reports['bottom']
    assert (report['binding'], report['garment_kind'], report['garment_kind_check']['between_share']) == (
        'skirt_legs', 'skirt', 0.)


# --- the server side of the worker: an admitted assembly never stays accepted or running for a live process ----------

@pytest.fixture
def admitted(tmp_path, monkeypatch):
    """A version accepted by this process and waiting for its worker."""
    monkeypatch.setattr(run_lock, 'FINAL_WRITE_DELAYS', (0, 0))
    factory, directory = seed_native_assembly(tmp_path, 'fixture')
    _write_json(directory/'input.json', {'source': str(directory/'body.glb'), 'parts': [], 'prefit_parts': []})
    _write_json(directory/'record.json', {'status': 'accepted', 'process': identity(), 'files': {}})
    return native.AvatarNativeParts(factory), directory


def refuse(monkeypatch, status, times):
    """Saves of the version record with `status` fail `times` times, as a storage outage would."""
    real, refused = native._write_json, []

    def write(path, value):
        if path.name == 'record.json' and value.get('status') == status and len(refused) < times:
            refused.append(status)
            raise OSError('storage unavailable')
        return real(path, value)
    monkeypatch.setattr(native, '_write_json', write)
    return refused


def test_an_assembly_stopped_before_blender_fails_instead_of_staying_accepted(admitted, monkeypatch):
    service, directory = admitted

    def unavailable(directory, *, inputs=()):
        raise OSError('stored inputs unavailable')
    monkeypatch.setattr(native, 'local_workspace', unavailable)
    refused = refuse(monkeypatch, 'failed', 1)
    with pytest.raises(OSError, match='stored inputs'):
        service.execute(1, JOB)
    record = read_json(directory/'record.json')
    assert refused and record['status'] == 'failed' and record['error_type'] == 'OSError'
    assert service.get(1, JOB)['status'] == 'failed' and native._WORKERS == {}


def test_an_assembly_whose_last_save_failed_reads_as_stopped_and_is_admitted_again(admitted, monkeypatch):
    service, directory = admitted

    def no_blender(*args, **kwargs):
        raise RuntimeError('Blender did not start')
    monkeypatch.setattr(native, 'blender_process', no_blender)
    refuse(monkeypatch, 'failed', 99)
    with pytest.raises(OSError):
        service.execute(1, JOB)
    # The record still says running in this live process; nothing runs it any more.
    assert read_json(directory/'record.json')['status'] == 'running'
    assert service.get(1, JOB)['status'] == 'recovery_required'
    assert native._WORKERS.acquire(str(directory))
    try:
        assert service.get(1, JOB)['status'] == 'running'  # while a worker holds it, it runs
    finally:
        native._WORKERS.release(str(directory))
    _, again = service._resume_version(1, JOB, VERSION)
    assert again and read_json(directory/'record.json')['status'] == 'accepted'
