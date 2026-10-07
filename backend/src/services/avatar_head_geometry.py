"""Head-part preparation: preserve hat proportions and separate duplicated headwear."""
import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

from src.services.avatar_blender_common import bone_key
from src.services.avatar_fit_geometry import bounds, head_region, place, surface, target_box
from src.services.avatar_part_gate import EYE_COLUMNS


def face_samples(meshes):
    samples = []
    pixels = {}
    for obj in meshes:
        uv = obj.data.uv_layers.active
        if uv is None:
            continue
        materials = obj.data.materials
        for face in obj.data.polygons:
            # A face may point past the material slots (a provider mesh with fewer slots than indices).
            material = materials[face.material_index] if face.material_index < len(materials) else None
            if not material or not material.use_nodes:
                continue
            shader = next((n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            links = shader.inputs['Base Color'].links if shader else []
            node = links[0].from_node if links else None
            if node is None or node.type != 'TEX_IMAGE' or node.image is None:
                continue
            image = node.image
            if image not in pixels:
                values = np.empty(len(image.pixels), dtype=np.float32)
                image.pixels.foreach_get(values)
                pixels[image] = values.reshape(image.size[1], image.size[0], image.channels)
            coord = sum((uv.data[i].uv for i in face.loop_indices), Vector((0, 0)))/len(face.loop_indices)
            x = max(0, min(image.size[0]-1, int(coord.x*image.size[0])))
            y = max(0, min(image.size[1]-1, int(coord.y*image.size[1])))
            color = pixels[image][y, x, :3].astype(float)
            if color.sum() > .05:
                samples.append((obj, face.index, obj.matrix_world @ face.center,
                                color/color.sum(), material, coord.copy()))
    return samples


def headwear_palette(meshes):
    rows = face_samples(meshes)
    return np.median([row[3] for row in rows], axis=0) if rows else None


def underlayer_faces(meshes):
    """Identify fabric, including saved teal sources, without selecting the face."""
    result = {}
    lo, hi = bounds(meshes)
    neck_limit = lo.z+(hi.z-lo.z)*.48
    for obj in meshes:
        materials = obj.data.materials
        for face in obj.data.polygons:
            material = materials[face.material_index] if face.material_index < len(materials) else None
            if material and material.get('base_underlayer'):
                result.setdefault(obj, set()).add(face.index)
    for obj, index, point, color, _, _ in face_samples(meshes):
        teal = color[1] > color[0]*1.15 and color[2] > color[0]*1.05
        white = max(color)-min(color) < .025
        if point.z < neck_limit and (teal or white):
            result.setdefault(obj, set()).add(index)
    return result


def whiten_base_body(body, spec):
    fabric = underlayer_faces(body)
    material = bpy.data.materials.new('WhiteBaseUnderlayer')
    material.use_nodes = True; material['base_underlayer'] = True
    shader = next(n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    shader.inputs['Base Color'].default_value = spec['base_body'].get('color_rgba', (.86, .86, .84, 1))
    shader.inputs['Roughness'].default_value = .9
    faces = 0
    for obj, indices in fabric.items():
        obj.data.materials.append(material); index = len(obj.data.materials)-1
        for face_index in indices:
            obj.data.polygons[face_index].material_index = index
            faces += 1
    return {'material': material.name, 'faces': faces, 'color': 'matte_white'}


def prepare_rear_hair(meshes, body, hat_palette, spec):
    """Remove a distinct headwear-colored crown, retaining the saved source GLB."""
    rows = face_samples(meshes)
    report = {'removed_headwear_faces': 0, 'scalp_shell': False}
    if not rows or hat_palette is None:
        return report
    lo, hi = bounds(meshes)
    span = max(hi.z-lo.z, .001)
    hair = [row for row in rows if row[2].z < lo.z+span*.35]
    crown = [row for row in rows if row[2].z > lo.z+span*.85]
    if not hair or not crown:
        return report
    hair_color = np.median([row[3] for row in hair], axis=0)
    crown_color = np.median([row[3] for row in crown], axis=0)
    difference = crown_color-hair_color
    separation = float(np.linalg.norm(difference))
    # A single-color hairstyle has no separable headwear region. Do not cut it.
    if separation < .012 or np.linalg.norm(crown_color-hat_palette) >= np.linalg.norm(hair_color-hat_palette):
        return report
    removed = {}
    for obj, index, point, color, _, _ in rows:
        score = float(np.dot(color-hair_color, difference)/np.dot(difference, difference))
        if point.z > lo.z+span*.36 and score > .48:
            removed.setdefault(obj, set()).add(index)
    for obj, indices in removed.items():
        mesh = bmesh.new()
        try:
            mesh.from_mesh(obj.data); mesh.faces.ensure_lookup_table()
            bmesh.ops.delete(mesh, geom=[mesh.faces[i] for i in indices], context='FACES')
            mesh.to_mesh(obj.data)
        finally:
            mesh.free()
        obj.data.update()
        report['removed_headwear_faces'] += len(indices)
    if not report['removed_headwear_faces']:
        return report
    # The mixed cap/hair crown is not usable hair geometry. Keep the detailed
    # lower locks and extend their roots to the hat seat instead of displaying
    # fragmented cap remnants or a large smooth replacement plate.
    root_line = lo.z+span*.60
    destination = spec['fitting'].get('hat_hairline_m', spec['body_height_m']*.95)
    for obj in meshes:
        mesh = bmesh.new()
        try:
            mesh.from_mesh(obj.data)
            bmesh.ops.bisect_plane(mesh, geom=[*mesh.verts, *mesh.edges, *mesh.faces],
                dist=1e-6, plane_co=Vector((0, 0, root_line)), plane_no=Vector((0, 0, 1)),
                clear_inner=False, clear_outer=True)
            for vertex in mesh.verts:
                vertex.co.z = lo.z+(vertex.co.z-lo.z)*(destination-lo.z)/(root_line-lo.z)
            mesh.to_mesh(obj.data)
        finally:
            mesh.free()
        obj.data.update()
    report['rear_locks_extended_to_m'] = destination
    return report


def fit_reference_frame(meshes, reference_bounds, slot):
    """Register metric reference images without stretching the source mesh."""
    lo, hi = bounds(meshes); a, b = target_box(reference_bounds)
    size, desired = hi-lo, b-a
    if min(size) <= 1e-8 or min(desired) <= 1e-8:
        raise ValueError('Part reference has no measurable extent')
    scale = float(np.median([desired[i]/size[i] for i in range(3)]))
    source, destination = (lo+hi)/2, (a+b)/2
    transform = Matrix.Translation(destination) @ Matrix.Scale(scale, 4) @ Matrix.Translation(-source)
    return transform, [], {'method': f'uniform_{slot}_on_shared_image_frame_v2', 'scale': scale,
                           'reference_bounds_gltf': reference_bounds,
                           'source_proportions_preserved': True}


def crown_width(meshes, *, brim=.8):
    """Width of a hat's crown. A brim (the hat much wider low down than over its upper 60%) never
    sets the size, or a straw hat shrinks until its crown perches on top of the head."""
    width, brimmed, _ = crown_frame(meshes, brim=brim)
    return width, brimmed


def crown_frame(meshes, *, brim=.8):
    """(width, brimmed, (x, y) centre) of a hat's crown: its upper 60%. A cap's peak reaches far forward of its
    crown, so the crown's centre, not the whole hat's, goes over the head's (centred on its box, a cap sat behind
    the head and the forehead came through its front)."""
    points = np.array([tuple(obj.matrix_world @ vertex.co) for obj in meshes for vertex in obj.data.vertices])
    low, height = points[:, 2].min(), np.ptp(points[:, 2])
    upper = points[points[:, 2] >= low + .4*height]
    if len(upper) <= 10:
        upper = points
    overall = np.ptp(points[:, 0])
    crown = np.ptp(upper[:, 0])
    centre = ((upper[:, 0].min() + upper[:, 0].max())/2, (upper[:, 1].min() + upper[:, 1].max())/2)
    return (crown, True, centre) if crown < brim*overall else (overall, False, centre)


def fit_hat(meshes, target, width_scale=1.0, reference_bounds=None):
    """Uniformly fit headwear to the measured body head and crown seat."""
    if reference_bounds is not None:
        # A bow or hair clip must retain its reference size and offset instead
        # of being expanded to the entire head width like a cap.
        return fit_reference_frame(meshes, reference_bounds, 'hat')
    lo, hi = bounds(meshes); a, b = target_box(target)
    width, brimmed, centre = crown_frame(meshes)
    scale = (b.x-a.x)/width*width_scale
    source = Vector((centre[0], centre[1], hi.z))
    destination = Vector(((a.x+b.x)/2, (a.y+b.y)/2, b.z))
    transform = Matrix.Translation(destination) @ Matrix.Scale(scale, 4) @ Matrix.Translation(-source)
    return transform, [], {'method': 'uniform_hat_scale_on_measured_body_head', 'scale': scale,
                           'sized_by': 'crown' if brimmed else 'overall_width',
                           'target_head_width_m': b.x-a.x,
                           'fitted_width_m': (hi.x-lo.x)*scale,
                           'crown_height_m': b.z, 'source_proportions_preserved': True}


# A hat's lowest point over the eyes (in front of the head's middle, out to the eyes' outer corners) stays above this
# share of the head's height, its skin from chin to crown: the seal's quality gate refuses a hat under
# avatar_part_gate.HAT_MIN_EYE_LINE (a beanie at .554 sat on the brows, a cap at .431 over the eyes), and the seat leaves
# a little room above that.
HAT_EYE_LINE = .62
# A hat that comes lower is too deep for the SD head: sized to the head's width and hung from the crown, a generated
# beanie or cap is as deep as a real one, and the SD head's dome above the brows is half its width. Its height is taken
# in about its crown down to this share of it ...
HAT_HEIGHT_LIMIT = .6
# ... and what is still too low makes the whole hat smaller about its crown, down to this, so it stays on the head
# instead of floating above it (a lifted crown stood off the skull, which clearance only pushes outward).
HAT_MIN_SCALE = .75


def head_skin(body):
    """(lowest, highest) corners of the skin whose strongest bone is the head, as the quality gate measures the head,
    or None when no skin follows a head bone."""
    points = []
    for obj in body:
        heads = {group.index for group in obj.vertex_groups if bone_key(group.name) == 'head'}
        if not heads:
            continue
        for vertex in obj.data.vertices:
            if vertex.groups and max(vertex.groups, key=lambda entry: entry.weight).group in heads:
                points.append(tuple(obj.matrix_world @ vertex.co))
    if not points:
        return None
    points = np.array(points, dtype=float)
    return Vector(points.min(axis=0)), Vector(points.max(axis=0))


def _eye_low(meshes, lo, hi):
    """The lowest Z of the hat over the eyes: in front of the head's middle (Blender -Y), within EYE_COLUMNS[1] of the
    head's half width from its middle line. None when no part of the hat is there."""
    points = np.array([tuple(obj.matrix_world @ vertex.co) for obj in meshes for vertex in obj.data.vertices],
                      dtype=float).reshape(-1, 3)
    over = ((points[:, 1] < (lo.y + hi.y)/2)
            & (np.abs(points[:, 0] - (lo.x + hi.x)/2) <= EYE_COLUMNS[1]*(hi.x - lo.x)/2))
    return float(points[over, 2].min()) if over.any() else None


def seat_hat_above_brows(meshes, body, rig, spec, *, line_share=HAT_EYE_LINE, limit=HAT_HEIGHT_LIMIT,
                         smallest=HAT_MIN_SCALE):
    """Keep a fitted hat above the eyes, in place.

    Its lowest point over the eyes (_eye_low, as the quality gate measures it) must stay above `line_share` of the
    head's height (head_skin). A hat that comes lower first has its height taken in about its crown, width and depth
    unchanged, down to `limit` of it; what is still too low makes the whole hat smaller about its crown, down to
    `smallest`, so its crown still sits on the head. It is never lifted: a hat that still covers the eyes is left for the
    gate to refuse. Returns the receipt."""
    frame = head_skin(body)
    lo, hi = frame if frame else head_region(body, rig, spec)[:2]
    line = lo.z + line_share*(hi.z - lo.z)
    report = {'method': 'hat_above_eyes_v2', 'eye_line_m': float(line), 'eye_line_share': line_share,
              'height_scale': 1., 'scale': 1., 'lift_m': 0.}
    low = _eye_low(meshes, lo, hi)
    if low is None:
        return {**report, 'reason': 'nothing_over_the_eyes'}
    report['eye_low_before_m'] = low
    if low >= line:
        return report
    _, _, (centre_x, centre_y) = crown_frame(meshes)
    top = float(bounds(meshes)[1].z)
    if top - low <= 1e-6:
        return report
    height = max(limit, (top - line)/(top - low))
    pivot = Vector((centre_x, centre_y, top))
    place(meshes, Matrix.Translation(pivot) @ Matrix.Diagonal((1., 1., height, 1.)) @ Matrix.Translation(-pivot))
    report.update(height_scale=float(height), source_proportions_preserved=False)
    low = _eye_low(meshes, lo, hi)
    if low is not None and low < line and top - low > 1e-6:
        scale = max(smallest, (top - line)/(top - low))
        place(meshes, Matrix.Translation(pivot) @ Matrix.Scale(scale, 4) @ Matrix.Translation(-pivot))
        report['scale'] = float(scale)
        low = _eye_low(meshes, lo, hi)
    report.update(eye_low_after_m=low, clear=low is None or low >= line - 1e-6)
    return report


HAT_CAVITY_LIMIT = 1.25         # the most a hat is enlarged for the skull (as hair_cavity_scale_limit)
# A hat surface this much nearer the head's centre than the skull, or farther, is not the inside the skull rests
# against: a fold or lining reaching into the hat (a pinched beanie's crown), or the far side of a brim.
HAT_CAVITY_RATIOS = (.75, 1.3)


def fit_hat_cavity(meshes, body, rig, spec, *, limit=HAT_CAVITY_LIMIT, accepted=HAT_CAVITY_RATIOS):
    """Enlarge a hat uniformly about the head's centre, in place, until its inside clears the skull.

    As fit_hair_cavity seats a wig: rays from the head's centre through the skull (not low over the face) meet the
    hat's inside, and the 90th percentile of (skin + clearance)/hat distance enlarges it, up to `limit`. Only hat
    surfaces at a believable distance count (`accepted` bounds that ratio): the crease a pinched beanie folds into
    its crown came within millimetres of the head's centre and enlarged the hat by the whole limit, far wider than
    the head."""
    lo, hi, collar = head_region(body, rig, spec)
    centre = (lo + hi)/2
    centre.z = (max(lo.z, collar) + hi.z)/2
    clearance = spec['fitting'].get('scalp_clearance_m', .003)
    skin, _, _ = surface(body)
    hat, _, _ = surface(meshes)
    ratios, sectors, rejected = [], set(), 0
    for elevation in (.05, .3, .55, .8):
        horizontal = float(np.sqrt(1 - elevation*elevation))
        for step in range(24):
            angle = step*np.pi/12
            ray = Vector((float(np.sin(angle))*horizontal, float(np.cos(angle))*horizontal, elevation))
            if ray.y < -.25 and elevation < .75:
                continue
            skin_hit, hat_hit = skin.ray_cast(centre, ray), hat.ray_cast(centre, ray)
            if skin_hit[0] is None or hat_hit[0] is None or hat_hit[3] <= 1e-8:
                continue
            ratio = (skin_hit[3] + clearance)/hat_hit[3]
            if accepted[0] <= ratio <= accepted[1]:
                ratios.append(ratio)
                sectors.add(step//6)
            else:
                rejected += 1
    report = {'method': 'sampled_inner_hat_cavity_v1', 'samples': len(ratios), 'rejected_samples': rejected,
              'sectors': len(sectors), 'scale': 1., 'center_blender': list(centre), 'accepted_ratios': list(accepted),
              'source_proportions_preserved': True}
    if len(ratios) < 12 or len(sectors) < 3:
        return {**report, 'reason': 'insufficient_cavity_surface'}
    requested = max(1., float(np.percentile(ratios, 90)))
    scale = min(requested, limit)
    report.update(requested_scale=requested, scale=scale, scale_limit=limit, limited=requested > limit)
    if scale > 1.0001:
        place(meshes, Matrix.Translation(centre) @ Matrix.Scale(scale, 4) @ Matrix.Translation(-centre))
    return report


def hat_target_over_hair(target, hair, spec):
    """Seat headwear around the upper hairstyle without sizing to hanging locks."""
    a, b = target_box(target)
    hair_lo, hair_hi = bounds(hair)
    seat_height = a.z
    crown = [obj.matrix_world @ vertex.co for obj in hair for vertex in obj.data.vertices
             if (obj.matrix_world @ vertex.co).z >= seat_height]
    if not crown:
        return target, {'method': 'measured_head_fallback', 'seat_height_m': seat_height,
                        'reason': 'no_hair_vertices_above_seat'}
    crown_lo = Vector([min(point[i] for point in crown) for i in range(3)])
    crown_hi = Vector([max(point[i] for point in crown) for i in range(3)])
    authored = spec['fitting']['bounds']
    base_width = max(b.x-a.x, crown_hi.x-crown_lo.x)
    # Both inputs are already measured in the canonical head frame. Applying
    # the legacy hat/hair envelope ratio again shrinks the cap below head width.
    width = base_width
    center_x = (crown_lo.x+crown_hi.x)/2
    crown_rise = max(0., authored['hat'][1][1]-authored['hair'][1][1])
    depth_center = (crown_lo.y+crown_hi.y)/2
    depth = max(b.y-a.y, crown_hi.y-crown_lo.y)
    fitted = [[center_x-width/2, seat_height, -depth_center-depth/2],
              [center_x+width/2, hair_hi.z+crown_rise, -depth_center+depth/2]]
    return fitted, {'method': 'measured_upper_hair_seat',
                    'seat_height_m': seat_height,
                    'hair_crown_bounds_gltf': [[crown_lo.x, crown_lo.z, -crown_hi.y],
                                                [crown_hi.x, crown_hi.z, -crown_lo.y]],
                    'measured_head_width_m': b.x-a.x,
                    'measured_crown_width_m': crown_hi.x-crown_lo.x,
                    'authored_crown_rise_m': crown_rise,
                    'target_width_before_clearance_m': width}


def dome_top(points, width, *, share=.55, step=.005):
    """Top of the hair's dome, below a bun or top knot. Scanning down from the top, the first slice
    at least `share` of the dome's width sits .165 of its radius under a round dome's top; a narrow
    knot above it is not the crown (it sank the whole style over the face)."""
    top, low = points[:, 2].max(), points[:, 2].min()
    radius = width/2
    for z in np.arange(top, low, -step):
        band = points[np.abs(points[:, 2]-z) <= step/2]
        if len(band) >= 8 and np.ptp(band[:, 0]) >= share*width:
            return float(min(top, z+(1-np.sqrt(1-share*share))*radius))
    return float(top)


def hair_scalp_frame(meshes, target):
    """Estimate the attachment region separately from tips and hanging locks.

    This is an inferred frame, not a measurement of a hidden head cavity. A
    bounded number of passes estimates the head-height band from the measured
    target head aspect ratio. Percentiles keep isolated spikes out of its pivot.
    All source geometry, including those spikes, keeps the same uniform scale.
    """
    points = np.array([list(obj.matrix_world @ vertex.co)
                       for obj in meshes for vertex in obj.data.vertices], dtype=float)
    a, b = target_box(target)
    crown = float(np.percentile(points[:, 2], 99))
    lower, upper = np.percentile(points, [2, 98], axis=0)
    crown = min(crown, dome_top(points, upper[0]-lower[0]))
    target_span = b-a
    for _ in range(3):
        width, depth = upper[:2]-lower[:2]
        scale = max(target_span.x/max(width, 1e-8), target_span.y/max(depth, 1e-8))
        floor = crown-target_span.z/max(scale, 1e-8)
        band = points[(points[:, 2] >= floor) & (points[:, 2] <= crown)]
        if len(band) < 8:
            break
        lower, upper = np.percentile(band, [2, 98], axis=0)
    # Only X/Y and the crown are used to register the attachment frame. Lower
    # strand length must not move its center or change the scalp scale.
    upper[2] = crown
    return Vector(lower), Vector(upper)


def fit_hair(meshes, target, spec, slot='hair', head_bounds=None, reference_bounds=None):
    """Uniform fit, with a versioned scalp frame for complete hairstyles."""
    lo, hi = bounds(meshes); a, b = target_box(target)
    scalp_frame = slot == 'hair' and spec['fitting'].get('hair_surface_fit') in (
        'scalp-frame-v2-bounded', 'cavity-reference-v3', 'cavity-reference-v4')
    if scalp_frame and reference_bounds is not None:
        # Generated views share the measured body's canvas. Their saved image
        # bounds retain the designed hair-to-head ratio, unlike a skull box.
        # Uploaded/tightly cropped views are never treated as metric references.
        transform, anchors, report = fit_reference_frame(meshes, reference_bounds, slot)
        report['hair_length'] = spec['fitting'].get('hair_length', 'source')
        return transform, anchors, report
    if scalp_frame:
        # hair_length controls tips, not the height of the attachment region.
        frame_target = [list(target[0]), list(target[1])]
        if head_bounds:
            frame_target[0][1] = head_bounds[0].z
            frame_target[1][1] = head_bounds[1].z
        lo, hi = hair_scalp_frame(meshes, frame_target)
    source_width, source_depth = hi.x-lo.x, hi.y-lo.y
    target_width, target_depth = b.x-a.x, b.y-a.y
    if min(source_width, source_depth, target_width, target_depth) <= 1e-8:
        raise ValueError('Hair has no measurable scalp footprint')
    width_scale = target_width/source_width
    depth_scale = target_depth/source_depth
    # An outer frame cannot prove cavity fit or rear coverage. Preserve the
    # silhouette with one scale; only small local clearance is applied later.
    scale = max(width_scale, depth_scale)
    source = Vector(((lo.x+hi.x)/2, (lo.y+hi.y)/2, hi.z))
    destination = Vector(((a.x+b.x)/2, (a.y+b.y)/2, b.z))
    transform = Matrix.Translation(destination) @ Matrix.Scale(scale, 4) @ Matrix.Translation(-source)
    return transform, [], {'method': ('uniform_hair_scalp_frame_v2' if scalp_frame
                                      else 'uniform_hair_scale_on_measured_head'), 'scale': scale,
                           'source_attachment_bounds_blender': [list(lo), list(hi)],
                           'attachment_frame_inferred': scalp_frame,
                           'width_scale_required': width_scale,
                           'depth_scale_required': depth_scale,
                           'target_head_width_m': target_width,
                           'target_head_depth_m': target_depth,
                           'crown_height_m': b.z, 'source_proportions_preserved': True,
                           'hair_length': spec['fitting'].get('hair_length', 'source')}


def fit_hair_length(meshes, target, spec, scalp_floor=None):
    """Adjust hanging strands below the crown, retaining scalp width and depth."""
    ratio = spec['fitting'].get('hair_length_head_ratio')
    if ratio is None:
        return {'method': 'preserve_source_length'}
    lo, hi = bounds(meshes); a, b = target_box(target)
    source_length, target_length = hi.z-lo.z, b.z-a.z
    if min(source_length, target_length) <= 1e-8:
        raise ValueError('Hair has no measurable length')
    # Keep the crown dome unchanged. Only the lower strands are extended or
    # shortened, with a continuous mapping at the protected scalp boundary.
    protected = min(source_length, target_length)*.35
    if spec['fitting'].get('hair_surface_fit') in ('scalp-frame-v2-bounded', 'cavity-reference-v3', 'cavity-reference-v4') and scalp_floor is not None:
        protected = max(0., hi.z-scalp_floor)
        if source_length <= protected+1e-8 or target_length <= protected+1e-8:
            return {'method': 'preserve_scalp_no_resizable_strands',
                    'source_length_m': source_length, 'requested_length_m': target_length,
                    'protected_crown_m': protected}
    shoulder = hi.z-protected
    strand_scale = (target_length-protected)/(source_length-protected)
    for obj in meshes:
        inverse = obj.matrix_world.inverted()
        for vertex in obj.data.vertices:
            point = obj.matrix_world @ vertex.co
            if point.z < shoulder:
                point.z = shoulder-(shoulder-point.z)*strand_scale
                vertex.co = inverse @ point
        obj.data.update()
    return {'method': 'strands_below_fixed_crown', 'head_height_ratio': ratio,
            'source_length_m': source_length, 'target_length_m': target_length,
            'protected_crown_m': protected, 'strand_scale': strand_scale,
            'width_and_depth_preserved': True}


def fit_hair_scalp(meshes, body, rig, spec):
    """Seat existing hair surfaces outside the actual skull without adding faces.

    Outer hair bounds include hanging locks and do not describe its head cavity.
    A small generic clearance cap leaves deeply intersecting scalp vertices inside
    the head. Resolve the full displacement in the skull region; keep the bounded
    correction below the head so long strands retain their authored silhouette.
    """
    head_lo, _, _ = head_region(body, rig, spec)
    tree, _, _ = surface(body)
    minimum = spec['fitting'].get('hair_clearance_m', .025)
    lower_limit = max(minimum, spec['tolerances'].get('max_surface_adjustment_m', .015))
    adjusted = scalp_adjusted = 0
    maximum_applied = 0.
    for obj in meshes:
        inverse = obj.matrix_world.inverted()
        for vertex in obj.data.vertices:
            point = obj.matrix_world @ vertex.co
            hit, normal, _, _ = tree.find_nearest(point)
            if hit is None:
                raise ValueError('Missing head surface')
            signed = (point-hit).dot(normal)
            if signed >= minimum:
                continue
            amount = minimum-signed
            scalp = point.z >= head_lo.z and hit.z >= head_lo.z
            if not scalp:
                amount = min(amount, lower_limit)
            destination = point+normal*amount
            vertex.co = inverse @ destination
            adjusted += 1
            scalp_adjusted += int(scalp)
            maximum_applied = max(maximum_applied, (destination-point).length)
        obj.data.update()
    return {'method': 'measured_skull_surface_fit_v1', 'adjusted_vertices': adjusted,
            'scalp_adjusted_vertices': scalp_adjusted, 'head_floor_m': head_lo.z,
            'maximum_adjustment_m': maximum_applied, 'lower_strand_limit_m': lower_limit,
            'topology_preserved': True, 'uv_preserved': True, 'added_faces': 0}


def fit_hair_scalp_bounded(meshes, body, rig, spec):
    """Apply small radial clearance without nearest-face direction flips.

    Deep intersections and missing rear faces cannot be repaired by projecting
    each vertex onto the skull. Keep displacement bounded and preserve the
    actual topology; adjustment counts describe the operation, not approval.
    """
    lo, hi, _ = head_region(body, rig, spec)
    center = (lo+hi)/2
    tree, _, _ = surface(body)
    minimum = spec['fitting'].get('scalp_clearance_m', .003)
    maximum = spec['tolerances'].get('max_surface_adjustment_m', .015)
    adjusted = limited = 0
    maximum_applied = 0.
    for obj in meshes:
        inverse = obj.matrix_world.inverted()
        for vertex in obj.data.vertices:
            point = obj.matrix_world @ vertex.co
            if point.z < lo.z:
                continue
            ray = point-center
            distance = ray.length
            if distance <= 1e-8:
                continue
            direction = ray/distance
            hit, _, _, radius = tree.ray_cast(center, direction)
            if hit is None or hit.z < lo.z:
                continue
            required = radius+minimum-distance
            if required <= 0:
                continue
            # Blend into untouched hanging strands at the head floor.
            blend = min(1., (point.z-lo.z)/max((hi.z-lo.z)*.15, 1e-8))
            amount = min(required, maximum)*blend*blend*(3-2*blend)
            limited += int(required > amount+1e-8)
            if amount <= 1e-8:
                continue
            vertex.co = inverse @ (point+direction*amount)
            adjusted += 1
            maximum_applied = max(maximum_applied, amount)
        obj.data.update()
    return {'method': 'bounded_radial_scalp_clearance_v2', 'adjusted_vertices': adjusted,
            'limited_vertices': limited, 'maximum_adjustment_m': maximum_applied,
            'maximum_allowed_m': maximum, 'bounded': True,
            'topology_preserved': True, 'uv_preserved': True, 'added_faces': 0}


def seat_legacy_hair_roots(meshes, body, spec):
    """Keep enlarged legacy locks, easing their roots inside the separate hat."""
    lo, hi = bounds(body)
    center = (lo+hi)/2
    rx = (hi.x-lo.x)/2; ry = (hi.y-lo.y)/2
    head_base = spec['anchors']['neck'][1]
    head_center = (hi.z+head_base)/2
    head_radius = (hi.z-head_base)/2
    rim = spec['fitting'].get('hat_hairline_m', 1.14)
    for obj in meshes:
        if obj.get('scalp_backing'):
            continue
        for vertex in obj.data.vertices:
            t = max(0, min(1, (vertex.co.z-(rim-.24))/.24))
            t = t*t*(3-2*t)
            x, y = vertex.co.x-center.x, vertex.co.y-center.y
            crown_fraction = max(0, min(.995, (vertex.co.z-head_center)/max(head_radius, .001)))
            section = (1-crown_fraction*crown_fraction)**.5
            radius = ((x/(rx*section+.035))**2+(y/(ry*section+.035))**2)**.5
            factor = 1-t*(1-min(1, 1/max(radius, 1e-8)))
            vertex.co.x = center.x+x*factor
            vertex.co.y = center.y+y*factor
        obj.data.update()


def head_preview_body(body, collar_height):
    copies = []
    for original in body:
        obj = bpy.data.objects.new('HeadViewBase', original.data.copy())
        bpy.context.scene.collection.objects.link(obj)
        obj.matrix_world = original.matrix_world.copy()
        place([obj], Matrix.Identity(4))
        mesh = bmesh.new()
        try:
            mesh.from_mesh(obj.data)
            bmesh.ops.bisect_plane(mesh, geom=[*mesh.verts, *mesh.edges, *mesh.faces],
                dist=1e-6, plane_co=Vector((0, 0, collar_height)), plane_no=Vector((0, 0, 1)),
                clear_inner=True, clear_outer=False)
            mesh.to_mesh(obj.data)
        finally:
            mesh.free()
        obj.data.update(); copies.append(obj)
    return copies
