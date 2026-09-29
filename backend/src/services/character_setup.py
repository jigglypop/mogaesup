"""Recipe-driven Blender fallback for stylized characters rejected by auto rigging."""

import json
import math
from pathlib import Path

from src.services.asset_delivery import DeliveryPolicy, inspect_glb, read_model
from src.services.asset_editor import _write_json
from src.services.blender_mcp import BlenderMCP
from src.services.wardrobe import _digest


def validate_recipe(recipe: dict, model: Path) -> None:
    if recipe.get("model_sha256") != _digest(model):
        raise ValueError("Recipe belongs to a different model; author landmarks for this GLB")

    def point(value):
        if (not isinstance(value, list) or len(value) != 3
                or any(type(v) not in (int, float) or not math.isfinite(v) for v in value)):
            raise ValueError("Coordinates must be three finite numbers")

    names = set()
    for bone in recipe.get("bones", []):
        name = bone.get("name")
        if not isinstance(name, str) or not name or name in names:
            raise ValueError("Bone names must be nonempty and unique")
        if bone.get("parent") and bone["parent"] not in names:
            raise ValueError("Parents must precede their children")
        point(bone["head"])
        point(bone["tail"])
        if sum((a - b) ** 2 for a, b in zip(bone["head"], bone["tail"])) < 1e-12:
            raise ValueError("Bone length must be positive")
        names.add(name)
    if not names or recipe.get("default_bone") not in names:
        raise ValueError("A default bone and skeleton are required")
    if not recipe.get("garment_regions"):
        raise ValueError("Explicit garment selection regions are required")
    for region in recipe.get("weight_regions", []) + recipe["garment_regions"]:
        point(region["min"])
        point(region["max"])
        if any(a >= b for a, b in zip(region["min"], region["max"])):
            raise ValueError("Selection bounds must have positive volume")
    for region in recipe.get("weight_regions", []):
        if not region.get("bones") or any(name not in names for name in region["bones"]):
            raise ValueError("Weight region references an unknown bone")
    for name, angle in recipe.get("pose_check", {}).items():
        if name not in names or type(angle) not in (int, float) or not math.isfinite(angle):
            raise ValueError("Invalid pose check bone or angle")
    for tube in recipe.get("sweater_tubes", []):
        point(tube["axis"])
        if sum(v * v for v in tube["axis"]) < 1e-12:
            raise ValueError("Tube axis must be nonzero")
        if len(tube["rings"]) < 2:
            raise ValueError("A garment tube requires at least two rings")
        for ring in tube["rings"]:
            point(ring["center"])
            if (len(ring["radius"]) != 2 or any(type(v) not in (int, float)
                    or not math.isfinite(v) or v <= 0 for v in ring["radius"])):
                raise ValueError("Tube radii must be positive finite numbers")


async def setup_character(model: Path, recipe_path: Path, output: Path, blender: BlenderMCP) -> dict:
    model, output = model.resolve(), output.resolve()
    recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
    validate_recipe(recipe, model)
    quality = inspect_glb(read_model(model, DeliveryPolicy()))
    if quality["errors"]:
        raise ValueError("Invalid source GLB: " + "; ".join(quality["errors"]))
    output.mkdir(parents=True, exist_ok=False)
    _write_json(output / "recipe.json", recipe)
    payload = {"model": str(model), "output": str(output), "recipe": recipe}
    worker = Path(__file__).with_name("character_blender.py").read_text(encoding="utf-8")
    code = (worker + "\nimport bpy\nbpy.ops.wm.read_factory_settings(use_empty=True)\n"
            "window = bpy.context.window_manager.windows[0]\n"
            "area = next(a for a in window.screen.areas if a.type == 'VIEW_3D')\n"
            "region = next(r for r in area.regions if r.type == 'WINDOW')\n"
            "with bpy.context.temp_override(window=window, area=area, region=region):\n"
            "    print('ASSET_EDITOR_RESULT=' + json.dumps(run(json.loads(" + repr(json.dumps(payload)) + "))))\n")
    result = await blender.execute(code, "Build character skeleton and separate clothing using authored landmarks")
    policy = DeliveryPolicy(required_joints=[b["name"] for b in recipe["bones"]],
                            required_animations=["pose_check"] if recipe.get("pose_check") else [])
    quality = inspect_glb(read_model(output / "base.glb", policy), policy)
    _write_json(output / "quality.json", quality)
    if quality["errors"]:
        raise ValueError("Rigged GLB rejected: " + "; ".join(quality["errors"]))
    result.update(status="review_required", model=str(output / "base.glb"),
                  source=str(output / "base.blend"), source_object="outfit_base",
                  model_sha256=_digest(output / "base.glb"), quality=quality)
    _write_json(output / "setup.json", result)
    return result
