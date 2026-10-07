"""Local fitting candidates on the original Meshy skeleton; never a visual approval."""
from contextlib import contextmanager
from copy import deepcopy
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import traceback

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.services.avatar_blender_common import (
    load, skeleton, body_meshes, bounds, bind, export, sha, blender_to_gltf,
    camera_setup, render, matte_materials, soft_lighting, find_bone, bind_skirt, gate_top_weights,
)
from src.services.glb import parse_glb
from src.services.avatar_fit_geometry import measured_fit, normalize_body, body_targets, hair_target, headwear_target, head_region, clearance, lift_hood, place, slim_base_body, bind_body_head, fit_equipment
from src.services.avatar_shoe_geometry import (
    fit_shoes_rigid, bind_shoes_rigid, finish_shoes_after_pose, foot_skin, foot_bounds, shoe_coverage,
    check_shoe_coverage,
)
from src.services.avatar_equipment import NATIVE_EQUIPMENT as EQUIPMENT
from src.services.avatar_body_layers import (
    crop_regions, mark_body_coverage, hide_covered_materials, restore_covered_materials, strip_covered_primitives,
)
from src.services.avatar_head_geometry import headwear_palette, prepare_rear_hair, fit_hat, fit_reference_frame, hat_target_over_hair, fit_hair, fit_hair_length, fit_hair_scalp, fit_hair_scalp_bounded, head_preview_body, whiten_base_body, seat_legacy_hair_roots, seat_hat_above_brows, fit_hat_cavity
from src.services.avatar_hair_geometry import add_scalp_cap, fit_hair_cavity, repair_hair_backing
from src.services.avatar_arm_geometry import fit_sleeves, bind_top_regions, t_rest_pose
from src.services.avatar_render_budget import optimize_part
from src.services.avatar_pipeline_quality import REVISION as QUALITY_REVISION, seal_quality
from src.services.avatar_quality_blender import measure_assembly
from src.services.avatar_expression_uv_blender import prepare_expression_uv
from src.services.avatar_garment_geometry import (
    bind_garment_regions, fit_profiled_garment, measure_body_profile,
)
from src.services.avatar_part_gate import (
    GATED_SLOTS, REVISION as GATE_REVISION, Body as GateBody, PartRefusal, gate_part, refusal as gate_refusal,
)
from src.services.avatar_clothing_binding import bind_hood_head, head_torso_bounds, mesh_bottom_kind, raised_hood

HAIR_SLOTS = ('hair', 'hairFront', 'hairBack')


class InputChanged(ValueError):
    """A saved input differs from the one the request was accepted with: nothing is fitted from it."""


class SlotFailure(Exception):
    """A step of the whole assembly failed on one slot's meshes: that slot alone is withdrawn."""

    def __init__(self, slot, error):
        super().__init__(slot, error)
        self.slot, self.error = slot, error


@contextmanager
def blame(slot):
    """An error raised inside is `slot`'s own and is raised again as SlotFailure; a nested step's slot is kept."""
    try:
        yield
    except SlotFailure:
        raise
    except Exception as exc:
        raise SlotFailure(slot, exc) from exc


def world_points(meshes):
    """(n, 3) world positions of the meshes' vertices (Blender, Z up)."""
    import numpy as np
    return np.array([tuple(obj.matrix_world @ vertex.co) for obj in meshes for vertex in obj.data.vertices],
                    float).reshape(-1, 3)


def discard_objects(objects):
    for obj in objects:
        try:
            if obj.name in bpy.data.objects:
                bpy.data.objects.remove(obj, do_unlink=True)
        except ReferenceError:
            pass  # Removed already together with its parent.


# Absolute paths in worker text (C:\..., \\host\..., /srv/...): a receipt keeps only the file name.
_ABSOLUTE_PATH = re.compile(r'(?:\b[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/]|(?<![\w.:/~-])/(?=[^\s/]+/))'
                            r'(?:[^\s\'"<>|*?\\/]+[\\/])*([^\s\'"<>|*?\\/]*)')


def public_message(exc):
    """`Type: message` of an exception for a part receipt, which the job's API answer carries: absolute paths cut to
    their file names, at most 300 characters. The full traceback goes to the worker log."""
    traceback.print_exception(type(exc), exc, exc.__traceback__)
    text = f'{type(exc).__name__}: {exc}'
    return _ABSOLUTE_PATH.sub(lambda match: match.group(1) or 'path', text)[:300]


def fit_failure(part, exc):
    """The receipt of a slot whose fitting raised: no mesh, not offered, and the other slots still assemble. A
    refusal (a shoe pair with a shoe missing, ...) carries its own code; anything else is fit_exception."""
    code = exc.code if isinstance(exc, PartRefusal) else 'fit_exception'
    return {'slot': part['slot'], 'source_sha256': part['sha256'], 'objects': [], 'anchors': [],
            'available': False, 'unavailable_reason': code, 'fit_status': 'failed',
            'errors': [{'code': code, 'message': public_message(exc)}],
            'runtime_budget': {'preserved': True, 'optimization': 'not_applied'},
            'clearance': {'method': 'not_applied'}}


def gate_fitted(output, reports, sealed):
    """The seal's quality gate (avatar_part_gate) over the slots this assembly fitted, on the files just exported:
    each receipt keeps the gate's measurements under `quality_gate`. Returns [(slot, PartRefusal)] of the slots it
    refuses. A slot carried over already sealed (`sealed`: a refit's frozen slots, an uploaded hair, a preserved
    fallback) is not measured again: a part once offered is never hidden by a later gate."""
    body, refused = None, []
    for report in reports:
        slot = report.get('slot')
        if slot not in GATED_SLOTS or slot in sealed or report.get('available') is False:
            continue
        try:
            body = body or GateBody((output/'body.glb').read_bytes())
            receipt = gate_part(slot, (output/f'{slot}.glb').read_bytes(), body=body)
        except Exception as exc:
            # A body the gate cannot read measures nothing: the slot is offered as the fitting left it.
            traceback.print_exc()
            receipt = {'revision': GATE_REVISION, 'measured': {}, 'refusal': None, 'skipped': 'unreadable',
                       'error': type(exc).__name__}
        report['quality_gate'] = receipt
        refusal = gate_refusal(receipt)
        if refusal is not None:
            refused.append((slot, refusal))
    return refused


def object_mode():
    """Leave an edit or sculpt mode an exception was raised in, so the next step starts in object mode."""
    try:
        if bpy.context.object is not None and bpy.context.object.mode != 'OBJECT':
            bpy.ops.object.mode_set(mode='OBJECT')
    except Exception:
        pass


def withdraw(slot, report, exc, code, fitted, *, prefit_paths=None):
    """A slot that fitted but failed a later step of the assembly (the shoes' final pose, the body crop, the layering,
    the export check): its meshes leave the scene, its receipt says why it is not offered, and the other slots still
    assemble. `fitted` loses the slot's meshes in place."""
    object_mode()
    dropped = [obj for obj in fitted if obj['part_role'] == slot]
    fitted[:] = [obj for obj in fitted if obj['part_role'] != slot]
    discard_objects(dropped)
    if prefit_paths is not None:
        prefit_paths.pop(slot, None)
    report.update(objects=[], anchors=[], nodes=[], available=False, unavailable_reason=code, fit_status='failed',
                  errors=[{'code': code, 'message': public_message(exc)}])


def check_crop_region(slot, meshes, rig, spec, coverage_profiles):
    """The body crop one garment asks for, measured alone: a garment whose region cannot be measured, or comes out
    not finite, is withdrawn before the body is cut for the others."""
    regions, lines = crop_regions({slot: meshes}, rig, spec, coverage_profiles)
    values = [value for _, point, normal in lines for value in (*point, *normal)]
    if not all(math.isfinite(value) for value in values):
        raise ValueError(f'The body crop of {slot} is not finite')
    return regions


def seal_part(output, doc, part):
    """Exported geometry of one slot: its runtime budget from its own file, its nodes in the composed model. A slot
    without a skinned node there raises."""
    exported, _ = parse_glb((output/f'{part["slot"]}.glb').read_bytes(), strict=True)
    primitives = [primitive for node in exported.get('nodes', []) if 'mesh' in node
                  for primitive in exported['meshes'][node['mesh']]['primitives']]
    # Coverage cuts can add vertices after simplification. Report the actual
    # exported geometry rather than presenting the requested cap as achieved.
    triangles = sum(exported['accessors'][p.get('indices', p['attributes']['POSITION'])]['count']//3
                    for p in primitives if p.get('mode', 4) == 4)
    budget = part['runtime_budget']
    budget.update(runtime_triangles=triangles, runtime_draws=len(primitives),
                  runtime_materials=len({p.get('material') for p in primitives}))
    if 'target_triangles' in budget:
        budget['budget_met'] = triangles <= budget['target_triangles']
    part['nodes'] = [i for i, n in enumerate(doc['nodes']) if n.get('name') in part['objects'] and 'mesh' in n]
    if not part['nodes'] or any('skin' not in doc['nodes'][i] for i in part['nodes']):
        raise ValueError('Missing skinned part')


def build_body_shell_part(part, body, rig, spec):
    """Garment from the frozen body surface and the registered canvas views."""
    from src.services.avatar_shell_garment import build_shell_garment
    for view, path in part.get('image_paths', {}).items():
        if sha(path) != part.get('image_sha256', {}).get(view):
            raise InputChanged('Part reference image changed')
    canvas = dict(spec['canvas'])
    meshes, report, covered = build_shell_garment(body, rig, part['slot'], part['image_paths'], canvas,
                                                  kind=part.get('garment_kind', 'source'), shape=part.get('shape'),
                                                  key_rgb=part.get('key_rgb'))
    for obj in meshes:
        obj['standard_slot'] = part['slot']
    report.update(binding='copied_body_weights', fit_method='body-shell-v1', available=True,
                  runtime_budget={'preserved': True, 'source_mesh_detail': True, 'shell_triangles': report.get('triangles')})
    if part['slot'] == 'bottom':
        report['garment_kind'] = part.get('garment_kind', 'source')
    return meshes, report, covered


def extract_worn_meshes(part, meshes, body, rig, spec):
    """Provider model worn on the key mannequin: register, remove the body, bind like the slot.

    Head parts follow the head bone, a skirt the pelvis and the thighs (bind_skirt); other garments take the
    body's skin weights from the nearest surface so sleeves and legs deform. Before
    that, sleeves are centred on the arms and every limb opening is measured.
    """
    from src.services.avatar_limb_fit import centre_limbs, check_limbs
    from src.services.avatar_worn_part import extract_worn_part
    drawings = []
    if part.get('drawings'):
        from src.services.avatar_shell_garment import CanvasView
        for view, path in part['drawings'].items():
            if sha(path) != part.get('drawing_sha256', {}).get(view):
                raise InputChanged('Part drawing changed')
            drawings.append(CanvasView(view, path, dict(spec['canvas'])))
    extracted, report = extract_worn_part(meshes, body, rig, part['slot'], key_rgb=part.get('key_rgb'), drawings=drawings)
    garment_kind, kind_check = ((part.get('fit_profile') or {}).get('kind') or part.get('garment_kind'), None)
    if part['slot'] == 'bottom':
        # A bottom no saved contract names is told apart by the fabric between the legs.
        garment_kind, kind_check = mesh_bottom_kind(part, extracted, rig)
    centring = centre_limbs(extracted, body, rig, part['slot'], garment_kind)
    runtime_policy = spec.get('runtime') or {}
    runtime_budget = {'preserved': True, 'source_mesh_detail': True, 'source_uv': True}
    if runtime_policy:
        target = runtime_policy['part_triangles'].get(part['slot'], 12000)
        runtime_budget = optimize_part(extracted, part['slot'], target_triangles=max(100, target),
            texture_max_edge=runtime_policy['texture_max_edge'], preserve_appearance=True, merge=True)
        runtime_budget.update(target_triangles=target, revision=runtime_policy['revision'])
    fitting = spec['fitting']
    adjustment = clearance(extracted, body, fitting.get('scalp_clearance_m', .003),
                           spec['tolerances'].get('max_surface_adjustment_m', .015))
    slot = part['slot']
    # A raised hood was registered to the bald head: lift it so hair worn under it stays inside.
    hood_room = (lift_hood(extracted, body, rig, spec)
                 if slot == 'top' and report.get('registration', {}).get('hood_vertices') else None)
    skirt = slot == 'bottom' and garment_kind == 'skirt'
    # Measured on the final rest geometry; a failed check is reported, never a blocked assembly.
    limb_fit = {'centring': centring, 'check': check_limbs(extracted, body, rig, slot, garment_kind)}
    bone = find_bone(rig, 'head') or 'Head'
    rigid = slot in ('hair', 'head', 'hairFront', 'hairBack', 'hat')
    scalp_cap = add_scalp_cap(extracted, body, rig, spec) if slot == 'hair' else None
    binding = (bind_skirt(extracted, body, rig, slot) if skirt else
               bind(extracted, body, rig, {'anchors': [], 'max_anchor_error_m': .0001,
                    'binding': 'rigid' if rigid else 'transfer', 'bone': bone, 'slot': slot,
                    'max_transfer_distance_m': None}, transform=Matrix.Identity(4)))
    if hood_room is not None:
        binding['hood_binding'] = bind_hood_head(extracted, rig, head_region(body, rig, spec)[2])
    if slot == 'top':
        # After the hood: the regions still keep the sleeves and the torso off the head.
        binding['regional_weights'] = gate_top_weights(extracted, rig, head_region(body, rig, spec)[:2])
    if slot == 'bottom':
        binding.update(garment_kind=garment_kind or 'source', garment_kind_check=kind_check)
    if slot == 'shoes':
        # Worn shoes too must still cover both feet once the mannequin is cut away.
        middle = sum((rig.matrix_world @ rig.data.bones[name].head_local).x
                     for name in (find_bone(rig, 'leftfoot'), find_bone(rig, 'rightfoot')) if name)/2
        sides = {obj: {vertex.index: 'left' if (obj.matrix_world @ vertex.co).x >= middle else 'right'
                       for vertex in obj.data.vertices} for obj in extracted}
        binding['foot_coverage'] = shoe_coverage(extracted, sides, foot_skin(body))
        check_shoe_coverage(binding['foot_coverage'])
    binding.update(measurement=report, runtime_budget=runtime_budget, clearance=adjustment,
                   limb_fit=limb_fit, fit_method='worn-extract-v1', available=True)
    if scalp_cap is not None:
        binding['scalp_cap'] = scalp_cap
    if hood_room is not None:
        binding['hood_room'] = hood_room
    return extracted, binding


def pressed_under(fitted, body, rig):
    """(apply, restore) for renders: this assembly's inner parts pressed onto the skin where the
    outer ones cover the body, as the wardrobe presses any outfit (avatar_wardrobe_coverage): the
    bottom under the top and into boots, low shoes under the bottom's hem, and hair on the head
    under a hat or a raised hood. The exported parts stay as fitted, so they still layer with
    parts of any other job. A failure on one part's meshes raises SlotFailure naming its slot (the
    outer part whose cover was measured, or the inner part being pressed); one on the body's own
    surface raises as it is."""
    import numpy as np
    from src.services.avatar_shell_garment import body_arrays
    from src.services.avatar_wardrobe_coverage import (ANCHOR_M, BOOT_SHIN_SHARE, HAIR_ANCHOR_M, HEAD_OUTSIDE_M,
                                                       HEAD_SHARE, UNDER, _covered, bone_keys, nearest, press)
    # The coverage helpers chunk along glTF Y (up): hand them Blender Z as Y.
    gltf = lambda a: np.stack([a[:, 0], a[:, 2], -a[:, 1]], axis=1)
    blender = lambda a: np.stack([a[:, 0], -a[:, 2], a[:, 1]], axis=1)

    def world(obj):
        mesh = obj.data
        local = np.empty(len(mesh.vertices)*3); mesh.vertices.foreach_get('co', local)
        local = local.reshape(-1, 3); matrix = np.array(obj.matrix_world)
        return local, local @ matrix[:3, :3].T + matrix[:3, 3], matrix
    roles = {obj['part_role'] for obj in fitted}
    pairs = [(inner, [role for role in outers if role in roles]) for inner, outers in UNDER.items() if inner in roles]
    pairs = [(inner, outers) for inner, outers in pairs if outers]
    if not pairs:
        return (lambda: None), (lambda: None)
    data = body_arrays(body, rig)
    skin, normals, triangles = gltf(data['positions']), gltf(data['normals']), data['triangles']
    # As the wardrobe reads them: 'mixamorig:LeftLeg' is a shin like 'LeftLeg'.
    dominant = bone_keys(np.array(data['bones'])[data['weights'].argmax(axis=1)])
    head = np.char.find(dominant, 'head') >= 0
    shins = np.isin(dominant, ('leftleg', 'rightleg'))
    upper = head & (skin[:, 1] >= np.median(skin[head, 1])) if head.any() else head
    garments = {}

    def garment(role):
        if role not in garments:
            with blame(role):
                points = gltf(np.concatenate([world(obj)[1] for obj in fitted if obj['part_role'] == role]))
                if len(points) > 20000:
                    points = points[np.random.default_rng(0).choice(len(points), 20000, replace=False)]
                garments[role] = points, _covered(skin, normals, points)
        return garments[role]
    boot = 'shoes' in roles and bool(shins.any() and garment('shoes')[1][shins].mean() >= BOOT_SHIN_SHARE)
    moves = []
    for inner, outers in pairs:
        # A bottom goes into boots; low shoes go under the bottom's hem.
        if (inner, boot) == ('shoes', True):
            continue
        covered = np.zeros(len(skin), bool)
        for role in outers:
            if (inner, role, boot) == ('bottom', 'shoes', False):
                continue
            points, flags = garment(role)
            if inner == 'hair':
                # A hat's crown or a hood's peak stands well off the scalp (the wardrobe's over).
                flags = flags.copy()
                with blame(role):
                    flags[head] |= _covered(skin[head], normals[head], points, outside=HEAD_OUTSIDE_M)
                # Hair goes under a hat or a raised hood only, never under a hood lying on the back.
                if not (upper.any() and flags[upper].mean() >= HEAD_SHARE):
                    continue
            covered |= flags
        if not covered.any():
            continue
        # The corners of covered body triangles, grown by one ring (as the wardrobe viewer does).
        corners = np.zeros(len(skin), bool)
        corners[triangles[covered[triangles].all(axis=1)].reshape(-1)] = True
        corners[triangles[corners[triangles].any(axis=1)].reshape(-1)] = True
        # As tuck_region(): hair only on the head.
        if inner == 'hair':
            corners &= head
        for obj in (obj for obj in fitted if obj['part_role'] == inner):
            with blame(inner):
                local, points, matrix = world(obj)
                index = nearest(gltf(points), skin, HAIR_ANCHOR_M if inner == 'hair' else ANCHOR_M)
                index[index >= 0] = np.where(corners[index[index >= 0]], index[index >= 0], -1)
                moved = points + blender(press(gltf(points), skin, normals, index, corners))
                moves.append((obj, local, (moved - matrix[:3, 3]) @ np.linalg.inv(matrix[:3, :3]).T))

    def put(which):
        for obj, local, pressed in moves:
            obj.data.vertices.foreach_set('co', (pressed if which else local).reshape(-1))
            obj.data.update()
    return (lambda: put(True)), (lambda: put(False))


def mark_shell_coverage(body, slot, covered):
    """Store which body vertices a shell garment covers, for the body-layer crop."""
    for obj in body:
        indices = covered.get(obj.name, set())
        name = f'shell_cover_{slot}'
        attribute = obj.data.attributes.get(name) or obj.data.attributes.new(name, 'FLOAT', 'POINT')
        values = [0.]*len(obj.data.vertices)
        for index in indices:
            if index < len(values):
                values[index] = 1.
        attribute.data.foreach_set('value', values)


def coverage_failures(body, garments, rig, spec, profiles, shell_slots):
    """{slot: exception} for the slots whose body cut raises on its own, once the cut for them all raised. Empty when
    the body cannot be cut even with nothing worn, or when every slot can be cut alone: then no one slot is to blame.
    The cut made afterwards for the slots left clears what these trial cuts hid, as a cut after a withdrawal does."""
    try:
        mark_body_coverage(body, {}, rig, spec, profiles, shell_slots=())
    except Exception:
        traceback.print_exc()
        return {}
    failures = {}
    for slot in [*(slot for slot, meshes in garments.items() if meshes), *shell_slots]:
        try:
            mark_body_coverage(body, {slot: garments[slot]} if slot in garments else {}, rig, spec, profiles,
                               shell_slots=(slot,) if slot in shell_slots else ())
        except Exception as exc:
            failures[slot] = exc
    return failures


def rig_signature(rig):
    """glTF-stable rest skeleton identity; Blender-inferred tails/roll are excluded."""
    return {bone.name: {
        'parent': bone.parent.name if bone.parent else None,
        'world_rest': tuple(float(value) for row in (rig.matrix_world @ bone.matrix_local) for value in row),
    } for bone in rig.data.bones}


def compatible_rig(source, target, tolerance=1e-4):
    source_bones, target_bones = rig_signature(source), rig_signature(target)
    if source_bones.keys() != target_bones.keys():
        return False
    for name, source_bone in source_bones.items():
        target_bone = target_bones[name]
        if source_bone['parent'] != target_bone['parent']:
            return False
        a_values, b_values = source_bone['world_rest'], target_bone['world_rest']
        if len(a_values) != len(b_values) or not all(math.isfinite(v) for v in (*a_values, *b_values)):
            return False
        if any(abs(a-b) > tolerance for a, b in zip(a_values, b_values)):
            return False
    return True


def load_prefit_part(part, rig, *, body_source=None):
    """Attach an already fitted slot to the identical canonical rig without touching its mesh."""
    if sha(part['path']) != part['sha256']:
        raise ValueError('Prefit part changed')
    if part.get('uploaded_native_hair'):
        if part['slot'] != 'hair': raise ValueError('Only uploaded native hair is supported')
        from src.services.native_hair_upload import validate_native_hair
        validate_native_hair(Path(part['path']).read_bytes(),
            body_content=Path(body_source).read_bytes() if body_source else None, inspect=False)
    additions = load(part['path'])
    imported_rigs = [obj for obj in additions if obj.type == 'ARMATURE']
    if len(imported_rigs) != 1:
        raise ValueError('Expected one sealed rigged prefit part')
    imported_rig = imported_rigs[0]
    meshes = body_meshes(additions, imported_rig)
    if not compatible_rig(imported_rig, rig):
        raise ValueError('Prefit part skeleton changed')
    for index, obj in enumerate(meshes):
        modifiers = [modifier for modifier in obj.modifiers if modifier.type == 'ARMATURE']
        if not modifiers or any(modifier.object != imported_rig for modifier in modifiers):
            raise ValueError('Prefit part skin binding changed')
        if part.get('uploaded_native_hair'):
            bone_names = {bone.name for bone in imported_rig.data.bones}
            group_names = {group.index: group.name for group in obj.vertex_groups}
            for vertex in obj.data.vertices:
                weights = [group for group in vertex.groups if group.weight > 0]
                if (not weights or any(not math.isfinite(group.weight) or not 0 <= group.weight <= 1
                        or group_names.get(group.group) not in bone_names for group in vertex.groups)
                        or abs(sum(group.weight for group in weights)-1.) > 1e-5):
                    raise ValueError('Prefit part vertex binding changed')
        world = obj.matrix_world.copy()
        for modifier in modifiers:
            modifier.object = rig
        obj.parent = rig
        obj.matrix_world = world
        obj.name = f'{part["slot"]}_{index}'
        obj['part_role'] = part['slot']
    for obj in additions:
        if obj not in meshes:
            bpy.data.objects.remove(obj, do_unlink=True)
    report = deepcopy(part.get('report') or {})
    if not isinstance(report.get('runtime_budget'), dict):
        raise ValueError('Prefit part receipt missing runtime budget')
    report.update(slot=part['slot'], source_sha256=part['sha256'],
                  objects=[obj.name for obj in meshes], origin='reused_fitted_native')
    report.pop('nodes', None)
    return meshes, report


def fit_uniform_part(part, meshes, body, rig, spec, targets, imported):
    """One uniform placement, bounded clearance and binding; no shape heuristics.

    The part keeps its generated proportions and is placed in the measured body
    slot box (a top with a raised hood in the head's and the torso's together).
    Image-measured frames are not used: saved views drift far from the
    shared canvas scale (e.g. a hat spanning the whole body height).
    """
    slot, fitting, tolerances = part['slot'], spec['fitting'], spec['tolerances']
    runtime_policy = spec.get('runtime') or {}
    runtime_budget = {'preserved': True, 'source_mesh_detail': True, 'source_uv': True}
    # Meshy often leaves the rear of an isolated hairstyle open. As in the measured path,
    # a backing that follows the accepted rear image closes it after seating.
    backed_hair = (slot == 'hair' and fitting.get('hair_surface_fit') in ('cavity-reference-v3', 'cavity-reference-v4')
                   and bool((part.get('image_paths') or {}).get('back')))
    if runtime_policy:
        target = runtime_policy['part_triangles'].get(slot, 12000)
        grid = fitting.get('hair_backing_grid', [81, 97])
        reserve = 2*(grid[0]-1)*(grid[1]-1) if backed_hair else 0
        # A hair's surfaces stay apart: joined, one without UVs (a rear surface or a cap of an earlier pass) can leave
        # the strands without an active UV layer, so the cap took a flat grey, and the joined mesh loses its role.
        runtime_budget = optimize_part(meshes, slot, target_triangles=max(100, target-reserve),
            texture_max_edge=runtime_policy['texture_max_edge'], preserve_appearance=True, merge=slot not in HAIR_SLOTS)
        runtime_budget.update(target_triangles=target, backing_reserved_triangles=reserve, revision=runtime_policy['revision'])
    maximum = tolerances.get('max_surface_adjustment_m', .015)
    # A raised hood stands around the head: the top fills the head's and the torso's space together, or the whole of
    # it, hood and all, was shrunk into the torso and the hood sat on the chest.
    hood = slot == 'top' and raised_hood(part.get('description'), world_points(meshes))
    if slot == 'hat':
        target = targets[slot]
        seat = None
        if imported.get('hair'):
            target, seat = hat_target_over_hair(target, imported['hair'], spec)
        transform, _, measurement = fit_hat(meshes, target, fitting.get('hat_width_scale', 1))
        if seat:
            measurement['seat'] = seat
    elif slot in HAIR_SLOTS:
        transform, _, measurement = fit_hair(meshes, targets[slot], spec, slot, head_region(body, rig, spec)[:2])
    elif hood:
        # The bald head's hat seat: a hood is worn with any hair, which the wardrobe presses under it.
        transform, _, measurement = fit_reference_frame(
            meshes, head_torso_bounds(targets[slot], headwear_target(body, rig, spec)), slot)
        measurement['frame'] = 'head_and_torso_bounds'
    else:
        transform, _, measurement = fit_reference_frame(meshes, targets[slot], slot)
        measurement['frame'] = 'body_slot_bounds'
    place(meshes, transform)
    if slot == 'hat':
        # Still one uniform scale: enlarge only when the hat's inside sits inside the skull (a cap sized to the
        # head's width is too shallow for the deep SD head and its forehead shows through). Then, sized to the
        # head's width and hung from the crown, a generated beanie or cap is as tall as a real one and its front
        # comes down over the SD face's eyes: its height is taken in until the front clears the brows.
        measurement['cavity_fitting'] = fit_hat_cavity(meshes, body, rig, spec)
        measurement['brow_seat'] = seat_hat_above_brows(meshes, body, rig, spec)
    elif slot == 'hair':
        # Still one uniform scale: enlarge only when the inner surface sits inside the skull.
        measurement['cavity_fitting'] = fit_hair_cavity(meshes, body, rig, spec)
    if slot in HAIR_SLOTS:
        # The chosen length (short, long) moves the hanging strands below the scalp, as in the measured path.
        measurement['length_fitting'] = fit_hair_length(meshes, targets[slot], spec, head_region(body, rig, spec)[0].z)
        adjustment = fit_hair_scalp_bounded(meshes, body, rig, spec)
    else:
        adjustment = clearance(meshes, body, tolerances['clearance_m'], maximum)
        adjustment.update(maximum_allowed_m=maximum, bounded=True)
    # Room inside the hood for the hair worn under it, as for a worn hoodie.
    hood_room = lift_hood(meshes, body, rig, spec) if hood else None
    head_preparation = None
    if backed_hair:
        head_preparation = repair_hair_backing(meshes, body, rig, spec, part.get('image_paths'),
                                              shared_canvas=bool(part.get('reference_bounds_m')))
        head_preparation['source_image_sha256'] = part.get('image_sha256', {}).get('back')
        runtime_budget['backing_added_triangles'] = head_preparation.get('added_faces', 0)*2
    scalp_cap = add_scalp_cap(meshes, body, rig, spec) if slot == 'hair' else None
    kind, kind_check = ((part.get('fit_profile') or {}).get('kind') or part.get('garment_kind', 'source'), None)
    if slot == 'bottom':
        # A skirt whose saved contract says 'source' took each leg's skin weights and tore between the legs.
        kind, kind_check = mesh_bottom_kind(part, meshes, rig)
    skirt = slot == 'bottom' and kind == 'skirt'
    rigid = slot in ('hair', 'head', 'hairFront', 'hairBack', 'hat')
    report = (bind_skirt(meshes, body, rig, slot) if skirt else
              bind(meshes, body, rig, {'anchors': [], 'max_anchor_error_m': .0001,
                   'binding': 'rigid' if rigid else 'transfer', 'bone': 'Head', 'slot': slot,
                   'max_transfer_distance_m': None}, transform=Matrix.Identity(4)))
    if hood:
        report['hood_binding'] = bind_hood_head(meshes, rig, head_region(body, rig, spec)[2])
    if slot == 'top':
        # After the hood: the regions still keep the sleeves and the torso off the head.
        report['regional_weights'] = gate_top_weights(meshes, rig, head_region(body, rig, spec)[:2])
    report.update(measurement=measurement, runtime_budget=runtime_budget, clearance=adjustment,
                  fit_method='uniform-slot-v1')
    if hood_room is not None:
        report['hood_room'] = hood_room
    if head_preparation is not None:
        report['head_preparation'] = head_preparation
    if scalp_cap is not None:
        report['scalp_cap'] = scalp_cap
    if slot == 'bottom':
        report.update(garment_kind=kind, garment_kind_check=kind_check)
    a, b = bounds(meshes)
    report['fitted_bounds_gltf'] = [[a.x, a.z, -b.y], [b.x, b.z, -a.y]]
    names = []
    for i, obj in enumerate(meshes):
        obj.name = f'{slot}_{i}'; obj['part_role'] = slot; names.append(obj.name)
    return {'slot': slot, 'source_sha256': part['sha256'], 'objects': names,
            'anchors': [], 'available': True, **report}


def run(payload):
    output = Path(payload['output'])
    if sha(payload['source']) != payload['source_sha256']:
        raise ValueError('Body source changed')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    objects = load(payload['source']); rig = skeleton(objects)
    rig.data.pose_position = 'REST'; bpy.context.view_layer.update()
    body = body_meshes(objects, rig)
    spec = payload['production_spec']
    fitting = spec['fitting']
    reference_hair = fitting.get('hair_surface_fit') in ('cavity-reference-v3', 'cavity-reference-v4')
    runtime_policy = spec.get('runtime') or {}
    bounded_hair = reference_hair or fitting.get('hair_surface_fit') == 'scalp-frame-v2-bounded'
    uniform_parts = fitting.get('part_fit') == 'uniform-slot-v1'
    frozen = spec.get('frozen_body', False)
    source_preserved_body = spec.get('base_body', {}).get('source_preserved') is True
    normalization = {'preserved': True} if frozen else normalize_body(objects, body, fitting['bounds']['body'])
    head_binding = ({'preserved': True, 'reason': 'source_body'} if source_preserved_body
                    else {'preserved': True} if frozen else bind_body_head(body, rig, spec))
    body_profile = payload.get('body_profile') or spec.get('body_profile')
    if not body_profile:
        body_profile = measure_body_profile(body, rig, payload['source_sha256'])
    targets, shoe_targets = (deepcopy(fitting['bounds']), deepcopy(fitting['shoe_bounds'])) if frozen else body_targets(body, rig, spec)
    measured_head = head_region(body, rig, spec)[:2]
    # Frozen bodies still need their current measured head. Persisted envelopes
    # can belong to an older body and must not enlarge a short hairstyle.
    for slot in ('hair', 'hairFront', 'hairBack'):
        if slot in targets:
            targets[slot] = hair_target(body, rig, spec, slot)
    if frozen and 'hat' in targets:
        targets['hat'] = headwear_target(body, rig, spec)
    # Include the metric parent in every export so separately loaded parts and
    # the body retain the same scaled skeleton and animation coordinate frame.
    metric_frame = bpy.data.objects['FactoryMetricFrame']
    reports, fitted = deepcopy(payload.get('unavailable_parts', [])), []
    body_names = []
    for i, obj in enumerate(body):
        obj.name = f'body_{i}'; obj['part_role'] = 'body'; body_names.append(obj.name)
    imported, imported_additions, prefit_paths = {}, {}, {}
    rejected = {}
    for part in payload.get('prefit_parts', []):
        known_objects = set(bpy.data.objects.keys())
        try:
            meshes, report = load_prefit_part(part, rig, body_source=payload['source'])
        except Exception as exc:
            # A sealed slot that cannot be attached again is withdrawn alone; the other slots still assemble.
            object_mode()
            discard_objects([bpy.data.objects[name] for name in set(bpy.data.objects.keys()) - known_objects])
            reports.append(fit_failure(part, exc))
            continue
        imported[part['slot']] = meshes
        prefit_paths[part['slot']] = part['path']
        reports.append(report)
        fitted += meshes
    for part in payload['parts']:
        if part.get('part_method') == 'body_shell':
            continue
        if sha(part['path']) != part['sha256']:
            if part.get('uploaded_native_hair'):
                rejected[part['slot']] = ValueError('Uploaded native hair source changed')
                continue
            raise InputChanged('Part source changed')
        if part.get('uploaded_native_hair'):
            known_objects = set(bpy.data.objects.keys())
            try:
                if part.get('native_upload_error') or part['slot'] != 'hair':
                    raise ValueError('Uploaded native hair is not eligible')
                frozen_part = {**part, 'report': {'runtime_budget': part['native_hair_budget'],
                    'fit_method': 'uploaded-native-hair-v1', 'available': True,
                    'clearance': {'method': 'preserved_uploaded_source'}}}
                meshes, report = load_prefit_part(frozen_part, rig, body_source=payload['source'])
                # Where the hair sits on the body: the wardrobe crops its preview from the front render there.
                a, b = bounds(meshes)
                report['fitted_bounds_gltf'] = [[a.x, a.z, -b.y], [b.x, b.z, -a.y]]
                imported[part['slot']] = meshes
                prefit_paths[part['slot']] = part['path']
                reports.append(report)
                fitted += meshes
            except Exception:
                traceback.print_exc()
                discard_objects([bpy.data.objects[name] for name in set(bpy.data.objects.keys())-known_objects])
                rejected[part['slot']] = ValueError('Uploaded native hair could not be attached to the frozen body')
            continue
        for view, path in part.get('image_paths', {}).items():
            if sha(path) != part.get('image_sha256', {}).get(view):
                raise InputChanged('Part reference image changed')
        additions = load(part['path'])
        if part.get('front_axis') == '+x':
            # glTF +X arrives as Blender +X; the fitting code expects the front at Blender -Y.
            turn = Matrix.Rotation(-1.5707963267948966, 4, 'Z')
            for obj in additions:
                if obj.parent is None:
                    obj.matrix_world = turn @ obj.matrix_world
            bpy.context.view_layer.update()
        meshes = [o for o in additions if o.type == 'MESH']
        if not meshes or any(o.type == 'ARMATURE' for o in additions):
            discard_objects(additions)
            rejected[part['slot']] = ValueError('Expected an unrigged generated part')
            continue
        imported[part['slot']] = meshes
        imported_additions[part['slot']] = additions
    hat_palette = headwear_palette(imported.get('hat', []))
    shell_coverage = {}
    # Headwear uses the already fitted hairstyle even if the request listed the hat first.
    for part in sorted(payload['parts'], key=lambda part: part['slot'] == 'hat'):
        slot = part['slot']
        if slot in rejected:
            reports.append(fit_failure(part, rejected[slot]))
            continue
        if slot in prefit_paths:
            continue
        known_objects = set(bpy.data.objects.keys())
        try:
            method = part.get('part_method', 'isolated')
            if method == 'body_shell':
                meshes, report, covered = build_body_shell_part(part, body, rig, spec)
                shell_coverage[slot] = covered
                imported[slot] = meshes
                names = []
                for i, obj in enumerate(meshes):
                    obj.name = f'{slot}_{i}'; obj['part_role'] = slot; names.append(obj.name)
                a, b = bounds(meshes)
                report['fitted_bounds_gltf'] = [[a.x, a.z, -b.y], [b.x, b.z, -a.y]]
                reports.append({'slot': slot, 'source_sha256': part['sha256'], 'objects': names, 'anchors': [], **report})
                fitted += meshes
                continue
            meshes = imported[slot]
            if method == 'worn':
                meshes, report = extract_worn_meshes(part, meshes, body, rig, spec)
                imported[slot] = meshes
                names = []
                for i, obj in enumerate(meshes):
                    obj.name = f'{slot}_{i}'; obj['part_role'] = slot; names.append(obj.name)
                a, b = bounds(meshes)
                report['fitted_bounds_gltf'] = [[a.x, a.z, -b.y], [b.x, b.z, -a.y]]
                reports.append({'slot': slot, 'source_sha256': part['sha256'], 'objects': names, 'anchors': [], **report})
                fitted += meshes
                continue
            profiled = part.get('fit_profile') is not None
            if uniform_parts and slot not in EQUIPMENT and slot != 'shoes':
                reports.append(fit_uniform_part(part, meshes, body, rig, spec, targets, imported))
                fitted += meshes
                continue
            garment_report, garment_masks = None, None
            runtime_budget = None
            if runtime_policy:
                # Provider detail controls the immutable source, not the wearable.
                # Reduce before fitting/BVH/weight transfer, retaining source UVs.
                target = runtime_policy['part_triangles'].get(slot, 12000)
                grid = fitting.get('hair_backing_grid', [81, 97])
                reserve = 2*(grid[0]-1)*(grid[1]-1) if slot == 'hair' and reference_hair and part.get('image_paths', {}).get('back') else 0
                runtime_budget = optimize_part(meshes, slot, target_triangles=max(100, target-reserve),
                    texture_max_edge=runtime_policy['texture_max_edge'], preserve_appearance=True,
                    merge=not profiled and slot not in HAIR_SLOTS)
                runtime_budget.update(target_triangles=target, backing_reserved_triangles=reserve,
                                      revision=runtime_policy['revision'])
            if profiled:
                if runtime_budget is None:
                    runtime_budget = {'preserved': True, 'source_mesh_detail': True,
                                      'source_uv': True, 'optimization': 'skipped_for_profiled_garment'}
                supplied_source = part['fit_profile'].get('source_sha256')
                if supplied_source and supplied_source != part['sha256']:
                    garment_report = {'fit_profile': part['fit_profile'], 'fit_status': 'failed',
                                      'errors': [{'code': 'source_sha256_mismatch',
                                                  'message': 'Fit profile belongs to a different source mesh'}],
                                      'source_landmarks': {}, 'target_landmarks': {}, 'coverage': None}
                    garment_masks = {obj: {} for obj in meshes}
                else:
                    garment_report, garment_masks = fit_profiled_garment(
                        meshes, body, rig, slot, part['fit_profile'], body_profile=body_profile,
                        image_paths=part.get('image_paths'), canvas=spec.get('canvas'))
                if garment_report['fit_status'] != 'fitted' and part.get('fallback_path'):
                    for obj in imported_additions.get(slot, []):
                        if obj.name in bpy.data.objects:
                            bpy.data.objects.remove(obj, do_unlink=True)
                    fallback_path = part['fallback_path']
                    fallback = {'slot': slot, 'path': fallback_path,
                                'sha256': part.get('fallback_sha256') or sha(fallback_path),
                                'report': part.get('fallback_report') or {}}
                    meshes, fallback_report = load_prefit_part(fallback, rig)
                    fallback_report['fit_status'] = 'fallback_preserved'
                    fallback_report['attempted_fit'] = garment_report
                    fallback_report['available'] = True
                    imported[slot] = meshes
                    prefit_paths[slot] = fallback_path
                    reports.append(fallback_report); fitted += meshes
                    continue
                if garment_report['fit_status'] != 'fitted':
                    # Preserve the generated source artifact outside this worker, but
                    # never bind or export an ambiguously placed raw mesh as wearable.
                    for obj in imported_additions.get(slot, []):
                        if obj.name in bpy.data.objects:
                            bpy.data.objects.remove(obj, do_unlink=True)
                    imported[slot] = []
                    reports.append({'slot': slot, 'source_sha256': part['sha256'],
                        'objects': [], 'anchors': [], 'available': False,
                        'unavailable_reason': 'garment_fit_incomplete',
                        'measurement': garment_report, 'runtime_budget': runtime_budget,
                        'clearance': {'method': 'not_applied'}, **garment_report})
                    continue
                transform, anchors, measurement = Matrix.Identity(4), [], garment_report
            elif runtime_budget is None:
                runtime_budget = ({'preserved': True, 'source_mesh_detail': True, 'source_uv': True,
                                   'optimization': 'skipped_for_accepted_meshy_options'}
                                  if part.get('preserve_generated_detail') else optimize_part(meshes, slot))
            if not profiled and slot in EQUIPMENT:
                transform, anchors, measurement = fit_equipment(meshes, spec['equipment'][slot])
            elif not profiled and slot == 'shoes':
                skin = foot_skin(body)
                measurement, shoe_regions = fit_shoes_rigid(meshes, shoe_targets, feet=foot_bounds(skin))
                # A pair that leaves either foot bare (a provider's broken model) is reported, not offered.
                measurement['foot_coverage'] = shoe_coverage(meshes, shoe_regions, skin)
                check_shoe_coverage(measurement['foot_coverage'])
                transform, anchors = Matrix.Identity(4), []
            elif not profiled and slot == 'hat':
                headwear_seat = None
                if imported.get('hair'):
                    targets[slot], headwear_seat = hat_target_over_hair(targets[slot], imported['hair'], spec)
                transform, anchors, measurement = fit_hat(meshes, targets[slot], fitting.get('hat_width_scale', 1),
                                                           part.get('reference_bounds_m') if bounded_hair else None)
                if headwear_seat:
                    measurement['seat'] = headwear_seat
            elif not profiled and slot in ('hair', 'hairFront', 'hairBack'):
                transform, anchors, measurement = fit_hair(meshes, targets[slot], spec, slot, measured_head,
                                                           part.get('reference_bounds_m'))
            elif not profiled:
                transform, anchors, measurement = measured_fit(meshes, targets[slot])
            skirt = slot == 'bottom' and (part.get('fit_profile') or {}).get('kind', part.get('garment_kind')) == 'skirt'
            rigid = slot in ('hair', 'head', 'hairBack', 'hairFront', 'hat', *EQUIPMENT)
            bone = EQUIPMENT.get(slot, 'Head')
            contract = {'anchors': anchors, 'max_anchor_error_m': .0001,
                        'binding': 'rigid' if rigid else 'transfer', 'bone': bone,
                        'slot': slot, 'max_transfer_distance_m': None}
            if not profiled:
                place(meshes, transform)
            if slot == 'hair' and reference_hair:
                measurement['cavity_fitting'] = fit_hair_cavity(meshes, body, rig, spec)
            if slot in ('hair', 'hairFront', 'hairBack'):
                measurement['length_fitting'] = fit_hair_length(meshes, targets[slot], spec, measured_head[0].z)
            if slot == 'top' and not profiled:
                measurement['sleeves'], sleeve_masks = fit_sleeves(meshes, rig, spec)
            # Preserve fitted strands. Derive a separate rear surface only from an
            # accepted rear image and the measured skull after clearance.
            head_preparation = (prepare_rear_hair(meshes, body, hat_palette, spec)
                                if slot == 'hairBack' and not bounded_hair else None)
            if slot == 'shoes':
                adjustment = {'method': 'rigid_foot_fit_no_surface_projection',
                              'adjusted_vertices': 0, 'maximum_adjustment_m': 0.0}
            elif slot in EQUIPMENT:
                adjustment = {'method': 'rigid_socket', 'adjusted_vertices': 0, 'maximum_adjustment_m': 0.0}
            elif profiled:
                adjustment = {'method': 'profiled_regional_fit_no_surface_projection',
                              'adjusted_vertices': sum(len(row) for row in garment_masks.values()),
                              'maximum_adjustment_m': None}
            elif slot in fitting.get('garment_margin_m', {}):
                # Keep the generated garment's volume and folds. Vertex projection
                # onto the body turns loose sleeves and hems into a skin-tight shell.
                adjustment = {'method': 'loose_fit_no_surface_projection',
                              'body_margin_xz_m': fitting['garment_margin_m'][slot],
                              'adjusted_vertices': 0, 'maximum_adjustment_m': 0.0}
            elif slot in ('hair', 'hairFront', 'hairBack') and bounded_hair:
                adjustment = fit_hair_scalp_bounded(meshes, body, rig, spec)
            elif slot in ('hair', 'hairFront', 'hairBack') and fitting.get('hair_surface_fit') == 'measured-skull-v1':
                adjustment = fit_hair_scalp(meshes, body, rig, spec)
            elif slot in ('hair', 'head', 'hairFront', 'hairBack'):
                maximum = max(fitting.get('hair_clearance_m', .025),
                              spec['tolerances'].get('max_surface_adjustment_m', .015))
                adjustments = [clearance([obj], body, fitting.get('scalp_clearance_m', .003) if obj.get('scalp_backing')
                                        else fitting.get('hair_clearance_m', .025), maximum) for obj in meshes]
                adjustment = {'adjusted_vertices': sum(a['adjusted_vertices'] for a in adjustments),
                              'maximum_adjustment_m': max(a['maximum_adjustment_m'] for a in adjustments),
                              'maximum_allowed_m': maximum,
                              'bounded': True}
            else:
                adjustment = clearance(meshes, body, spec['tolerances']['clearance_m'],
                    spec['tolerances']['max_surface_adjustment_m'] if slot == 'hat' else None)
            if slot in ('hairBack', 'hairFront') and 'hat' in imported and not bounded_hair:
                seat_legacy_hair_roots(meshes, body, spec)
            if slot == 'hair' and reference_hair:
                head_preparation = repair_hair_backing(meshes, body, rig, spec, part.get('image_paths'),
                                                      shared_canvas=bool(part.get('reference_bounds_m')))
                head_preparation['source_image_sha256'] = part.get('image_sha256', {}).get('back')
                runtime_budget['backing_added_triangles'] = head_preparation.get('added_faces', 0)*2
            scalp_cap = add_scalp_cap(meshes, body, rig, spec) if slot == 'hair' else None
            kind_check = None
            if slot == 'bottom' and not profiled:
                # Measured where it is worn: a bottom no saved contract names is told apart by the fabric between
                # the legs.
                bottom_kind, kind_check = mesh_bottom_kind(part, meshes, rig)
                skirt = bottom_kind == 'skirt'
            # Transfer weights only after the final garment size has been applied.
            report = (bind_shoes_rigid(meshes, rig, shoe_regions) if slot == 'shoes'
                      else bind_skirt(meshes, body, rig, slot) if skirt and not profiled
                      else bind(meshes, body, rig, contract, transform=Matrix.Identity(4)))
            if profiled:
                report['regional_binding'] = bind_garment_regions(meshes, rig, slot, garment_masks)
                report['weights'] = 'profiled_anatomical_regions'
            elif slot == 'top':
                bind_top_regions(meshes, rig, sleeve_masks)
                report['weights'] = 'anatomical_sleeves_and_torso'
            report['measurement'] = measurement
            if profiled:
                report.update(garment_report)
            if slot == 'bottom':
                report['garment_kind'] = (garment_report.get('resolved_kind', part['fit_profile'].get('kind')) if profiled
                                          else bottom_kind)
                if kind_check is not None:
                    report['garment_kind_check'] = kind_check
            report['runtime_budget'] = runtime_budget
            report['clearance'] = adjustment
            if head_preparation is not None:
                report['head_preparation'] = head_preparation
            if scalp_cap is not None:
                report['scalp_cap'] = scalp_cap
            a, b = bounds(meshes)
            report['fitted_bounds_gltf'] = [[a.x, a.z, -b.y], [b.x, b.z, -a.y]]
            names = []
            for i, obj in enumerate(meshes):
                obj.name = f'{slot}_{i}'; obj['part_role'] = slot; names.append(obj.name)
            reports.append({'slot': slot, 'source_sha256': part['sha256'], 'objects': names,
                            'anchors': anchors, 'available': True, **report})
            fitted += meshes
        except InputChanged:
            raise
        except Exception as exc:
            # One part that cannot be fitted must not take the others down with it: it is reported as not offered.
            object_mode()
            strays = [bpy.data.objects[name] for name in set(bpy.data.objects.keys()) - known_objects]
            discard_objects([*imported_additions.get(slot, []), *imported.get(slot, []), *strays])
            imported[slot] = []
            shell_coverage.pop(slot, None)
            reports.append(fit_failure(part, exc))
    # Hair and hat retain independent meshes, files and equip slots. A complete
    # hairstyle comes from its own generation job, never from joining headwear.
    # Keep the original skin as the weight-transfer source, then slim the core
    # for display. This leaves all skeleton transforms and transferred weights intact.
    base_shape = ({'preserved': True, 'reason': 'source_body'} if source_preserved_body
                  else {'preserved': True} if frozen else slim_base_body(body, rig, spec))
    base_shape['head_binding'] = head_binding
    base_shape['appearance'] = ({'preserved': True, 'reason': 'source_body'} if source_preserved_body
                                else {'preserved': True} if frozen else whiten_base_body(body, spec))
    body_budget = ({'preserved': True, 'source_mesh_detail': True} if source_preserved_body
                   else {'preserved': True} if frozen and not payload.get('canonical_pose')
                   else optimize_part(body, 'body'))
    rest_pose = ({'preserved': True} if frozen and not payload.get('canonical_pose')
                 else t_rest_pose(rig, [*body, *fitted]))
    if frozen and payload.get('canonical_pose'):
        rest_pose['derived_from_sha256'] = payload['source_sha256']
    # Persist measurements from the exported body state. Fitting may consume a
    # previously sealed profile above, but registration must describe the final
    # uniform-normalized, canonical-rest derivative.
    body_profile = measure_body_profile(body, rig, payload['source_sha256'])
    expression_uv = ({'available': False, 'preserved': True, 'reason': 'uploaded_face_texture'}
                     if spec.get('base_body', {}).get('preserve_face_texture') else prepare_expression_uv(body))
    # Sealed prefit slots stay byte-identical; equipment keeps its own finish.
    finish = matte_materials([*body, *[obj for obj in fitted
                                       if obj['part_role'] not in (*EQUIPMENT, *prefit_paths)]])
    selected_slots = {part['slot'] for part in payload['parts']}
    shoes = [obj for obj in fitted if obj['part_role'] == 'shoes'] if 'shoes' in selected_slots else []
    if shoes:
        shoe_report = next(report for report in reports if report['slot'] == 'shoes')
        try:
            shoe_report['final_pose_fitting'] = finish_shoes_after_pose(shoes, rig)
            a, b = bounds(shoes)
            shoe_report['fitted_bounds_gltf'] = [[a.x, a.z, -b.y], [b.x, b.z, -a.y]]
        except Exception as exc:
            withdraw('shoes', shoe_report, exc, 'post_fit_exception', fitted, prefit_paths=prefit_paths)
    garment_meshes = {part['slot']: [obj for obj in fitted if obj['part_role'] == part['slot']]
                     for part in reports if part.get('fit_status') not in ('needs_anchors', 'failed')
                     and part['slot'] not in shell_coverage}
    coverage_profiles = {report['slot']: report.get('coverage') for report in reports
                         if report.get('coverage')}

    def drop(slot, exc, code, report=None):
        """Withdraw an offered slot from the scene, the body cut, the layering and the exported files."""
        if report is None:
            report = next(report for report in reports if report['slot'] == slot and report.get('available', True))
        withdraw(slot, report, exc, code, fitted, prefit_paths=prefit_paths)
        shell_coverage.pop(slot, None)
        garment_meshes.pop(slot, None)
        coverage_profiles.pop(slot, None)
        (output/f'{slot}.glb').unlink(missing_ok=True)
    for slot in [slot for slot in ('top', 'bottom', 'shoes') if garment_meshes.get(slot)]:
        try:
            check_crop_region(slot, garment_meshes[slot], rig, spec, coverage_profiles)
        except Exception as exc:
            drop(slot, exc, 'body_crop_failed')
    for slot, covered in list(shell_coverage.items()):
        try:
            mark_shell_coverage(body, slot, covered)
        except Exception as exc:
            drop(slot, exc, 'body_crop_failed')
    parts = [{'slot': 'body', 'objects': body_names, 'runtime_budget': body_budget}, *reports]
    # What is offered is settled before anything is drawn, so every render below shows the exported model. A slot the
    # body cut, the layering or the export check fails on is withdrawn alone; the body is cut and pressed again for the
    # slots left and exported again with the composed model. A failure no one slot accounts for ends the assembly, as
    # does a body exported without its skin.
    rig.data.pose_position = 'POSE'
    exported = False
    while True:
        try:
            covered_materials, coverage, crop_lines = mark_body_coverage(
                body, garment_meshes, rig, spec, coverage_profiles, shell_slots=tuple(shell_coverage))
        except Exception:
            failures = coverage_failures(body, garment_meshes, rig, spec, coverage_profiles, tuple(shell_coverage))
            if not failures:
                raise
            for slot, exc in failures.items():
                drop(slot, exc, 'body_crop_failed')
            continue
        try:
            press_bottom, release_bottom = pressed_under(fitted, body, rig)
        except SlotFailure as failure:
            drop(failure.slot, failure.error, 'layer_press_failed')
            continue
        if exported:
            export(output/'body.glb', [metric_frame, rig, *body])
        export(output/'model.glb', [metric_frame, rig, *body, *fitted])
        strip_covered_primitives(output/'model.glb')
        if not exported:
            export_roles = [('body', body), *[(p['slot'], [o for o in fitted if o['part_role'] == p['slot']])
                                              for p in reports if p.get('available', True)]]
            for role, meshes in export_roles:
                if role in prefit_paths:
                    # Preserve the sealed fitted slot byte-for-byte. The composed model
                    # above uses the same geometry/UV/weights attached to the same rig.
                    shutil.copyfile(prefit_paths[role], output/f'{role}.glb')
                else:
                    export(output/f'{role}.glb', [metric_frame, rig, *meshes])
            exported = True
            # The seal's quality gate measures the files as members would wear them; a slot it refuses is withdrawn
            # with the gate's code, and the body and the composed model are exported again without it.
            refused = gate_fitted(output, reports, prefit_paths)
            if refused:
                for slot, refusal in refused:
                    drop(slot, refusal, refusal.code)
                continue
        # Every offered slot is skinned in the composed model.
        doc, _ = parse_glb((output/'model.glb').read_bytes(), strict=True)
        broken = []
        for part in parts:
            if not part.get('available', True):
                part['nodes'] = []
                continue
            try:
                seal_part(output, doc, part)
            except Exception as exc:
                if part['slot'] == 'body':
                    raise
                broken.append((part, exc))
        if not broken:
            break
        for part, exc in broken:
            drop(part['slot'], exc, 'export_check_failed', part)
    # The stills show the rest pose; the exports above and the motion render below use the pose.
    rig.data.pose_position = 'REST'; bpy.context.view_layer.update()
    hidden = hide_covered_materials(covered_materials)
    press_bottom()
    camera, view_center = camera_setup(spec['body_height_m'])
    # How the product renders frame the body: the wardrobe crops part previews from the front render with it.
    render_frame = {'ortho_scale_m': float(camera.data.ortho_scale),
                    'center_gltf_m': [float(value) for value in blender_to_gltf(view_center)]}
    soft_lighting(bpy.context.scene)
    directions = [('front', (0, -1, 0)), ('side', (1, 0, 0)), ('back', (0, 1, 0)), ('opposite', (-1, 0, 0))]
    # Product screens show the front; the other views are receipts: smaller and not denoised.
    for view, direction in directions:
        bpy.context.scene.cycles.use_denoising = view == 'front'
        render(output/f'{view}.png', camera, view_center, direction, 800 if view == 'front' else 512)
    bpy.context.scene.cycles.use_denoising = True
    detail_files = []
    visibility = {obj: obj.hide_render for obj in fitted}
    if os.getenv('ASSET_DETAIL_RENDERS') == '1':
        # Optional inspection views of the head parts and outfit from all four sides.
        original_scale = camera.data.ortho_scale
        detail_center = Vector((0, 0, spec['body_height_m']*.74))
        camera.data.ortho_scale = spec['body_height_m']*1.05
        collar_height = next((line['point_m'][1] for line in crop_lines if line['name'] == 'collar'), spec['anchors']['neck'][1])
        preview_body = head_preview_body(body, collar_height)
        for obj in body:
            obj.hide_render = True
        for group, slots in (('head', ('hair', 'head', 'hairFront', 'hairBack', 'hat')),
                             ('hair', ('hair', 'hairFront', 'hairBack')), ('hat', ('hat',))):
            if not any(obj['part_role'] in slots for obj in fitted):
                continue
            for obj in fitted:
                obj.hide_render = obj['part_role'] not in slots
            for view, direction in directions:
                name = f'{group}-{view}.png'
                render(output/name, camera, detail_center, direction, 600)
                detail_files.append(name)
        for obj, hidden_before in visibility.items():
            obj.hide_render = hidden_before
        for obj in preview_body:
            bpy.data.objects.remove(obj, do_unlink=True)
        for obj in body:
            obj.hide_render = False
        camera.data.ortho_scale = original_scale
        for obj in fitted:
            obj.hide_render = obj['part_role'] not in ('top', 'bottom', 'shoes', *EQUIPMENT)
        for view, direction in directions:
            name = f'wardrobe-{view}.png'
            render(output/name, camera, view_center, direction, 600)
            detail_files.append(name)
    restore_covered_materials(hidden)
    for obj in fitted:
        obj.hide_render = True
    # The base-body portrait is the only extra view the product screens show.
    for view, direction in (directions if os.getenv('ASSET_DETAIL_RENDERS') == '1' else directions[:1]):
        name = f'body-{view}.png'
        render(output/name, camera, view_center, direction, 600)
        detail_files.append(name)
    for obj, hidden_before in visibility.items():
        obj.hide_render = hidden_before
    release_bottom()
    rig.data.pose_position = 'POSE'
    animation = rig.animation_data
    motion = None
    for track in animation.nla_tracks if animation else []:
        track.mute = True
        for strip in track.strips:
            if strip.action and (motion is None or 'walk' in strip.action.name.lower()):
                motion = (strip.action, strip.action_slot)
    if motion:
        animation.action, animation.action_slot = motion
        start, end = motion[0].frame_range
        bpy.context.scene.frame_set(round(start+(end-start)*.25))
    else:
        bpy.context.scene.frame_set(0)
    bpy.context.view_layer.update()
    hide_covered_materials(covered_materials)
    bpy.context.scene.cycles.use_denoising = False
    press_bottom()
    render(output/'motion.png', camera, view_center, (0, -1, 0), 512)
    release_bottom()
    saved_blend = os.getenv('ASSET_SAVE_MASTER_BLEND') == '1'
    if saved_blend:
        bpy.ops.wm.save_as_mainfile(filepath=str(output/'master.blend'))
    incomplete_parts = []
    for part in reports:
        # A preserved fallback reports the fit it could not make; any other receipt reports itself.
        attempted = part.get('attempted_fit') if part.get('fit_status') == 'fallback_preserved' else part
        attempted = attempted or part
        if attempted.get('fit_status') in ('needs_anchors', 'failed'):
            incomplete_parts.append({'slot': part['slot'], 'status': attempted['fit_status'],
                'errors': attempted.get('errors', []),
                'fallback_preserved': part.get('fit_status') == 'fallback_preserved',
                'available': part.get('available', True)})
    result = {'parts': parts, 'bone_count': len(rig.data.bones),
              'production_spec_sha256': spec['sha256'], 'normalization': normalization,
              'fitting_revision': fitting['revision'], 'fitting_targets': targets,
              'render_frame': render_frame,
              'body_coverage_faces': coverage,
              'body_crop_lines': crop_lines,
              'body_profile': body_profile,
              'fit_status': 'incomplete' if incomplete_parts else 'complete',
              'incomplete_parts': incomplete_parts,
              'base_body_shape': base_shape,
              'rest_pose': rest_pose,
              'expression_uv': expression_uv,
              'material_finish': finish,
              'source_sha256': payload['source_sha256'],
              'visual_review': 'required', 'origin': 'generated_parts_fitted_to_meshy_body',
              'limitations': ['Measured fitting and surface weight transfer require visual review.',
                              'Independently generated parts are not a segmentation of the original image or mesh.']}
    files = (['model.glb', *(['master.blend'] if saved_blend else []), 'front.png', 'side.png', 'back.png', 'opposite.png', 'motion.png']
             + [f'{p["slot"]}.glb' for p in parts if p.get('available', True)] + detail_files)
    if payload.get('contract', {}).get('pipeline_quality_revision') == QUALITY_REVISION:
        groups = {part['slot']: [obj for obj in fitted if obj['part_role'] == part['slot']]
                  for part in reports if part.get('available', True)}
        measured = measure_assembly(body, rig, groups)
        quality, delivery_files = seal_quality(output, files, parts, spec, measured)
        result.update(quality=quality, delivery=quality['delivery'])
        files += delivery_files
    (output/'complete.json').write_text(json.dumps({'input_sha256': sha(output/'input.json'),
        'files': {name: sha(output/name) for name in files}, 'result': result}), encoding='utf8')


if __name__ == '__main__':
    run(json.loads(Path(sys.argv[sys.argv.index('--')+1]).read_text(encoding='utf8')))
