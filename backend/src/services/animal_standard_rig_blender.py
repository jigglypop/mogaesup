"""Standard chibi-dog rig for a static animal GLB: centreline-fitted skeleton, region-limited bone-heat
weights and seven in-place clips (walk, run, idle, bark, sit, lie, jump) solved with two-bone leg IK.

Blender axes after glTF import: +X = the dog's left, -Y = front, +Z = up.
Input: a JSON file with `source` (GLB), `output` (directory) and `attempt` (the caller's nonce).
Output: motions-standard.glb, then standard.json (landmarks, paw ground contact and stretch per region
for the walk) as the completion seal: it repeats the attempt and the digests of the source and the GLB.
A shape the rig cannot fit writes error.json with a fixed code instead; the caller words the message.
"""
import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector, kdtree

args = json.loads(Path(sys.argv[sys.argv.index('--') + 1]).read_text(encoding='utf8'))
out = Path(args['output'])
out.mkdir(parents=True, exist_ok=True)


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def fail(code, **detail):
    """Stop with a fixed failure code the caller can report; never a path or a traceback."""
    (out / 'error.json').write_text(json.dumps({'attempt': args.get('attempt'), 'code': code, **detail}), encoding='utf8')
    raise RuntimeError(code)


source_sha256 = sha256(args['source'])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=args['source'])
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and len(o.data.vertices)]
if not meshes:
    fail('mesh_missing')
bpy.ops.object.select_all(action='DESELECT')
for obj in meshes:
    world = obj.matrix_world.copy(); obj.parent = None; obj.matrix_world = world
    obj.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
if len(meshes) > 1:
    bpy.ops.object.join()
mesh = bpy.context.view_layer.objects.active
for obj in list(bpy.context.scene.objects):
    if obj is not mesh:
        bpy.data.objects.remove(obj, do_unlink=True)

n = len(mesh.data.vertices)
co = np.empty(n * 3); mesh.data.vertices.foreach_get('co', co); co = co.reshape(n, 3)
lo, hi = co.min(0), co.max(0)
H, W, L = hi[2] - lo[2], hi[0] - lo[0], hi[1] - lo[1]
if min(H, W, L) < 1e-5:
    fail('mesh_degenerate')
cx = (lo[0] + hi[0]) / 2

# 1. Paws: k-means (k=4) on the lowest 8 % of vertices, seeded by quadrants.
low = co[co[:, 2] < lo[2] + .08 * H][:, :2]
if len(low) < 4:
    fail('paws_not_found')
ymed = np.median(low[:, 1])
seeds = []
for left in (True, False):
    for front in (True, False):
        quadrant = low[((low[:, 0] > cx) == left) & ((low[:, 1] < ymed) == front)]
        if not len(quadrant):
            fail('paws_not_found')
        seeds.append(quadrant.mean(0))
centers = np.array(seeds)
for _ in range(15):
    label = np.argmin(((low[:, None, :] - centers[None]) ** 2).sum(-1), 1)
    centers = np.array([low[label == k].mean(0) if (label == k).any() else centers[k] for k in range(4)])
if any(not (label == k).any() for k in range(4)):
    fail('paws_not_found')
order = sorted(range(4), key=lambda k: centers[k][1])  # smaller y = front
names = {}
for rank, k in enumerate(order):
    names[k] = ('fore' if rank < 2 else 'hind') + ('_L' if centers[k][0] > cx else '_R')
if sorted(names.values()) != ['fore_L', 'fore_R', 'hind_L', 'hind_R']:
    fail('paws_not_found')
foot = {names[k]: centers[k] for k in range(4)}
foot_front = {}
for k in range(4):
    pts = low[label == k]
    foot_front[names[k]] = pts[:, 1].min()
fore_y = (foot['fore_L'][1] + foot['fore_R'][1]) / 2
hind_y = (foot['hind_L'][1] + foot['hind_R'][1]) / 2
mid_y = (fore_y + hind_y) / 2
xy = co[:, :2]
foot_xy = np.array([foot[k] for k in ('fore_L', 'fore_R', 'hind_L', 'hind_R')])
cell = np.argmin(((xy[:, None, :] - foot_xy[None]) ** 2).sum(-1), 1)  # Voronoi cell of each vertex
cell_radius = {key: .5 * min(np.linalg.norm(foot[key] - foot[o]) for o in foot if o != key) for key in foot}

# 2. Leg columns: slice every 1 % of the height; the leg ends where its slice widens into the body
#    or reaches the midline (the two legs merge).
legs = {}
for index, key in enumerate(('fore_L', 'fore_R', 'hind_L', 'hind_R')):
    samples = []
    for step in range(2, 50):
        z = lo[2] + step * .01 * H
        sel = (np.abs(co[:, 2] - z) < .006 * H) & (cell == index) & (np.linalg.norm(xy - foot[key], axis=1) < 1.3 * cell_radius[key])
        if sel.sum() < 6:
            break
        c = xy[sel].mean(0)
        r = np.linalg.norm(xy[sel] - c, axis=1).mean()
        merged = (np.abs(co[sel, 0] - cx) < .04 * W).any()
        samples.append((z, c, r, merged))
    # A leg needs three slices (paw, ankle, knee) before it may merge into the body.
    if len(samples) < 3:
        fail('leg_not_found', leg=key)
    base_r = np.median([s[2] for s in samples[:max(3, len(samples) // 3)]])
    top = len(samples) - 1
    for i, (z, c, r, merged) in enumerate(samples[3:], start=3):
        if r > 1.6 * base_r or merged:
            top = i - 1
            break
    top = max(top, 2)
    legs[key] = {'z_top': samples[top][0], 'samples': samples[:top + 1], 'radius': base_r}


def centroid_at(key, z):
    samples = legs[key]['samples']
    best = min(samples, key=lambda s: abs(s[0] - z))
    return best[1]


# 3. Torso. The chibi head sits straight on the chest, so there is no neck to find; the body's own
#    back shows only at mid-length, behind the head and in front of the tail. Along the midline there,
#    the belly surface comes first; after the first empty gap above it comes the back surface.
fore_top = max(legs['fore_L']['z_top'], legs['fore_R']['z_top'])
hind_top = max(legs['hind_L']['z_top'], legs['hind_R']['z_top'])
leg_top = (fore_top + hind_top) / 2
backs = []
for offset in np.arange(-.15, .151, .03):
    y = mid_y + offset * L
    sel = (np.abs(co[:, 1] - y) < .02 * L) & (np.abs(co[:, 0] - cx) < .12 * W) & (co[:, 2] > leg_top - .02 * H)
    z = np.sort(co[sel, 2])
    gaps = np.nonzero(np.diff(z) > .04 * H)[0]
    if len(gaps):
        backs.append(z[gaps[0] + 1])
# Where the hood covers the midline the gap lands on the hood, so the lowest back found wins.
backs = [b for b in backs if b > leg_top + .12 * H]
back = min(float(min(backs)) if backs else leg_top + .25 * H, lo[2] + .6 * H)
torso_c = (leg_top + back) / 2
torso_top = back
hip = Vector((cx, hind_y, torso_c))
shoulder = Vector((cx, fore_y, torso_c))
joints = {}
for key in legs:
    c = centroid_at(key, legs[key]['z_top'])
    z_top = legs[key]['z_top']
    joints[key] = Vector((c[0] + .3 * (cx - c[0]), c[1], z_top + .6 * (torso_c - z_top)))
hind_bottom = hind_top

# 4. Head: above the torso top in the front half, and the hood that overhangs the back.
neck_z = torso_top
neck = Vector((cx, fore_y, neck_z))
head_mask = ((co[:, 2] > neck_z) & (co[:, 1] < mid_y)) | ((co[:, 2] > torso_top + .1 * H) & (co[:, 1] < hind_y))
if head_mask.sum() < 4:
    fail('head_not_found')
head_c = Vector(co[head_mask].mean(0))
head_c.x = cx
head_r = np.median(np.linalg.norm(co[head_mask] - np.array(head_c), axis=1))

# 5. Ears: the farthest head vertex on each side; kept only when it clearly sticks out.
ears = {}
for side, sign in (('L', 1), ('R', -1)):
    side_mask = head_mask & ((co[:, 0] - cx) * sign > .1 * W)
    if not side_mask.any():
        continue
    d = np.linalg.norm(co[side_mask] - np.array(head_c), axis=1)
    tip = co[side_mask][d.argmax()]
    if d.max() > 1.3 * head_r:
        direction = (Vector(tip) - head_c).normalized()
        ears[side] = (head_c + direction * head_r * .9, Vector(tip))

# 6. Tail: vertices behind the hind legs above the torso's lower edge, split into three segments.
tail_mask = (co[:, 1] > hind_y + .06 * L) & (co[:, 2] > hind_bottom) & ~head_mask
tail = None
if tail_mask.sum() > 40:
    tail_pts = co[tail_mask]
    d = np.linalg.norm(tail_pts - np.array(hip), axis=1)
    base = Vector(tail_pts[d.argmin()])
    base = base.lerp(hip, .3)
    edges = np.quantile(d, [0, .33, .66, 1])
    points = [base] + [Vector(tail_pts[(d >= edges[i]) & (d <= edges[i + 1])].mean(0)) for i in range(1, 3)]
    points.append(Vector(tail_pts[d.argmax()]))
    tail = points

# 7. Skeleton.
arm_data = bpy.data.armatures.new('ChibiDog')
rig = bpy.data.objects.new('ChibiDog', arm_data)
bpy.context.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='EDIT')


def bone(name, head, tail_point, parent=None, deform=True, connect=False):
    b = arm_data.edit_bones.new(name)
    b.head, b.tail = Vector(head), Vector(tail_point)
    b.use_deform = deform
    if parent:
        b.parent = arm_data.edit_bones[parent]
        b.use_connect = connect
    return b


spine_mid = hip.lerp(shoulder, .5)
bone('root', (cx, mid_y, lo[2]), (cx, mid_y + .15 * L, lo[2]), deform=False)
bone('pelvis', hip + Vector((0, .05 * L, 0)), hip, 'root')
bone('spine_1', hip, spine_mid, 'pelvis', connect=True)
bone('spine_2', spine_mid, shoulder, 'spine_1', connect=True)
bone('chest', shoulder, shoulder.lerp(neck, .5), 'spine_2', connect=True)
bone('neck', shoulder.lerp(neck, .5), neck, 'chest', connect=True)
bone('head', neck, Vector((cx, head_c.y, head_c.z + .6 * (hi[2] - head_c.z))), 'neck', connect=True)
for side, (base, tip) in ears.items():
    bone(f'ear_{side}', base, tip, 'head')
for key, info in legs.items():
    limb, side = key.split('_')
    z_top = info['z_top']
    knee_z, ankle_z = lo[2] + .6 * (z_top - lo[2]), lo[2] + .22 * (z_top - lo[2])
    knee = Vector((*centroid_at(key, knee_z), knee_z))
    ankle = Vector((*centroid_at(key, ankle_z), ankle_z))
    toe = Vector((foot[key][0], foot_front[key], lo[2] + .015 * H))
    bone(f'{limb}_upper_{side}', joints[key], knee, 'chest' if limb == 'fore' else 'pelvis')
    bone(f'{limb}_lower_{side}', knee, ankle, f'{limb}_upper_{side}', connect=True)
    bone(f'{limb}_paw_{side}', ankle, toe, f'{limb}_lower_{side}', connect=True)
if tail:
    for i in range(3):
        bone(f'tail_{i + 1}', tail[i], tail[i + 1], 'pelvis' if i == 0 else f'tail_{i}', connect=i > 0)
bpy.ops.object.mode_set(mode='OBJECT')
bone_names = [b.name for b in rig.data.bones if b.use_deform]
bone_index = {name: i for i, name in enumerate(bone_names)}

# 8. Weights: bone heat on a voxel proxy, transferred by nearest-face interpolation.
proxy = mesh.copy(); proxy.data = mesh.data.copy(); bpy.context.collection.objects.link(proxy)
proxy.vertex_groups.clear()
remesh = proxy.modifiers.new('voxel', 'REMESH'); remesh.mode = 'VOXEL'; remesh.voxel_size = H / 70
bpy.ops.object.select_all(action='DESELECT'); proxy.select_set(True); bpy.context.view_layer.objects.active = proxy
bpy.ops.object.modifier_apply(modifier=remesh.name)
proxy.select_set(True); rig.select_set(True); bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
bpy.ops.object.select_all(action='DESELECT'); mesh.select_set(True); rig.select_set(True); bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type='ARMATURE_NAME')
transfer = mesh.modifiers.new('weights', 'DATA_TRANSFER')
transfer.object = proxy; transfer.use_vert_data = True; transfer.data_types_verts = {'VGROUP_WEIGHTS'}
transfer.vert_mapping = 'POLYINTERP_NEAREST'; transfer.layers_vgroup_select_src = 'ALL'; transfer.layers_vgroup_select_dst = 'NAME'
bpy.ops.object.select_all(action='DESELECT'); mesh.select_set(True); bpy.context.view_layer.objects.active = mesh
bpy.ops.object.modifier_move_to_index(modifier=transfer.name, index=0)
bpy.ops.object.modifier_apply(modifier=transfer.name)
bpy.data.objects.remove(proxy, do_unlink=True)

Wt = np.zeros((n, len(bone_names)))
group_bone = {g.index: bone_index.get(g.name) for g in mesh.vertex_groups}
for v in mesh.data.vertices:
    for g in v.groups:
        b = group_bone.get(g.group)
        if b is not None:
            Wt[v.index, b] = g.weight

# Regions only forbid cross-talk; the leg-to-body transition keeps bone heat's smooth falloff.
# A vertex may not follow another leg, legs never move the head or tail, and ears move only the head.
allowed = np.ones_like(Wt, dtype=bool)
region = np.full(n, 'torso', dtype=object)
leg_bone_sets = {}
for index, key in enumerate(('fore_L', 'fore_R', 'hind_L', 'hind_R')):
    limb, side = key.split('_')
    leg_bone_sets[key] = [bone_index[f'{limb}_{part}_{side}'] for part in ('upper', 'lower', 'paw')]
    in_leg = (cell == index) & (co[:, 2] < legs[key]['z_top'] + .03 * H) & (np.linalg.norm(xy - foot[key], axis=1) < 1.4 * cell_radius[key])
    region[in_leg] = key
all_leg_bones = [b for bones in leg_bone_sets.values() for b in bones]
for index, key in enumerate(('fore_L', 'fore_R', 'hind_L', 'hind_R')):
    others = [b for k, bones in leg_bone_sets.items() if k != key for b in bones]
    allowed[np.ix_(cell == index, others)] = False
ear_bones = [bone_index[f'ear_{s}'] for s in ears]
head_bones = [bone_index['head']] + ear_bones
tail_bones = [bone_index[f'tail_{i}'] for i in (1, 2, 3)] if tail else []
in_head = head_mask & (region == 'torso')
region[in_head] = 'head'
allowed[np.ix_(in_head, all_leg_bones + tail_bones)] = False
allowed[np.ix_(~in_head, ear_bones)] = False
if tail:
    in_tail = tail_mask & (region == 'torso')
    region[in_tail] = 'tail'
    allowed[np.ix_(in_tail, all_leg_bones + head_bones)] = False
for key in legs:
    allowed[np.ix_(region == key, head_bones + tail_bones + [bone_index['neck']])] = False
    allowed[np.ix_(co[:, 2] > joints[key].z + .04 * H, leg_bone_sets[key])] = False


def constrain(weights):
    weights = weights * allowed
    total = weights.sum(1, keepdims=True)
    empty = total[:, 0] < 1e-6
    if empty.any():
        # Nearest allowed bone by distance to the bone segment.
        heads = np.array([rig.data.bones[b].head_local for b in bone_names])
        tails = np.array([rig.data.bones[b].tail_local for b in bone_names])
        for i in np.nonzero(empty)[0]:
            p = co[i]
            v = tails - heads
            t = np.clip(((p - heads) * v).sum(1) / (v * v).sum(1), 0, 1)
            dist = np.linalg.norm(p - (heads + t[:, None] * v), axis=1)
            dist[~allowed[i]] = np.inf
            weights[i, dist.argmin()] = 1
        total = weights.sum(1, keepdims=True)
    return weights / total


# Position-based smoothing (UV seams split vertices, so mesh edges alone would tear at seams).
tree = kdtree.KDTree(n)
for i, p in enumerate(co):
    tree.insert(p, i)
tree.balance()
neighbors = [[j for _, j, _ in tree.find_range(p, .03 * H)] for p in co]
Wt = constrain(Wt)
for _ in range(4):
    Wt = constrain(np.array([Wt[nb].mean(0) for nb in neighbors]))
# Four influences per vertex, as glTF skins carry.
keep = np.argsort(-Wt, axis=1)[:, :4]
limited = np.zeros_like(Wt)
rows = np.arange(n)[:, None]
limited[rows, keep] = Wt[rows, keep]
Wt = limited / limited.sum(1, keepdims=True)
for g in list(mesh.vertex_groups):
    mesh.vertex_groups.remove(g)
for name, b in bone_index.items():
    group = mesh.vertex_groups.new(name=name)
    for i in np.nonzero(Wt[:, b] > 1e-3)[0]:
        group.add([int(i)], float(Wt[i, b]), 'REPLACE')

# 9. Animations. The body is posed first (pelvis lift and pitch, spine bends); the legs are then
#    solved by analytic two-bone IK from their actual posed hip and shoulder joints, so paws stay on
#    their planned targets however the body moves. All leg rotations are about the armature X axis.
FPS = 24
scene = bpy.context.scene
scene.render.fps = FPS
rig.animation_data_create()
for pose_bone in rig.pose.bones:
    pose_bone.rotation_mode = 'QUATERNION'


def local_rotation(name, axis, degrees):
    rest = rig.data.bones[name].matrix_local.to_3x3()
    return (rest.inverted() @ Matrix.Rotation(math.radians(degrees), 3, axis) @ rest).to_quaternion()


def smooth(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * (3 - 2 * t)


def plane_angle(v):
    return math.atan2(v.z, v.y)


def wrap(angle):
    return (angle + math.pi) % (2 * math.pi) - math.pi


leg_info = {}
for key in legs:
    limb, side = key.split('_')
    upper, lower = rig.data.bones[f'{limb}_upper_{side}'], rig.data.bones[f'{limb}_lower_{side}']
    J0, K0, A0 = upper.head_local.copy(), upper.tail_local.copy(), lower.tail_local.copy()
    leg_info[key] = {'J0': J0, 'K0': K0, 'A0': A0, 'a': (K0 - J0).length, 'b': (A0 - K0).length, 'reach': J0.z - lo[2]}
reach = min(info['reach'] for info in leg_info.values())
hind_reach = min(leg_info[k]['reach'] for k in ('hind_L', 'hind_R'))
body_span = ((leg_info['fore_L']['J0'] + leg_info['fore_R']['J0']) / 2 - (leg_info['hind_L']['J0'] + leg_info['hind_R']['J0']) / 2).length
PITCH_CHAIN = {'pelvis': ('pelvis',), 'chest': ('pelvis', 'spine_1', 'spine_2', 'chest')}
pitch = {}


def turn(name, axis, degrees):
    if name in rig.pose.bones:
        rig.pose.bones[name].rotation_quaternion = local_rotation(name, axis, degrees)
        if axis == 'X':
            pitch[name] = degrees


def set_body(lift=0.0, tilt=0.0, forward=0.0):
    """Lift (armature Z), pitch about X (negative = nose up) and shift (armature Y) the whole body."""
    pelvis = rig.pose.bones['pelvis']
    pelvis.location = rig.data.bones['pelvis'].matrix_local.to_3x3().inverted() @ Vector((0, forward, lift))
    turn('pelvis', 'X', tilt)


def solve_leg(key, target, paw_angle=0.0):
    """Local upper, lower and paw angles that put the ankle on target from the posed joint."""
    info = leg_info[key]
    limb, side = key.split('_')
    joint = rig.pose.bones[f'{limb}_upper_{side}'].head
    parent_pitch = math.radians(sum(pitch.get(name, 0.0) for name in PITCH_CHAIN['chest' if limb == 'fore' else 'pelvis']))
    to_target = Vector((0, target.y - joint.y, target.z - joint.z))
    a, b = info['a'], info['b']
    d = min(max(to_target.length, abs(a - b) + 1e-5), a + b - 1e-5)
    bend = math.acos(max(-1, min(1, (a * a + d * d - b * b) / (2 * a * d))))
    # Fore elbows fold back (+Y), hind stifles fold forward (-Y).
    upper_angle = plane_angle(to_target) + (bend if limb == 'fore' else -bend)
    knee = joint + a * Vector((0, math.cos(upper_angle), math.sin(upper_angle)))
    lower_dir = Vector((0, target.y - knee.y, target.z - knee.z))
    upper_world = wrap(upper_angle - plane_angle(info['K0'] - info['J0']))
    lower_world = wrap(plane_angle(lower_dir) - plane_angle(info['A0'] - info['K0']))
    return (math.degrees(wrap(upper_world - parent_pitch)), math.degrees(wrap(lower_world - upper_world)),
            math.degrees(wrap(math.radians(paw_angle) - lower_world)))


def set_legs(targets, paw_angles=None):
    bpy.context.view_layer.update()  # posed joint positions after the body pose
    for key, target in targets.items():
        limb, side = key.split('_')
        upper, lower, paw = solve_leg(key, target, (paw_angles or {}).get(key, 0.0))
        rig.pose.bones[f'{limb}_upper_{side}'].rotation_quaternion = local_rotation(f'{limb}_upper_{side}', 'X', upper)
        rig.pose.bones[f'{limb}_lower_{side}'].rotation_quaternion = local_rotation(f'{limb}_lower_{side}', 'X', lower)
        rig.pose.bones[f'{limb}_paw_{side}'].rotation_quaternion = local_rotation(f'{limb}_paw_{side}', 'X', paw)


def planted(offsets=None):
    return {key: leg_info[key]['A0'] + (offsets or {}).get(key, Vector()) for key in legs}


def wag(amplitude, cycles, t, lift=0.0):
    for i, scale in ((1, 1), (2, .8), (3, .6)):
        name = f'tail_{i}'
        if name in rig.pose.bones:
            rig.pose.bones[name].rotation_quaternion = (local_rotation(name, 'Z', amplitude * scale * math.sin(2 * math.pi * cycles * t + .7 * i))
                                                        @ local_rotation(name, 'X', -lift * scale))


def move_ears(left, right=None):
    turn('ear_L', 'Y', left)
    turn('ear_R', 'Y', -(left if right is None else right))


def level_head(extra=0.0, yaw=0.0, roll=0.0):
    """Keep the head's world pitch at `extra` whatever the body pitch below it."""
    below = sum(pitch.get(name, 0.0) for name in ('pelvis', 'spine_1', 'spine_2', 'chest', 'neck'))
    rig.pose.bones['head'].rotation_quaternion = (local_rotation('head', 'X', extra - below)
                                                  @ local_rotation('head', 'Z', yaw) @ local_rotation('head', 'Y', roll))


recorded = []


def record(name, frames, pose):
    action = bpy.data.actions.new(name)
    recorded.append(name)
    rig.animation_data.action = action
    for frame in range(frames + 1):
        pitch.clear()
        for pose_bone in rig.pose.bones:
            pose_bone.rotation_quaternion = (1, 0, 0, 0)
            pose_bone.location = (0, 0, 0)
        pose(frame / frames)
        for pose_bone in rig.pose.bones:
            pose_bone.keyframe_insert('rotation_quaternion', frame=frame)
        rig.pose.bones['pelvis'].keyframe_insert('location', frame=frame)
    action.use_fake_user = True
    return action


def paw_path(key, p, duty, stride, lift):
    if p < duty:
        y, z = -stride / 2 + stride * (p / duty), 0.0
    else:
        s = (p - duty) / (1 - duty)
        y, z = stride / 2 - stride * smooth(s), lift * math.sin(math.pi * s)
    return leg_info[key]['A0'] + Vector((0, y, z))


def gait(phases, duty, stride, lift, bob, head, tail, ear, spine=0.0):
    def pose(t):
        set_body(lift=bob * math.sin(4 * math.pi * t))
        turn('spine_1', 'X', spine * math.sin(4 * math.pi * t))
        set_legs({key: paw_path(key, (t + phase) % 1, duty, stride, lift) for key, phase in phases.items()})
        level_head(head * math.sin(4 * math.pi * t + .6))
        wag(tail, 1, t)
        move_ears(ear * math.sin(4 * math.pi * t))
    return pose


def pulse(t, starts, width):
    return sum(math.sin(math.pi * (t - start) / width) for start in starts if start < t < start + width)


def hold(t, down, up):
    """0 -> 1 over [0, down], stays 1, back to 0 over [up, 1]."""
    return smooth(t / down) if t < down else 1.0 if t < up else 1 - smooth((t - up) / (1 - up))


def idle(t):
    set_body(lift=.006 * reach * math.sin(4 * math.pi * t))
    turn('chest', 'X', 1.5 * math.sin(4 * math.pi * t))
    set_legs(planted())
    level_head(0, yaw=5 * math.sin(2 * math.pi * t), roll=4 * math.sin(2 * math.pi * t + 1.2))
    wag(14, 3, t)
    move_ears(10 * pulse(t, (.55,), .1), 0)


def bark(t):
    snap, crouch = pulse(t, (.15, .55), .18), pulse(t, (.02, .42), .15)
    set_body(lift=(.03 * snap - .02 * crouch) * reach)
    turn('chest', 'X', 4 * snap - 2 * crouch)
    set_legs(planted())
    level_head(-10 * snap + 4 * crouch)
    wag(18, 4, t)
    move_ears(8 * snap)


def sit(t):
    # Hips drop onto the ground; the body pitches nose-up about the rump so the chest keeps its height,
    # the fore legs stay straight and the head stays level. Down, hold (tail sweeps), up.
    k = hold(t, .25, .75)
    drop = .6 * hind_reach * k
    tilt = -math.degrees(math.asin(min(.9, drop / max(body_span, 1e-4))))
    set_body(lift=-drop, tilt=tilt)
    set_legs(planted({'hind_L': Vector((0, -.12 * hind_reach * k, 0)), 'hind_R': Vector((0, -.12 * hind_reach * k, 0))}))
    level_head(3 * math.sin(2 * math.pi * 2 * t) * k, roll=6 * math.sin(2 * math.pi * t) * k)
    wag(16 * k, 2, t, lift=-10 * k)
    move_ears(4 * math.sin(4 * math.pi * t) * k)


def lie(t):
    # Belly down: the body lowers, fore paws slide forward along the ground, hind legs fold under.
    k = hold(t, .3, .8)
    drop = .7 * reach * k
    set_body(lift=-drop)
    forward_fore, forward_hind = -.4 * reach * k, -.1 * reach * k
    set_legs(planted({'fore_L': Vector((0, forward_fore, 0)), 'fore_R': Vector((0, forward_fore, 0)),
                      'hind_L': Vector((0, forward_hind, 0)), 'hind_R': Vector((0, forward_hind, 0))}))
    level_head(6 * k, roll=5 * math.sin(2 * math.pi * t) * k)
    wag(8 * k, 1, t, lift=12 * k)
    move_ears(-6 * k)


def jump(t):
    # Crouch, push, flight with tucked paws, landing absorb, recover.
    R = reach
    if t < .2:
        lift, feet, tilt = -.25 * R * smooth(t / .2), 0.0, 4 * smooth(t / .2)
    elif t < .3:
        s = (t - .2) / .1
        lift, feet, tilt = -.25 * R + .4 * R * smooth(s), 0.0, 4 - 11 * smooth(s)
    elif t < .7:
        u = (t - .3) / .4
        lift = .15 * R + .9 * R * 4 * u * (1 - u)
        feet = lift - .15 * R + .25 * R * math.sin(math.pi * u)
        tilt = -7 + 13 * u
    elif t < .85:
        s = (t - .7) / .15
        lift, feet, tilt = .15 * R - .35 * R * smooth(s), 0.0, 6 - 6 * smooth(s)
    else:
        s = (t - .85) / .15
        lift, feet, tilt = -.2 * R + .2 * R * smooth(s), 0.0, 0.0
    set_body(lift=lift, tilt=tilt)
    set_legs(planted({key: Vector((0, 0, max(feet, 0.0))) for key in legs}))
    level_head(-.4 * tilt)
    airborne = 1.0 if .3 <= t < .7 else 0.0
    wag(10, 2, t, lift=10 * airborne)
    move_ears(8 * airborne)


record('bark', 24, bark)
record('idle', 48, idle)
record('jump', 36, jump)
record('lie', 48, lie)
record('run', 12, gait({'fore_L': 0, 'hind_R': 0, 'fore_R': .5, 'hind_L': .5}, duty=.45, stride=.45 * reach,
                       lift=.25 * reach, bob=.03 * reach, head=4, tail=14, ear=8, spine=1.5))
record('sit', 48, sit)
walk = record('walk', 24, gait({'hind_L': 0, 'fore_L': .25, 'hind_R': .5, 'fore_R': .75}, duty=.65, stride=.35 * reach,
                               lift=.16 * reach, bob=.012 * reach, head=3, tail=8, ear=3))
rig.animation_data.action = walk
FRAMES = 24
scene.frame_start, scene.frame_end = 0, FRAMES

# 10. Checks: paw ground contact and surface stretch per region.
edges = np.empty(len(mesh.data.edges) * 2, dtype=np.int64); mesh.data.edges.foreach_get('vertices', edges); edges = edges.reshape(-1, 2)
rest_len = np.linalg.norm(co[edges[:, 0]] - co[edges[:, 1]], axis=1)
valid = rest_len > 1e-6
edge_region = region[edges[:, 0]]
paw_sets = {key: np.nonzero((region == key) & (co[:, 2] < lo[2] + .25 * (legs[key]['z_top'] - lo[2])))[0] for key in legs}
for key, idx in paw_sets.items():
    if not len(idx):
        fail('leg_not_found', leg=key)
track = {key: [] for key in legs}
stretch = {}
for frame in range(FRAMES):
    scene.frame_set(frame)
    dg = bpy.context.evaluated_depsgraph_get()
    evaluated = mesh.evaluated_get(dg)
    em = evaluated.to_mesh()
    posed = np.empty(n * 3); em.vertices.foreach_get('co', posed); posed = posed.reshape(n, 3)
    evaluated.to_mesh_clear()
    for key, idx in paw_sets.items():
        track[key].append(round(float(100 * (posed[idx, 2].min() - lo[2]) / H), 1))
    ratio = np.linalg.norm(posed[edges[:, 0]] - posed[edges[:, 1]], axis=1)[valid] / rest_len[valid]
    for name in ('torso', 'head', 'tail', 'fore_L', 'fore_R', 'hind_L', 'hind_R'):
        sel = edge_region[valid] == name
        if sel.any():
            stretch[name] = max(stretch.get(name, 0), float(np.percentile(np.abs(ratio[sel] - 1), 99)))
report = {
    'landmarks': {'leg_top_pct': {k: round(float(100 * (v['z_top'] - lo[2]) / H), 1) for k, v in legs.items()},
                  'neck_pct': round(float(100 * (neck_z - lo[2]) / H), 1), 'ears': sorted(ears), 'tail': bool(tail),
                  'hip_pct': round(float(100 * (hip.z - lo[2]) / H), 1), 'shoulder_pct': round(float(100 * (shoulder.z - lo[2]) / H), 1),
                  'joint_pct': {k: round(float(100 * (v.z - lo[2]) / H), 1) for k, v in joints.items()}},
    'bones': len(rig.data.bones), 'vertices': n,
    'region_vertices': {name: int((region == name).sum()) for name in set(region)},
    'paw_height_pct': {k: {'min': min(v), 'max': max(v), 'frames_on_ground(<2%)': sum(x < 2 for x in v)} for k, v in track.items()},
    'stretch_p99_pct': {k: round(100 * v, 1) for k, v in stretch.items()},
    'clips': recorded, 'fps': FPS,
}

# 11. Export, then seal: standard.json is written last and names the attempt, the source and the GLB.
scene.frame_set(0)
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True); mesh.select_set(True); bpy.context.view_layer.objects.active = rig
bpy.ops.export_scene.gltf(filepath=str(out / 'motions-standard.glb'), export_format='GLB', use_selection=True,
                          export_animations=True, export_animation_mode='ACTIONS')
report.update(attempt=args.get('attempt'), source_sha256=source_sha256,
              files={'motions-standard.glb': sha256(out / 'motions-standard.glb')})
(out / 'standard.json').write_text(json.dumps(report, indent=1), encoding='utf8')
print('STANDARD_RIG', json.dumps(report))
