"""Validated edit commands compiled into a fixed Blender script."""

from __future__ import annotations

import json
from textwrap import indent
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class EditCommand(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class TransformEdit(EditCommand):
    op: Literal["transform"]
    object: str = Field(min_length=1, max_length=200)
    location: list[float] | None = Field(default=None, min_length=3, max_length=3)
    rotation_degrees: list[float] | None = Field(default=None, min_length=3, max_length=3)
    scale: list[Annotated[float, Field(gt=0)]] | None = Field(default=None, min_length=3, max_length=3)


class MaterialEdit(EditCommand):
    op: Literal["material"]
    object: str = Field(min_length=1, max_length=200)
    material_slot: int = Field(default=0, ge=0)
    base_color: list[Annotated[float, Field(ge=0, le=1)]] = Field(min_length=4, max_length=4)
    roughness: float = Field(default=0.5, ge=0, le=1)
    metallic: float = Field(default=0, ge=0, le=1)


class VisibilityEdit(EditCommand):
    op: Literal["visibility"]
    object: str = Field(min_length=1, max_length=200)
    visible: bool


class AttachEdit(EditCommand):
    op: Literal["attach"]
    object: str = Field(min_length=1, max_length=200)
    armature: str = Field(min_length=1, max_length=200)
    bone: str = Field(min_length=1, max_length=200)


class EditRecipe(EditCommand):
    user_prompt: str = Field(min_length=1, max_length=4000)
    operations: list[Annotated[TransformEdit | MaterialEdit | VisibilityEdit | AttachEdit,
                               Field(discriminator="op")]] = Field(min_length=1, max_length=100)


def edit_script(*, source: str, blend_output: str, glb_output: str, operations: list[dict], importing: bool) -> str:
    # JSON is data, even when names contain quotes, newlines, or Python syntax.
    payload = json.dumps({"source": source, "blend_output": blend_output, "glb_output": glb_output,
                          "operations": operations, "importing": importing}, ensure_ascii=True)
    setup = '''
if p["importing"]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
else:
    bpy.ops.wm.open_mainfile(filepath=p["source"], use_scripts=False, load_ui=False)
window = bpy.context.window_manager.windows[0]
area = next(a for a in window.screen.areas if a.type == "VIEW_3D")
region = next(r for r in area.regions if r.type == "WINDOW")
with bpy.context.temp_override(window=window, area=area, region=region):
'''
    return "import bpy, json, math\np = json.loads(" + repr(payload) + ")\n" + setup + indent(_EDIT_SCRIPT, "    ")


_EDIT_SCRIPT = '''
if p["importing"]:
    bpy.ops.import_scene.gltf(filepath=p["source"])

# Validate all targets before making any edit. A failed attempt never saves a revision.
for command in p["operations"]:
    obj = bpy.data.objects.get(command["object"])
    if obj is None:
        raise ValueError("Edit target not found")
    if command["op"] == "material":
        if obj.type != "MESH" or command["material_slot"] >= len(obj.material_slots):
            raise ValueError("Material slot not found")
    if command["op"] == "attach":
        rig = bpy.data.objects.get(command["armature"])
        if obj == rig or rig is None or rig.type != "ARMATURE" or command["bone"] not in rig.data.bones:
            raise ValueError("Attachment bone not found")
        parent = rig.parent
        while parent is not None:
            if parent == obj:
                raise ValueError("Attachment would create a cycle")
            parent = parent.parent

for command in p["operations"]:
    obj = bpy.data.objects[command["object"]]
    if command["op"] == "transform":
        if command.get("location") is not None:
            obj.location = command["location"]
        if command.get("rotation_degrees") is not None:
            obj.rotation_mode = "XYZ"
            obj.rotation_euler = [math.radians(v) for v in command["rotation_degrees"]]
        if command.get("scale") is not None:
            obj.scale = command["scale"]
    elif command["op"] == "material":
        slot = obj.material_slots[command["material_slot"]]
        material = slot.material.copy() if slot.material else bpy.data.materials.new("AssetMaterial")
        slot.link = "OBJECT"
        slot.material = material
        material.use_nodes = True
        shader = next((n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if shader is None:
            raise ValueError("Material has no Principled BSDF")
        for name, value in (("Base Color", command["base_color"]), ("Roughness", command["roughness"]), ("Metallic", command["metallic"])):
            for link in list(shader.inputs[name].links):
                material.node_tree.links.remove(link)
            shader.inputs[name].default_value = value
        material.diffuse_color = command["base_color"]
    elif command["op"] == "visibility":
        obj.hide_viewport = not command["visible"]
        obj.hide_render = not command["visible"]
    elif command["op"] == "attach":
        world_matrix = obj.matrix_world.copy()
        obj.parent = bpy.data.objects[command["armature"]]
        obj.parent_type = "BONE"
        obj.parent_bone = command["bone"]
        bpy.context.view_layer.update()
        obj.matrix_world = world_matrix

bpy.context.view_layer.update()
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=p["blend_output"])
bpy.ops.export_scene.gltf(filepath=p["glb_output"], export_format="GLB",
    export_animations=True, export_yup=True, export_cameras=False, export_lights=False,
    use_visible=True)
snapshot = {"blender_version": bpy.app.version_string, "objects": [
    {"name": obj.name, "type": obj.type, "location": list(obj.location),
     "rotation_degrees": [math.degrees(v) for v in obj.rotation_euler], "scale": list(obj.scale),
     "visible": not obj.hide_viewport, "parent": obj.parent.name if obj.parent else None,
     "parent_bone": obj.parent_bone,
     "materials": [slot.material.name if slot.material else None for slot in obj.material_slots],
     "bones": [bone.name for bone in obj.data.bones] if obj.type == "ARMATURE" else []}
    for obj in bpy.context.scene.objects]}
print("ASSET_EDITOR_RESULT=" + json.dumps(snapshot))
'''
