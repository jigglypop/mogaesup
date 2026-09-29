"""Align saved sleeves and publish a shared T rest pose with rebased clips."""
import bpy
from mathutils import Matrix, Vector

from src.services.avatar_blender_common import bounds, blender_to_gltf


def fit_sleeves(meshes, rig, spec):
    """Seat sleeve openings on the actual wrists before transferring weights."""
    lo, hi = bounds(meshes)
    torso = spec['base_body']['torso_width_m']/2
    reports = {}
    masks = {obj: {} for obj in meshes}
    def smooth(value):
        t = max(0, min(1, value))
        return t*t*(3-2*t)
    for side, sign in (('Left', 1), ('Right', -1)):
        shoulder = rig.matrix_world @ rig.data.bones[side+'Arm'].head_local
        wrist = rig.matrix_world @ rig.data.bones[side+'Hand'].head_local
        points = [obj.matrix_world @ v.co for obj in meshes for v in obj.data.vertices]
        extent = max(sign*p.x for p in points)
        cuff = [p for p in points if sign*p.x >= extent-.035]
        center = sum(cuff, Vector())/len(cuff)
        source_axis, target_axis = center-shoulder, wrist-shoulder
        rotation = source_axis.normalized().rotation_difference(target_axis.normalized()).to_matrix()
        direction = source_axis.normalized()
        longitudinal = target_axis.length/source_axis.length
        for obj in meshes:
            inverse = obj.matrix_world.inverted()
            for vertex in obj.data.vertices:
                point = obj.matrix_world @ vertex.co
                t = smooth((sign*point.x-torso)/(extent*.72-torso))
                upper = smooth((point.z-(lo.z+(hi.z-lo.z)*.25))/((hi.z-lo.z)*.25))
                outer = smooth((sign*point.x-extent*.5)/(extent*.22))
                t *= max(upper, outer)
                if not t:
                    continue
                masks[obj][vertex.index] = (side, t)
                offset = point-shoulder
                offset += direction*offset.dot(direction)*(longitudinal-1)
                destination = shoulder+rotation @ offset
                delta = inverse.to_3x3() @ ((destination-point)*t)
                original = vertex.co.copy()
                if obj.data.shape_keys:
                    for key in obj.data.shape_keys.key_blocks:
                        key.data[vertex.index].co += delta
                vertex.co = original+delta
            obj.data.update()
        reports[side.lower()] = {'source_cuff_m': blender_to_gltf(center),
                                'wrist_m': blender_to_gltf(wrist)}
    return {'method': 'sleeve_axis_to_actual_wrist', 'sides': reports}, masks


def bind_top_regions(meshes, rig, masks):
    """The shirt hem follows the torso, even when a hand is its nearest surface."""
    torso_names = [b.name for b in rig.data.bones if any(k in b.name.lower() for k in ('hips', 'spine', 'chest'))]
    centers = {name: rig.matrix_world @ rig.data.bones[name].head_local for name in torso_names}
    for obj in meshes:
        groups = {g.name: g for g in obj.vertex_groups}
        for vertex in obj.data.vertices:
            point = obj.matrix_world @ vertex.co
            side, amount = masks[obj].get(vertex.index, ('Left' if point.x >= 0 else 'Right', 0))
            core = min(torso_names, key=lambda name: abs(centers[name].z-point.z))
            row = {core: 1-amount}
            shoulder, elbow, wrist = [rig.matrix_world @ rig.data.bones[side+name].head_local
                                     for name in ('Arm', 'ForeArm', 'Hand')]
            direction = (wrist-shoulder).normalized()
            distance = (point-elbow).dot(direction)
            blend = max(0, min(1, .5+distance/.05))
            row[side+'Arm'] = amount*(1-blend)
            row[side+'ForeArm'] = amount*blend
            for index in [group.group for group in vertex.groups]:
                obj.vertex_groups[index].remove([vertex.index])
            for name, weight in row.items():
                if weight > 1e-8:
                    groups[name].add([vertex.index], weight, 'REPLACE')


def t_rest_pose(rig, meshes):
    """Align rest limbs and skin together; preserve the captured motion frames."""
    bones = list(rig.data.bones)
    old = {bone.name: bone.matrix_local.copy() for bone in bones}
    world = rig.matrix_world.copy()
    inverse = world.inverted()
    new = {name: matrix.copy() for name, matrix in old.items()}
    shoulder_height = sum((world @ old[side+'Arm']).translation.z for side in ('Left', 'Right'))/2
    shoulder_depth = sum((world @ old[side+'Arm']).translation.y for side in ('Left', 'Right'))/2
    shoulder_half_width = sum(abs((world @ old[side+'Arm']).translation.x) for side in ('Left', 'Right'))/2
    arm_lengths = {suffix: sum(((world @ old[side+suffix]).translation-(world @ old[side+parent]).translation).length
                              for side in ('Left', 'Right'))/2
                   for suffix, parent in (('ForeArm', 'Arm'), ('Hand', 'ForeArm'))}
    for side, sign in (('Left', 1), ('Right', -1)):
        direction = Vector((sign, 0, 0))
        previous = None
        for suffix in ('Arm', 'ForeArm', 'Hand'):
            name = side+suffix
            source = world @ old[name]
            axis = source.to_3x3() @ Vector((0, 1, 0))
            rotation = axis.normalized().rotation_difference(direction).to_matrix().to_4x4()
            destination = rotation @ source
            if previous is None:
                destination.translation = Vector((sign*shoulder_half_width, shoulder_depth, shoulder_height))
            else:
                # Blender's imported display-bone length is not the distance
                # between skin joints. Preserve the measured world distance.
                length = arm_lengths[suffix]
                destination.translation = (world @ new[previous]).translation+direction*length
            new[name] = inverse @ destination
            previous = name
        for bone in rig.data.bones[side+'Hand'].children_recursive:
            new[bone.name] = new[bone.parent.name] @ old[bone.parent.name].inverted() @ old[bone.name]

    # A vertical hip/knee/ankle chain and matching sagittal foot axes remove
    # asymmetric knee bends and toe-out from the saved reference pose. This is
    # a new rest-frame derivative, never an edit of the imported source GLB.
    joints = {side: {suffix: (world @ old[side+suffix]).translation
                    for suffix in ('UpLeg', 'Leg', 'Foot', 'ToeBase')}
              for side in ('Left', 'Right')}
    hip_height = sum(row['UpLeg'].z for row in joints.values())/2
    ankle_height = sum(row['Foot'].z for row in joints.values())/2
    half_stance = sum(abs(row['UpLeg'].x) for row in joints.values())/2
    sagittal = sum(row['UpLeg'].y for row in joints.values())/2
    knee_fraction = sum((row['Leg']-row['UpLeg']).length /
                        ((row['Leg']-row['UpLeg']).length+(row['Foot']-row['Leg']).length)
                        for row in joints.values())/2
    foot_offset = sum((row['ToeBase']-row['Foot'] for row in joints.values()), Vector())/2
    foot_offset.x = 0
    foot_offset.y = -abs(foot_offset.y)
    for side, sign in (('Left', 1), ('Right', -1)):
        row = joints[side]
        hip = Vector((sign*half_stance, sagittal, hip_height))
        ankle = Vector((hip.x, sagittal, ankle_height))
        knee = hip.lerp(ankle, knee_fraction)
        targets = {'UpLeg': (hip, Vector((0, 0, -1))),
                   'Leg': (knee, Vector((0, 0, -1))),
                   'Foot': (ankle, foot_offset.normalized()),
                   'ToeBase': (ankle+foot_offset, Vector((0, -1, 0)))}
        for suffix, (head, direction) in targets.items():
            name = side+suffix
            source = world @ old[name]
            axis = source.to_3x3() @ Vector((0, 1, 0))
            destination = axis.normalized().rotation_difference(direction).to_matrix().to_4x4() @ source
            destination.translation = head
            new[name] = inverse @ destination
        for bone in rig.data.bones[side+'ToeBase'].children_recursive:
            new[bone.name] = new[bone.parent.name] @ old[bone.parent.name].inverted() @ old[bone.name]

    # Capture channels in the imported rest frame before changing that frame.
    animation = rig.animation_data
    active = (animation.action, animation.action_slot) if animation and animation.action else None
    tracks = [(track, track.mute) for track in animation.nla_tracks] if animation else []
    sources = dict([(active[0], active[1])] if active else [])
    for track, _ in tracks:
        track.mute = True
        for strip in track.strips:
            if strip.action:
                sources[strip.action] = strip.action_slot
    samples = {}
    scene = bpy.context.scene
    frame = scene.frame_current
    rig.data.pose_position = 'POSE'
    for action, slot in sources.items():
        animation.action = action
        if slot:
            animation.action_slot = slot
        start, end = action.frame_range
        frames = sorted({float(start), float(end), *map(float, range(int(start), int(end)+1))})
        rows = []
        for value in frames:
            scene.frame_set(int(value), subframe=value-int(value))
            bpy.context.view_layer.update()
            rows.append((value, {p.name: p.matrix_basis.copy() for p in rig.pose.bones}))
        samples[action] = rows
    if animation:
        animation.action = None
    rig.data.pose_position = 'REST'

    transforms = {name: world @ new[name] @ old[name].inverted() @ inverse for name in old}
    for obj in meshes:
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        local = obj.matrix_world.inverted()
        groups = {g.index: g.name for g in obj.vertex_groups}
        for vertex in obj.data.vertices:
            weights = [(transforms[groups[g.group]], g.weight) for g in vertex.groups if groups.get(g.group) in transforms]
            total = sum(weight for _, weight in weights)
            if not total:
                continue
            def deform(co):
                point = obj.matrix_world @ co
                return local @ (sum(((transform @ point)*weight for transform, weight in weights), Vector())/total)
            destination = deform(vertex.co.copy())
            if obj.data.shape_keys:
                for key in obj.data.shape_keys.key_blocks:
                    key.data[vertex.index].co = deform(key.data[vertex.index].co.copy())
            vertex.co = destination
        obj.data.update()

    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True); bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    for bone in rig.data.edit_bones:
        bone.use_connect = False
        bone.matrix = new[bone.name]
    bpy.ops.object.mode_set(mode='OBJECT')
    new = {bone.name: bone.matrix_local.copy() for bone in rig.data.bones}
    correction = {}
    for bone in rig.data.bones:
        old_local = old[bone.parent.name].inverted() @ old[bone.name] if bone.parent else old[bone.name]
        new_local = new[bone.parent.name].inverted() @ new[bone.name] if bone.parent else new[bone.name]
        correction[bone.name] = new_local.inverted() @ old_local
    replacements = {}
    for source, rows in samples.items():
        action = bpy.data.actions.new(source.name+'_T_Rest')
        animation.action = action
        for value, matrices in rows:
            for pose in rig.pose.bones:
                pose.rotation_mode = 'QUATERNION'
                pose.matrix_basis = correction[pose.name] @ matrices[pose.name]
                for channel in ('location', 'rotation_quaternion', 'scale'):
                    pose.keyframe_insert(data_path=channel, frame=value, group=pose.name)
        replacements[source] = (action, animation.action_slot)
    if animation:
        animation.action = None
        for track, mute in tracks:
            for strip in track.strips:
                if strip.action in replacements:
                    action, slot = replacements[strip.action]
                    strip.action = action
                    strip.action_slot = slot
            track.mute = mute
        if active:
            animation.action, animation.action_slot = replacements[active[0]]
    scene.frame_set(frame)
    rig.data.pose_position = 'REST'; bpy.context.view_layer.update()
    return {'rest_pose': 'T', 'revision': 'axis-aligned-limbs-v1',
            'animation_rest_bases_rebased': len(replacements),
            'legs_m': {side.lower(): {suffix: blender_to_gltf(world @ rig.data.bones[side+suffix].head_local)
                         for suffix in ('UpLeg', 'Leg', 'Foot', 'ToeBase')} for side in ('Left', 'Right')},
            'wrists_m': {side.lower(): blender_to_gltf(world @ rig.data.bones[side+'Hand'].head_local)
                         for side in ('Left', 'Right')}}
