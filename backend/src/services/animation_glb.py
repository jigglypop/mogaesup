"""Animation buffer copying shared by world delivery and character preparation."""

from copy import deepcopy
from typing import Any
from src.services.glb import parse_glb, build_glb


def merge_character_clips(base: bytes, sources: dict[str, bytes]) -> bytes:
    doc, binary = parse_glb(base, strict=True)
    target = bytearray(binary)
    names = [node.get("name") for node in doc["nodes"]]
    target_joints = {doc["nodes"][index].get("name") for skin in doc.get("skins", []) for index in skin["joints"]}
    if not target_joints or None in target_joints:
        raise ValueError("Canonical rig needs named joints")
    for slot, content in sources.items():
        source, source_binary = parse_glb(content, strict=True)
        joints = {source["nodes"][index].get("name") for skin in source.get("skins", []) for index in skin["joints"]}
        if joints != target_joints or not source.get("animations"):
            raise ValueError(f"Incompatible rig or missing animation: {slot}")
        animation = deepcopy(source["animations"][0])
        animation.update(name=slot, extras={"canonicalName": slot, "provider": "meshy"})
        views, accessors = {}, {}
        for sampler in animation["samplers"]:
            for field in ("input", "output"):
                sampler[field] = _copy_animation_accessor(source_doc=source, target_doc=doc, source_binary=source_binary,
                    target_binary=target, source_accessor_index=sampler[field], buffer_view_map=views, accessor_map=accessors)
        for channel in animation["channels"]:
            source_node = source["nodes"][channel["target"]["node"]]
            name = source_node.get("name")
            if not name or names.count(name) != 1:
                raise ValueError(f"Ambiguous animation joint: {name}")
            channel["target"]["node"] = names.index(name)
        doc.setdefault("animations", [])[:] = [a for a in doc["animations"] if a.get("name") != slot]
        doc["animations"].append(animation)
    doc["buffers"][0]["byteLength"] = len(target)
    return build_glb(doc, bytes(target))

def _copy_animation_accessor(
    *,
    source_doc: dict[str, Any],
    target_doc: dict[str, Any],
    source_binary: bytes,
    target_binary: bytearray,
    source_accessor_index: int,
    buffer_view_map: dict[int, int],
    accessor_map: dict[int, int],
) -> int:
    if source_accessor_index in accessor_map:
        return accessor_map[source_accessor_index]
    source_accessors = source_doc.get("accessors") if isinstance(source_doc.get("accessors"), list) else []
    if source_accessor_index < 0 or source_accessor_index >= len(source_accessors):
        raise ValueError(f"animation accessor out of range: {source_accessor_index}")
    accessor = deepcopy(source_accessors[source_accessor_index])
    if not isinstance(accessor, dict):
        raise ValueError("animation accessor is invalid")

    def copy_buffer_view(source_buffer_view_index: int) -> int:
        if source_buffer_view_index in buffer_view_map:
            return buffer_view_map[source_buffer_view_index]
        source_buffer_views = source_doc.get("bufferViews") if isinstance(source_doc.get("bufferViews"), list) else []
        if source_buffer_view_index < 0 or source_buffer_view_index >= len(source_buffer_views):
            raise ValueError(f"animation bufferView out of range: {source_buffer_view_index}")
        source_view = source_buffer_views[source_buffer_view_index]
        if not isinstance(source_view, dict):
            raise ValueError("animation bufferView is invalid")
        if int(source_view.get("buffer") or 0) != 0:
            raise ValueError("external animation buffers are not supported")
        source_offset = int(source_view.get("byteOffset") or 0)
        source_length = int(source_view.get("byteLength") or 0)
        if source_offset < 0 or source_length < 0 or source_offset + source_length > len(source_binary):
            raise ValueError("animation bufferView range is invalid")
        while len(target_binary) % 4:
            target_binary.append(0)
        target_offset = len(target_binary)
        target_binary.extend(source_binary[source_offset:source_offset + source_length])
        target_view = deepcopy(source_view)
        target_view["buffer"] = 0
        target_view["byteOffset"] = target_offset
        target_views = target_doc.setdefault("bufferViews", [])
        if not isinstance(target_views, list):
            target_views = []
            target_doc["bufferViews"] = target_views
        target_views.append(target_view)
        target_index = len(target_views) - 1
        buffer_view_map[source_buffer_view_index] = target_index
        return target_index

    if "bufferView" in accessor:
        accessor["bufferView"] = copy_buffer_view(int(accessor["bufferView"]))
    sparse = accessor.get("sparse")
    if isinstance(sparse, dict):
        indices = sparse.get("indices")
        values = sparse.get("values")
        if isinstance(indices, dict) and "bufferView" in indices:
            indices["bufferView"] = copy_buffer_view(int(indices["bufferView"]))
        if isinstance(values, dict) and "bufferView" in values:
            values["bufferView"] = copy_buffer_view(int(values["bufferView"]))
    target_accessors = target_doc.setdefault("accessors", [])
    if not isinstance(target_accessors, list):
        target_accessors = []
        target_doc["accessors"] = target_accessors
    target_accessors.append(accessor)
    target_index = len(target_accessors) - 1
    accessor_map[source_accessor_index] = target_index
    return target_index
