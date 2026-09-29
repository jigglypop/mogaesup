"""Offline production checks and versioned delivery of reviewed 3D assets.

This is a bounded preflight, not a complete glTF validator or a renderer.
No supplier calls, embedded scripts, external resources, or Blender code run here.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import warnings
import zipfile
from pathlib import Path
from typing import Any, Literal

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, model_validator

from src.services.glb import parse_glb


class DeliveryPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    max_file_bytes: int = Field(default=25 * 1024 * 1024, gt=0)
    max_vertices: int = Field(default=100_000, gt=0)
    max_triangles: int = Field(default=100_000, gt=0)
    max_materials: int = Field(default=16, gt=0)
    max_texture_dimension: int = Field(default=4096, gt=0)
    max_texture_pixels: int = Field(default=32 * 1024 * 1024, gt=0)
    required_animations: list[str] = Field(default_factory=list)
    required_joints: list[str] = Field(default_factory=list)


class DeliveryReview(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)

    model_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    reviewer: str = Field(min_length=1, max_length=200)
    rights_evidence: str = Field(min_length=1, max_length=2000)
    visual_evidence: str = Field(min_length=1, max_length=2000)
    runtime_evidence: str = Field(min_length=1, max_length=2000)


class DeliveryRecipe(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)

    contract_version: Literal["1.0"] = "1.0"
    asset_id: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$")
    revision: int = Field(gt=0)
    part_type: Literal["body", "rigid", "skinned", "surface"]
    slot: str = Field(min_length=1, max_length=100)
    body_asset_id: str = Field(min_length=1, max_length=100)
    body_revision: int = Field(gt=0)
    rig_ref: str = Field(min_length=1, max_length=200)
    fit_ref: str = Field(min_length=1, max_length=200)
    occlusion_ref: str = Field(min_length=1, max_length=200)
    socket: str | None = Field(default=None, min_length=1, max_length=100)
    policy: DeliveryPolicy = Field(default_factory=DeliveryPolicy)
    review: DeliveryReview | None = None

    @model_validator(mode="after")
    def require_socket(self) -> DeliveryRecipe:
        if self.part_type == "rigid" and not self.socket:
            raise ValueError("rigid parts require an attachment socket")
        return self


def _integer(value: Any, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        raise ValueError("invalid nonnegative integer")
    return value


def _ref(items: list[dict], index: Any) -> dict:
    return items[_integer(index)]


def _tables(doc: dict) -> dict[str, list[dict]]:
    result = {}
    for key in ("buffers", "bufferViews", "accessors", "meshes", "nodes", "skins",
                "animations", "materials", "images", "textures", "samplers", "scenes"):
        value = doc.get(key, [])
        if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
            raise ValueError(f"invalid {key} table")
        result[key] = value
    return result


def _check_buffers(tables: dict, binary: bytes) -> None:
    buffers, views = tables["buffers"], tables["bufferViews"]
    if len(buffers) > 1 or any("uri" in buffer for buffer in buffers):
        raise ValueError("delivery requires a single embedded buffer")
    length = _integer(buffers[0]["byteLength"], 1) if buffers else 0
    if not 0 <= len(binary) - length <= 3:
        raise ValueError("embedded buffer length mismatch")
    for view in views:
        buffer = _ref(buffers, view["buffer"])
        if _integer(view.get("byteOffset", 0)) + _integer(view["byteLength"], 1) > buffer["byteLength"]:
            raise ValueError("buffer view exceeds its buffer")
    components = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
    shapes = {"SCALAR": (1, 1), "VEC2": (1, 2), "VEC3": (1, 3), "VEC4": (1, 4),
              "MAT2": (2, 2), "MAT3": (3, 3), "MAT4": (4, 4)}
    for accessor in tables["accessors"]:
        count = _integer(accessor["count"], 1)
        size = components[_integer(accessor["componentType"]) ]
        columns, rows = shapes[accessor["type"]]
        column_bytes = rows * size
        element_bytes = columns * (((column_bytes + 3) // 4) * 4 if columns > 1 else column_bytes)
        if "bufferView" in accessor:
            view = _ref(views, accessor["bufferView"])
            stride = _integer(view.get("byteStride", element_bytes), element_bytes)
            if "byteStride" in view and (stride > 252 or stride % 4):
                raise ValueError("invalid accessor stride")
            offset = _integer(accessor.get("byteOffset", 0))
            if offset % size or (offset + view.get("byteOffset", 0)) % size:
                raise ValueError("unaligned accessor")
            if offset + (count - 1) * stride + element_bytes > view["byteLength"]:
                raise ValueError("accessor exceeds its buffer view")
        if "sparse" in accessor:
            sparse = accessor["sparse"]
            sparse_count = _integer(sparse["count"], 1)
            if sparse_count > count:
                raise ValueError("sparse count exceeds accessor count")
            index_size = {5121: 1, 5123: 2, 5125: 4}[sparse["indices"]["componentType"]]
            for key, width in (("indices", index_size), ("values", element_bytes)):
                entry = sparse[key]
                view = _ref(views, entry["bufferView"])
                if _integer(entry.get("byteOffset", 0)) + sparse_count * width > view["byteLength"]:
                    raise ValueError("sparse data exceeds buffer view")
        for key in ("min", "max"):
            if key in accessor:
                values = accessor[key]
                if len(values) != rows * columns or not all(type(v) in (float, int) and math.isfinite(v) for v in values):
                    raise ValueError("invalid accessor bounds")


def _check_scene(tables: dict, doc: dict) -> dict:
    nodes, meshes, accessors = tables["nodes"], tables["meshes"], tables["accessors"]
    vertices = triangles = 0
    counted_positions = set()
    for mesh in meshes:
        primitives = mesh["primitives"]
        if not primitives:
            raise ValueError("mesh contains no primitives")
        for primitive in primitives:
            attributes = primitive["attributes"]
            position = _ref(accessors, attributes["POSITION"])
            if position["type"] != "VEC3":
                raise ValueError("POSITION must be VEC3")
            # Separated parts may share the exact source attribute buffers.
            if attributes["POSITION"] not in counted_positions:
                vertices += position["count"]
                counted_positions.add(attributes["POSITION"])
            for index in attributes.values():
                if _ref(accessors, index)["count"] != position["count"]:
                    raise ValueError("vertex attribute count mismatch")
            count = position["count"]
            if "indices" in primitive:
                indices = _ref(accessors, primitive["indices"])
                if indices["type"] != "SCALAR" or indices["componentType"] not in (5121, 5123, 5125):
                    raise ValueError("invalid index accessor")
                count = indices["count"]
            mode = _integer(primitive.get("mode", 4))
            if mode > 6:
                raise ValueError("invalid primitive mode")
            if mode == 4:
                if count % 3:
                    raise ValueError("triangle count is not divisible by three")
                triangles += count // 3
            elif mode in (5, 6):
                triangles += max(0, count - 2)
            if "material" in primitive:
                _ref(tables["materials"], primitive["material"])
    if not meshes or not any("mesh" in node for node in nodes):
        raise ValueError("no instantiated mesh")
    parents: dict[int, int] = {}
    for i, node in enumerate(nodes):
        if "mesh" in node:
            _ref(meshes, node["mesh"])
        if "skin" in node:
            _ref(tables["skins"], node["skin"])
            mesh = _ref(meshes, node["mesh"])
            if any(not {"JOINTS_0", "WEIGHTS_0"} <= p["attributes"].keys() for p in mesh["primitives"]):
                raise ValueError("skinned mesh is missing joint weights")
        for child in node.get("children", []):
            _ref(nodes, child)
            if child in parents:
                raise ValueError("node has multiple parents")
            parents[child] = i
    visited: set[int] = set()
    for index in range(len(nodes)):
        path: set[int] = set()
        while index not in visited:
            if index in path:
                raise ValueError("cycle in node hierarchy")
            path.add(index)
            if index not in parents:
                break
            index = parents[index]
        visited.update(path)
    for scene in tables["scenes"]:
        for index in scene.get("nodes", []):
            _ref(nodes, index)
            if index in parents:
                raise ValueError("scene root has a parent")
    if "scene" in doc:
        _ref(tables["scenes"], doc["scene"])
    joint_names = set()
    for skin in tables["skins"]:
        joints = skin["joints"]
        if not joints or len(set(joints)) != len(joints):
            raise ValueError("empty or duplicate skin joints")
        for index in joints:
            joint_names.add(_ref(nodes, index).get("name", ""))
        if "skeleton" in skin:
            _ref(nodes, skin["skeleton"])
        if "inverseBindMatrices" in skin:
            accessor = _ref(accessors, skin["inverseBindMatrices"])
            if accessor["type"] != "MAT4" or accessor["componentType"] != 5126 or accessor["count"] < len(joints):
                raise ValueError("invalid inverse bind matrices")
    animation_names = []
    for animation in tables["animations"]:
        animation_names.append(animation.get("name", ""))
        if not animation["channels"] or not animation["samplers"]:
            raise ValueError("empty animation")
        for sampler in animation["samplers"]:
            accessor = _ref(accessors, sampler["input"])
            _ref(accessors, sampler["output"])
            if accessor["type"] != "SCALAR" or accessor["componentType"] != 5126:
                raise ValueError("invalid animation time accessor")
            if sampler.get("interpolation", "LINEAR") not in ("LINEAR", "STEP", "CUBICSPLINE"):
                raise ValueError("invalid animation interpolation")
        for channel in animation["channels"]:
            _ref(animation["samplers"], channel["sampler"])
            target = channel["target"]
            _ref(nodes, target["node"])
            if target["path"] not in ("translation", "rotation", "scale", "weights"):
                raise ValueError("invalid animation target")
    return {"vertices": vertices, "triangles": triangles, "materials": len(tables["materials"]),
            "meshes": len(meshes), "skins": len(tables["skins"]),
            "animations": animation_names, "joints": sorted(joint_names)}


def _check_images(tables: dict, binary: bytes, policy: DeliveryPolicy, budget_warnings: list | None = None) -> int:
    pixels = 0
    for image in tables["images"]:
        if "uri" in image:
            uri = image["uri"]
            if "bufferView" in image or not uri.startswith(("data:image/png;base64,", "data:image/jpeg;base64,")):
                raise ValueError("only embedded PNG/JPEG images are supported by preflight")
            content = base64.b64decode(uri.split(",", 1)[1], validate=True)
        else:
            view = _ref(tables["bufferViews"], image["bufferView"])
            offset = view.get("byteOffset", 0)
            content = binary[offset:offset + view["byteLength"]]
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as decoded:
                if decoded.format not in ("PNG", "JPEG"):
                    raise ValueError("unsupported embedded image format")
                width, height = decoded.size
                pixels += width * height
                if max(width, height) > policy.max_texture_dimension or pixels > policy.max_texture_pixels:
                    if budget_warnings is None:
                        raise ValueError("texture budget exceeded")
                    if "texture budget exceeded" not in budget_warnings:
                        budget_warnings.append("texture budget exceeded")
                decoded.load()
    for texture in tables["textures"]:
        _ref(tables["images"], texture["source"])
        if "sampler" in texture:
            _ref(tables["samplers"], texture["sampler"])
    return pixels


def inspect_glb(data: bytes, policy: DeliveryPolicy | None = None, *, budget_warnings: bool = False) -> dict[str, Any]:
    policy = policy or DeliveryPolicy()
    report: dict[str, Any] = {
        "inspector_version": "1.0", "sha256": hashlib.sha256(data).hexdigest(),
        "file_bytes": len(data), "status": "review_required", "errors": [],
        "metrics": {}, "required_extensions": [], "policy": policy.model_dump(),
        "manual_checks": ["rights", "body_fit_and_pose_intersections", "materials_and_animation_playback",
                          "browser_gpu_budget_and_long_session_cleanup"],
    }
    if budget_warnings:
        report['warnings'] = []
    try:
        if len(data) > policy.max_file_bytes:
            if not budget_warnings:
                raise ValueError("file size budget exceeded")
            report['warnings'].append('file size budget exceeded')
        doc, binary = parse_glb(data, strict=True)
        if doc.get("asset", {}).get("version") != "2.0":
            raise ValueError("glTF asset version must be 2.0")
        tables = _tables(doc)
        _check_buffers(tables, binary)
        metrics = _check_scene(tables, doc)
        report["metrics"] = metrics
        metrics["texture_pixels"] = _check_images(tables, binary, policy, report.get('warnings'))
        for key in ("vertices", "triangles", "materials"):
            if metrics[key] > getattr(policy, f"max_{key}"):
                report['warnings' if budget_warnings else 'errors'].append(f"{key} budget exceeded")
        for key, expected in (("animations", policy.required_animations), ("joints", policy.required_joints)):
            if not set(expected) <= set(metrics[key]):
                report["errors"].append(f"required {key} missing")
        extensions = doc.get("extensionsRequired", [])
        if not isinstance(extensions, list) or not all(isinstance(x, str) for x in extensions):
            raise ValueError("invalid required extensions")
        report["required_extensions"] = extensions
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, OverflowError,
            RecursionError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        # Never echo document content, resource URIs, or parser snippets into reports.
        message = str(exc) if type(exc) is ValueError else "invalid or unsupported GLB document"
        report["errors"].append(message)
    if report["errors"]:
        report["status"] = "rejected"
    return report


def read_model(path: Path, policy: DeliveryPolicy) -> bytes:
    with path.open("rb") as stream:
        data = stream.read(policy.max_file_bytes + 1)
    if len(data) > policy.max_file_bytes:
        raise ValueError("file size budget exceeded")
    return data


def build_delivery(model: Path, source: Path, recipe: DeliveryRecipe, output: Path) -> dict:
    """Create a new ZIP only after preflight and hash-bound operator reviews."""
    data = read_model(model, recipe.policy)
    report = inspect_glb(data, recipe.policy)
    if report["errors"]:
        raise ValueError("GLB preflight rejected: " + "; ".join(report["errors"]))
    if recipe.part_type in ("body", "skinned") and not report["metrics"]["skins"]:
        raise ValueError("body and skinned parts require a skin")
    if recipe.review is None or recipe.review.model_sha256 != report["sha256"]:
        raise ValueError("review is missing or does not match model hash")
    if source.suffix.lower() != ".blend":
        raise ValueError("delivery requires a .blend source")
    # Copy and hash the same open source stream, without executing its contents.
    with source.open("rb") as stream:
        source_hash = hashlib.file_digest(stream, "sha256").hexdigest()
        if source_hash != recipe.review.source_sha256:
            raise ValueError("review does not match source hash")
        stream.seek(0)
        manifest = {
            **recipe.model_dump(exclude={"review"}), "status": "reviewed",
            "review": recipe.review.model_dump(), "quality": report,
            "files": {"model.glb": {"sha256": report["sha256"], "bytes": len(data)},
                      "source.blend": {"sha256": source_hash}},
        }
        # Exclusive creation protects prior asset revisions from accidental replacement.
        with output.open("xb") as destination:
            try:
                with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                    archive.writestr("model.glb", data)
                    copied_hash = hashlib.sha256()
                    copied_bytes = 0
                    with archive.open("source.blend", "w", force_zip64=True) as target:
                        while chunk := stream.read(1024 * 1024):
                            target.write(chunk)
                            copied_hash.update(chunk)
                            copied_bytes += len(chunk)
                    if copied_hash.hexdigest() != source_hash:
                        raise ValueError("source changed while packaging")
                    manifest["files"]["source.blend"]["bytes"] = copied_bytes
                    archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
            except BaseException:
                destination.close()
                output.unlink()
                raise
    return manifest
