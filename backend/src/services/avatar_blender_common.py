"""Blender helpers shared by the fitting, rig-transfer and reference workers.

Runs inside Blender only. Every worker imports its geometry helpers from here so
the part, body and rig workers use one loader, one weight transfer and one camera.
"""
import hashlib
from pathlib import Path
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load(path):
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    return list(set(bpy.context.scene.objects)-before)


def bounds(meshes):
    points = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
    return Vector([min(p[i] for p in points) for i in range(3)]), Vector([max(p[i] for p in points) for i in range(3)])


def skeleton(objects):
    rigs = [o for o in objects if o.type == 'ARMATURE']
    if len(rigs) != 1:
        raise ValueError('Exactly one canonical armature is required')
    rig = rigs[0]
    if not rig.data.bones:
        raise ValueError('Missing bones')
    return rig


def body_meshes(objects, rig):
    # Blender's importer creates Icosphere custom bone widgets in the scene.
    # These are display aids, not glTF geometry or weight-transfer surfaces.
    widgets = {b.custom_shape for b in rig.pose.bones if b.custom_shape}
    meshes = [o for o in objects if o.type == 'MESH' and o not in widgets]
    if not meshes:
        raise ValueError('Body has no surface')
    return meshes


def gltf_to_blender(p):
    return Vector((p[0], -p[2], p[1]))


def blender_to_gltf(p):
    return [p.x, p.z, -p.y]


def fit_matrix(anchors, tolerance):
    source = np.array([gltf_to_blender(a['source']) for a in anchors], dtype=float)
    target = np.array([gltf_to_blender(a['target']) for a in anchors], dtype=float)
    a, b = source-source.mean(axis=0), target-target.mean(axis=0)
    if np.linalg.matrix_rank(a, tol=1e-7) < 2 or np.linalg.matrix_rank(b, tol=1e-7) < 2:
        raise ValueError('At least three non-collinear fitting anchors are required')
    u, singular, vt = np.linalg.svd(a.T @ b)
    correction = np.eye(3); correction[-1, -1] = np.linalg.det(vt.T @ u.T)
    rotation = vt.T @ correction @ u.T
    scale = float(np.sum(singular*np.diag(correction))/np.sum(a*a))
    if not .001 <= scale <= 1000:
        raise ValueError('Invalid uniform scale')
    translation = target.mean(axis=0)-scale*rotation@source.mean(axis=0)
    fitted = (scale*rotation@source.T).T+translation
    errors = np.linalg.norm(fitted-target, axis=1)
    if tolerance is not None and max(errors) > tolerance:
        raise ValueError('Wearing anchors disagree; redesign required instead of stretching silhouette')
    result = Matrix.Identity(4)
    for i in range(3):
        for j in range(3):
            result[i][j] = float(scale*rotation[i, j])
        result[i][3] = float(translation[i])
    return result, {'uniform_scale': scale, 'anchor_errors_m': errors.tolist()}


def weight_surface(meshes, rig):
    points, triangles, weights = [], [], []
    for obj in meshes:
        offset = len(points)
        points += [obj.matrix_world @ v.co for v in obj.data.vertices]
        names = {g.index: g.name for g in obj.vertex_groups if g.name in rig.data.bones}
        for v in obj.data.vertices:
            row = {names[g.group]: g.weight for g in v.groups if g.group in names and g.weight > 0}
            if not row or abs(sum(row.values())-1) > .02:
                raise ValueError(f'Canonical body has missing or non-normalized weights: {obj.name} vertex {v.index}: {row}')
            weights.append(row)
        obj.data.calc_loop_triangles()
        triangles += [tuple(offset+i for i in t.vertices) for t in obj.data.loop_triangles]
    return BVHTree.FromPolygons(points, triangles, all_triangles=True), points, triangles, weights


def bind(meshes, body, rig, contract, *, transform=None):
    if transform is None:
        transform, report = fit_matrix(contract['anchors'], contract['max_anchor_error_m'])
        fitting = 'uniform_anchor_alignment'
    else:
        # Factory fitting already resolved width, depth, height and position.
        # Solving uniform anchors again would discard the depth correction.
        report = {'transform_blender': [list(row) for row in transform]}
        fitting = 'shared_frame_axis_alignment'
    tree, points, triangles, weights = weight_surface(body, rig)
    distances, inside = [], 0
    for obj in meshes:
        # Unrigged source only: do not silently discard an independently authored skin.
        if any(mod.type == 'ARMATURE' for mod in obj.modifiers):
            raise ValueError('Part is already rigged; supply the unrigged generated shape')
        world = transform @ obj.matrix_world
        obj.parent = None; obj.matrix_world = Matrix.Identity(4)
        obj.data.transform(world, shape_keys=True)
        obj.vertex_groups.clear()
        groups = {b.name: obj.vertex_groups.new(name=b.name) for b in rig.data.bones}
        for vertex in obj.data.vertices:
            hit, normal, index, distance = tree.find_nearest(vertex.co)
            if hit is None:
                raise ValueError('No body surface for weight transfer')
            distances.append(distance)
            inside += int((vertex.co-hit).dot(normal) < -.002)
            if contract['binding'] == 'rigid':
                row = {contract['bone']: 1.}
            else:
                maximum_distance = contract.get('max_transfer_distance_m')
                if maximum_distance is not None and distance > maximum_distance:
                    raise ValueError('Part is too far from the body for a reliable weight transfer')
                ids = triangles[index]
                bary = barycentric_transform(hit, *(points[i] for i in ids), Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
                row = {}
                for i, factor in zip(ids, bary):
                    for name, weight in weights[i].items():
                        row[name] = row.get(name, 0)+max(0, factor)*weight
                row = dict(sorted(row.items(), key=lambda pair: pair[1], reverse=True)[:4])
                total = sum(row.values())
                if total <= 1e-8:
                    # A degenerate body triangle has no barycentric weights: take its nearest corner's.
                    corner = min(ids, key=lambda i: (points[i]-hit).length)
                    row = dict(sorted(weights[corner].items(), key=lambda pair: pair[1], reverse=True)[:4])
                    total = sum(row.values())
                if total <= 1e-8:
                    raise ValueError('Zero transferred skin weight')
                row = {k: v/total for k, v in row.items()}
            for name, weight in row.items():
                if weight > 1e-8:
                    groups[name].add([vertex.index], weight, 'REPLACE')
        modifier = obj.modifiers.new('CanonicalBodySkin', 'ARMATURE'); modifier.object = rig
        obj['standard_slot'] = contract['slot']
    report.update(binding=contract['binding'], max_surface_distance_m=max(distances),
                  possible_inside_vertices=inside, visual_review='required',
                  fitting=fitting, weights='body_surface_barycentric' if contract['binding'] == 'transfer' else 'single_canonical_bone')
    return report


# One soft matte finish for character surfaces; the viewer applies the same values
# (frontend/src/matte-materials.ts).
MATTE_ROUGHNESS = .95
MATTE_NORMAL_STRENGTH = .4


def matte_materials(objects):
    """No metal, no emission, near-full roughness, softened normal maps and both faces drawn.

    Provider metal/roughness/emission maps are unlinked, so the exporter drops them. Double-sided
    export shows a garment's inside at its openings and hides a provider's reversed triangles.
    """
    done = set()
    for obj in objects:
        for material in obj.data.materials:
            if not material or not material.use_nodes or material in done:
                continue
            done.add(material)
            material.use_backface_culling = False
            tree = material.node_tree
            for node in tree.nodes:
                if node.type == 'NORMAL_MAP':
                    node.inputs['Strength'].default_value = MATTE_NORMAL_STRENGTH
                if node.type != 'BSDF_PRINCIPLED':
                    continue
                for name, value in (('Metallic', 0.), ('Roughness', MATTE_ROUGHNESS), ('Emission Strength', 0.),
                                    ('Emission Color', (0., 0., 0., 1.)), ('Specular IOR Level', .5),
                                    ('Specular Tint', (1., 1., 1., 1.)), ('IOR', 1.5)):
                    socket = node.inputs.get(name)
                    if socket is None:
                        continue
                    for link in list(socket.links):
                        tree.links.remove(link)
                    socket.default_value = value
    return {'finish': 'matte', 'materials': len(done), 'roughness': MATTE_ROUGHNESS,
            'normal_strength': MATTE_NORMAL_STRENGTH}


# The viewer's SoftLights (frontend/src/viewer.tsx), in its frame: +Y up, +Z front.
SOFT_HEMISPHERE = ('#fffaf2', '#e0d3c1', 2.4)
SOFT_AMBIENT = .65
SOFT_SUNS = ((2, 4, 6, 1.9), (-4, 2, 4, .85), (0, 3, -5, .9))


def soft_lighting(scene):
    """Light product previews like the viewer: warm hemisphere, ambient fill and three soft suns.

    three.js hemisphere irradiance at normal n is I*mix(ground, sky, .5 + .5 n.up). A world
    radiance a + b*z gives pi*a + (2 pi/3)*b*n.z, hence a = I(g+s)/(2 pi), b = 3 I(s-g)/(4 pi).
    """
    for obj in [o for o in scene.objects if o.type == 'LIGHT']:
        bpy.data.objects.remove(obj, do_unlink=True)

    def linear(value):
        channels = [int(value[i:i+2], 16)/255 for i in (1, 3, 5)]
        return [c/12.92 if c <= .04045 else ((c + .055)/1.055)**2.4 for c in channels]
    sky_hex, ground_hex, intensity = SOFT_HEMISPHERE
    sky, ground = linear(sky_hex), linear(ground_hex)
    world = bpy.data.worlds.new('SoftPreviewLight'); scene.world = world; world.use_nodes = True
    tree = world.node_tree; tree.nodes.clear()
    direction = tree.nodes.new('ShaderNodeSeparateXYZ')
    tree.links.new(tree.nodes.new('ShaderNodeTexCoord').outputs['Generated'], direction.inputs[0])
    combine = tree.nodes.new('ShaderNodeCombineColor')
    for k in range(3):
        channel = tree.nodes.new('ShaderNodeMath'); channel.operation = 'MULTIPLY_ADD'
        tree.links.new(direction.outputs['Z'], channel.inputs[0])
        channel.inputs[1].default_value = 3*intensity*(sky[k] - ground[k])/(4*np.pi)
        channel.inputs[2].default_value = (intensity*(ground[k] + sky[k])/2 + SOFT_AMBIENT)/np.pi
        tree.links.new(channel.outputs[0], combine.inputs[k])
    background = tree.nodes.new('ShaderNodeBackground')
    tree.links.new(combine.outputs[0], background.inputs['Color'])
    tree.links.new(background.outputs[0], tree.nodes.new('ShaderNodeOutputWorld').inputs[0])
    for index, (x, y, z, power) in enumerate(SOFT_SUNS):
        sun = bpy.data.objects.new(f'SoftSun{index}', bpy.data.lights.new(f'SoftSun{index}', 'SUN'))
        sun.data.energy = power
        scene.collection.objects.link(sun)
        sun.rotation_euler = (-Vector((x, -z, y))).to_track_quat('-Z', 'Y').to_euler()
    transforms = [item.identifier for item in scene.view_settings.bl_rna.properties['view_transform'].enum_items]
    if 'Khronos PBR Neutral' in transforms:
        scene.view_settings.view_transform = 'Khronos PBR Neutral'  # three.js NeutralToneMapping
    scene.cycles.samples = 8; scene.cycles.use_denoising = True


def export(path, objects):
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = next(o for o in objects if o.type == 'ARMATURE')
    bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True,
                              export_animations=True, export_animation_mode='NLA_TRACKS',
                              export_extras=True, export_all_influences=False)


def camera_setup(height):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'; scene.cycles.samples = 8
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'; scene.render.image_settings.color_mode = 'RGBA'
    scene.render.film_transparent = True
    camera = bpy.data.objects.new('StandardCamera', bpy.data.cameras.new('StandardCamera'))
    scene.collection.objects.link(camera); scene.camera = camera
    camera.data.type = 'ORTHO'; camera.data.ortho_scale = 2048*height/1500
    center = Vector((0, 0, height*(.5+26/1500)))
    for i, pos in enumerate(((2, -3, 4), (-3, -1, 2), (0, 3, 3))):
        light = bpy.data.objects.new(f'StandardLight{i}', bpy.data.lights.new(f'StandardLight{i}', 'AREA'))
        scene.collection.objects.link(light); light.location = pos; light.data.energy = 180; light.data.size = 4
        light.rotation_euler = (center-light.location).to_track_quat('-Z', 'Y').to_euler()
    return camera, center


def render(path, camera, center, direction, size):
    camera.location = center+Vector(direction)*4
    camera.rotation_euler = (center-camera.location).to_track_quat('-Z', 'Y').to_euler()
    scene = bpy.context.scene; scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.filepath = str(path); bpy.ops.render.render(write_still=True)
