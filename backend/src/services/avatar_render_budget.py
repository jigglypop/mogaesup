"""Local runtime derivatives; provider source GLBs remain untouched."""
import bpy
import bmesh
import json

PART_TRIANGLES = {'body': 8000, 'hair': 3500, 'hat': 1600, 'top': 2000, 'bottom': 1600, 'shoes': 1600,
                  'weapon': 1200, 'tool': 1000, 'glasses': 500}
TEXTURE_EDGES = {'body': 1024, 'hair': 512, 'hat': 512, 'top': 512, 'bottom': 512,
                 'shoes': 512, 'weapon': 512, 'tool': 256, 'glasses': 256}
MATTE_ROUGHNESS = {'body': .65, 'hair': .58, 'top': .8, 'bottom': .8, 'shoes': .65}


def _material_signature(material):
    """Only deduplicate plain static glTF PBR graphs with identical inputs."""
    if not material.use_nodes or material.animation_data or material.node_tree.animation_data:
        return None
    nodes = material.node_tree.nodes
    if any(node.type not in ('BSDF_PRINCIPLED', 'OUTPUT_MATERIAL', 'TEX_IMAGE') for node in nodes):
        return None
    visited = set()
    def value(socket):
        if socket.is_linked:
            return tuple((node_value(link.from_node), link.from_socket.identifier) for link in socket.links)
        default = getattr(socket, 'default_value', None)
        return tuple(default) if hasattr(default, '__len__') and not isinstance(default, str) else default
    def node_value(node):
        if node in visited:
            raise ValueError('Cyclic material')
        visited.add(node)
        try:
            image = ((node.image.as_pointer() if node.image else None), node.interpolation,
                     node.projection, node.extension) if node.type == 'TEX_IMAGE' else None
            return (node.type, image, tuple((s.identifier, value(s)) for s in node.inputs))
        finally:
            visited.remove(node)
    outputs = [node for node in nodes if node.type == 'OUTPUT_MATERIAL' and node.is_active_output]
    if len(outputs) != 1:
        return None
    extras = json.dumps(dict(material.items()), sort_keys=True, default=str)
    return (extras, material.use_backface_culling, getattr(material, 'surface_render_method', None),
            tuple(material.diffuse_color), node_value(outputs[0]))


def prepare_materials(meshes, slot, *, preserve_appearance=False):
    originals, canonical = {}, {}
    before = {material for obj in meshes for material in obj.data.materials if material}
    for obj in meshes:
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        for index, original in enumerate(obj.data.materials):
            if not original:
                continue
            if original not in originals:
                material = original.copy()
                if not preserve_appearance and material.use_nodes and slot in MATTE_ROUGHNESS:
                    for node in material.node_tree.nodes:
                        if node.type == 'BSDF_PRINCIPLED':
                            roughness = node.inputs.get('Roughness')
                            if roughness and not roughness.is_linked:
                                roughness.default_value = max(roughness.default_value, MATTE_ROUGHNESS[slot])
                signature = _material_signature(material)
                if signature is not None:
                    material = canonical.setdefault(signature, material)
                originals[original] = material
            obj.data.materials[index] = originals[original]
        # Repeated slots still produce separate draw groups in exported GLB.
        unique, mapping = [], {}
        for index, material in enumerate(obj.data.materials):
            if material not in unique:
                unique.append(material)
            mapping[index] = unique.index(material)
        face_materials = [mapping.get(face.material_index, 0) for face in obj.data.polygons]
        if len(unique) < len(obj.data.materials) and all(unique):
            obj.data.materials.clear()
            for material in unique:
                obj.data.materials.append(material)
            for face, index in zip(obj.data.polygons, face_materials):
                face.material_index = index
    after = {material for obj in meshes for material in obj.data.materials if material}
    return {'source_materials': len(before), 'runtime_materials': len(after),
            'shader_profile': 'matte-pbr' if not preserve_appearance and slot in MATTE_ROUGHNESS else 'source-pbr'}


def consolidate_part(meshes):
    """Join unrigged components in one slot; never merge separate equip slots."""
    if len(meshes) < 2 or any(obj.data.shape_keys or obj.modifiers or obj.animation_data for obj in meshes):
        return
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    meshes[:] = [bpy.context.view_layer.objects.active]


def optimize_part(meshes, slot, *, target_triangles=None, texture_max_edge=None, preserve_appearance=False, merge=True):
    def triangles(obj):
        return sum(max(0, len(p.vertices)-2) for p in obj.data.polygons)
    before = sum(triangles(obj) for obj in meshes)
    source_objects = len(meshes)
    material_report = prepare_materials(meshes, slot, preserve_appearance=preserve_appearance)
    if slot != 'body' and merge:
        consolidate_part(meshes)
    target = max(100, int(target_triangles if target_triangles is not None else PART_TRIANGLES.get(slot, 2000)))
    texture_edge = int(texture_max_edge if texture_max_edge is not None else TEXTURE_EDGES.get(slot, 512))
    texture_count = 0
    resized = {}
    skipped = []
    # Each object receives its share of the slot budget. Simplify BEFORE skin
    # transfer, so new vertices receive weights on the exact final geometry.
    for obj in meshes:
        count = triangles(obj)
        if before > target and obj.data.shape_keys:
            skipped.append({'object': obj.name, 'reason': 'shape_keys_preserved', 'triangles': count})
        if before > target and count > 12 and not obj.data.shape_keys:
            # GLB often duplicates vertices at UV/normal seams. Collapsing these
            # disconnected triangles independently tears the surface. Weld only
            # coincident positions; UV coordinates remain per-corner loop data.
            mesh = bmesh.new()
            mesh.from_mesh(obj.data)
            extent = max(obj.dimensions)
            bmesh.ops.remove_doubles(mesh, verts=list(mesh.verts), dist=max(extent*1e-6, 1e-8))
            mesh.to_mesh(obj.data); mesh.free(); obj.data.update()
            bpy.ops.object.select_all(action='DESELECT')
            obj.select_set(True); bpy.context.view_layer.objects.active = obj
            modifier = obj.modifiers.new('RuntimeTriangleBudget', 'DECIMATE')
            modifier.ratio = target/before
            modifier.use_collapse_triangulate = True
            bpy.ops.object.modifier_apply(modifier=modifier.name)
            for polygon in obj.data.polygons:
                polygon.use_smooth = True
        for material in obj.data.materials:
            if not material or not material.use_nodes:
                continue
            for node in material.node_tree.nodes:
                if node.type != 'TEX_IMAGE' or node.image is None:
                    continue
                image = node.image
                width, height = image.size
                if max(width, height) > texture_edge:
                    derivative = resized.get(image.as_pointer())
                    if derivative is None:
                        derivative = image.copy()
                        scale = texture_edge/max(width, height)
                        derivative.scale(max(1, round(width*scale)), max(1, round(height*scale)))
                        derivative.pack()
                        resized[image.as_pointer()] = derivative
                        texture_count += 1
                    node.image = derivative
    after = sum(triangles(obj) for obj in meshes)
    return {'source_triangles': before, 'runtime_triangles': after, 'target_triangles': target,
            'source_objects': source_objects, 'runtime_objects': len(meshes), **material_report,
            'texture_max_edge': texture_edge, 'resized_textures': texture_count,
            'budget_met': after <= target, 'source_files_preserved': True, 'skipped': skipped}
