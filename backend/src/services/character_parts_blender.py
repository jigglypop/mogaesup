"""Fixed worker invoked only by character_parts; not a user-supplied recipe."""

import hashlib
import json
from pathlib import Path
import sys

import bpy
from mathutils import Vector


def run(payload):
    source, output = Path(payload["model"]), Path(payload["output"])
    if hashlib.sha256(source.read_bytes()).hexdigest() != payload["source_sha256"]:
        raise ValueError("Source changed before Blender import")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE']
    if len(armatures) != 1:
        raise ValueError("Material recipe requires one canonical armature")
    custom_shapes = {bone.custom_shape for armature in armatures for bone in armature.pose.bones if bone.custom_shape}
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH' and obj not in custom_shapes]
    count = 0
    for obj in meshes:
        if payload.get("review_only"):
            continue
        used = {face.material_index for face in obj.data.polygons}
        if len(used) < 2:
            continue
        if obj.data.shape_keys:
            raise ValueError("Shape-key separation requires an authored recipe")
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.separate(type='MATERIAL')
        bpy.ops.object.mode_set(mode='OBJECT')
        count += 1
    if not count and not payload.get("review_only"):
        raise ValueError("No material boundaries to separate")
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH' and obj not in custom_shapes]
    for index, obj in enumerate(meshes):
        if not payload.get("review_only"):
            obj.name = f"candidate_{index:03d}"
        # Splitting preserves vertex groups and modifiers; never create a new rig.
        if not any(mod.type == 'ARMATURE' and mod.object == armatures[0] for mod in obj.modifiers) and not (obj.parent == armatures[0] and obj.parent_type == 'BONE'):
            raise ValueError(f"Candidate rig binding missing: {obj.name}, parent={obj.parent}, type={obj.parent_type}, modifiers={[(m.type, getattr(m, 'object', None)) for m in obj.modifiers]}")
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes + armatures:
        obj.select_set(True)
    if not payload.get("review_only"):
        bpy.ops.export_scene.gltf(filepath=str(output / 'character.glb'), export_format='GLB',
                                  use_selection=True, export_animations=True, export_skins=True)
    scene = bpy.context.scene
    points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    lo = Vector(tuple(min(p[i] for p in points) for i in range(3)))
    hi = Vector(tuple(max(p[i] for p in points) for i in range(3)))
    center, size = (lo + hi) / 2, max(hi - lo)
    camera = bpy.data.objects.new('ReviewCamera', bpy.data.cameras.new('ReviewCamera'))
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.location = center + Vector((size * .1, -size * 2.4, size * .1))
    camera.rotation_euler = (center - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = size * 1.3
    for index, offset in enumerate(((2, -3, 4), (-3, -2, 2))):
        light = bpy.data.objects.new(f'ReviewLight{index}', bpy.data.lights.new(f'ReviewLight{index}', 'AREA'))
        scene.collection.objects.link(light)
        light.location = center + Vector(offset) * size
        light.rotation_euler = (center - light.location).to_track_quat('-Z', 'Y').to_euler()
        light.data.energy, light.data.shape, light.data.size = 450 * size * size, 'DISK', size * 3
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 16
    scene.render.resolution_x = scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.film_transparent = True
    armatures[0].data.pose_position = 'REST'
    scene.render.filepath = str(output / 'rest.png')
    bpy.ops.render.render(write_still=True)
    armatures[0].data.pose_position = 'POSE'
    bpy.ops.wm.save_as_mainfile(filepath=str(output / 'source.blend'))
    (output / 'candidates.json').write_text(json.dumps({"source_sha256": payload['source_sha256'],
        "armature": armatures[0].name, "objects": [obj.name for obj in meshes],
        "body_coverage": "unknown", "semantic_roles": "unassigned"}), encoding='utf-8')
    names = ['source.blend', 'rest.png', 'candidates.json', 'selected.glb' if payload.get('review_only') else 'character.glb']
    if payload.get('review_only'):
        names.append('selection.json')
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    seal = {"source_sha256": payload['source_sha256'], "input_sha256": digest(output / 'input.json'),
            "files": {name: digest(output / name) for name in names}}
    temporary = output / 'worker-complete.json.part'
    temporary.write_text(json.dumps(seal), encoding='utf-8')
    temporary.replace(output / 'worker-complete.json')


if __name__ == '__main__':
    run(json.loads(Path(sys.argv[sys.argv.index('--') + 1]).read_text(encoding='utf-8')))
