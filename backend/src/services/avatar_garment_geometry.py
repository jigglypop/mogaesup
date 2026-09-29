"""Anatomical garment fitting that preserves generated topology and UVs."""
import hashlib
import math

from mathutils import Matrix, Vector

from src.services.avatar_blender_common import blender_to_gltf, bounds, fit_matrix, gltf_to_blender

PROFILE_REVISION = 'garment-fit-v1'


def _bone(rig, *suffixes):
    wanted = tuple(value.lower() for value in suffixes)
    return next((bone for bone in rig.data.bones
                 if bone.name.lower().split(':')[-1] in wanted
                 or any(bone.name.lower().endswith(value) for value in wanted)), None)


def _joint(rig, *suffixes):
    bone = _bone(rig, *suffixes)
    return rig.matrix_world @ bone.head_local if bone is not None else None


def _json_point(point):
    return blender_to_gltf(point) if point is not None else None


def _dominant_group(obj, vertex):
    names = {group.index: group.name.lower() for group in obj.vertex_groups}
    rows = [(entry.weight, names.get(entry.group)) for entry in vertex.groups if names.get(entry.group)]
    return max(rows, default=(0., ''))[1]


def _world_rows(meshes):
    return [(obj, vertex, obj.matrix_world @ vertex.co, _dominant_group(obj, vertex))
            for obj in meshes for vertex in obj.data.vertices]


def _stable_geometry_signature(meshes, rig):
    digest = hashlib.sha256()
    for obj in sorted(meshes, key=lambda value: value.name):
        digest.update(f'{len(obj.data.vertices)}:{len(obj.data.polygons)}'.encode())
        for vertex in obj.data.vertices:
            point = obj.matrix_world @ vertex.co
            digest.update(','.join(f'{value:.6f}' for value in point).encode())
        for polygon in obj.data.polygons:
            digest.update(','.join(map(str, polygon.vertices)).encode())
    for bone in sorted(rig.data.bones, key=lambda value: value.name):
        parent = bone.parent.name if bone.parent else ''
        matrix = rig.matrix_world @ bone.matrix_local
        digest.update((bone.name+'\0'+parent+'\0').encode())
        digest.update(','.join(f'{value:.6f}' for row in matrix for value in row).encode())
    return digest.hexdigest()


def _section_result(points, height, region, method):
    if len(points) < 4:
        return None
    lo = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    hi = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return {'region': region, 'method': method, 'height_m': height,
            'center': _json_point((lo+hi)/2), 'width_m': hi.x-lo.x,
            'depth_m': hi.y-lo.y,
            'bounds': [[lo.x, lo.z, -hi.y], [hi.x, hi.z, -lo.y]],
            'sample_vertices': len(points)}


def _horizontal_section(rows, height, band, allowed, region):
    points = [point for _, _, point, group in rows
              if abs(point.z-height) <= band and any(token in group for token in allowed)]
    return _section_result(points, height, region, 'horizontal_dominant_skin_section')


def _limb_section(rows, joint, axis, band, allowed, region):
    if joint is None or axis is None or axis.length <= 1e-8:
        return None
    axis = axis.normalized()
    points = [point for _, _, point, group in rows
              if abs((point-joint).dot(axis)) <= band and any(token in group for token in allowed)]
    result = _section_result(points, joint.z, region, 'joint_axis_orthogonal_dominant_skin_section')
    if result is None:
        return None
    reference = Vector((0, 0, 1)) if abs(axis.z) < .9 else Vector((1, 0, 0))
    first = axis.cross(reference).normalized(); second = axis.cross(first).normalized()
    offsets = [point-joint for point in points]
    first_values = [value.dot(first) for value in offsets]; second_values = [value.dot(second) for value in offsets]
    result.update(axis=_json_point(axis), basis_u=_json_point(first), basis_v=_json_point(second),
                  diameter_u_m=max(first_values)-min(first_values),
                  diameter_v_m=max(second_values)-min(second_values))
    return result


def measure_body_profile(body, rig, source_sha256=None):
    """Measure rest geometry by dominant skin region, independent of materials."""
    rows = _world_rows(body); points = [row[2] for row in rows]
    if not points:
        raise ValueError('Body has no measurable vertices')
    lo, hi = bounds(body); height = max(hi.z-lo.z, 1e-6); band = max(.006, height*.012)
    skeletal_neck = _joint(rig, 'neck')
    shoulder_points = [_joint(rig, 'leftarm', 'leftshoulder'), _joint(rig, 'rightarm', 'rightshoulder')]
    shoulder_points = [point for point in shoulder_points if point is not None]
    neck_skin = [point for _, _, point, group in rows if any(token in group for token in ('neck', 'head'))]
    shoulder_height = sum(point.z for point in shoulder_points)/len(shoulder_points) if shoulder_points else None
    skin_floor = sorted(point.z for point in neck_skin)[max(0, round(len(neck_skin)*.08)-1)] if neck_skin else None
    collar_candidates = [value for value in (skeletal_neck.z if skeletal_neck is not None else None,
                                              shoulder_height+height*.025 if shoulder_height is not None else None,
                                              skin_floor) if value is not None]
    collar_height = max(collar_candidates) if collar_candidates else lo.z+height*.8
    collar_skin = [point for point in neck_skin if abs(point.z-collar_height) <= band*2]
    wearing_neck = (sum(collar_skin, Vector())/len(collar_skin) if collar_skin else
                    Vector((skeletal_neck.x, skeletal_neck.y, collar_height)) if skeletal_neck is not None else None)
    landmarks = {'crown': Vector(((lo.x+hi.x)/2, (lo.y+hi.y)/2, hi.z)),
                 'skeletal_neck': skeletal_neck, 'wearing_neck': wearing_neck,
                 'neck': wearing_neck, 'waist': _joint(rig, 'hips', 'pelvis')}
    for side, prefix in (('left', 'Left'), ('right', 'Right')):
        landmarks.update({f'shoulder_{side}': _joint(rig, prefix+'arm'),
                          f'elbow_{side}': _joint(rig, prefix+'forearm'),
                          f'wrist_{side}': _joint(rig, prefix+'hand'),
                          f'hip_{side}': _joint(rig, prefix+'upleg'),
                          f'knee_{side}': _joint(rig, prefix+'leg'),
                          f'ankle_{side}': _joint(rig, prefix+'foot')})
    sections = {}
    torso_rules = {'neck': (wearing_neck, ('neck', 'head', 'spine', 'chest')),
                    'waist': (landmarks['waist'], ('hips', 'pelvis', 'spine'))}
    hips = [landmarks.get('hip_left'), landmarks.get('hip_right')]; hips = [point for point in hips if point is not None]
    torso_rules['hip'] = (sum(hips, Vector())/len(hips) if hips else None, ('hips', 'pelvis', 'upleg'))
    if wearing_neck is not None and landmarks['waist'] is not None:
        torso_rules['chest'] = (wearing_neck.lerp(landmarks['waist'], .38), ('spine', 'chest'))
    for name, (joint, allowed) in torso_rules.items():
        section = _horizontal_section(rows, joint.z, band, allowed, name) if joint is not None else None
        if section:
            sections[name] = section
    for side in ('left', 'right'):
        shoulder, elbow, wrist = (landmarks.get(f'{name}_{side}') for name in ('shoulder', 'elbow', 'wrist'))
        hip, knee, ankle = (landmarks.get(f'{name}_{side}') for name in ('hip', 'knee', 'ankle'))
        cases = [('shoulder', shoulder, elbow-shoulder if shoulder is not None and elbow is not None else None, (side+'arm',)),
                 ('elbow', elbow, wrist-shoulder if wrist is not None and shoulder is not None else None, (side+'arm', side+'forearm')),
                 ('wrist', wrist, wrist-elbow if wrist is not None and elbow is not None else None, (side+'forearm', side+'hand')),
                 ('knee', knee, ankle-hip if ankle is not None and hip is not None else None, (side+'upleg', side+'leg')),
                 ('ankle', ankle, ankle-knee if ankle is not None and knee is not None else None, (side+'leg', side+'foot'))]
        for name, joint, axis, allowed in cases:
            section = _limb_section(rows, joint, axis, band, allowed, f'{name}_{side}')
            if section:
                sections[f'{name}_{side}'] = section
    signature = _stable_geometry_signature(body, rig)
    return {'revision': PROFILE_REVISION, 'source_sha256': source_sha256,
            'coordinate_system': 'gltf-metres', 'signature': signature,
            'geometry_rig_signature': signature,
            'bounds': [[lo.x, lo.z, -hi.y], [hi.x, hi.z, -lo.y]],
            'landmarks': {name: _json_point(point) for name, point in landmarks.items() if point is not None},
            'missing_landmarks': sorted(name for name, point in landmarks.items() if point is None),
            'sections': sections, 'measurement_basis': 'dominant_skin_groups_and_joint_axis_sections',
            'mesh_signature': [{'name': obj.name, 'vertices': len(obj.data.vertices),
                                'polygons': len(obj.data.polygons)} for obj in body]}


def _percentile(values, fraction):
    values = sorted(values)
    return values[min(len(values)-1, max(0, round((len(values)-1)*fraction)))] if values else None


def _slice(points, axis, value, band):
    return [point for point in points if value is not None and abs(point[axis]-value) <= band]


def _centroid(points):
    return sum(points, Vector())/len(points) if points else None


def _top_landmarks(points):
    lo = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    hi = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    center = (lo+hi)/2; width = max(hi.x-lo.x, 1e-6); height = max(hi.z-lo.z, 1e-6)
    central = [p for p in points if abs(p.x-center.x) <= width*.14]
    collar_z = _percentile([p.z for p in central], .985); hem_z = _percentile([p.z for p in central], .015)
    landmarks = {'neck': _centroid(_slice(central, 2, collar_z, max(height*.025, .004))),
                 'hem': _centroid(_slice(central, 2, hem_z, max(height*.025, .004)))}
    confidence = {'neck': 'torso_column_high_surface', 'hem': 'torso_column_low_surface'}
    half = width/2; thickness = []
    for index in range(24):
        row = [p for p in points if half*index/24 <= abs(p.x-center.x) < half*(index+1)/24]
        thickness.append((_percentile([p.z for p in row], .9)-_percentile([p.z for p in row], .1)) if len(row) >= 4 else 0.)
    torso = max(thickness[2:8], default=0.); transition = None
    for index in range(5, 21):
        if torso > 0 and thickness[index] < torso*.72 and any(thickness[index+step] > 0 for step in range(1, 4)):
            transition = half*(index+.5)/24; break
    if transition is None:
        transition = _percentile([abs(p.x-center.x) for p in points if p.z > center.z], .45)
    for side, sign in (('left', 1), ('right', -1)):
        shoulder = [p for p in points if sign*(p.x-center.x) >= 0
                    and abs(abs(p.x-center.x)-transition) <= width*.035]
        top = _percentile([p.z for p in shoulder], .85)
        landmarks[f'shoulder_{side}'] = _centroid(_slice(shoulder, 2, top, max(height*.04, .005)))
        confidence[f'shoulder_{side}'] = 'torso_sleeve_narrowing_upper_surface'
        cuff = [p for p in points if sign*(p.x-center.x) >= half*.94]
        landmarks[f'cuff_{side}'] = _centroid(cuff); confidence[f'cuff_{side}'] = 'outermost_sleeve_slice'
    attach_z = collar_z+(hem_z-collar_z)*.45 if collar_z is not None and hem_z is not None else None
    landmarks['torso_attach'] = _centroid(_slice(central, 2, attach_z, max(height*.04, .005)))
    confidence['torso_attach'] = 'torso_column_section'
    required = ('neck', 'hem', 'shoulder_left', 'shoulder_right', 'cuff_left', 'cuff_right', 'torso_attach')
    errors = [{'code': 'ambiguous_source_landmark', 'landmark': name,
               'message': f'Could not measure source landmark: {name}'} for name in required if landmarks.get(name) is None]
    return landmarks, confidence, errors


def _bottom_landmarks(points):
    lo = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    hi = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    center = (lo+hi)/2; width = max(hi.x-lo.x, 1e-6); height = max(hi.z-lo.z, 1e-6); band = max(height*.035, .004)
    waist = _slice(points, 2, hi.z-height*.025, band); hip = _slice(points, 2, hi.z-height*.25, band)
    low = [p for p in points if p.z <= lo.z+height*.28]
    pants = (any(p.x > center.x+width*.12 for p in low) and any(p.x < center.x-width*.12 for p in low)
             and len([p for p in low if abs(p.x-center.x) < width*.07]) < max(3, len(low)*.025))
    landmarks = {'waist': _centroid(waist)}; confidence = {'waist': 'upper_occupancy_section'}
    for label, row in (('waist', waist), ('hip', hip)):
        for side, selector in (('left', max), ('right', min)):
            if row:
                edge = selector(p.x for p in row)
                landmarks[f'{label}_{side}'] = _centroid([p for p in row if abs(p.x-edge) <= width*.04])
                confidence[f'{label}_{side}'] = label+'_section_edge'
    if pants:
        for side, sign in (('left', 1), ('right', -1)):
            leg = [p for p in low if sign*(p.x-center.x) > 0]; level = _percentile([p.z for p in leg], .04)
            landmarks[f'hem_{side}'] = _centroid(_slice(leg, 2, level, band)); confidence[f'hem_{side}'] = 'lower_leg_occupancy'
        central = [p for p in points if abs(p.x-center.x) < width*.07]; level = min((p.z for p in central), default=None)
        landmarks['crotch'] = _centroid(_slice(central, 2, level, band)); confidence['crotch'] = 'lowest_central_occupancy'
        kind = 'pants'; required = ('waist_left', 'waist_right', 'hip_left', 'hip_right', 'crotch', 'hem_left', 'hem_right')
    else:
        level = _percentile([p.z for p in points], .02)
        landmarks['hem'] = _centroid(_slice(points, 2, level, band)); confidence['hem'] = 'continuous_lower_occupancy'
        kind = 'skirt'; required = ('waist_left', 'waist_right', 'hip_left', 'hip_right', 'hem')
    errors = [{'code': 'ambiguous_source_landmark', 'landmark': name,
               'message': f'Could not measure source landmark: {name}'} for name in required if landmarks.get(name) is None]
    return landmarks, confidence, errors, kind


def _discover_source_landmarks(meshes, slot, profile, orientation=None):
    orientation = orientation if orientation is not None else Matrix.Identity(4)
    points = [orientation @ row[2] for row in _world_rows(meshes)]
    if len(points) < 12:
        return {}, {}, [{'code': 'insufficient_source_geometry', 'message': 'Garment has too few vertices'}], None
    if slot == 'top':
        landmarks, confidence, errors = _top_landmarks(points); detected = None
    else:
        landmarks, confidence, errors, detected = _bottom_landmarks(points)
    inverse = orientation.inverted()
    landmarks = {name: inverse @ point for name, point in landmarks.items() if point is not None}
    for anchor in profile.get('anchors') or []:
        if anchor.get('name') and isinstance(anchor.get('source'), (list, tuple)) and len(anchor['source']) == 3:
            landmarks[anchor['name']] = gltf_to_blender(anchor['source']); confidence[anchor['name']] = 'override'
            errors = [error for error in errors if error.get('landmark') != anchor['name']]
    requested_kind = profile.get('kind')
    if slot == 'bottom' and requested_kind in ('pants', 'skirt') and detected != requested_kind:
        errors.append({'code': 'garment_kind_geometry_mismatch',
                       'message': f'Source occupancy looks like {detected}, not {requested_kind}'})
    return landmarks, confidence, errors, detected


def _target_landmarks(body_profile, slot, profile):
    body = {name: gltf_to_blender(point) for name, point in body_profile.get('landmarks', {}).items()}
    sections = body_profile.get('sections', {})
    result = {}
    if slot == 'top':
        for name in ('neck', 'shoulder_left', 'shoulder_right'):
            if name in body:
                result[name] = body[name]
        neck, waist = body.get('neck'), body.get('waist')
        if neck is not None and waist is not None:
            result['_neck_waist_length_m'] = (waist-neck).length
        chest_section = sections.get('chest', {})
        chest = chest_section.get('center')
        if chest:
            result['torso_attach'] = gltf_to_blender(chest)
        elif neck is not None and waist is not None:
            result['torso_attach'] = neck.lerp(waist, .45)
        result['_chest_width_m'] = chest_section.get('width_m')
        result['_chest_depth_m'] = chest_section.get('depth_m')
        for side in ('left', 'right'):
            arm = sections.get(f'elbow_{side}', {})
            diameters = [value for value in (arm.get('diameter_u_m'), arm.get('diameter_v_m')) if value]
            result[f'_arm_diameter_{side}_m'] = max(diameters) if diameters else None
        ratio = profile.get('length_ratio')
        if ratio is not None and neck is not None and waist is not None:
            result['hem'] = neck.lerp(waist, max(0., min(3., float(ratio))))
        for side in ('left', 'right'):
            shoulder, wrist = body.get(f'shoulder_{side}'), body.get(f'wrist_{side}')
            if wrist is not None:
                result[f'_wrist_{side}'] = wrist
            ratio = profile.get('sleeve_ratio')
            if ratio is None:
                ratio = {'none': .08, 'short': .38, 'long': 1.0}.get(profile.get('sleeve', 'source'))
            if shoulder is not None and wrist is not None and ratio is not None:
                result[f'cuff_{side}'] = shoulder.lerp(wrist, max(0., min(1.5, float(ratio))))
    else:
        waist = body.get('waist'); hips = {side: body.get(f'hip_{side}') for side in ('left', 'right')}
        waist_section, hip_section = sections.get('waist', {}), sections.get('hip', {})
        if waist is not None:
            result['waist'] = waist
        for name, section, fallback_height in (('waist', waist_section, waist), ('hip', hip_section, None)):
            box = section.get('bounds')
            if box:
                lower, upper = gltf_to_blender(box[0]), gltf_to_blender(box[1])
                center = gltf_to_blender(section['center'])
                result[f'{name}_left'] = Vector((upper.x, center.y, center.z))
                result[f'{name}_right'] = Vector((lower.x, center.y, center.z))
            elif fallback_height is not None:
                for side in ('left', 'right'):
                    if hips[side] is not None:
                        result[f'{name}_{side}'] = Vector((hips[side].x, fallback_height.y, fallback_height.z))
        for side in ('left', 'right'):
            if hips[side] is not None:
                result[f'hip_axis_{side}'] = hips[side]
        result['_waist_width_m'] = waist_section.get('width_m')
        result['_waist_depth_m'] = waist_section.get('depth_m')
        result['_hip_width_m'] = hip_section.get('width_m')
        result['_hip_depth_m'] = hip_section.get('depth_m')
        available = [point for point in hips.values() if point is not None]
        knees = [body.get(f'knee_{side}') for side in ('left', 'right')]; knees = [point for point in knees if point is not None]
        if available and knees:
            result['crotch'] = (sum(available, Vector())/len(available)).lerp(sum(knees, Vector())/len(knees), .18)
        ratio = profile.get('length_ratio')
        if ratio is not None:
            ratio = max(0., min(3., float(ratio)))
            if profile.get('kind') == 'pants':
                for side in ('left', 'right'):
                    ankle = body.get(f'ankle_{side}')
                    if hips[side] is not None and ankle is not None:
                        result[f'hem_{side}'] = hips[side].lerp(ankle, ratio)
            elif waist is not None:
                ankles = [body.get(f'ankle_{side}') for side in ('left', 'right')]; ankles = [point for point in ankles if point is not None]
                if ankles:
                    result['hem'] = waist.lerp(sum(ankles, Vector())/len(ankles), ratio)
    for anchor in profile.get('anchors') or []:
        if anchor.get('name') and isinstance(anchor.get('target'), (list, tuple)) and len(anchor['target']) == 3:
            result[anchor['name']] = gltf_to_blender(anchor['target'])
    return result


def _image_mask(path):
    import bpy
    image = bpy.data.images.load(str(path), check_existing=True)
    width, height = image.size; pixels = list(image.pixels)
    occupied = [(index % width, height-1-index//width) for index in range(width*height)
                if pixels[index*4+3] > .05]
    if not occupied or len(occupied) > width*height*.95:
        return None
    return width, height, occupied


def _normalized_profile(points, horizontal_axis, bins=24):
    horizontal = [point[horizontal_axis] for point in points]; vertical = [point[2] for point in points]
    hlo, hhi, vlo, vhi = min(horizontal), max(horizontal), min(vertical), max(vertical)
    hs, vs = [0]*bins, [0]*bins
    for h, v in zip(horizontal, vertical):
        hs[min(bins-1, int((h-hlo)/max(hhi-hlo, 1e-8)*bins))] += 1
        vs[min(bins-1, int((v-vlo)/max(vhi-vlo, 1e-8)*bins))] += 1
    def normalized(row):
        maximum = max(row) or 1
        return [value/maximum for value in row]
    return normalized(hs), normalized(vs), (hhi-hlo)/max(vhi-vlo, 1e-8)


def _image_profile(mask):
    _, _, occupied = mask
    return _normalized_profile([Vector((x, 0, -y)) for x, y in occupied], 0)


def _silhouette_registration(meshes, image_paths, canvas, slot):
    """Choose yaw from normalized silhouettes and recover fixed-canvas heights."""
    if not image_paths or not canvas:
        return None, Matrix.Identity(4)
    raw_points = [row[2] for row in _world_rows(meshes)]; masks, views = {}, {}
    for view in ('front', 'side', 'back'):
        path = image_paths.get(view)
        if not path:
            continue
        try:
            mask = _image_mask(path)
            if mask is None:
                views[view] = {'source': str(path), 'error': 'alpha_silhouette_unavailable'}
                continue
            masks[view] = mask
            width, height, occupied = mask; xs = [p[0] for p in occupied]; ys = [p[1] for p in occupied]
            views[view] = {'source': str(path), 'alpha_bounds_px': [min(xs), min(ys), max(xs), max(ys)],
                           'orientation': {'front': '-Z', 'side': '+X', 'back': '+Z'}[view]}
        except Exception as exc:
            views[view] = {'source': str(path), 'error': str(exc)}
    candidates = []
    for degrees in (0, 90, 180, 270):
        rotation = Matrix.Rotation(math.radians(degrees), 4, 'Z'); points = [rotation @ point for point in raw_points]
        score, evidence = 0., []
        for view, mask in masks.items():
            mesh_h, mesh_v, mesh_aspect = _normalized_profile(points, 0 if view in ('front', 'back') else 1)
            image_h, image_v, image_aspect = _image_profile(mask)
            mismatch = abs(math.log(max(mesh_aspect, 1e-8)/max(image_aspect, 1e-8)))
            mismatch += sum(abs(a-b) for a, b in zip(mesh_h, image_h))/len(mesh_h)
            mismatch += sum(abs(a-b) for a, b in zip(mesh_v, image_v))/len(mesh_v)
            score += mismatch; evidence.append({'view': view, 'mismatch': mismatch})
        candidates.append({'yaw_degrees': degrees, 'score': score, 'views': evidence})
    best = min(candidates, key=lambda row: (row['score'], row['yaw_degrees'])) if masks else candidates[0]
    zero = next(row for row in candidates if row['yaw_degrees'] == 0)
    ambiguity_tolerance = max(.03, abs(zero['score'])*.03)
    selected = zero if zero['score'] <= best['score']+ambiguity_tolerance else best
    image_landmarks = {}; primary = masks.get('front') or masks.get('back')
    if primary:
        width, _, occupied = primary; band = [p for p in occupied if abs(p[0]-canvas['center_x']) <= width*.08]
        ys = [p[1] for p in band or occupied]; ppm = float(canvas['pixels_per_metre'])
        upper = (canvas['sole_y']-min(ys))/ppm; lower = (canvas['sole_y']-max(ys))/ppm
        span = max(max(ys)-min(ys), 1)
        if slot == 'top':
            rows = {}
            for x, y in occupied:
                rows.setdefault(y, []).append(x)
            shoulder_y = min(rows, key=lambda y: (-max(rows[y])+min(rows[y]), y))
            shoulder = (canvas['sole_y']-shoulder_y)/ppm
            image_landmarks = {'neck_height_m': upper, 'shoulder_height_m': shoulder,
                               'hem_height_m': lower,
                               'relative_y': {'neck': 0., 'shoulder': (shoulder_y-min(ys))/span, 'hem': 1.}}
        else:
            image_landmarks = {'waist_height_m': upper, 'hem_height_m': lower,
                               'relative_y': {'waist': 0., 'hem': 1.}}
    report = {'method': 'normalized_projected_silhouette_yaw', 'views': views,
              'yaw_candidates': candidates, 'selected_yaw_degrees': selected['yaw_degrees'],
              'selection_basis': 'normalized occupancy profiles and aspect mismatch',
              'orientation_ambiguous': selected is zero and best['yaw_degrees'] != 0,
              'zero_yaw_tolerance': ambiguity_tolerance,
              'image_landmarks': image_landmarks, 'global_anisotropic_scaling': False,
              'used_for_fit': True}
    return report, Matrix.Rotation(math.radians(selected['yaw_degrees']), 4, 'Z')


def _apply_matrix(meshes, transform):
    for obj in meshes:
        obj.data.transform(obj.matrix_world.inverted() @ transform @ obj.matrix_world, shape_keys=True)
        obj.data.update()


def _smooth(value):
    value = max(0., min(1., value))
    return value*value*(3-2*value)


def _regional_fit(meshes, slot, profile, source, target):
    lo, hi = bounds(meshes); masks = {obj: {} for obj in meshes}
    regional = profile.get('region_ease') or {}
    def ease_name(region):
        return regional.get(region, profile.get('ease', 'source'))
    def ease_factor(region):
        return {'source': 1., 'regular': 1.03, 'loose': 1.10}.get(ease_name(region), 1.)
    center_x, center_y = (lo.x+hi.x)/2, (lo.y+hi.y)/2
    shoulder_span = max((abs(point.x-center_x) for name, point in source.items()
                         if name.startswith('shoulder_') and point is not None), default=(hi.x-lo.x)*.3)
    torso_points = [row[2] for row in _world_rows(meshes) if abs(row[2].x-center_x) <= shoulder_span*1.08]
    torso_width = max((p.x for p in torso_points), default=hi.x)-min((p.x for p in torso_points), default=lo.x)
    torso_depth = max((p.y for p in torso_points), default=hi.y)-min((p.y for p in torso_points), default=lo.y)
    torso_ease = ease_factor('torso')
    torso_scale_x = ((target.get('_chest_width_m') or torso_width)*torso_ease/max(torso_width, 1e-6)
                      if ease_name('torso') != 'source' else 1.)
    torso_scale_y = ((target.get('_chest_depth_m') or torso_depth)*torso_ease/max(torso_depth, 1e-6)
                      if ease_name('torso') != 'source' else 1.)
    hip_ease = ease_factor('hip')
    hip_scale_x = ((target.get('_hip_width_m') or (hi.x-lo.x))*hip_ease/max(hi.x-lo.x, 1e-6)
                   if ease_name('hip') != 'source' else 1.)
    hip_scale_y = ((target.get('_hip_depth_m') or (hi.y-lo.y))*hip_ease/max(hi.y-lo.y, 1e-6)
                   if ease_name('hip') != 'source' else 1.)
    sleeve_scales = {}
    all_points = [row[2] for row in _world_rows(meshes)]
    for side, sign in (('left', 1), ('right', -1)):
        shoulder, cuff = source.get(f'shoulder_{side}'), source.get(f'cuff_{side}')
        scale = 1.
        if shoulder is not None and cuff is not None and (cuff-shoulder).length > 1e-6 and ease_name('sleeve') != 'source':
            axis = (cuff-shoulder).normalized()
            sleeve_points = [point for point in all_points if sign*(point.x-center_x) >= shoulder_span*.8]
            radii = [((point-shoulder)-axis*(point-shoulder).dot(axis)).length for point in sleeve_points]
            source_diameter = 2*(_percentile(radii, .8) or 0.)
            desired = target.get(f'_arm_diameter_{side}_m')
            if desired and source_diameter > 1e-6:
                scale = desired*ease_factor('sleeve')/source_diameter
            else:
                scale = ease_factor('sleeve')
        sleeve_scales[side] = scale
    coverage = {'slot': slot, 'kind': profile.get('kind', 'source')}
    for obj in meshes:
        inverse = obj.matrix_world.inverted()
        for vertex in obj.data.vertices:
            point = obj.matrix_world @ vertex.co; destination = point.copy()
            region = 'torso' if slot == 'top' else 'skirt'
            if slot == 'top':
                side = 'left' if point.x >= (lo.x+hi.x)/2 else 'right'
                source_shoulder, source_cuff = source.get(f'shoulder_{side}'), source.get(f'cuff_{side}')
                shoulder, cuff = target.get(f'shoulder_{side}'), target.get(f'cuff_{side}')
                if cuff is None:
                    cuff = source_cuff
                lateral = abs(point.x-(lo.x+hi.x)/2)/max((hi.x-lo.x)/2, 1e-6)
                amount = _smooth((lateral-.42)/.35)
                if all(value is not None for value in (source_shoulder, source_cuff, shoulder, cuff)) and amount:
                    source_axis, target_axis = source_cuff-source_shoulder, cuff-shoulder
                    if source_axis.length > 1e-6 and target_axis.length > 1e-6:
                        direction = source_axis.normalized(); offset = point-source_shoulder
                        along = offset.dot(direction)/source_axis.length
                        radial = offset-direction*offset.dot(direction)
                        radial_factor = sleeve_scales[side]
                        fitted = shoulder+target_axis*along+direction.rotation_difference(target_axis.normalized()) @ radial*radial_factor
                        destination = point.lerp(fitted, amount); region = f'sleeve_{side}'
                if region == 'torso':
                    if profile.get('length_ratio') is not None or target.get('_image_length'):
                        values = source.get('hem'), target.get('hem'), source.get('neck'), target.get('neck')
                        if all(value is not None for value in values):
                            hem_s, hem_t, neck_s, neck_t = values
                            fraction = (neck_s.z-point.z)/max(neck_s.z-hem_s.z, 1e-6)
                            destination.z = neck_t.z+(hem_t.z-neck_t.z)*fraction
                    neck = source.get('neck'); attach = source.get('torso_attach')
                    shape_blend = (_smooth((neck.z-point.z)/max(neck.z-attach.z, 1e-6))
                                   if neck is not None and attach is not None else 1.)
                    scale_x = 1+(torso_scale_x-1)*shape_blend
                    scale_y = 1+(torso_scale_y-1)*shape_blend
                    destination.x = center_x+(destination.x-center_x)*scale_x
                    destination.y = center_y+(destination.y-center_y)*scale_y
            elif profile.get('kind') == 'pants':
                side = 'left' if point.x >= (lo.x+hi.x)/2 else 'right'; region = f'leg_{side}'
                if profile.get('length_ratio') is not None or target.get('_image_length'):
                    values = source.get('waist'), source.get(f'hem_{side}'), target.get('waist'), target.get(f'hem_{side}')
                    if all(value is not None for value in values):
                        waist_s, hem_s, waist_t, hem_t = values
                        fraction = (waist_s.z-point.z)/max(waist_s.z-hem_s.z, 1e-6)
                        destination.z = waist_t.z+(hem_t.z-waist_t.z)*fraction
                axis = target.get(f'hip_axis_{side}')
                if axis is None:
                    axis = target.get('waist')
                if axis is not None:
                    destination.x = axis.x+(destination.x-axis.x)*hip_scale_x
                    destination.y = axis.y+(destination.y-axis.y)*hip_scale_y
            else:
                if profile.get('length_ratio') is not None or target.get('_image_length'):
                    values = source.get('waist'), source.get('hem'), target.get('waist'), target.get('hem')
                    if all(value is not None for value in values):
                        waist_s, hem_s, waist_t, hem_t = values
                        fraction = (waist_s.z-point.z)/max(waist_s.z-hem_s.z, 1e-6)
                        destination.z = waist_t.z+(hem_t.z-waist_t.z)*fraction
                center = Vector(((lo.x+hi.x)/2, (lo.y+hi.y)/2, destination.z))
                destination.x = center.x+(destination.x-center.x)*hip_scale_x
                destination.y = center.y+(destination.y-center.y)*hip_scale_y
            delta = inverse.to_3x3() @ (destination-point); original = vertex.co.copy()
            if obj.data.shape_keys:
                for key in obj.data.shape_keys.key_blocks:
                    key.data[vertex.index].co += delta
            vertex.co = original+delta; masks[obj][vertex.index] = region
        obj.data.update()
    final_lo, final_hi = bounds(meshes); hem_points = [target.get('hem'), source.get('hem')]
    if slot == 'bottom' and profile.get('kind') == 'pants':
        hem_points = []
        for side in ('left', 'right'):
            value = target.get(f'hem_{side}')
            hem_points.append(value if value is not None else source.get(f'hem_{side}'))
    hem_points = [point for point in hem_points if point is not None]
    coverage.update(hem_m=min(point.z for point in hem_points) if hem_points else final_lo.z, upper_m=final_hi.z)
    for side in ('left', 'right'):
        cuff = target.get(f'cuff_{side}')
        if cuff is None:
            cuff = source.get(f'cuff_{side}')
        if cuff is not None:
            coverage[f'cuff_{side}_m'] = _json_point(cuff)
    return masks, coverage


def fit_profiled_garment(meshes, body, rig, slot, fit_profile, *, body_profile=None,
                          image_paths=None, canvas=None):
    """Fit a garment; only geometric ambiguity or computation errors are incomplete."""
    requested = dict(fit_profile or {}); profile = dict(requested)
    report = {'fit_profile': requested, 'fit_status': 'unfitted', 'errors': [],
              'source_landmarks': {}, 'target_landmarks': {}, 'coverage': None}
    if profile.get('revision') != PROFILE_REVISION or slot not in ('top', 'bottom'):
        report['errors'].append({'code': 'unsupported_fit_profile',
                                 'message': 'Expected garment-fit-v1 for a top or bottom'})
        report['fit_status'] = 'failed'
        return report, {obj: {} for obj in meshes}
    length_ratio, sleeve_ratio = profile.get('length_ratio'), profile.get('sleeve_ratio')
    if ((length_ratio is not None and not 0. < float(length_ratio) <= 3.)
            or (sleeve_ratio is not None and not 0. <= float(sleeve_ratio) <= 1.5)):
        report['errors'].append({'code': 'fit_ratio_out_of_range',
                                 'message': 'length_ratio must be >0..3 and sleeve_ratio must be 0..1.5'})
        report['fit_status'] = 'failed'
        return report, {obj: {} for obj in meshes}
    body_profile = body_profile or measure_body_profile(body, rig)
    registration, yaw = _silhouette_registration(meshes, image_paths, canvas, slot)
    source, confidence, errors, detected_kind = _discover_source_landmarks(meshes, slot, profile, yaw)
    if slot == 'bottom' and profile.get('kind') == 'source':
        profile['kind'] = detected_kind; report['resolved_kind'] = detected_kind
    target = _target_landmarks(body_profile, slot, profile)
    image_levels = (registration or {}).get('image_landmarks', {})
    image_length_calibration = None
    if (slot == 'top' and profile.get('length_ratio') is None
            and all(image_levels.get(name) is not None
                    for name in ('neck_height_m', 'shoulder_height_m', 'hem_height_m'))):
        target_shoulders = [target.get(f'shoulder_{side}') for side in ('left', 'right')]
        target_shoulders = [point for point in target_shoulders if point is not None]
        target_neck = target.get('neck')
        image_neck = float(image_levels['neck_height_m'])
        image_shoulder = float(image_levels['shoulder_height_m'])
        denominator = image_neck-image_shoulder
        if target_neck is not None and target_shoulders and abs(denominator) > 1e-5:
            target_shoulder_z = sum(point.z for point in target_shoulders)/len(target_shoulders)
            calibration_scale = (target_neck.z-target_shoulder_z)/denominator
            if 0.05 <= abs(calibration_scale) <= 5.:
                hem_z = target_shoulder_z+(float(image_levels['hem_height_m'])-image_shoulder)*calibration_scale
                base = target.get('torso_attach')
                if base is None:
                    base = target_neck
                target['hem'] = Vector((base.x, base.y, hem_z)); target['_image_length'] = True
                image_length_calibration = {'method': 'neck_shoulder_relative_height',
                    'scale': calibration_scale, 'target_hem_height_m': hem_z}
    source_sleeve_mapping = {}
    if slot == 'top' and profile.get('sleeve') == 'source' and profile.get('sleeve_ratio') is None:
        source_neck, source_hem = source.get('neck'), source.get('hem')
        source_torso = (source_neck-source_hem).length if source_neck is not None and source_hem is not None else 0.
        target_torso = target.get('_neck_waist_length_m') or 0.
        for side in ('left', 'right'):
            source_shoulder, source_cuff = source.get(f'shoulder_{side}'), source.get(f'cuff_{side}')
            target_shoulder, target_wrist = target.get(f'shoulder_{side}'), target.get(f'_wrist_{side}')
            target_arm = ((target_wrist-target_shoulder).length
                          if target_wrist is not None and target_shoulder is not None else 0.)
            if all(value > 1e-6 for value in (source_torso, target_torso, target_arm)) and source_shoulder is not None and source_cuff is not None:
                source_sleeve = (source_cuff-source_shoulder).length
                ratio = max(0., min(1.5, (source_sleeve/source_torso)/(target_arm/target_torso)))
                target[f'cuff_{side}'] = target_shoulder.lerp(target_wrist, ratio)
                source_sleeve_mapping[side] = {'source_sleeve_to_torso': source_sleeve/source_torso,
                                                'target_arm_ratio': ratio}
    report['source_landmarks'] = {name: _json_point(point) for name, point in source.items()}
    report['source_landmark_confidence'] = confidence
    report['target_landmarks'] = {name: _json_point(point) for name, point in target.items()
                                  if not name.startswith('_')}
    report['silhouette_registration'] = registration; report['errors'].extend(errors)
    if image_length_calibration:
        report['image_length_calibration'] = image_length_calibration
    if source_sleeve_mapping:
        report['source_sleeve_mapping'] = source_sleeve_mapping
    attachment_names = ({'neck', 'shoulder_left', 'shoulder_right', 'torso_attach'} if slot == 'top'
                        else {'waist_left', 'waist_right', 'hip_left', 'hip_right', 'crotch'})
    working_source = {name: yaw @ point for name, point in source.items()}
    pairs = [{'name': name, 'source': _json_point(working_source[name]), 'target': _json_point(target[name])}
             for name in attachment_names & working_source.keys() & target.keys()]
    if errors or len(pairs) < 3:
        if len(pairs) < 3:
            report['errors'].append({'code': 'insufficient_attachment_anchors',
                                     'message': 'At least three attachment anchor correspondences are required'})
        report['fit_status'] = 'needs_anchors'
        return report, {obj: {} for obj in meshes}
    originals = {obj: ([vertex.co.copy() for vertex in obj.data.vertices],
                       [[point.co.copy() for point in key.data] for key in obj.data.shape_keys.key_blocks]
                       if obj.data.shape_keys else None) for obj in meshes}
    try:
        alignment_transform, alignment = fit_matrix(pairs, None)
        transform = alignment_transform @ yaw
        _apply_matrix(meshes, transform)
        transformed_source = {name: transform @ point for name, point in source.items()}
        for side in ('left', 'right'):
            if target.get(f'cuff_{side}') is None and transformed_source.get(f'cuff_{side}') is not None:
                target[f'cuff_{side}'] = transformed_source[f'cuff_{side}']
        masks, coverage = _regional_fit(meshes, slot, profile, transformed_source, target)
    except (ValueError, ZeroDivisionError, ArithmeticError) as exc:
        for obj, (vertices, keys) in originals.items():
            for vertex, coordinate in zip(obj.data.vertices, vertices):
                vertex.co = coordinate
            if keys is not None:
                for key, coordinates in zip(obj.data.shape_keys.key_blocks, keys):
                    for point, coordinate in zip(key.data, coordinates):
                        point.co = coordinate
            obj.data.update()
        report['errors'].append({'code': 'fit_computation_failed', 'message': str(exc)})
        report['fit_status'] = 'failed'
        return report, {obj: {} for obj in meshes}
    alignment['selected_yaw_degrees'] = (registration or {}).get('selected_yaw_degrees', 0)
    alignment['attachment_anchors'] = sorted(pair['name'] for pair in pairs)
    report['target_landmarks'] = {name: _json_point(point) for name, point in target.items()
                                  if not name.startswith('_')}
    report.update(fit_status='fitted', alignment=alignment, coverage=coverage,
                  regional_method='sleeve_torso' if slot == 'top' else profile.get('kind'))
    return report, masks


def bind_garment_regions(meshes, rig, slot, region_masks):
    """Remove cross-limb transferred weights while retaining normalized skinning."""
    torso_tokens = ('hips', 'pelvis', 'spine', 'chest', 'neck')

    def allowed(name, region):
        lower = name.lower(); semantic = lower.split(':')[-1]
        torso = any(token in semantic for token in torso_tokens)
        if region in ('torso', 'skirt'):
            return torso
        side = 'left' if region.endswith('_left') else 'right'
        same_side = side in semantic
        if region.startswith('sleeve_'):
            return torso or (same_side and any(token in semantic for token in ('shoulder', 'arm', 'forearm', 'hand')))
        if region.startswith('leg_'):
            pelvis = any(token in semantic for token in ('hips', 'pelvis'))
            return pelvis or (same_side and any(token in semantic for token in ('upleg', 'leg', 'foot', 'toe')))
        return torso

    def fallback_name(region):
        names = [bone.name for bone in rig.data.bones]
        permitted = [name for name in names if allowed(name, region)]
        if region.startswith('sleeve_'):
            limb = [name for name in permitted if any(token in name.lower() for token in ('forearm', 'arm'))]
        elif region.startswith('leg_'):
            limb = [name for name in permitted if any(token in name.lower() for token in ('upleg', 'leg'))]
        else:
            limb = []
        torso = [name for name in permitted if any(token in name.lower() for token in ('hips', 'pelvis', 'spine', 'chest'))]
        return next(iter(limb or torso or permitted), None)

    changed = 0
    for obj in meshes:
        group_names = {group.index: group.name for group in obj.vertex_groups}
        groups = {group.name: group for group in obj.vertex_groups}
        for vertex in obj.data.vertices:
            region = region_masks.get(obj, {}).get(vertex.index)
            if not region:
                continue
            row = {group_names[element.group]: element.weight for element in vertex.groups
                   if element.group in group_names}
            row = {name: weight for name, weight in row.items() if allowed(name, region)}
            if not row:
                fallback = fallback_name(region)
                if fallback:
                    row = {fallback: 1.}
            total = sum(row.values())
            if total <= 1e-8:
                continue
            for element in list(vertex.groups):
                obj.vertex_groups[element.group].remove([vertex.index])
            for name, weight in row.items():
                groups[name].add([vertex.index], weight/total, 'REPLACE')
            changed += 1
    return {'method': 'per_region_weight_filter', 'vertices': changed,
            'cross_limb_weights_removed': True}
