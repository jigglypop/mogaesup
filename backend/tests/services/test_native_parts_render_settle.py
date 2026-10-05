"""The native-parts worker settles what it offers before it draws anything (tests/fake_blender.py stands in for Blender).

A slot withdrawn by the body cut, the layering or the export check is out of every render, and the hash the seal keeps
for each render is of that final drawing. A body cut or a layering that fails on one slot's meshes withdraws that slot
alone, with a receipt like the other withdrawals; a failure no single slot accounts for ends the assembly.
"""
import hashlib
import json
import sys
import types

import numpy as np
import pytest

import fake_blender
from services.test_native_parts_worker import PLACES, Assembly, offered

STILLS = ('front.png', 'side.png', 'back.png', 'opposite.png')


@pytest.fixture
def assembly(tmp_path, monkeypatch):
    return Assembly(tmp_path, monkeypatch)


def incomplete(assembly):
    return {part['slot']: part for part in assembly.result['incomplete_parts']}


def render_hash(name, meshes):
    """The seal's hash of the stand-in render `name` that shows exactly `meshes`."""
    return hashlib.sha256(f'render {name}: {" ".join(meshes)}'.encode()).hexdigest()


def test_every_render_is_drawn_once_after_the_last_export_and_the_stills_in_the_rest_pose(assembly):
    assembly.run()
    kinds = [kind for kind, _, _ in assembly.steps]
    assert 'export' not in kinds[kinds.index('render'):]
    assert {pose for kind, _, pose in assembly.steps if kind == 'export'} == {'POSE'}
    renders = [(name, pose) for kind, name, pose in assembly.steps if kind == 'render']
    assert renders == [*((name, 'REST') for name in STILLS), ('body-front.png', 'REST'), ('motion.png', 'POSE')]
    for name in (*STILLS, 'motion.png'):
        assert assembly.files[name] == render_hash(name, ['body_0', 'hair_0', 'shoes_0', 'top_0'])
    assert assembly.drawn('body-front.png') == ['body_0']


def test_a_slot_withdrawn_by_the_export_check_is_in_no_render(assembly, monkeypatch):
    def unbound_shoes(meshes, rig, regions):
        return {'binding': 'rigid_feet'}   # no armature modifier: the exporter writes no skin
    monkeypatch.setattr(assembly.worker, 'bind_shoes_rigid', unbound_shoes)
    assembly.run()
    assert assembly.reports['shoes']['unavailable_reason'] == 'export_check_failed'
    # The model is exported again without the shoes, and only then is anything drawn.
    last_export = max(i for i, (kind, _, _) in enumerate(assembly.steps) if kind == 'export')
    assert all(i > last_export for i, (kind, _, _) in enumerate(assembly.steps) if kind == 'render')
    for name in (*STILLS, 'motion.png'):
        assert assembly.files[name] == render_hash(name, ['body_0', 'hair_0', 'top_0'])
    assert assembly.result['fit_status'] == 'incomplete'


def test_a_slot_whose_body_cut_fails_is_withdrawn_alone_and_drawn_nowhere(assembly, monkeypatch):
    calls = []

    def mark_body_coverage(body, garments, rig, spec, profiles, shell_slots=()):
        worn = sorted(slot for slot, meshes in garments.items() if meshes)
        calls.append(worn)
        if 'top' in worn:
            raise RuntimeError(r'Bisect failed, see C:\Users\someone\AppData\Local\Temp\tmpq1\top.blend')
        return [], {}, []
    monkeypatch.setattr(assembly.worker, 'mark_body_coverage', mark_body_coverage)
    assembly.run()
    assert offered(assembly) == ['body', 'hair', 'shoes'] and 'top.glb' not in assembly.files
    top = assembly.reports['top']
    assert (top['available'], top['unavailable_reason'], top['fit_status']) == (False, 'body_crop_failed', 'failed')
    assert top['errors'] == [{'code': 'body_crop_failed', 'message': 'RuntimeError: Bisect failed, see top.blend'}]
    assert incomplete(assembly)['top']['status'] == 'failed'
    # All together, then the body alone, then each slot alone, then the slots left together.
    assert calls == [['hair', 'shoes', 'top'], [], ['hair'], ['top'], ['shoes'], ['hair', 'shoes']]
    assert all(not any(name.startswith('top') for name in names) for _, names in assembly.exports)
    assert assembly.drawn('front.png') == ['body_0', 'hair_0', 'shoes_0']


@pytest.mark.parametrize('fails', [lambda worn: True, lambda worn: {'top', 'shoes'} <= set(worn)],
                         ids=['the body itself', 'two slots only together'])
def test_a_body_cut_no_one_slot_accounts_for_ends_the_assembly(assembly, monkeypatch, fails):
    def mark_body_coverage(body, garments, rig, spec, profiles, shell_slots=()):
        if fails([slot for slot, meshes in garments.items() if meshes]):
            raise RuntimeError('Body cut failed')
        return [], {}, []
    monkeypatch.setattr(assembly.worker, 'mark_body_coverage', mark_body_coverage)
    with pytest.raises(RuntimeError, match='Body cut failed'):
        assembly.worker.run(assembly.payload)
    assert not (assembly.output/'complete.json').exists()
    assert not [kind for kind, _, _ in assembly.steps]


@pytest.mark.parametrize('broken', [False, True])
def test_a_shell_garment_whose_coverage_cannot_be_marked_is_withdrawn_alone(assembly, monkeypatch, broken):
    worker, scene = assembly.worker, assembly.scene
    next(part for part in assembly.payload['parts'] if part['slot'] == 'top')['part_method'] = 'body_shell'
    (assembly.output/'input.json').write_text(json.dumps(assembly.payload), encoding='utf8')

    def build_body_shell_part(part, body, rig, spec):
        shell = fake_blender.mesh(scene, 'shell', PLACES['top'], rig=rig, weights=[{'Spine': 1.}]*3)
        return [shell], {'binding': 'copied_body_weights', 'fit_method': 'body-shell-v1', 'available': True,
                         'runtime_budget': {'preserved': True}}, {'body_0': {0, 1}}

    def mark_shell_coverage(body, slot, covered):
        if broken:
            raise RuntimeError('Body has no attribute layer for the shell')
    cut_with_shells = []

    def mark_body_coverage(body, garments, rig, spec, profiles, shell_slots=()):
        cut_with_shells.append(tuple(shell_slots))
        return [], {}, []
    monkeypatch.setattr(worker, 'build_body_shell_part', build_body_shell_part)
    monkeypatch.setattr(worker, 'mark_shell_coverage', mark_shell_coverage)
    monkeypatch.setattr(worker, 'mark_body_coverage', mark_body_coverage)
    assembly.run()
    if not broken:
        assert offered(assembly) == ['body', 'hair', 'shoes', 'top'] and cut_with_shells == [('top',)]
        assert assembly.drawn('front.png') == ['body_0', 'hair_0', 'shoes_0', 'top_0']
        return
    assert offered(assembly) == ['body', 'hair', 'shoes'] and cut_with_shells == [()]
    assert assembly.reports['top']['errors'] == [{'code': 'body_crop_failed',
                                                  'message': 'RuntimeError: Body has no attribute layer for the shell'}]
    assert assembly.drawn('front.png') == ['body_0', 'hair_0', 'shoes_0']


def test_a_part_the_layering_fails_on_is_withdrawn_alone(assembly, monkeypatch):
    worker, pressed = assembly.worker, []

    def pressed_under(fitted, body, rig):
        roles = sorted({obj['part_role'] for obj in fitted})
        pressed.append(roles)
        if 'top' in roles:
            raise worker.SlotFailure('top', ValueError('Top cover is not finite'))
        return (lambda: None), (lambda: None)
    monkeypatch.setattr(worker, 'pressed_under', pressed_under)
    assembly.run()
    assert offered(assembly) == ['body', 'hair', 'shoes']
    top = assembly.reports['top']
    assert (top['unavailable_reason'], top['errors']) == (
        'layer_press_failed', [{'code': 'layer_press_failed', 'message': 'ValueError: Top cover is not finite'}])
    # The body is cut and pressed again without the top before anything is exported or drawn.
    assert pressed == [['hair', 'shoes', 'top'], ['hair', 'shoes']]
    assert assembly.coverage_calls == [['hair', 'shoes', 'top'], ['hair', 'shoes']]
    assert all(not any(name.startswith('top') for name in names) for _, names in assembly.exports)
    assert assembly.drawn('front.png') == ['body_0', 'hair_0', 'shoes_0']


def test_a_layering_failure_on_the_body_ends_the_assembly(assembly, monkeypatch):
    def pressed_under(fitted, body, rig):
        raise ValueError('Body surface has no triangles')
    monkeypatch.setattr(assembly.worker, 'pressed_under', pressed_under)
    with pytest.raises(ValueError, match='no triangles'):
        assembly.worker.run(assembly.payload)
    assert not (assembly.output/'complete.json').exists()


# --- pressed_under itself: which slot a failure belongs to ----------------------------------------------------------

class Part:
    """A fitted part as pressed_under reads it: its role, world matrix and vertex coordinates (Blender space)."""

    def __init__(self, role, points, broken=False):
        self.role, self.points, self.broken = role, np.array(points, float), broken
        self.matrix_world = np.eye(4)
        self.data = types.SimpleNamespace(vertices=self, update=lambda: None)

    def __getitem__(self, key):
        return {'part_role': self.role}[key]

    def __len__(self):
        return len(self.points)

    def foreach_get(self, name, values):
        if self.broken:
            raise RuntimeError(f'{self.role} mesh has no vertex data')
        values[:] = self.points.reshape(-1)

    def foreach_set(self, name, values):
        self.points = np.array(values, float).reshape(-1, 3)


def front(depth, heights):
    """Points across the body front at `depth` metres in front of it (Blender -Y), at each height."""
    return [(x, -depth, z) for z in heights for x in np.linspace(-.2, .2, 5)]


@pytest.fixture
def layering(monkeypatch):
    """pressed_under of the worker, on a flat 0.4 m wide body front from the hips to the chest."""
    _, modules = fake_blender.install(monkeypatch, 'avatar_native_parts_blender')
    heights = np.linspace(.8, 1.2, 5)
    positions = np.array(front(0., heights))
    triangles = [(row*5+column, row*5+column+1, (row+1)*5+column) for row in range(4) for column in range(4)]
    surface = {'positions': positions, 'normals': np.tile((0., -1., 0.), (len(positions), 1)),
               'triangles': np.array(triangles), 'weights': np.ones((len(positions), 1)), 'bones': ['Spine']}
    shell = types.ModuleType('src.services.avatar_shell_garment')
    shell.body_arrays = lambda body, rig: surface
    monkeypatch.setitem(sys.modules, 'src.services.avatar_shell_garment', shell)
    return modules['avatar_native_parts_blender'], shell


def test_the_layering_presses_the_bottom_under_the_top(layering):
    worker, _ = layering
    top, bottom = Part('top', front(.02, np.linspace(.8, 1.2, 5))), Part('bottom', front(.03, (.8, .9)))
    apply, restore = worker.pressed_under([top, bottom], [], None)
    apply()
    assert bottom.points[:, 1] == pytest.approx(-.001)
    restore()
    assert bottom.points[:, 1] == pytest.approx(-.03)


@pytest.mark.parametrize('broken', ['top', 'bottom'])
def test_a_layering_failure_names_the_part_it_failed_on(layering, broken):
    worker, _ = layering
    top = Part('top', front(.02, np.linspace(.8, 1.2, 5)), broken=broken == 'top')
    bottom = Part('bottom', front(.03, (.8, .9)), broken=broken == 'bottom')
    with pytest.raises(worker.SlotFailure) as failure:
        worker.pressed_under([top, bottom], [], None)
    assert failure.value.slot == broken
    assert str(failure.value.error) == f'{broken} mesh has no vertex data'


def test_a_layering_failure_on_the_body_names_no_part(layering, monkeypatch):
    worker, shell = layering

    def body_arrays(body, rig):
        raise ValueError('Body has no skin weights')
    monkeypatch.setattr(shell, 'body_arrays', body_arrays)
    with pytest.raises(ValueError, match='no skin weights'):
        worker.pressed_under([Part('top', front(.02, (1.,))), Part('bottom', front(.03, (.8,)))], [], None)
