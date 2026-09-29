"""Reserve a non-overlapping base-color UV region for generated face art."""
import numpy as np
import bpy
from mathutils import Vector

from src.services.avatar_blender_common import MATTE_ROUGHNESS


UV_NAME = 'FactoryExpressionBaseColorUV'
ATLAS_REGION_EDGE = 2048


def _image_node(material):
    if not material or not material.use_nodes:
        return None, None
    shader = next((node for node in material.node_tree.nodes if node.type == 'BSDF_PRINCIPLED'), None)
    if not shader:
        return None, None
    pending = [link.from_node for link in material.node_tree.links if link.to_node == shader and link.to_socket == shader.inputs['Base Color']]
    seen = set()
    while pending:
        node = pending.pop(0)
        if node in seen:
            continue
        seen.add(node)
        if node.type == 'TEX_IMAGE' and node.image:
            return shader, node
        pending.extend(link.from_node for link in material.node_tree.links if link.to_node == node)
    return shader, None


def _head_weight(obj, vertex, head_groups):
    return sum(group.weight for group in vertex.groups if group.group in head_groups)


def _front_faces(body):
    samples = []
    bounds = []
    for obj in body:
        head_groups = {group.index for group in obj.vertex_groups if group.name.lower().split(':')[-1] == 'head'}
        if not head_groups:
            continue
        matrix = obj.matrix_world
        skin_vertices = set()
        for polygon in obj.data.polygons:
            material = obj.data.materials[polygon.material_index] if obj.data.materials else None
            if material and material.get('base_underlayer'):
                continue
            skin_vertices.update(polygon.vertices)
            if min(_head_weight(obj, obj.data.vertices[index], head_groups) for index in polygon.vertices) <= .6:
                continue
            points = [matrix @ obj.data.vertices[index].co for index in polygon.vertices]
            normal = (matrix.to_3x3() @ polygon.normal).normalized()
            samples.append((obj, polygon, points, normal))
        bounds.extend(matrix @ obj.data.vertices[index].co for index in skin_vertices
                      if _head_weight(obj, obj.data.vertices[index], head_groups) > .6)
    if not bounds:
        raise ValueError('Missing Head-weighted body geometry for expression UV')
    lo = Vector(tuple(min(point[axis] for point in bounds) for axis in range(3)))
    hi = Vector(tuple(max(point[axis] for point in bounds) for axis in range(3)))
    depth = hi.y-lo.y
    selected = [(obj, polygon, points) for obj, polygon, points, normal in samples
                if normal.y < -.18 and all(point.y < hi.y-depth*.45 for point in points)]
    if not selected:
        # Some imported bodies use the opposite front winding. Choose the side
        # facing the factory's front camera, while retaining the same depth cut.
        selected = [(obj, polygon, points) for obj, polygon, points, normal in samples
                    if normal.y < 0 and all(point.y < hi.y-depth*.45 for point in points)]
    if not selected:
        raise ValueError('Missing front Head faces for expression UV')
    return selected, lo, hi


def _pixels(image, width=512, height=512):
    image.colorspace_settings.name = image.colorspace_settings.name
    source = np.empty(image.size[0]*image.size[1]*4, dtype=np.float32)
    image.pixels.foreach_get(source)
    source = source.reshape(image.size[1], image.size[0], 4)
    ys = np.minimum(image.size[1]-1, np.floor(np.arange(height)*image.size[1]/height).astype(int))
    xs = np.minimum(image.size[0]-1, np.floor(np.arange(width)*image.size[0]/width).astype(int))
    return source[ys[:, None], xs[None, :]]


def _skin_color(material, image, loop_uvs):
    shader, _ = _image_node(material)
    fallback = np.array(shader.inputs['Base Color'].default_value[:] if shader else (.91, .70, .59, 1), dtype=np.float32)
    if image is None or not loop_uvs:
        return fallback
    pixels = _pixels(image, image.size[0], image.size[1])
    colors = []
    for uv in loop_uvs:
        x = min(image.size[0]-1, max(0, int((uv.x % 1) * image.size[0])))
        y = min(image.size[1]-1, max(0, int((uv.y % 1) * image.size[1])))
        colors.append(pixels[y, x])
    return np.median(np.asarray(colors), axis=0) if colors else fallback


def _prepare_expression_uv(body):
    """Keep geometry/material groups and reserve the right atlas half for face art."""
    marked = {material for obj in body for material in obj.data.materials
              if material and material.get('factory_expression_uv') == 'expression-base-color-uv-v1'}
    if marked:
        complete = all(obj.data.uv_layers.get(UV_NAME) for obj in body if obj.type == 'MESH')
        image = _image_node(next(iter(marked)))[1]
        width, height = image.image.size if image is not None else (1024, 512)
        return {'available': complete, 'revision': 'expression-base-color-uv-v1', 'uv': UV_NAME,
                'atlas_size': [width, height], 'face_region': [width//2, 0, width//2, height],
                'materials': len(marked), 'preserved': True,
                **({} if complete else {'reason': 'incomplete_existing_expression_uv'})}
    selected, lo, hi = _front_faces(body)
    selected_ids = {(id(obj), polygon.index) for obj, polygon, _ in selected}
    side = max(hi.x-lo.x, hi.z-lo.z)
    center_x, center_z = (lo.x+hi.x)/2, (lo.z+hi.z)/2
    material_face_uvs = {}
    for obj, polygon, _ in selected:
        old = obj.data.uv_layers.active
        if old:
            material_face_uvs.setdefault(obj.data.materials[polygon.material_index], []).extend(old.data[index].uv.copy() for index in polygon.loop_indices)

    # Keep 4K provider albedo at its native resolution inside the left half.
    # The same normalized UV split remains compatible with older 2K atlases.
    edge = ATLAS_REGION_EDGE
    for material in material_face_uvs:
        _, node = _image_node(material)
        if node and node.image:
            edge = max(edge, min(4096, max(node.image.size)))
    atlases = {}
    for material, face_uvs in material_face_uvs.items():
        shader, texture_node = _image_node(material)
        original = texture_node.image if texture_node else None
        left = _pixels(original, edge, edge) if original else np.tile(np.asarray(shader.inputs['Base Color'].default_value[:], dtype=np.float32), (edge, edge, 1))
        color = _skin_color(material, original, face_uvs)
        atlas_pixels = np.empty((edge, edge*2, 4), dtype=np.float32)
        atlas_pixels[:, :edge] = left
        atlas_pixels[:, edge:] = color
        atlas = bpy.data.images.new(f'{material.name} ExpressionAtlas', width=edge*2, height=edge, alpha=True)
        atlas.pixels.foreach_set(atlas_pixels.ravel())
        atlas.pack()
        nodes = material.node_tree.nodes
        if texture_node is None:
            texture_node = nodes.new('ShaderNodeTexImage')
            material.node_tree.links.new(texture_node.outputs['Color'], shader.inputs['Base Color'])
        texture_node.image = atlas
        uv_node = nodes.new('ShaderNodeUVMap')
        uv_node.uv_map = UV_NAME
        material.node_tree.links.new(uv_node.outputs['UV'], texture_node.inputs['Vector'])
        material['factory_expression_uv'] = 'expression-base-color-uv-v1'
        atlases[material] = atlas

    for obj in body:
        old = obj.data.uv_layers.active
        if old is None:
            continue
        target = obj.data.uv_layers.get(UV_NAME) or obj.data.uv_layers.new(name=UV_NAME)
        for loop in obj.data.loops:
            uv = old.data[loop.index].uv
            target.data[loop.index].uv = (uv.x*.5, uv.y)
        for polygon in obj.data.polygons:
            if (id(obj), polygon.index) not in selected_ids or obj.data.materials[polygon.material_index] not in atlases:
                continue
            for loop_index in polygon.loop_indices:
                point = obj.matrix_world @ obj.data.vertices[obj.data.loops[loop_index].vertex_index].co
                source_x = (point.x-center_x)/side+.5
                source_y = .5-(point.z-center_z)/side
                # Blender UV has bottom-left origin; its glTF exporter writes
                # this as the top-left-origin TEXCOORD used by the PNG.
                target.data[loop_index].uv = (.5+source_x*.5, 1-source_y)
        # Base color names this UV map explicitly. Keep the original map active
        # so normal/ORM texture nodes that use Blender's implicit active UV are
        # exported against their unchanged coordinates.
        old.active_render = True
    return {'available': True, 'revision': 'expression-base-color-uv-v1', 'uv': UV_NAME,
            'atlas_size': [edge*2, edge],
            'face_region': [edge, 0, edge, edge],
            'materials': len(atlases), 'front_faces': len(selected)}


def prepare_expression_uv(body):
    # Expression support is an optional derived representation. A body that
    # cannot expose a suitable UV surface must still finish assembly intact.
    try:
        result = _prepare_expression_uv(body)
        for obj in body:
            for material in obj.data.materials:
                if not material or material.get('factory_expression_uv') != 'expression-base-color-uv-v1':
                    continue
                shader, _ = _image_node(material)
                if shader is None:
                    continue
                for name, value in [('Emission Strength', 0), ('Metallic', 0), ('Roughness', MATTE_ROUGHNESS)]:
                    socket = shader.inputs.get(name)
                    if socket is not None:
                        for link in list(socket.links):
                            material.node_tree.links.remove(link)
                        socket.default_value = value
        return result
    except Exception as exc:
        return {'available': False, 'revision': 'expression-base-color-uv-v1',
                'reason': type(exc).__name__}
