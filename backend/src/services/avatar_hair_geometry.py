"""Measured wig seating and image-supported repair of missing rear surfaces.

Runs inside Blender. Fitted strands, UVs and materials remain intact; a derived
rear backing is a separate mesh with its own provenance in the fitting receipt.
"""
import math

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

from src.services.avatar_fit_geometry import bounds, head_region, place


class _Surface:
    """Keep large provider meshes in Blender instead of copying every triangle."""
    def __init__(self, meshes):
        bpy.context.view_layer.update()
        graph = bpy.context.evaluated_depsgraph_get()
        self.items = []
        for obj in meshes:
            matrix = obj.matrix_world.copy()
            inverse = matrix.inverted()
            tree = BVHTree.FromObject(obj, graph)
            self.items.append((tree, matrix, inverse, inverse.transposed().to_3x3()))

    def cast(self, origin, direction):
        nearest = None
        for tree, matrix, inverse, normals in self.items:
            local_direction = (inverse.to_3x3() @ direction).normalized()
            point, normal, _, _ = tree.ray_cast(inverse @ origin, local_direction)
            if point is None:
                continue
            world = matrix @ point
            distance = (world-origin).length
            if nearest is None or distance < nearest[2]:
                nearest = world, (normals @ normal).normalized(), distance
        return nearest


def fit_hair_cavity(meshes, body, rig, spec):
    """Seat the inner hair surface with one uniform correction, before clearance.

    Outer locks do not measure a head cavity. Use rays through the actual skull
    and the first hair surface, excluding lower front bangs and missing rays.
    A bounded correction preserves the design when the source is not a wig.
    """
    lo, hi, collar = head_region(body, rig, spec)
    center = (lo+hi)/2
    center.z = (max(lo.z, collar)+hi.z)/2
    skull, hair = _Surface(body), _Surface(meshes)
    clearance = spec['fitting'].get('scalp_clearance_m', .003)
    ratios = []
    sectors = set()
    for elevation in (.05, .3, .55, .8):
        horizontal = math.sqrt(1-elevation*elevation)
        for step in range(24):
            angle = step*math.tau/24
            ray = Vector((math.sin(angle)*horizontal, math.cos(angle)*horizontal, elevation))
            if ray.y < -.25 and elevation < .75:
                continue
            skin_hit, hair_hit = skull.cast(center, ray), hair.cast(center, ray)
            if skin_hit is None or hair_hit is None or hair_hit[2] <= 1e-8:
                continue
            ratio = (skin_hit[2]+clearance)/hair_hit[2]
            # Interior fragments are not the cavity. Keep their exclusion visible
            # in the receipt through the valid sample count, not a pass/fail gate.
            if .5 <= ratio <= 2:
                ratios.append(ratio)
                sectors.add(step//6)
    report = {'method': 'sampled_inner_hair_cavity_v3', 'samples': len(ratios),
              'sectors': len(sectors), 'scale': 1., 'center_blender': list(center),
              'source_proportions_preserved': True}
    if len(ratios) < 12 or len(sectors) < 3:
        return {**report, 'reason': 'insufficient_cavity_surface'}
    requested = max(1., float(np.percentile(ratios, 90)))
    limit = float(spec['fitting'].get('hair_cavity_scale_limit', 1.25))
    scale = min(requested, limit)
    report.update(requested_scale=requested, scale=scale, scale_limit=limit,
                  limited=requested > limit)
    if scale > 1.0001:
        place(meshes, Matrix.Translation(center) @ Matrix.Scale(scale, 4) @ Matrix.Translation(-center))
    return report


SIDE_MARGIN_M = .02   # a derived rear surface reaches this far beyond the head's width
SCALP_CAP_M = .0015   # the scalp cap lies this far outside the skin, under the strands' 3 mm
SCALP_TOP = .45       # skin whose normal rises this steeply is scalp (the forehead and face stay below)
SCALP_SIDE = -.5      # above the ears, skin facing no further forward than this is scalp (the temples)
SCALP_REAR = .3       # below the ears, skin facing this far backward is scalp down to the nape
SCALP_NAPE = .3       # the nape: this share of the head's height below its centre
SCALP_EAR = .97       # a height band this close to the head's widest holds the ears
SCALP_WIDTH = .85     # below the ears, the scalp spans this share of the half width (the ears' backs stay skin)
SCALP_SPECK = .05     # a cap island smaller than this share of the largest is dropped


def _srgb_to_linear(values):
    return np.where(values <= .04045, values/12.92, ((values+.055)/1.055)**2.4)


def _base_image(material):
    if not material or not material.node_tree:
        return None
    shader = next((node for node in material.node_tree.nodes if node.type == 'BSDF_PRINCIPLED'), None)
    links = shader.inputs['Base Color'].links if shader else []
    node = links[0].from_node if links else None
    if node is None or node.type != 'TEX_IMAGE':
        node = next((n for n in material.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image), None)
    return node.image if node is not None and node.image and node.image.size[0] else None


def hair_colour(meshes, samples=4000):
    """Median linear RGB of the strands' own texels (their base colour without a texture)."""
    rng = np.random.default_rng(0)
    colours = []
    for obj in meshes:
        mesh = obj.data
        if obj.get('scalp_backing') or not len(mesh.polygons):
            continue
        uv_layer = mesh.uv_layers.active
        if uv_layer is not None:
            uv = np.empty(len(mesh.loops)*2); uv_layer.data.foreach_get('uv', uv); uv = uv.reshape(-1, 2)
            material_index = np.empty(len(mesh.polygons), dtype=np.int64); mesh.polygons.foreach_get('material_index', material_index)
            loop_start = np.empty(len(mesh.polygons), dtype=np.int64); mesh.polygons.foreach_get('loop_start', loop_start)
            loop_total = np.empty(len(mesh.polygons), dtype=np.int64); mesh.polygons.foreach_get('loop_total', loop_total)
            loop_material = np.full(len(mesh.loops), -1, dtype=np.int64)
            for start, total, index in zip(loop_start, loop_total, material_index):
                loop_material[start:start+total] = index
        for index, slot in enumerate(obj.material_slots):
            image = _base_image(slot.material) if uv_layer is not None else None
            if image is None:
                shader = (next((n for n in slot.material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
                          if slot.material and slot.material.node_tree else None)
                if shader is not None:
                    colours.append(np.array(shader.inputs['Base Color'].default_value[:3], dtype=np.float64)[None])
                continue
            loops = np.flatnonzero(loop_material == index)
            if not len(loops):
                continue
            loops = rng.choice(loops, min(len(loops), samples), replace=False)
            width, height = image.size
            pixels = np.empty(width*height*image.channels, dtype=np.float32)
            image.pixels.foreach_get(pixels)
            pixels = pixels.reshape(height, width, image.channels)
            u = np.clip((uv[loops, 0] % 1)*width, 0, width-1).astype(np.int64)
            v = np.clip((uv[loops, 1] % 1)*height, 0, height-1).astype(np.int64)
            texels = pixels[v, u].astype(np.float64)
            if image.channels == 4:
                texels = texels[texels[:, 3] >= .5]
            texels = texels[:, :3]
            if not image.is_float and image.colorspace_settings.name.lower() in ('srgb', 'srgb 2.2', 'srgb - texture'):
                texels = _srgb_to_linear(texels)
            colours.append(texels)
    colours = np.concatenate(colours) if colours else np.zeros((0, 3))
    return np.median(colours, axis=0) if len(colours) else None


def add_scalp_cap(meshes, body, rig, spec):
    """A hair-coloured cap over the scalp, under the strands.

    The base body is bald, so skin shows wherever the strands part (a spiky crown, the back of
    twin tails). As game hair does, a thin cap in the strands' median colour covers the upper
    skull and the back of the head down to the nape; the face, forehead and ears stay skin.
    """
    from src.services.avatar_shell_garment import body_arrays
    report = {'method': 'scalp_cap_v1', 'added_faces': 0, 'input_strands_preserved': True}
    colour = hair_colour(meshes)
    if colour is None:
        return {**report, 'reason': 'hair_colour_unavailable'}
    data = body_arrays(body, rig)
    positions, normals, triangles, weld = data['positions'], data['normals'], data['triangles'], data['weld']
    dominant = np.char.lower(np.array(data['bones'])[data['weights'].argmax(axis=1)])
    head = np.char.find(dominant, 'head') >= 0
    lo, hi, _ = head_region(body, rig, spec)
    center = (lo+hi)/2
    # The ears: the highest height band nearly as wide as the head's widest ends at their top.
    lateral = np.abs(positions[:, 0]-center.x)
    edges = np.linspace(lo.z, hi.z, 13)
    widths = np.array([lateral[head & (positions[:, 2] >= a) & (positions[:, 2] < b)].max(initial=0.)
                       for a, b in zip(edges[:-1], edges[1:])])
    ear_top = edges[1:][widths >= widths.max()*SCALP_EAR].max()
    # Blender: +Z up, +Y the back of the head.
    top = (normals[:, 2] >= SCALP_TOP) & (positions[:, 2] >= center.z)   # not the ledge under the chin
    side = (positions[:, 2] >= ear_top) & (normals[:, 1] >= SCALP_SIDE)
    rear = ((normals[:, 1] >= SCALP_REAR) & (positions[:, 2] >= center.z-(hi.z-lo.z)*SCALP_NAPE)
            & (lateral <= widths.max()*SCALP_WIDTH))
    scalp = head & (top | side | rear)
    faces = weld[triangles[scalp[triangles].all(axis=1)]]
    if not len(faces):
        return {**report, 'reason': 'no_scalp_surface'}
    # Specks a bump of the forehead passes (a normal tilted up) show as dots between bangs.
    parent = np.arange(weld.max()+1)

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    for a, b, c in faces:
        for other in (b, c):
            ra, ro = find(a), find(other)
            if ra != ro:
                parent[ro] = ra
    roots = np.array([find(a) for a in faces[:, 0]])
    labels, sizes = np.unique(roots, return_counts=True)
    faces = faces[np.isin(roots, labels[sizes >= sizes.max()*SCALP_SPECK])]
    # One vertex per welded position (the body is split at UV seams).
    first = np.zeros(weld.max()+1, dtype=np.int64)
    first[weld[::-1]] = np.arange(len(weld))[::-1]
    used, inverse = np.unique(faces, return_inverse=True)
    points = positions[first[used]] + normals[first[used]]*SCALP_CAP_M
    mesh = bpy.data.meshes.new('HairScalpCap')
    mesh.from_pydata(points.tolist(), [], inverse.reshape(-1, 3).tolist())
    mesh.update()
    mesh.polygons.foreach_set('use_smooth', [True]*len(mesh.polygons))
    shade = colour*.85
    material = bpy.data.materials.new('HairScalpCap')
    material.use_nodes = True
    material.use_backface_culling = False
    shader = next(node for node in material.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
    shader.inputs['Base Color'].default_value = (*shade.tolist(), 1.)
    shader.inputs['Roughness'].default_value = .65
    mesh.materials.append(material)
    obj = bpy.data.objects.new('HairScalpCap', mesh)
    obj['scalp_cap'] = True
    bpy.context.scene.collection.objects.link(obj)
    meshes.append(obj)
    return {**report, 'added_faces': len(faces), 'added_vertices': len(used),
            'colour_linear': [round(float(c), 4) for c in shade], 'clearance_m': SCALP_CAP_M}


def _reference(path):
    image = bpy.data.images.load(path, check_existing=False)
    width, height = image.size
    values = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(values)
    rgba = values.reshape(height, width, image.channels)
    # Without a transparent reference, hair cannot be distinguished from a face
    # or background. Do not synthesize a cap from an opaque rectangle.
    if image.channels < 4 or not np.any(rgba[:, :, 3] < .1):
        bpy.data.images.remove(image)
        return None
    occupied = rgba[:, :, 3] >= .8
    ys, xs = np.where(occupied)
    if len(xs) < 16:
        bpy.data.images.remove(image)
        return None
    return image, occupied, (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))


def repair_hair_backing(meshes, body, rig, spec, image_paths, *, shared_canvas=False):
    """Bridge a missing rear surface where the accepted rear image contains hair.

    A projected rear image supplies the strand color/texture. Geometry follows
    the measured rear head surface, with a small clearance and overlap beneath
    existing strands. V4 extends the backing to the reference silhouette below
    the skull; it does not claim to recover individual missing locks.
    """
    extended = spec['fitting'].get('hair_rear_surface') == 'reference-silhouette-v4'
    report = {'method': 'reference_rear_surface_v4' if extended else 'reference_backed_rear_roots_v3', 'added_faces': 0,
              'input_strands_preserved': True, 'body_geometry_preserved': True}
    path = (image_paths or {}).get('back')
    if not path:
        return {**report, 'reason': 'rear_reference_unavailable'}
    reference = _reference(path)
    if reference is None:
        return {**report, 'reason': 'rear_reference_alpha_unavailable'}
    image, mask, (px0, py0, px1, py1) = reference
    width, height = image.size
    lo, hi, collar = head_region(body, rig, spec)
    hair_lo, hair_hi = bounds(meshes)
    floor = hair_lo.z if extended else max(lo.z, collar, hair_lo.z)
    center = (lo+hi)/2
    skull, hair = _Surface(body), _Surface(meshes)
    clearance = max(.001, float(spec['fitting'].get('scalp_clearance_m', .003)))
    if hi.z <= floor or hair_hi.x-hair_lo.x <= 1e-8:
        bpy.data.images.remove(image)
        return {**report, 'reason': 'no_rear_head_region'}
    # Uploaded tiles share pixel scale but have no metre origin. Register the
    # rear image uniformly to the already seated hair, anchored at its crown.
    # Authored metric images retain their original shared canvas coordinates.
    pixel_scale = (px1-px0)/max(hair_hi.x-hair_lo.x, 1e-8)
    canvas = spec['canvas']
    use_canvas = bool(shared_canvas and width == canvas['width'] and height == canvas['height'])
    if extended:
        # Include the whole accepted silhouette even when the provider omitted
        # its lower rear. Register it at the same pixel scale, never stretch it.
        reference_floor = ((py0-(height-1-canvas['sole_y']))/canvas['pixels_per_metre']
                           if use_canvas else hair_hi.z-(py1-py0)/pixel_scale)
        floor = min(floor, reference_floor)

    def project(x, z):
        if use_canvas:
            return (canvas['center_x']-x*canvas['pixels_per_metre'],
                    height-1-canvas['sole_y']+z*canvas['pixels_per_metre'])
        return (px1-(x-hair_lo.x)*pixel_scale,
                py1-(hair_hi.z-z)*pixel_scale)

    columns, rows = spec['fitting'].get('hair_backing_grid', [81, 97])
    x_min, x_max = (hair_lo.x, hair_hi.x) if extended else (lo.x, hi.x)
    top = hair_hi.z if extended else hi.z
    # Cells reach wherever the reference has hair within half a cell; the material's alpha then
    # cuts the backing to the reference outline instead of the grid's steps.
    cell_px = max(abs(project(x_max, top)[0] - project(x_min, top)[0])/max(columns-1, 1),
                  abs(project(x_min, top)[1] - project(x_min, floor)[1])/max(rows-1, 1))
    reach = mask.copy()
    for _ in range(max(1, int(math.ceil(cell_px/2)))):
        grown = reach.copy()
        grown[1:] |= reach[:-1]; grown[:-1] |= reach[1:]; grown[:, 1:] |= reach[:, :-1]; grown[:, :-1] |= reach[:, 1:]
        reach = grown
    radius_x = max((hi.x-lo.x)/2, (hair_hi.x-hair_lo.x)*.5, 1e-6)
    radius_y = max((hi.y-lo.y)/2, 1e-6)
    radius_z = max(top-center.z, 1e-6)
    points, uvs, missing = {}, {}, set()
    lower_samples = 0
    origin_y = max(hi.y, hair_hi.y)+(hi-lo).length
    for row, z in enumerate(np.linspace(floor, top, rows)):
        for col, x in enumerate(np.linspace(x_min, x_max, columns)):
            px, py = project(float(x), float(z))
            ix, iy = round(px), round(py)
            # One-pixel inset avoids projecting transparent border RGB.
            if ix < 1 or iy < 1 or ix >= width-1 or iy >= height-1 or not reach[iy, ix]:
                continue
            origin = Vector((x, origin_y, z))
            hit = skull.cast(origin, Vector((0, -1, 0)))
            if (hit is not None and z >= max(lo.z, collar)
                    and hit[0].y >= center.y and hit[1].y > .1):
                point = hit[0]+hit[1]*clearance
            elif extended and abs(x-center.x) <= (hi.x-lo.x)/2+SIDE_MARGIN_M:
                # Only behind the head's own width: twin tails and side locks are whole strands,
                # and a sheet beside them shows its grid edge from the front.
                # The old root-only patch stopped at the neck and never filled
                # the absent rear of a bob. Continue the measured rear curvature
                # down through the opaque reference silhouette, keeping every
                # transparent opening and all original strands. Never cross the
                # head centre toward the face. This is a derived curved surface,
                # not a claim to recover the provider's original strand geometry.
                horizontal = min(.98, ((x-center.x)/radius_x)**2)
                upper = (max(0., z-center.z)/radius_z)**2
                depth = radius_y*math.sqrt(max(.0025, 1-horizontal-upper))
                point = Vector((x, center.y+depth+clearance, z))
                lower_samples += int(z < max(lo.z, collar))
            else:
                continue
            hair_hit = hair.cast(origin, Vector((0, -1, 0)))
            index = (row, col)
            points[index] = point
            # Normal offset changes X/Z as well; project the final vertex.
            u, v = project(point.x, point.z)
            uvs[index] = ((u+.5)/width, (v+.5)/height)
            if hair_hit is None or hair_hit[0].y < point.y-clearance*.25:
                missing.add(index)
    # Extend two cells beneath surrounding source strands to avoid a hard gap.
    support = {index for row, col in missing for dy in range(-2, 3) for dx in range(-2, 3)
               if (index := (row+dy, col+dx)) in points}
    faces = []
    for row in range(rows-1):
        for col in range(columns-1):
            face = ((row, col), (row+1, col), (row+1, col+1), (row, col+1))
            if all(index in support for index in face):
                faces.append(face)
    if not faces:
        bpy.data.images.remove(image)
        return {**report, 'reason': 'no_supported_rear_gap', 'exposed_samples': len(missing)}
    used = sorted({index for face in faces for index in face})
    indices = {index: i for i, index in enumerate(used)}
    mesh = bpy.data.meshes.new('HairRearRootBacking')
    mesh.from_pydata([points[index] for index in used], [],
                     [tuple(indices[index] for index in face) for face in faces])
    mesh.update()
    uv = mesh.uv_layers.new(name='RearReferenceUV')
    for polygon in mesh.polygons:
        polygon.use_smooth = True
        for loop_index in polygon.loop_indices:
            uv.data[loop_index].uv = uvs[used[mesh.loops[loop_index].vertex_index]]
    material = bpy.data.materials.new('HairRearReference')
    material.use_nodes = True
    material.use_backface_culling = False
    shader = next(node for node in material.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
    shader.inputs['Roughness'].default_value = .65
    texture = material.node_tree.nodes.new('ShaderNodeTexImage')
    texture.image = image
    texture.extension = 'EXTEND'
    # Alpha clip (exported as glTF MASK): the backing ends at the reference's own outline.
    clip = material.node_tree.nodes.new('ShaderNodeMath')
    clip.operation = 'ROUND'
    material.node_tree.links.new(texture.outputs['Alpha'], clip.inputs[0])
    material.node_tree.links.new(clip.outputs['Value'], shader.inputs['Alpha'])
    texture_edge = int(spec.get('runtime', {}).get('texture_max_edge', max(width, height)))
    if max(width, height) > texture_edge:
        scale = texture_edge/max(width, height)
        image.scale(max(1, round(width*scale)), max(1, round(height*scale)))
    image.pack()
    material.node_tree.links.new(texture.outputs['Color'], shader.inputs['Base Color'])
    mesh.materials.append(material)
    obj = bpy.data.objects.new('HairRearRootBacking', mesh)
    obj['scalp_backing'] = True
    obj['derived_from'] = 'accepted_rear_reference_and_measured_head'
    bpy.context.scene.collection.objects.link(obj)
    meshes.append(obj)
    return {**report, 'added_faces': len(faces), 'added_vertices': len(used),
            'exposed_samples': len(missing), 'source_view': 'back',
            'lower_reference_samples': lower_samples,
            'projection': 'shared_canvas' if use_canvas else 'uniform_crown_registration',
            'source_texture_size_px': [width, height], 'texture_size_px': list(image.size),
            'clearance_m': clearance,
            'limitation': ('Missing rear surface follows the reference silhouette and measured head curvature; source strands are retained.'
                          if extended else 'Rear root backing is reconstructed; hanging strands remain the source mesh.')}
