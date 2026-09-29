"""Shared metric fitting with garment ease, without clothing shrinkwrap."""
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from copy import deepcopy

from src.services.avatar_blender_common import bounds, blender_to_gltf


def target_box(value):
    lo, hi = value
    return Vector((lo[0], -hi[2], lo[1])), Vector((hi[0], -lo[2], hi[1]))


def box_fit(lo, hi, target):
    a, b = target_box(target)
    size, desired = hi-lo, b-a
    if min(size) <= 1e-6 or min(desired) <= 1e-6:
        raise ValueError('Degenerate production bounds')
    scale = Vector([desired[i]/size[i] for i in range(3)])
    center, destination = (lo+hi)/2, (a+b)/2
    transform = (Matrix.Translation(destination) @ Matrix.Diagonal((*scale, 1.0))
                 @ Matrix.Translation(-center))
    anchors = [{'name': str(i), 'source': blender_to_gltf(p), 'target': blender_to_gltf(transform @ p)}
               for i, p in enumerate((center, center+Vector((1, 0, 0)),
                                       center+Vector((0, 1, 0)), center+Vector((0, 0, 1))))]
    return transform, anchors, {'method': 'axis_scale_in_shared_frame',
                                'source_bounds': [list(lo), list(hi)], 'target_bounds_gltf': target,
                                'axis_scale_gltf': [scale.x, scale.z, scale.y]}


def measured_fit(meshes, target):
    return box_fit(*bounds(meshes), target)


def fit_equipment(meshes, attachment):
    """Uniform physical scale around the declared grip/bridge, not XYZ stretch."""
    lo, hi = bounds(meshes)
    size = hi-lo
    pivot = attachment['pivot_fraction']
    source = Vector((lo.x+size.x*pivot[0], hi.y-size.y*pivot[2], lo.z+size.z*pivot[1]))
    anchor = attachment['position_m']
    destination = Vector((anchor[0], -anchor[2], anchor[1]))
    axis = 0 if attachment['bone'] == 'Head' else 2
    physical = attachment['size_m'][0 if axis == 0 else 1]
    if size[axis] <= 1e-6:
        raise ValueError('Equipment has no measurable attachment axis')
    scale = physical/size[axis]
    transform = Matrix.Translation(destination) @ Matrix.Scale(scale, 4) @ Matrix.Translation(-source)
    return transform, [{'name': 'attachment', 'source': blender_to_gltf(source), 'target': anchor}], {
        'method': 'uniform_metric_socket', 'scale': scale, 'socket': attachment}


def place(meshes, transform):
    for obj in meshes:
        world = transform @ obj.matrix_world
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        obj.parent = None
        obj.matrix_world = Matrix.Identity(4)
        obj.data.transform(world, shape_keys=True)
        obj.data.update()


def normalize_body(objects, body, target):
    lo, hi = bounds(body); a, b = target_box(target)
    scale = (b.z-a.z)/(hi.z-lo.z)
    source = Vector(((lo.x+hi.x)/2, (lo.y+hi.y)/2, lo.z))
    destination = Vector(((a.x+b.x)/2, (a.y+b.y)/2, a.z))
    transform = Matrix.Translation(destination) @ Matrix.Scale(scale, 4) @ Matrix.Translation(-source)
    report = {'method': 'uniform_height_preserve_body_proportions', 'scale': scale,
              'source_bounds': [list(lo), list(hi)], 'target_height_m': b.z-a.z}
    root = bpy.data.objects.new('FactoryMetricFrame', None)
    bpy.context.scene.collection.objects.link(root)
    roots = [obj for obj in objects if obj.parent not in objects]
    for obj in roots:
        world = obj.matrix_world.copy()
        obj.parent = root
        obj.matrix_world = world
    root.matrix_world = transform
    bpy.context.view_layer.update()
    return report


def head_weighted_vertices(body, rig, minimum=.25):
    """Return vertices that are materially controlled by the canonical Head bone."""
    head = next((bone for bone in rig.data.bones
                 if bone.name.lower().split(':')[-1] == 'head'), None)
    if head is None:
        return {}
    result = {}
    for obj in body:
        group = next((group for group in obj.vertex_groups
                      if group.name.lower().split(':')[-1] == 'head'), None)
        if group is None:
            continue
        underlayer = set()
        for face in obj.data.polygons:
            material = (obj.data.materials[face.material_index]
                        if face.material_index < len(obj.data.materials) else None)
            if material and material.get('base_underlayer'):
                underlayer.update(face.vertices)
        indices = set()
        for vertex in obj.data.vertices:
            if vertex.index in underlayer:
                continue
            weight = next((entry.weight for entry in vertex.groups
                           if entry.group == group.index), 0.)
            if weight >= minimum:
                indices.add(vertex.index)
        if indices:
            result[obj] = indices
    return result


def head_region(body, rig, spec):
    """Measure skin weighted to Head, with a bounded geometric fallback."""
    lo, hi = bounds(body)
    bones = {bone.name.lower().split(':')[-1]: bone for bone in rig.data.bones}
    shoulders = [rig.matrix_world @ bones[name].head_local
                 for name in ('leftarm', 'rightarm') if name in bones]
    rise = spec['anchors']['neck'][1]-spec['anchors']['shoulder_left'][1]
    collar = (sum(p.z for p in shoulders)/len(shoulders)+rise if shoulders
              else lo.z+(hi.z-lo.z)*spec['anchors']['neck'][1]/spec['body_height_m'])
    weighted = head_weighted_vertices(body, rig)
    points = [obj.matrix_world @ obj.data.vertices[index].co
              for obj, indices in weighted.items() for index in indices]
    if not points:
        # Some providers omit usable skin weights. The upper skull band avoids
        # counting T-pose arms at shoulder height as head width.
        skull_floor = max(collar, hi.z-(hi.z-lo.z)*.48)
        points = [obj.matrix_world @ vertex.co for obj in body for vertex in obj.data.vertices
                  if (obj.matrix_world @ vertex.co).z >= skull_floor]
    if not points:
        raise ValueError('Body has no measurable head surface')
    a = Vector([min(p[i] for p in points) for i in range(3)])
    b = Vector([max(p[i] for p in points) for i in range(3)])
    return a, b, collar


def headwear_target(body, rig, spec):
    """Build the hat seat from the body's measured head, not a fixed envelope."""
    lo, hi, _ = head_region(body, rig, spec)
    fitting = spec['fitting']
    hairline_drop = max(0., spec['body_height_m']-fitting.get(
        'hat_hairline_m', spec['body_height_m']))
    crown_clearance = fitting.get('hair_crown_clearance_m', 0.)
    return [[lo.x, max(lo.z, hi.z-hairline_drop), -hi.y],
            [hi.x, hi.z+crown_clearance, -lo.y]]


def hair_target(body, rig, spec, slot='hair'):
    """Seat hair on the measured head without inflating it to a fixed envelope."""
    lo, hi, _ = head_region(body, rig, spec)
    fitting = spec['fitting']
    clearance = fitting.get('hair_clearance_m', .025)
    head_width = hi.x-lo.x
    head_depth = hi.y-lo.y
    width = head_width+clearance*2
    depth = head_depth+clearance*2
    center_x = (lo.x+hi.x)/2
    center_depth = -(lo.y+hi.y)/2

    # Split legacy parts retain their authored front/rear relationship to the
    # head, while their size comes from the same measured head as unified hair.
    authored = fitting.get('bounds', {})
    authored_head = authored.get('head')
    authored_slot = authored.get(slot)
    if slot in ('hairFront', 'hairBack') and authored_head and authored_slot:
        authored_width = authored_head[1][0]-authored_head[0][0]
        authored_depth = authored_head[1][2]-authored_head[0][2]
        if min(authored_width, authored_depth) > 1e-8:
            width *= (authored_slot[1][0]-authored_slot[0][0])/authored_width
            depth *= (authored_slot[1][2]-authored_slot[0][2])/authored_depth
            head_depth_center = (authored_head[0][2]+authored_head[1][2])/2
            slot_depth_center = (authored_slot[0][2]+authored_slot[1][2])/2
            center_depth += (slot_depth_center-head_depth_center)*head_depth/authored_depth

    crown = hi.z+fitting.get('hair_crown_clearance_m', .035)
    length_ratio = fitting.get('hair_length_head_ratio')
    lower = lo.z if length_ratio is None else crown-(hi.z-lo.z)*length_ratio
    return [[center_x-width/2, lower, center_depth-depth/2],
            [center_x+width/2, crown, center_depth+depth/2]]


def bind_body_head(body, rig, spec):
    """Keep the visible head on Head even when auto-rigging chose a shoulder."""
    _, _, collar = head_region(body, rig, spec)
    bone = next((b for b in rig.data.bones if b.name.lower().split(':')[-1] == 'head'), None)
    if bone is None:
        return {'method': 'unchanged', 'adjusted_vertices': 0}
    blend_start = collar-.04
    adjusted = 0
    for obj in body:
        group = obj.vertex_groups.get(bone.name) or obj.vertex_groups.new(name=bone.name)
        for vertex in obj.data.vertices:
            height = (obj.matrix_world @ vertex.co).z
            if height <= blend_start:
                continue
            blend = min(1, (height-blend_start)/(collar-blend_start))
            blend = blend*blend*(3-2*blend)
            previous = [(g.group, g.weight) for g in vertex.groups]
            total = sum(weight for _, weight in previous)
            head_weight = sum(weight for index, weight in previous if index == group.index)
            if total and head_weight/total > .9999:
                continue
            for index, weight in previous:
                obj.vertex_groups[index].remove([vertex.index])
                remaining = weight/max(total, 1e-8)*(1-blend)
                if remaining > 1e-8:
                    obj.vertex_groups[index].add([vertex.index], remaining, 'REPLACE')
            group.add([vertex.index], blend, 'ADD')
            adjusted += 1
    return {'method': 'geometric_head_on_canonical_bone', 'bone': bone.name,
            'collar_height_m': collar, 'adjusted_vertices': adjusted, 'skeleton_changed': False}


def slim_base_body(body, rig, spec):
    """Reduce only clothed core thickness around the unchanged rest skeleton."""
    core = spec.get('base_body')
    if not core:
        return {'method': 'unchanged', 'adjusted_vertices': 0}
    from src.services.avatar_head_geometry import underlayer_faces
    fabric = underlayer_faces(body)
    _, _, head_collar = head_region(body, rig, spec)
    joints = []
    for side in ('Left', 'Right'):
        for name, parent, diameter in (('Hand', 'ForeArm', core.get('wrist_diameter_m', .028)),
                                        ('Foot', 'Leg', core.get('ankle_diameter_m', .032))):
            joint, above = rig.data.bones.get(side+name), rig.data.bones.get(side+parent)
            if joint and above:
                center = rig.matrix_world @ joint.head_local
                axis = (center-rig.matrix_world @ above.head_local).normalized()
                joints.append((center, axis, diameter/2))
    segments = {}
    for bone in rig.data.bones:
        name = bone.name.lower()
        if any(token in name for token in ('head', 'neck', 'hand', 'finger', 'thumb', 'foot', 'toe')):
            continue
        kind = ('arm' if 'arm' in name or 'shoulder' in name else
                'leg' if 'leg' in name or 'thigh' in name else
                'torso' if any(token in name for token in ('hips', 'pelvis', 'spine', 'chest')) else None)
        if kind:
            segments[bone.name] = (kind, rig.matrix_world @ bone.head_local, rig.matrix_world @ bone.tail_local)
    adjusted, maximum, protected_fabric = 0, 0.0, 0
    for obj in body:
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        inverse = obj.matrix_world.inverted()
        names = {g.index: g.name for g in obj.vertex_groups}
        fabric_vertices = {i for face in obj.data.polygons if face.index in fabric.get(obj, set()) for i in face.vertices}
        for vertex in obj.data.vertices:
            point = obj.matrix_world @ vertex.co
            is_fabric = vertex.index in fabric_vertices
            # Auto-rigging can assign the entire face to a shoulder. Only the
            # identified underlayer below the head may be made thinner.
            near_joint = []
            for center, axis, radius in joints:
                along = (point-center).dot(axis)
                radial = point-center-axis*along
                if abs(along) < .035 and radial.length < .07:
                    near_joint.append((center, axis, radius, along))
            if (not is_fabric and not near_joint) or point.z >= head_collar-.04:
                continue
            influences = [(segments[names[g.group]], g.weight) for g in vertex.groups
                          if is_fabric and names.get(g.group) in segments]
            if is_fabric:
                protected_fabric += int(any(g.weight > .5 and names.get(g.group) not in segments for g in vertex.groups))
                if sum(weight for _, weight in influences) < .25:
                    def distance(segment):
                        _, start, end = segment; axis = end-start
                        t = max(0, min(1, (point-start).dot(axis)/max(axis.length_squared, 1e-10)))
                        return (point-(start+axis*t)).length_squared
                    influences = [(min(segments.values(), key=distance), 1.0)] if segments else []
            total = sum(weight for _, weight in influences) if is_fabric else sum(g.weight for g in vertex.groups)
            delta = Vector((0, 0, 0))
            for segment, weight in influences:
                kind, start, end = segment
                axis = end-start
                t = max(0, min(1, (point-start).dot(axis)/max(axis.length_squared, 1e-10)))
                center = start+axis*t
                offset = point-center
                if kind == 'torso':
                    radial = ((offset.x/(core['torso_width_m']/2))**2
                              + (offset.y/(core['torso_depth_m']/2))**2)**.5
                    factor = min(1, 1/max(radial, 1e-8))
                    candidate = Vector((center.x+offset.x*factor, center.y+offset.y*factor, point.z))
                else:
                    radius = core[f'{kind}_diameter_m']/2
                    tip = core.get('wrist_diameter_m' if kind == 'arm' else 'ankle_diameter_m', radius*2)/2
                    if any(token in names.get(max(vertex.groups, key=lambda g: g.weight).group, '').lower()
                           for token in ('forearm', 'leftleg', 'rightleg')):
                        radius += (tip-radius)*t*t
                    candidate = center+offset*min(1, radius/max(offset.length, 1e-8))
                delta += (candidate-point)*weight/max(total, 1e-8)
            for center, axis, radius, along in near_joint:
                candidate = point+delta
                axial = (candidate-center).dot(axis)
                radial = candidate-center-axis*axial
                blend = (1-abs(along)/.035)**2
                delta += radial*(min(1, radius/max(radial.length, 1e-8))-1)*blend
            if delta.length > 1e-7:
                local_delta = inverse.to_3x3() @ delta
                destination = vertex.co+local_delta
                if obj.data.shape_keys:
                    for key in obj.data.shape_keys.key_blocks:
                        key.data[vertex.index].co += local_delta
                vertex.co = destination
                adjusted += 1; maximum = max(maximum, delta.length)
        obj.data.update()
    return {'method': 'weighted_rest_bone_cross_sections', 'cross_sections_m': core,
            'adjusted_vertices': adjusted, 'maximum_adjustment_m': maximum,
            'fabric_vertices_with_protected_bone_weights': protected_fabric,
            'skeleton_changed': False}


def body_targets(body, rig, spec):
    """Resolve garment attachment heights on the normalized body's actual rig."""
    targets = deepcopy(spec['fitting']['bounds'])
    feet = deepcopy(spec['fitting']['shoe_bounds'])
    lo, hi = bounds(body)
    def joint(*names):
        bone = next((rig.data.bones.get(name) for name in names if rig.data.bones.get(name)), None)
        return rig.matrix_world @ bone.head_local if bone else None
    neck, waist = joint('neck', 'Neck'), joint('Hips', 'hips')
    ankles = {side: joint(name) for side, name in (('left', 'LeftFoot'), ('right', 'RightFoot'))}
    source = [0, spec['anchors']['waist'][1], spec['anchors']['neck'][1], spec['body_height_m']]
    actual = [lo.z, waist.z if waist else source[1], neck.z if neck else source[2], hi.z]
    if not all(b > a for a, b in zip(actual, actual[1:])):
        actual = source
    # Some imported rigs place the neck joint below the shoulders. Using that
    # joint alone compresses the whole shirt down onto the stomach.
    garment_landmarks = actual.copy()
    shoulders = [p for p in (joint('LeftArm', 'LeftShoulder'), joint('RightArm', 'RightShoulder'))
                 if p is not None]
    if shoulders:
        shoulder_y = sum(p.z for p in shoulders)/len(shoulders)
        neck_rise = source[2]-spec['anchors']['shoulder_left'][1]
        garment_landmarks[2] = max(actual[2], shoulder_y+neck_rise)
    if not all(b > a for a, b in zip(garment_landmarks, garment_landmarks[1:])):
        garment_landmarks = actual
    def height(value, landmarks):
        index = next((i for i in range(3) if value <= source[i+1]), 2)
        return landmarks[index]+(value-source[index])*(landmarks[index+1]-landmarks[index])/(source[index+1]-source[index])
    for slot, target in targets.items():
        if slot == 'body':
            continue
        for corner in target:
            corner[1] = height(corner[1], garment_landmarks if slot in ('top', 'bottom') else actual)
    # Older contracts enlarged garments to contain the base body. Cropped-body
    # contracts keep the authored size instead of growing around the blue layer.
    for slot in (('top', 'bottom') if spec['fitting'].get('fit_to_body_surface', True) else ()):
        a, b = targets[slot]; points = []
        for obj in body:
            names = {g.index: g.name.lower() for g in obj.vertex_groups}
            for vertex in obj.data.vertices:
                name = names.get(max(vertex.groups, key=lambda g: g.weight).group, '') if vertex.groups else ''
                excluded = ('head', 'neck', 'hand', 'finger', 'foot', 'toe')
                if slot == 'bottom':
                    excluded += ('arm', 'shoulder')
                point = obj.matrix_world @ vertex.co
                if a[1] <= point.z <= b[1] and not any(token in name for token in excluded):
                    points.append(point)
        if points:
            margins = spec['fitting'].get('garment_margin_m', {}).get(
                slot, [spec['tolerances']['clearance_m']]*2)
            for (axis, blender_axis, sign), padding in zip(((0, 0, 1), (2, 1, -1)), margins):
                values = [sign*p[blender_axis] for p in points]
                a[axis] = min(a[axis], min(values)-padding)
                b[axis] = max(b[axis], max(values)+padding)
    for side, target in feet.items():
        ankle = ankles[side]
        if ankle is not None:
            center_x = (target[0][0]+target[1][0])/2
            for corner in target:
                corner[0] += ankle.x-center_x
                corner[2] += -ankle.y-spec['anchors'][f'ankle_{side}'][2]
    targets['shoes'] = [[min(box[0][i] for box in feet.values()) for i in range(3)],
                        [max(box[1][i] for box in feet.values()) for i in range(3)]]
    for slot in ('hair', 'hairFront', 'hairBack'):
        if slot in targets:
            targets[slot] = hair_target(body, rig, spec, slot)
    if 'hat' in targets:
        targets['hat'] = headwear_target(body, rig, spec)
    return targets, feet


def surface(objects, evaluated=False):
    vertices, triangles = [], []
    depsgraph = bpy.context.evaluated_depsgraph_get() if evaluated else None
    for original in objects:
        obj = original.evaluated_get(depsgraph) if evaluated else original
        mesh = obj.to_mesh() if evaluated else obj.data
        try:
            mesh.calc_loop_triangles(); offset = len(vertices)
            vertices.extend(obj.matrix_world @ v.co for v in mesh.vertices)
            triangles.extend(tuple(offset+i for i in t.vertices) for t in mesh.loop_triangles)
        finally:
            if evaluated:
                obj.to_mesh_clear()
    if not vertices or not triangles:
        raise ValueError('Empty collision surface')
    return BVHTree.FromPolygons(vertices, triangles, all_triangles=True), vertices, triangles


def clearance(meshes, body, minimum, maximum=None):
    tree, _, _ = surface(body)
    adjusted = 0; maximum_applied = 0.
    for obj in meshes:
        inverse = obj.matrix_world.inverted()
        for vertex in obj.data.vertices:
            world = obj.matrix_world @ vertex.co
            hit, normal, _, distance = tree.find_nearest(world)
            if hit is None:
                raise ValueError('Missing body surface')
            signed = (world-hit).dot(normal)
            if signed < minimum:
                amount = minimum-signed
                if maximum is not None:
                    amount = min(amount, maximum)
                destination = world+normal*amount
                vertex.co = inverse @ destination
                adjusted += 1; maximum_applied = max(maximum_applied, (destination-world).length)
        obj.data.update()
    return {'adjusted_vertices': adjusted, 'maximum_adjustment_m': maximum_applied}
