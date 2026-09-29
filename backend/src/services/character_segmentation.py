"""Source-bound triangle selections. Preserve all original vertex/skin/UV data."""

from copy import deepcopy
import hashlib
import struct

from src.services.glb import build_glb, parse_glb

PART_ROLES = ("body", "head", "hair", "hat", "top", "pants", "skirt", "dress", "shoes", "outfit_base", "accessory", "eyes", "other")
CLOTHING_ROLES = {"outfit_base", "top", "pants", "skirt", "dress"}


def triangle_indices(doc, binary, primitive):
    if primitive.get("mode", 4) != 4 or primitive.get("extensions", {}).get("KHR_draco_mesh_compression"):
        raise ValueError("Decode compressed/non-triangle geometry before face authoring")
    if "indices" not in primitive:
        values = list(range(doc["accessors"][primitive["attributes"]["POSITION"]]["count"]))
    else:
        accessor = doc["accessors"][primitive["indices"]]
        if accessor.get("sparse") or accessor.get("type") != "SCALAR":
            raise ValueError("Unsupported index accessor")
        view = doc["bufferViews"][accessor["bufferView"]]
        code = {5121: "B", 5123: "H", 5125: "I"}[accessor["componentType"]]
        size = struct.calcsize("<" + code)
        offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        stride = view.get("byteStride", size)
        values = [struct.unpack_from("<" + code, binary, offset + i * stride)[0] for i in range(accessor["count"])]
    if len(values) % 3:
        raise ValueError("Triangle index count is invalid")
    return [values[i:i + 3] for i in range(0, len(values), 3)]


def split_faces(content: bytes, expected_hash: str, selections: list[dict]) -> tuple[bytes, list[dict]]:
    if hashlib.sha256(content).hexdigest() != expected_hash:
        raise ValueError("Selection belongs to another model version")
    doc, binary = parse_glb(content, strict=True)
    if not doc.get("skins"):
        raise ValueError("Separate only after the canonical rig exists")
    # Reuse original accessors instead of round-tripping weights through Blender.
    target = bytearray(binary)
    groups = {}
    for selection in selections:
        node_index, primitive_index = selection["node_index"], selection["primitive_index"]
        role = selection["role"]
        if role not in PART_ROLES:
            raise ValueError("Unknown part role")
        if node_index < 0 or node_index >= len(doc["nodes"]):
            raise ValueError("Unknown source node")
        node = doc["nodes"][node_index]
        if "mesh" not in node or "skin" not in node:
            raise ValueError("Select a skinned source mesh")
        primitives = doc["meshes"][node["mesh"]]["primitives"]
        if primitive_index < 0 or primitive_index >= len(primitives):
            raise ValueError("Unknown source primitive")
        triangles = triangle_indices(doc, binary, primitives[primitive_index])
        assignments = groups.setdefault((node_index, primitive_index), {})
        for face in selection["faces"]:
            if face < 0 or face >= len(triangles) or face in assignments:
                raise ValueError("Out-of-range or overlapping face selection")
            assignments[face] = role
    if not groups or not any(groups.values()):
        raise ValueError("Paint at least one source face")
    parts = []
    for node_index in sorted({key[0] for key in groups}):
        node = doc["nodes"][node_index]
        mesh = deepcopy(doc["meshes"][node["mesh"]])
        role_primitives = {}
        for primitive_index, primitive in enumerate(mesh["primitives"]):
            assignments = groups.get((node_index, primitive_index), {})
            triangles = triangle_indices(doc, binary, primitive)
            faces_by_role = {}
            for face, indices in enumerate(triangles):
                faces_by_role.setdefault(assignments.get(face, "other"), []).extend(indices)
            for role, indices in faces_by_role.items():
                while len(target) % 4:
                    target.append(0)
                offset = len(target)
                target.extend(struct.pack("<" + "I" * len(indices), *indices))
                doc.setdefault("bufferViews", []).append({"buffer": 0, "byteOffset": offset, "byteLength": len(indices) * 4, "target": 34963})
                doc.setdefault("accessors", []).append({"bufferView": len(doc["bufferViews"]) - 1, "componentType": 5125, "count": len(indices), "type": "SCALAR"})
                part = deepcopy(primitive)
                part["indices"] = len(doc["accessors"]) - 1
                role_primitives.setdefault(role, []).append(part)
        # Keep the original transform node as parent so animation channels still target it.
        node.pop("mesh")
        skin = node.pop("skin")
        for role, primitives in role_primitives.items():
            name = f"{role}_{node_index}"
            new_mesh = {**mesh, "name": name, "primitives": primitives}
            doc["meshes"].append(new_mesh)
            new_index = len(doc["nodes"])
            child = {"name": name, "mesh": len(doc["meshes"]) - 1, "skin": skin,
                     "extras": {"semantic_role": role, "source_node": node_index, "review_status": "review_required"}}
            if "weights" in node:
                child["weights"] = node["weights"]
            # Morph animation must drive every split mesh, not an empty parent.
            for animation in doc.get("animations", []):
                for channel in list(animation.get("channels", [])):
                    if channel.get("target") == {"node": node_index, "path": "weights"}:
                        animation["channels"].append({**deepcopy(channel), "target": {"node": new_index, "path": "weights"}})
            doc["nodes"].append(child)
            node.setdefault("children", []).append(new_index)
            parts.append({"node_index": new_index, "name": name, "role": role})
        node.pop("weights", None)
        for animation in doc.get("animations", []):
            animation["channels"] = [c for c in animation["channels"] if c.get("target") != {"node": node_index, "path": "weights"}]
    assigned = {p["node_index"] for p in parts}
    for index, node in enumerate(doc["nodes"]):
        if "mesh" in node and index not in assigned:
            parts.append({"node_index": index, "name": node.get("name", f"Mesh {index}"), "role": "other"})
    used_meshes = sorted({node["mesh"] for node in doc["nodes"] if "mesh" in node})
    mesh_map = {old: new for new, old in enumerate(used_meshes)}
    doc["meshes"] = [doc["meshes"][index] for index in used_meshes]
    for node in doc["nodes"]:
        if "mesh" in node:
            node["mesh"] = mesh_map[node["mesh"]]
    doc["buffers"][0]["byteLength"] = len(target)
    return build_glb(doc, bytes(target)), parts
