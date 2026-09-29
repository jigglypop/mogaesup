"""Shape-preserving shoe fitting and foot-local rigid binding."""

import bmesh
from mathutils import Matrix, Vector

from src.services.avatar_fit_geometry import target_box
from src.services.avatar_blender_common import blender_to_gltf


def _components(obj):
    """Return vertex-index sets without ever cutting an edge or triangle."""
    count = len(obj.data.vertices)
    parent = list(range(count))

    def root(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def join(a, b):
        a, b = root(a), root(b)
        if a != b:
            parent[b] = a

    # Polygon adjacency deliberately ignores provider wire edges. A loose edge
    # left in the cut strip must not reconnect the two rendered shoe shells.
    for face in obj.data.polygons:
        vertices = list(face.vertices)
        for index in range(1, len(vertices)):
            join(vertices[0], vertices[index])
    rows = {}
    for index in range(count):
        rows.setdefault(root(index), set()).add(index)
    return list(rows.values())


def _box(points):
    return (Vector([min(point[axis] for point in points) for axis in range(3)]),
            Vector([max(point[axis] for point in points) for axis in range(3)]))


def _collect(meshes):
    components = []
    all_points = []
    for obj in meshes:
        for indices in _components(obj):
            points = [obj.data.vertices[index].co.copy() for index in indices]
            if not points:
                continue
            lo, hi = _box(points)
            components.append({'object': obj, 'indices': indices, 'points': points,
                               'lo': lo, 'hi': hi, 'center': sum(points, Vector())/len(points)})
            all_points.extend(points)
    return components, all_points


def _spans_pair(component, divider, pair_width):
    return (pair_width > 1e-6
            and component['lo'].x < divider-pair_width*.12
            and component['hi'].x > divider+pair_width*.12
            and component['hi'].x-component['lo'].x > pair_width*.55)


def _cut_center_bridge(obj, divider, half_gap):
    """Bisect and remove only a narrow center band, retaining mesh data layers."""
    if obj.data.shape_keys:
        # Generated shoe parts currently have no morphs. Preserving mismatched
        # morph topology would be worse than leaving an authored connected mesh.
        return 0
    mesh = obj.data
    bm = bmesh.new()
    removed = 0
    try:
        bm.from_mesh(mesh)
        for x in (divider-half_gap, divider+half_gap):
            geometry = [*bm.verts, *bm.edges, *bm.faces]
            bmesh.ops.bisect_plane(
                bm, geom=geometry, plane_co=Vector((x, 0, 0)),
                plane_no=Vector((1, 0, 0)), dist=1e-7,
                use_snap_center=False, clear_outer=False, clear_inner=False)
        middle = [face for face in bm.faces
                  if divider-half_gap-1e-7 <= face.calc_center_median().x <= divider+half_gap+1e-7]
        if middle:
            removed = len(middle)
            bmesh.ops.delete(bm, geom=middle, context='FACES')
        loose_strip = [vertex for vertex in bm.verts
                       if not vertex.link_faces
                       and divider-half_gap-1e-7 <= vertex.co.x <= divider+half_gap+1e-7]
        if loose_strip:
            bmesh.ops.delete(bm, geom=loose_strip, context='VERTS')
        bm.to_mesh(mesh)
        mesh.update()
    finally:
        bm.free()
    return removed


def fit_shoes_rigid(meshes, targets):
    """Seat a shoe pair per foot while preserving topology and proportions.

    Disconnected buckles, soles, laces and similar authored pieces follow the
    same side transform as their nearest shoe. A connected component is never
    split at the character center line.
    """
    if not meshes:
        raise ValueError('Missing shoe geometry')
    for obj in meshes:
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        # Work in the same parent-free world-coordinate contract as bind().
        world = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = Matrix.Identity(4)
        obj.data.transform(world, shape_keys=True)

    components, all_points = _collect(meshes)
    if not all_points:
        raise ValueError('Missing shoe geometry')

    pair_lo, pair_hi = _box(all_points)
    divider = (pair_lo.x+pair_hi.x)/2
    pair_width = pair_hi.x-pair_lo.x
    bridge_faces_removed = 0
    center_half_gap = 0.0
    topology_split = any(_spans_pair(row, divider, pair_width) for row in components)
    if topology_split:
        crossing = {row['object'] for row in components if _spans_pair(row, divider, pair_width)}
        # Start with a 2% total seam. Widen only when the provider created a
        # thicker center bridge; target-box fitting supplies the final foot gap.
        for fraction in (.01, .02, .04, .08):
            center_half_gap = pair_width*fraction
            bridge_faces_removed += sum(_cut_center_bridge(obj, divider, center_half_gap)
                                        for obj in crossing)
            components, all_points = _collect(meshes)
            if (components
                    and not any(_spans_pair(row, divider, pair_width) for row in components)
                    and any(row['center'].x >= divider for row in components)
                    and any(row['center'].x < divider for row in components)):
                break

    regions = {obj: {} for obj in meshes}
    sides = {'left': [], 'right': []}
    for component in components:
        side = 'left' if component['center'].x >= divider else 'right'
        component['side'] = side
        sides[side].append(component)
        for index in component['indices']:
            regions[component['object']][index] = side
    if any(not sides[side] for side in sides):
        raise ValueError('Shoe geometry must contain separate left and right components')

    source_boxes = {}
    target_boxes = {side: target_box(targets[side]) for side in sides}
    scale_limits = []
    for side, rows in sides.items():
        points = [point for row in rows for point in row['points']]
        lo, hi = source_boxes[side] = _box(points)
        target_lo, target_hi = target_boxes[side]
        source_size, target_size = hi-lo, target_hi-target_lo
        if min(source_size) <= 1e-6 or min(target_size) <= 1e-6:
            raise ValueError(f'Degenerate {side} shoe bounds')
        # The footprint (width, length) sets the scale; a boot's shaft keeps its authored height
        # instead of shrinking the whole boot into a sneaker's box and inside the calf.
        scale_limits.extend(target_size[axis]/source_size[axis] for axis in (0, 1))
    minimum_gap = .008
    target_centers_x = {side: sum(target_boxes[side][corner].x for corner in (0, 1))/2
                        for side in sides}
    target_center_separation = abs(target_centers_x['left']-target_centers_x['right'])
    source_half_width_sum = sum((source_boxes[side][1].x-source_boxes[side][0].x)/2
                                for side in sides)
    # Some production targets overlap because ankle distance is narrower than
    # two nominal shoe boxes. Bound the shared scale by the actual center gap.
    gap_scale_limit = ((target_center_separation-minimum_gap)/source_half_width_sum
                       if source_half_width_sum > 1e-6 else 0)
    if gap_scale_limit <= 0:
        raise ValueError('Shoe target centers cannot provide the minimum foot gap')
    scale_limits.append(gap_scale_limit)
    scale = min(scale_limits)
    if not 1e-4 <= scale <= 1e4:
        raise ValueError('Invalid shoe scale')

    transforms = {}
    reports = {}
    for side in sides:
        lo, hi = source_boxes[side]
        target_lo, target_hi = target_boxes[side]
        # Align the sole vertically and center the footprint. This leaves boot
        # height, heel thickness and toe shape in their authored proportions.
        source_anchor = Vector(((lo.x+hi.x)/2, (lo.y+hi.y)/2, lo.z))
        target_anchor = Vector(((target_lo.x+target_hi.x)/2,
                                (target_lo.y+target_hi.y)/2, target_lo.z))
        transforms[side] = (Matrix.Translation(target_anchor)
                            @ Matrix.Scale(scale, 4)
                            @ Matrix.Translation(-source_anchor))
        reports[side] = {
            'source_bounds_blender': [list(lo), list(hi)],
            'target_bounds_gltf': targets[side],
            'source_anchor_gltf': blender_to_gltf(source_anchor),
            'target_anchor_gltf': blender_to_gltf(target_anchor),
            'components': len(sides[side]),
            'vertices': sum(len(row['indices']) for row in sides[side]),
        }

    for obj in meshes:
        for index, side in regions[obj].items():
            transform = transforms[side]
            vertex = obj.data.vertices[index]
            if obj.data.shape_keys:
                for key in obj.data.shape_keys.key_blocks:
                    key.data[index].co = transform @ key.data[index].co
            vertex.co = transform @ vertex.co
        obj.data.update()
    return ({'method': 'connected_components_uniform_per_foot',
             'uniform_scale': scale, 'divider_x_m': divider,
             'minimum_gap_m': minimum_gap,
             'fitted_gap_m': target_center_separation-source_half_width_sum*scale,
             'topology_split': topology_split,
             'bridge_faces_removed': bridge_faces_removed,
             'source_center_half_gap_m': center_half_gap,
             'feet': reports}, regions)


def _foot_bone(rig, side):
    wanted = side+'foot'
    bone = next((bone for bone in rig.data.bones
                 if bone.name.lower().split(':')[-1] == wanted), None)
    if bone is None:
        raise ValueError(f'Missing {side.title()}Foot bone')
    return bone.name


def bind_shoes_rigid(meshes, rig, regions):
    """Bind every shoe component wholly to its anatomical foot bone."""
    bones = {side: _foot_bone(rig, side) for side in ('left', 'right')}
    counts = {'left': 0, 'right': 0}
    for obj in meshes:
        assignments = regions.get(obj)
        if assignments is None or len(assignments) != len(obj.data.vertices):
            raise ValueError(f'Incomplete shoe side assignment: {obj.name}')
        if any(mod.type == 'ARMATURE' for mod in obj.modifiers):
            raise ValueError('Part is already rigged; supply the unrigged generated shape')
        world = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = Matrix.Identity(4)
        obj.data.transform(world, shape_keys=True)
        obj.vertex_groups.clear()
        groups = {side: obj.vertex_groups.new(name=name) for side, name in bones.items()}
        for index, side in assignments.items():
            groups[side].add([index], 1.0, 'REPLACE')
            counts[side] += 1
        modifier = obj.modifiers.new('CanonicalShoeSkin', 'ARMATURE')
        modifier.object = rig
        obj['standard_slot'] = 'shoes'
        obj.data.update()
    return {'binding': 'rigid_per_foot', 'bones': bones,
            'vertices_per_foot': counts, 'weights': 'single_anatomical_foot_bone',
            'cross_foot_weights': 0, 'body_surface_transfer': False,
            'visual_review': 'required'}


def finish_shoes_after_pose(meshes, rig, minimum_gap=.008):
    """Re-seat rigid shoes after the canonical rest pose narrows the ankles."""
    bones = {side: _foot_bone(rig, side) for side in ('left', 'right')}
    bone_x = {side: (rig.matrix_world @ rig.data.bones[name].head_local).x
              for side, name in bones.items()}
    rows = {'left': [], 'right': []}
    for obj in meshes:
        names = {group.index: group.name for group in obj.vertex_groups}
        inverse = obj.matrix_world.inverted()
        for vertex in obj.data.vertices:
            weights = {side: sum(link.weight for link in vertex.groups
                                 if names.get(link.group) == bone)
                       for side, bone in bones.items()}
            side = max(weights, key=weights.get)
            if weights[side] <= 1e-8:
                raise ValueError(f'Shoe vertex has no anatomical foot weight: {obj.name} {vertex.index}')
            rows[side].append((obj, vertex.index, obj.matrix_world @ vertex.co, inverse))
    if any(not rows[side] for side in rows):
        raise ValueError('Both anatomical shoes are required after rest-pose fitting')

    before_boxes = {side: _box([row[2] for row in values]) for side, values in rows.items()}
    before_centers = {side: (box[0].x+box[1].x)/2 for side, box in before_boxes.items()}
    before_half_width_sum = sum((box[1].x-box[0].x)/2 for box in before_boxes.values())
    before_gap = abs(before_centers['left']-before_centers['right'])-before_half_width_sum
    separation = abs(bone_x['left']-bone_x['right'])
    if separation <= minimum_gap or before_half_width_sum <= 1e-8:
        raise ValueError('Final foot centers cannot provide the requested shoe gap')
    scale = min(1.0, (separation-minimum_gap)/before_half_width_sum)

    transforms = {}
    for side, box in before_boxes.items():
        lo, hi = box
        # The anchor keeps the existing footprint depth and sole height. Only
        # x is re-centered on the final rest-pose foot joint.
        source = Vector(((lo.x+hi.x)/2, (lo.y+hi.y)/2, lo.z))
        destination = Vector((bone_x[side], source.y, source.z))
        transforms[side] = (Matrix.Translation(destination)
                            @ Matrix.Scale(scale, 4)
                            @ Matrix.Translation(-source))

    adjusted = 0
    for side, values in rows.items():
        transform = transforms[side]
        for obj, index, point, inverse in values:
            vertex = obj.data.vertices[index]
            if obj.data.shape_keys:
                for key in obj.data.shape_keys.key_blocks:
                    key.data[index].co = inverse @ (transform @ (obj.matrix_world @ key.data[index].co))
            vertex.co = inverse @ (transform @ point)
            adjusted += 1
    for obj in meshes:
        obj.data.update()

    after_boxes = {side: _box([obj.matrix_world @ obj.data.vertices[index].co
                               for obj, index, _, _ in values])
                   for side, values in rows.items()}
    after_centers = {side: (box[0].x+box[1].x)/2 for side, box in after_boxes.items()}
    after_half_width_sum = sum((box[1].x-box[0].x)/2 for box in after_boxes.values())
    final_gap = abs(after_centers['left']-after_centers['right'])-after_half_width_sum
    return {'method': 'post_rest_pose_rigid_foot_reseat',
            'minimum_gap_m': minimum_gap, 'gap_before_m': before_gap,
            'final_gap_m': final_gap, 'uniform_scale': scale,
            'foot_bone_x_m': bone_x, 'shoe_center_x_m': after_centers,
            'adjusted_vertices': adjusted, 'weights_preserved': True,
            'skeleton_changed': False}
