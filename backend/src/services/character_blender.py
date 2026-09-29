"""Executed only inside the dedicated Blender MCP instance. Coordinates are Blender world space."""

import json


def run(payload):
    import bpy
    import math
    from pathlib import Path
    from mathutils import Vector

    recipe = payload["recipe"]
    output = Path(payload["output"])
    bpy.ops.import_scene.gltf(filepath=payload["model"])
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if any(o.find_armature() for o in meshes):
        raise ValueError("Source already has a rig; preserve it with the wardrobe pipeline")
    if not meshes:
        raise ValueError("Source has no meshes")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    body = bpy.context.object
    body.name = "character_body"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    def inside(point, region):
        return all(region["min"][i] <= point[i] <= region["max"][i] for i in range(3))

    # Author-specified regions are deliberately explicit; this is not semantic AI segmentation.
    for polygon in body.data.polygons:
        polygon.select = any(inside(polygon.center, region) for region in recipe["garment_regions"])
    selected = sum(p.select for p in body.data.polygons)
    if not 0 < selected < len(body.data.polygons):
        raise ValueError("Clothing selection must include some, but not all, faces")
    bpy.context.tool_settings.mesh_select_mode = (False, False, True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.separate(type="SELECTED")
    bpy.ops.object.mode_set(mode="OBJECT")
    garment = next(o for o in bpy.context.selected_objects if o != body)
    garment.name = "outfit_base"
    meshes = [body, garment]

    armature = bpy.data.armatures.new("CharacterRig")
    rig = bpy.data.objects.new("CharacterRig", armature)
    bpy.context.scene.collection.objects.link(rig)
    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for item in recipe["bones"]:
        bone = armature.edit_bones.new(item["name"])
        bone.head, bone.tail = item["head"], item["tail"]
        if item.get("parent"):
            bone.parent = armature.edit_bones[item["parent"]]
    bpy.ops.object.mode_set(mode="OBJECT")
    segments = {b["name"]: (Vector(b["head"]), Vector(b["tail"])) for b in recipe["bones"]}

    def distance(point, name):
        head, tail = segments[name]
        axis = tail - head
        t = max(0, min(1, (point - head).dot(axis) / axis.length_squared))
        return (point - head - axis * t).length

    for obj in meshes:
        groups = {name: obj.vertex_groups.new(name=name) for name in segments}
        for vertex in obj.data.vertices:
            candidates = [recipe["default_bone"]]
            for region in recipe.get("weight_regions", []):
                if inside(vertex.co, region):
                    candidates = region["bones"]
                    break
            nearest = sorted(((distance(vertex.co, name), name) for name in candidates))[:4]
            weights = [(1 / max(d, 0.025) ** 4, name) for d, name in nearest]
            total = sum(weight for weight, _ in weights)
            for weight, name in weights:
                groups[name].add([vertex.index], weight / total, "REPLACE")
        modifier = obj.modifiers.new("Character rig", "ARMATURE")
        modifier.object = rig
        obj.parent = rig

    if recipe.get("pose_check"):
        for frame, factor in ((1, 0), (16, 1), (31, 0)):
            for name, angle in recipe["pose_check"].items():
                bone = rig.pose.bones[name]
                bone.rotation_mode = "XYZ"
                bone.rotation_euler = (0, 0, math.radians(angle) * factor)
                bone.keyframe_insert("rotation_euler", frame=frame, group=name)
        rig.animation_data.action.name = "pose_check"
    bpy.context.scene.frame_set(1)
    bpy.context.scene.frame_end = 31
    bpy.ops.wm.save_as_mainfile(filepath=str(output / "base.blend"))
    bpy.ops.export_scene.gltf(filepath=str(output / "base.glb"), export_format="GLB", export_animations=True)

    garment_path = create_sweatshirt(recipe, output)
    return {"bones": list(segments), "selected_faces": selected,
            "unweighted_vertices": 0, "garment": garment_path,
            "limitations": ["Authored region segmentation requires visual review",
                            "No body reconstruction under original clothing",
                            "Pose check is a diagnostic clip, not a walk cycle"]}


def create_sweatshirt(recipe, output):
    """Build a standalone basic garment for testing the replacement path."""
    import bpy
    import bmesh
    import math
    from mathutils import Vector

    # A separate, coarse sweatshirt asset for exercising replacement; custom GLBs can replace it.
    pieces = []
    material = bpy.data.materials.new("Sweatshirt blue fabric")
    material.diffuse_color = (0.12, 0.38, 0.62, 1)
    material.use_nodes = True
    material.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = material.diffuse_color
    material.node_tree.nodes.get("Principled BSDF").inputs["Roughness"].default_value = 0.85
    for index, tube in enumerate(recipe.get("sweater_tubes", [])):
        axis = Vector(tube["axis"]).normalized()
        tangent = Vector((0, 1, 0)) if abs(axis.y) < 0.9 else Vector((1, 0, 0))
        u = tangent.cross(axis).normalized()
        v = axis.cross(u).normalized()
        vertices, faces = [], []
        steps = 32
        for ring in tube["rings"]:
            center = Vector(ring["center"])
            for j in range(steps):
                angle = 2 * math.pi * j / steps
                vertices.append(center + u * math.cos(angle) * ring["radius"][0]
                                + v * math.sin(angle) * ring["radius"][1])
        for row in range(len(tube["rings"]) - 1):
            for j in range(steps):
                a, b = row * steps + j, row * steps + (j + 1) % steps
                faces.append((a, b, b + steps, a + steps))
        faces.append(tuple(reversed(range(steps))))
        faces.append(tuple(range(len(vertices) - steps, len(vertices))))
        mesh = bpy.data.meshes.new(f"Sweatshirt_{index}")
        mesh.from_pydata(vertices, [], faces)
        mesh.materials.append(material)
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(mesh.name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        for polygon in mesh.polygons:
            polygon.use_smooth = True
        pieces.append(obj)
    if pieces:
        bpy.ops.object.select_all(action="DESELECT")
        for obj in pieces:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = pieces[0]
        if len(pieces) > 1:
            bpy.ops.object.join()
        sweater = bpy.context.object
        sweater.name = "Sweatshirt"
        remesh = sweater.modifiers.new("Join sleeve seams", "REMESH")
        remesh.mode = "VOXEL"
        remesh.voxel_size = 0.008
        remesh.use_smooth_shade = True
        bpy.ops.object.modifier_apply(modifier=remesh.name)
        smooth = sweater.modifiers.new("Soften fabric", "SMOOTH")
        smooth.factor = 1
        smooth.iterations = 4
        bpy.ops.object.modifier_apply(modifier=smooth.name)
        bpy.ops.export_scene.gltf(filepath=str(output / "sweatshirt.glb"), export_format="GLB",
                                  use_selection=True, export_animations=False, export_apply=True)
    return str(output / "sweatshirt.glb") if pieces else None
