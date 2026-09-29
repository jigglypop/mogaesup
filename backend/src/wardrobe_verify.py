"""Run with Blender --background --python src/wardrobe_verify.py -- MODEL.glb OUTPUT_DIR.

Reimports the delivered GLB, samples each NLA clip and renders rest/posed previews.
This measures finite deformation and motion, not collision-free clothing fit.
"""

import json
import math
from pathlib import Path
import sys


def main():
    import bpy
    from mathutils import Vector

    model, output = map(Path, sys.argv[sys.argv.index("--") + 1:])
    output.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(model.resolve()))
    rig = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    garments = [o for o in bpy.context.scene.objects if o.type == "MESH" and o.name.startswith("outfit_")]
    if not garments:
        raise ValueError("No outfit meshes in exported GLB")
    scene = bpy.context.scene
    animation = rig.animation_data
    if animation is None or not any(t.strips for t in animation.nla_tracks):
        raise ValueError("No animation clips available for deformation verification")
    animation.action = None
    tracks = [t for t in animation.nla_tracks if t.strips]
    for track in tracks:
        track.mute = True

    def points():
        bpy.context.view_layer.update()
        graph = bpy.context.evaluated_depsgraph_get()
        return [obj.evaluated_get(graph).matrix_world @ vertex.co
                for obj in garments for vertex in obj.evaluated_get(graph).data.vertices]

    report = {"model": str(model.resolve()), "clips": [], "finite": True}
    for track in tracks:
        track.mute = False
        start = min(s.frame_start for s in track.strips)
        end = max(s.frame_end for s in track.strips)
        samples = []
        for frame in (start, (start + end) / 2, end):
            scene.frame_set(int(frame), subframe=frame % 1)
            samples.append(points())
        finite = all(math.isfinite(c) for sample in samples for v in sample for c in v)
        displacement = max((a - b).length for sample in samples[1:] for a, b in zip(samples[0], sample))
        report["clips"].append({"name": track.name, "finite": finite,
                                "sampled_max_displacement": displacement})
        report["finite"] &= finite
        track.mute = True

    rig.data.pose_position = "REST"
    bpy.context.view_layer.update()
    visible = [o for o in scene.objects if o.type == "MESH" and not o.hide_render and not o.hide_get()]
    vertices = [o.matrix_world @ Vector(corner) for o in visible for corner in o.bound_box]
    low = Vector(tuple(min(v[i] for v in vertices) for i in range(3)))
    high = Vector(tuple(max(v[i] for v in vertices) for i in range(3)))
    center = (low + high) / 2
    size = max(high - low)
    camera_data = bpy.data.cameras.new("Preview")
    camera = bpy.data.objects.new("Preview", camera_data)
    scene.collection.objects.link(camera)
    camera.location = center + Vector((0, -size * 3, size * 0.05))
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = size * 1.25
    scene.camera = camera
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 16
    scene.cycles.device = "CPU"
    scene.render.resolution_x = 768
    scene.render.resolution_y = 768
    scene.render.resolution_percentage = 100
    if scene.world is None:
        scene.world = bpy.data.worlds.new("PreviewWorld")
    scene.world.color = (0.25, 0.25, 0.25)
    for index, offset in enumerate(((-1, -2, 2), (1, -1, 1), (0, 1, 2))):
        light_data = bpy.data.lights.new(f"PreviewLight{index}", "AREA")
        light_data.energy = 150 * size * size
        light_data.shape = "DISK"
        light_data.size = size * 2
        light = bpy.data.objects.new(light_data.name, light_data)
        scene.collection.objects.link(light)
        light.location = center + Vector(offset) * size
        light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str((output / "rest.png").resolve())
    bpy.ops.render.render(write_still=True)
    rig.data.pose_position = "POSE"
    moving = next((t for t in tracks if t.name == "walk"), tracks[0])
    moving.mute = False
    scene.frame_set(int((moving.strips[0].frame_start + moving.strips[0].frame_end) / 2))
    scene.render.filepath = str((output / ("walk.png" if moving.name == "walk" else "posed.png")).resolve())
    bpy.ops.render.render(write_still=True)
    (output / "deformation.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    if not report["finite"]:
        raise ValueError("Non-finite garment deformation")
    if not any(clip["sampled_max_displacement"] > 1e-6 for clip in report["clips"]):
        raise ValueError("No garment motion detected in sampled animation frames")


if __name__ == "__main__":
    main()
