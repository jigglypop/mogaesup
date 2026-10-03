#!/usr/bin/env python3
"""Offline sample checks only; stdlib, no network, no saves, no generation.

The schema evaluator supports only keywords present in the adjacent schema.
This is not a general JSON Schema implementation or a production plan validator.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import re
import struct
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
EPS = 2e-6


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def schema_check(value, spec, root, path="$", probing=False):
    """Evaluate this sample's schema subset, rejecting unsupported keywords."""
    allowed = {"$schema", "$id", "$defs", "$ref", "title", "description", "type",
               "const", "enum", "properties", "required", "additionalProperties",
               "items", "minItems", "maxItems", "uniqueItems", "minLength",
               "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum",
               "allOf", "if", "then", "anyOf", "contains"}
    require(set(spec) <= allowed, f"Unsupported schema keywords at {path}")
    if "$ref" in spec:
        require(spec["$ref"].startswith("#/$defs/"), "Only local sample refs supported")
        return schema_check(value, root["$defs"][spec["$ref"].split("/")[-1]], root, path)
    if "const" in spec:
        require(value == spec["const"], f"{path}: const mismatch")
    if "enum" in spec:
        require(value in spec["enum"], f"{path}: enum mismatch")
    types = spec.get("type", [])
    if isinstance(types, str):
        types = [types]
    matches = {"object": isinstance(value, dict), "array": isinstance(value, list),
               "string": isinstance(value, str), "number": isinstance(value, (int, float)) and not isinstance(value, bool),
               "integer": isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value == int(value),
               "null": value is None, "boolean": isinstance(value, bool)}
    require(not types or any(matches[t] for t in types), f"{path}: type mismatch")
    if isinstance(value, dict):
        require(set(spec.get("required", [])) <= set(value), f"{path}: missing fields")
        if spec.get("additionalProperties") is False:
            require(set(value) <= set(spec.get("properties", {})), f"{path}: extra fields")
        for key, subspec in spec.get("properties", {}).items():
            if key in value:
                schema_check(value[key], subspec, root, f"{path}.{key}")
    if isinstance(value, list):
        require(len(value) >= spec.get("minItems", 0), f"{path}: too few items")
        require(len(value) <= spec.get("maxItems", math.inf), f"{path}: too many items")
        if spec.get("uniqueItems"):
            require(len({json.dumps(v, sort_keys=True) for v in value}) == len(value), f"{path}: duplicate items")
        if "items" in spec:
            for i, item in enumerate(value):
                schema_check(item, spec["items"], root, f"{path}[{i}]")
        if "contains" in spec:
            matched = False
            for item in value:
                try:
                    schema_check(item, spec["contains"], root, path)
                except AssertionError:
                    continue
                matched = True
                break
            require(matched, f"{path}: contains did not match")
    if isinstance(value, str):
        require(len(value) >= spec.get("minLength", 0), f"{path}: short string")
        require(len(value) <= spec.get("maxLength", math.inf), f"{path}: long string")
        if "pattern" in spec:
            require(re.search(spec["pattern"], value), f"{path}: pattern mismatch")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        require(math.isfinite(value), f"{path}: nonfinite number")
        require(value >= spec.get("minimum", -math.inf), f"{path}: below minimum")
        require(value <= spec.get("maximum", math.inf), f"{path}: above maximum")
        require(value > spec.get("exclusiveMinimum", -math.inf), f"{path}: below exclusive minimum")
    for subspec in spec.get("allOf", []):
        schema_check(value, subspec, root, path)
    if "anyOf" in spec:
        matched = False
        for subspec in spec["anyOf"]:
            try:
                schema_check(value, subspec, root, path)
            except AssertionError:
                continue
            matched = True
            break
        require(matched, f"{path}: anyOf did not match")
    if "if" in spec:
        try:
            schema_check(value, spec["if"], root, path, probing=True)
        except AssertionError:
            pass
        else:
            if "then" in spec:
                schema_check(value, spec["then"], root, path)


def multiply(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


IDENTITY = [[int(i == j) for j in range(4)] for i in range(4)]


def local_matrix(node):
    if "matrix" in node:
        return [[node["matrix"][j * 4 + i] for j in range(4)] for i in range(4)]
    x, y, z, w = node.get("rotation", [0, 0, 0, 1])
    r = [[1 - 2 * (y*y + z*z), 2 * (x*y - z*w), 2 * (x*z + y*w)],
         [2 * (x*y + z*w), 1 - 2 * (x*x + z*z), 2 * (y*z - x*w)],
         [2 * (x*z - y*w), 2 * (y*z + x*w), 1 - 2 * (x*x + y*y)]]
    scales = node.get("scale", [1, 1, 1])
    translations = node.get("translation", [0, 0, 0])
    return [[r[i][j] * scales[j] for j in range(3)] + [translations[i]] for i in range(3)] + [[0, 0, 0, 1]]


def glb_bounds(raw):
    """Static, uncompressed float POSITION sample assets only."""
    require(raw[:4] == b"glTF", "GLB magic")
    doc = binary = None
    offset = 12
    while offset < len(raw):
        size, kind = struct.unpack_from("<II", raw, offset)
        data = raw[offset + 8:offset + 8 + size]
        offset += 8 + size
        if kind == 0x4E4F534A:
            doc = json.loads(data)
        elif kind == 0x004E4942:
            binary = data
    require(doc is not None and binary is not None, "GLB chunks")
    points = []

    def visit(index, parent):
        node = doc["nodes"][index]
        require("skin" not in node, "Sample checker does not support skinned geometry")
        matrix = multiply(parent, local_matrix(node))
        if "mesh" in node:
            for primitive in doc["meshes"][node["mesh"]]["primitives"]:
                accessor = doc["accessors"][primitive["attributes"]["POSITION"]]
                require(accessor["componentType"] == 5126 and accessor["type"] == "VEC3" and "sparse" not in accessor, "Unsupported sample accessor")
                view = doc["bufferViews"][accessor["bufferView"]]
                require(view.get("buffer", 0) == 0, "Only embedded BIN supported")
                byte = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
                stride = view.get("byteStride", 12)
                for i in range(accessor["count"]):
                    point = list(struct.unpack_from("<fff", binary, byte + i * stride)) + [1]
                    points.append([sum(matrix[axis][j] * point[j] for j in range(4)) for axis in range(3)])
        for child in node.get("children", []):
            visit(child, matrix)

    for node in doc["scenes"][doc.get("scene", 0)]["nodes"]:
        visit(node, IDENTITY)
    require(points, "Empty sample mesh")
    return {"min": [min(p[i] for p in points) for i in range(3)],
            "max": [max(p[i] for p in points) for i in range(3)]}


def rectangle(x0, z0, x1, z1):
    return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]


def separated(a, b, clearance=0):
    """Convex rectangle SAT; nonnegative clearance conservatively expands projections."""
    for poly in [a, b]:
        for i, start in enumerate(poly):
            end = poly[(i + 1) % len(poly)]
            dx, dz = end[0] - start[0], end[1] - start[1]
            length = math.hypot(dx, dz)
            require(length > EPS, "Degenerate footprint")
            axis = [-dz / length, dx / length]
            av = [v[0] * axis[0] + v[1] * axis[1] for v in a]
            bv = [v[0] * axis[0] + v[1] * axis[1] for v in b]
            if max(av) + clearance <= min(bv) + EPS or max(bv) + clearance <= min(av) + EPS:
                return True
    return False


def distance_to_polygon(point, poly):
    distances = []
    for i, a in enumerate(poly):
        b = poly[(i + 1) % len(poly)]
        dx, dz = b[0] - a[0], b[1] - a[1]
        t = max(0, min(1, ((point[0] - a[0])*dx + (point[1] - a[1])*dz)/(dx*dx + dz*dz)))
        distances.append(math.hypot(point[0] - a[0] - t*dx, point[1] - a[1] - t*dz))
    return min(distances)


def main():
    inp = json.loads((HERE / "store-layout.input.example.json").read_text())
    plan = json.loads((HERE / "store-layout.output.example.json").read_text())
    schema = json.loads((HERE / "store-layout.schema.json").read_text())
    schema_check(plan, schema, schema)
    require(plan["baseline"] == inp["baseline"] and plan["grid"] == inp["grid"], "Baseline/grid differ")
    require(plan["baseline"]["source"] == "illustrative_fixture", "Sample is fixture only")
    require(inp["existing"]["tiles"] == inp["existing"]["walls"] == inp["existing"]["objects"] == [], "Only empty fixture supported")
    ids = [t["tileId"] for t in plan["tiles"]] + [w["wallId"] for w in plan["walls"]] + [o["objectId"] for o in plan["objects"]] + [e["entranceId"] for e in plan["entrances"]] + [p["pathId"] for p in plan["circulation"]["paths"]]
    require(len(set(ids)) == len(ids), "Duplicate plan IDs")
    catalog = {i["id"]: i for i in inp["catalog"]}
    archive = ROOT / "frontend/vendor/gaesup-world-1.7.0-mogaesup.2.tgz"
    with tarfile.open(archive) as tar:
        object_source = tar.extractfile("package/dist/plugin-DwKEQduO.js").read().decode()
        preset_source = tar.extractfile("package/dist/useClicker-dd9Qqwl0.js").read().decode()
        for item in catalog.values():
            block = re.search(r'id: "' + re.escape(item["id"]) + r'",(.*?)\n\t}', object_source, re.S)
            require(block is not None, f"Missing built-in ID {item['id']}")
            scale = re.search(r"defaultScale: ([0-9.]+)", block.group(1))
            require(scale and float(scale.group(1)) == item["defaultScale"], "Catalog scale changed")
            require(f'modelUrl: "{item["modelUrl"]}"' in block.group(1), "Catalog URL changed")
            path = item["geometryEvidence"]["path"].split("::", 1)[1]
            raw = tar.extractfile(path).read()
            require(hashlib.sha256(raw).hexdigest() == item["geometryEvidence"]["sourceAssetSha256"], "Source asset hash changed")
            require(item["geometryEvidence"]["boundsStage"] == "source_uncompressed", "Source geometry stage")
            require(item["geometryEvidence"]["deliveredAssetSha256"] is None and item["geometryEvidence"]["deliveredBoundsM"] is None, "Fixture must not claim delivered geometry")
            measured = glb_bounds(raw)
            require(all(abs(measured[key][axis] - item["localBoundsM"][key][axis]) < EPS for key in ["min", "max"] for axis in range(3)), "Measured geometry changed")
        for preset in inp["allowedFloorPresetIds"] + inp["allowedWallPresetIds"]:
            require(f'id: "{preset}"' in preset_source, f"Unknown preset {preset}")

    lo, hi = plan["region"]["minXZ"], plan["region"]["maxXZ"]
    tiles = {t["tileId"]: t for t in plan["tiles"]}
    cells = set()
    for tile in tiles.values():
        x, z, level = (tile["cell"][k] for k in ["x", "z", "level"])
        require((x, z, level) not in cells, "Duplicate floor cell")
        cells.add((x, z, level))
        require(tile["centerM"] == [x*4, level, z*4] and tile["topY"] == level, "Grid equation")
        require(abs(tile["topY"] - tile["baseY"] - tile["thicknessM"]) < EPS, "Slab equation")
        require(tile["action"] == "install" and tile["floorPresetId"] in inp["allowedFloorPresetIds"], "Floor authority")
        require(lo[0] <= x*4-2 and x*4+2 <= hi[0] and lo[1] <= z*4-2 and z*4+2 <= hi[1], "Tile bounds")
    require(len(tiles)*16 == (hi[0]-lo[0])*(hi[1]-lo[1]), "Sample region must be fully tiled")

    objects = {o["objectId"]: o for o in plan["objects"]}
    for item in objects.values():
        require(item["catalogId"] in catalog and item["tileId"] in tiles, "Object reference")
        require(all(abs(v-round(v)) < EPS for v in item["positionM"]), "Object 1m snap")
        tile = tiles[item["tileId"]]
        require(item["positionM"][1] == tile["topY"], "Object support height")
        require(abs(item["positionM"][0]-tile["centerM"][0]) <= 2 and abs(item["positionM"][2]-tile["centerM"][2]) <= 2, "Pivot support reference")
        source = catalog[item["catalogId"]]
        scale = source["defaultScale"]*item["sizeFactor"]
        mn, mx = source["localBoundsM"]["min"], source["localBoundsM"]["max"]
        c, s = math.cos(math.radians(item["rotationDeg"])), math.sin(math.radians(item["rotationDeg"]))
        expected = [[item["positionM"][0]+scale*(c*x+s*z), item["positionM"][2]+scale*(-s*x+c*z)] for x, z in [(mn[0], mn[2]), (mx[0], mn[2]), (mx[0], mx[2]), (mn[0], mx[2])]]
        require(all(abs(a-b) < EPS for actual, wanted in zip(item["footprintM"], expected) for a, b in zip(actual, wanted)), "Footprint equation")
        require(all(lo[0] <= v[0] <= hi[0] and lo[1] <= v[1] <= hi[1] for v in expected), "Object floor bounds")
    pieces = list(objects.values())
    for i, a in enumerate(pieces):
        for b in pieces[i+1:]:
            require(separated(a["footprintM"], b["footprintM"]), f"Object collision {a['objectId']}/{b['objectId']}")

    edges = set()
    wall_solids = []
    walls = {w["wallId"]: w for w in plan["walls"]}
    for wall in walls.values():
        require(wall["tileId"] in tiles and wall["wallPresetId"] in inp["allowedWallPresetIds"] and wall["kind"] in inp["allowedWallKinds"], "Wall authority")
        x, _, z = tiles[wall["tileId"]]["centerM"]
        side = wall["edge"]
        along_x = side in ["north", "south"]
        if side == "north": z -= 2
        if side == "south": z += 2
        if side == "west": x -= 2
        if side == "east": x += 2
        key = (x, z, along_x)
        require(key not in edges, "Duplicate physical edge")
        edges.add(key)
        spans = [(-2, 2)] if wall["kind"] not in ["door", "arch"] else [(-2, -1.04), (1.04, 2)]
        for start, end in spans:
            wall_solids.append(rectangle(x+start, z-.25, x+end, z+.25) if along_x else rectangle(x-.25, z+start, x+.25, z+end))
    for item in pieces:
        require(all(separated(item["footprintM"], wall) for wall in wall_solids), f"Wall collision {item['objectId']}")

    circulation = plan["circulation"]
    entrances = {e["entranceId"]: e for e in plan["entrances"]}
    for entrance in entrances.values():
        require(entrance["wallId"] in walls and walls[entrance["wallId"]]["kind"] in ["door", "arch"], "Entrance reference")
        require(abs(entrance["clearOpeningWidthM"]-2.08) < EPS, "Door frame opening")
        require(entrance["clearOpeningWidthM"] >= circulation["minClearWidthM"]+2*circulation["safetyMarginM"], "Narrow entrance")
    for path in circulation["paths"]:
        require(path["entranceId"] in entrances, "Path entrance reference")
        require(path["clearWidthM"] >= circulation["minClearWidthM"] >= circulation["avatarCapsuleDiameterM"], "Narrow corridor")
        radius = path["clearWidthM"] / 2
        strips = []
        for a, b in zip(path["pointsXZ"], path["pointsXZ"][1:]):
            dx, dz = b[0]-a[0], b[1]-a[1]
            length = math.hypot(dx, dz)
            require(length > EPS, "Zero-length path")
            nx, nz = -dz/length*radius, dx/length*radius
            strips.append([[a[0]+nx, a[1]+nz], [b[0]+nx, b[1]+nz], [b[0]-nx, b[1]-nz], [a[0]-nx, a[1]-nz]])
        for x, z in path["pointsXZ"][1:-1]:
            strips.append(rectangle(x-radius, z-radius, x+radius, z+radius))
        for strip in strips:
            require(all(lo[0]-EPS <= v[0] <= hi[0]+EPS and lo[1]-EPS <= v[1] <= hi[1]+EPS for v in strip), "Corridor floor bounds")
            require(all(separated(strip, item["footprintM"], circulation["safetyMarginM"]) for item in pieces), "Corridor blocked by object")
            require(all(separated(strip, wall, circulation["safetyMarginM"]) for wall in wall_solids), "Corridor blocked by wall")
        for target in path["targetObjectIds"]:
            require(target in objects, "Path target reference")
            require(distance_to_polygon(path["pointsXZ"][-1], objects[target]["footprintM"]) <= circulation["targetReachM"], "Target too far from corridor end")
    # This fixture's branches join the main route at exact points; no general graph algorithm is claimed.
    main_path = circulation["paths"][0]
    for path in circulation["paths"][1:]:
        point = path["pointsXZ"][0]
        connected = False
        for a, b in zip(main_path["pointsXZ"], main_path["pointsXZ"][1:]):
            dx, dz = b[0]-a[0], b[1]-a[1]
            cross = dx*(point[1]-a[1])-dz*(point[0]-a[0])
            dot = (point[0]-a[0])*dx+(point[1]-a[1])*dz
            if abs(cross) < EPS and -EPS <= dot <= dx*dx+dz*dz+EPS:
                connected = True
        require(connected, "Disconnected fixture branch")
    ids = [q["id"] for q in plan["qualityChecks"]]
    require(len(set(ids)) == len(ids) and set(ids) == set(schema["$defs"]["qualityCheck"]["properties"]["id"]["enum"]), "Check coverage")
    require(all(q["status"] == "pending" and q["evidence"] is None for q in plan["qualityChecks"]), "Fixture must not claim applied checks")
    require(plan["status"] == "blocked" and plan["blockers"], "Unverified fixture is blocked")
    print(f"PASS: sample schema subset; {len(tiles)} tiles, {len(walls)} walls, {len(objects)} objects; vendor hashes, measured footprints, references and interior circulation.")
    print("LIMITS: example fixture only; actual world/revision, outside access, rendering and SaveBlob size remain unverified. No files or APIs changed.")


if __name__ == "__main__":
    main()
