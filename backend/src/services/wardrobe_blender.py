"""Fixed Blender worker loaded through the existing MCP transport."""


def run(p):
    import bpy
    from mathutils import Vector

    def select(objects):
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.hide_set(False)
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]

    def bounds(objects):
        points = [obj.matrix_world @ v.co for obj in objects for v in obj.data.vertices]
        return (Vector(tuple(min(v[i] for v in points) for i in range(3))),
                Vector(tuple(max(v[i] for v in points) for i in range(3))))

    if p["stage"] == "prepare":
        bpy.ops.import_scene.gltf(filepath=p["base"])
    source = bpy.data.objects.get(p["source_object"])
    if source is None or source.type != "MESH":
        raise ValueError("Clothing source must be an existing mesh")
    rig = source.find_armature()
    if rig is None:
        raise ValueError("Clothing source has no armature")
    rig.data.pose_position = "REST"
    bpy.context.view_layer.update()
    if p["stage"] == "prepare":
        bpy.ops.wm.save_as_mainfile(filepath=p["base_blend"])
        # Export an unskinned copy in world coordinates at the rest pose.
        garment = source.copy()
        garment.data = source.data.copy()
        bpy.context.collection.objects.link(garment)
        world = source.matrix_world.copy()
        garment.parent = None
        garment.matrix_world = world
        garment.modifiers.clear()
        garment.vertex_groups.clear()
        select([garment])
        bpy.ops.export_scene.gltf(filepath=p["template"], export_format="GLB",
                                  use_selection=True, export_animations=False, export_skins=False)
        return {"source_object": source.name, "rig": rig.name,
                "bones": [b.name for b in rig.data.bones],
                "vertices": len(source.data.vertices),
                "meshes": [o.name for o in bpy.context.scene.objects if o.type == "MESH" and o != garment]}

    previous = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=p["garment"])
    imported = set(bpy.data.objects) - previous
    garments = [o for o in imported if o.type == "MESH" and len(o.data.vertices)]
    if not garments:
        raise ValueError("Garment GLB contains no mesh vertices")
    for obj in garments:
        world = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = world
        obj.modifiers.clear()
        obj.vertex_groups.clear()
    for obj in imported - set(garments):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.context.view_layer.update()
    if p["fit"] == "bounds":
        lo, hi = bounds(garments)
        target_lo, target_hi = bounds([source])
        size, target_size = hi - lo, target_hi - target_lo
        if min(size) <= 1e-8 or min(target_size) <= 1e-8:
            raise ValueError("Cannot fit a degenerate garment bounding box")
        # Explicit coarse fitting: orientation must already match the baseline.
        for obj in garments:
            matrix = obj.matrix_world.copy()
            for vertex in obj.data.vertices:
                point = matrix @ vertex.co
                vertex.co = Vector(tuple(target_lo[i] + (point[i] - lo[i]) * target_size[i] / size[i]
                                         for i in range(3)))
            obj.matrix_world.identity()
    deform_names = {b.name for b in rig.data.bones if b.use_deform}
    for index, obj in enumerate(garments):
        obj.name = f"outfit_{index:02d}"
        for group in source.vertex_groups:
            obj.vertex_groups.new(name=group.name)
        select([obj])
        transfer = obj.modifiers.new("Baseline garment weights", "DATA_TRANSFER")
        transfer.object = source
        transfer.use_vert_data = True
        transfer.data_types_verts = {"VGROUP_WEIGHTS"}
        transfer.vert_mapping = "POLYINTERP_NEAREST"
        transfer.layers_vgroup_select_src = "ALL"
        transfer.layers_vgroup_select_dst = "NAME"
        bpy.ops.object.modifier_apply(modifier=transfer.name)
        valid = {g.index for g in obj.vertex_groups if g.name in deform_names}
        missing = 0
        for vertex in obj.data.vertices:
            weights = [(g.group, g.weight) for g in vertex.groups if g.group in valid and g.weight > 0]
            weights = sorted(weights, key=lambda pair: pair[1], reverse=True)[:4]
            total = sum(w for _, w in weights)
            if total <= 1e-8:
                missing += 1
                continue
            for group in list(vertex.groups):
                obj.vertex_groups[group.group].remove([vertex.index])
            for group, weight in weights:
                obj.vertex_groups[group].add([vertex.index], weight / total, "REPLACE")
        if missing:
            raise ValueError(f"{obj.name}: {missing} vertices have no deform weights")
        modifier = obj.modifiers.new("Baseline rig", "ARMATURE")
        modifier.object = rig
        world = obj.matrix_world.copy()
        obj.parent = rig
        obj.matrix_world = world
    # Keep the original garment in the blend for later fitting, exclude it from GLB.
    source.hide_render = True
    source.hide_viewport = True
    rig.data.pose_position = "POSE"
    bpy.context.view_layer.update()
    bpy.ops.wm.save_as_mainfile(filepath=p["output_blend"])
    bpy.ops.export_scene.gltf(filepath=p["output_glb"], export_format="GLB", use_visible=True,
                              export_animations=True, export_cameras=False, export_lights=False)
    return {"rig": rig.name, "garments": [o.name for o in garments],
            "vertices": sum(len(o.data.vertices) for o in garments), "unweighted_vertices": 0,
            "fit": p["fit"], "visual_review_required": True}
