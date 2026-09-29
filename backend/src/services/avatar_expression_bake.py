"""Bake generated facial art into the immutable body's existing UV atlases."""
from __future__ import annotations

import base64
import io
import math
import struct
from dataclasses import dataclass

from PIL import Image

from src.services.character_pipeline import PipelineError
from src.services.glb import parse_glb


MAX_EXPRESSION_TEXTURE_EDGE = 8192


_COMPONENT = {
    5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2),
    5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4),
}
_WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def _accessor(doc, binary, index):
    item = doc["accessors"][index]
    if item.get("sparse") or "bufferView" not in item:
        raise PipelineError("unsupported_body", "희소 GLB 접근자가 있는 몸은 표정 텍스처를 적용할 수 없습니다.", 422)
    view = doc["bufferViews"][item["bufferView"]]
    code, size = _COMPONENT[item["componentType"]]
    width = _WIDTH[item["type"]]
    stride = view.get("byteStride", size * width)
    offset = view.get("byteOffset", 0) + item.get("byteOffset", 0)
    values = []
    for row in range(item["count"]):
        value = struct.unpack_from("<" + code * width, binary, offset + row * stride)
        if item.get("normalized") and code in "bBhH":
            maximum = (1 << (size * 8)) - 1 if code in "BH" else (1 << (size * 8 - 1)) - 1
            value = tuple(max(-1.0, component / maximum) for component in value)
        values.append(value)
    return values


def _multiply(a, b):
    return [[sum(a[row][k] * b[k][column] for k in range(4)) for column in range(4)] for row in range(4)]


def _local_matrix(node):
    if "matrix" in node:
        flat = node["matrix"]
        return [[flat[column * 4 + row] for column in range(4)] for row in range(4)]
    x, y, z, w = node.get("rotation", [0, 0, 0, 1])
    sx, sy, sz = node.get("scale", [1, 1, 1])
    tx, ty, tz = node.get("translation", [0, 0, 0])
    return [
        [(1 - 2 * (y*y + z*z)) * sx, 2 * (x*y - z*w) * sy, 2 * (x*z + y*w) * sz, tx],
        [2 * (x*y + z*w) * sx, (1 - 2 * (x*x + z*z)) * sy, 2 * (y*z - x*w) * sz, ty],
        [2 * (x*z - y*w) * sx, 2 * (y*z + x*w) * sy, (1 - 2 * (x*x + y*y)) * sz, tz],
        [0, 0, 0, 1],
    ]


def _world_matrices(doc):
    parents = {child: parent for parent, node in enumerate(doc.get("nodes", [])) for child in node.get("children", [])}
    cache = {}

    def world(index):
        if index not in cache:
            local = _local_matrix(doc["nodes"][index])
            cache[index] = _multiply(world(parents[index]), local) if index in parents else local
        return cache[index]

    return [world(index) for index in range(len(doc.get("nodes", [])))]


def _point(matrix, value):
    x, y, z = value[:3]
    return tuple(sum(matrix[row][column] * component for column, component in enumerate((x, y, z, 1))) for row in range(3))


def _head_joint_ids(doc, node):
    if "skin" not in node:
        return set()
    joints = doc.get("skins", [])[node["skin"]].get("joints", [])
    return {local for local, joint in enumerate(joints)
            if doc["nodes"][joint].get("name", "").lower().split(":")[-1] == "head"}


def _texture_image(doc, binary, material_index):
    material = doc.get("materials", [])[material_index]
    texture_info = material.get("pbrMetallicRoughness", {}).get("baseColorTexture")
    if texture_info is None:
        raise PipelineError("missing_uv_texture", "얼굴 재질에 기본 색상 텍스처가 필요합니다.", 422)
    texture = doc.get("textures", [])[texture_info["index"]]
    source = texture.get("source")
    if source is None and "extensions" in texture:
        source = texture["extensions"].get("KHR_texture_basisu", {}).get("source")
    if source is None:
        raise PipelineError("missing_uv_texture", "얼굴 재질 텍스처 원본을 찾을 수 없습니다.", 422)
    image = doc["images"][source]
    if "bufferView" in image:
        view = doc["bufferViews"][image["bufferView"]]
        start = view.get("byteOffset", 0)
        raw = binary[start:start + view["byteLength"]]
    elif image.get("uri", "").startswith("data:"):
        raw = base64.b64decode(image["uri"].split(",", 1)[1])
    else:
        raise PipelineError("external_texture", "외부 파일을 참조하는 몸 텍스처는 적용할 수 없습니다.", 422)
    try:
        opened = Image.open(io.BytesIO(raw)).convert("RGBA")
        opened.load()
    except Exception:
        raise PipelineError("invalid_body_texture", "몸의 기본 색상 텍스처를 읽을 수 없습니다.", 422) from None
    maximum = max(opened.size)
    if maximum > MAX_EXPRESSION_TEXTURE_EDGE:
        scale = MAX_EXPRESSION_TEXTURE_EDGE / maximum
        opened = opened.resize((max(1, round(opened.width * scale)), max(1, round(opened.height * scale))), Image.Resampling.LANCZOS)
    return opened, texture_info, texture


def _texture_uv(value, info):
    transform = info.get("extensions", {}).get("KHR_texture_transform", {})
    scale = transform.get("scale", [1, 1])
    offset = transform.get("offset", [0, 0])
    angle = transform.get("rotation", 0)
    x, y = value[0] * scale[0], value[1] * scale[1]
    return (offset[0] + math.cos(angle) * x - math.sin(angle) * y,
            offset[1] + math.sin(angle) * x + math.cos(angle) * y)


def _wrap(value, mode):
    if mode == 33071:  # CLAMP_TO_EDGE
        return min(1.0, max(0.0, value))
    if mode == 33648:  # MIRRORED_REPEAT
        value %= 2.0
        return value if value <= 1 else 2 - value
    return value % 1.0


def _wrap_triangle(uv, wrap_s, wrap_t):
    """Wrap a triangle as one piece: a vertex exactly on the 1.0 edge (the chin of a
    projected face) must stay beside its neighbours instead of jumping to 0.0."""
    def axis(values, mode):
        if mode == 10497:  # REPEAT
            shift = math.floor(min(values) + 1e-9)
            return [value - shift for value in values]
        return [_wrap(value, mode) for value in values]
    return list(zip(axis([point[0] for point in uv], wrap_s), axis([point[1] for point in uv], wrap_t)))


@dataclass
class _Triangle:
    material: int
    points: tuple
    source: tuple
    uv: tuple


def _triangles(doc, binary):
    worlds = _world_matrices(doc)
    candidates = []
    head_points = []
    for node_index, node in enumerate(doc.get("nodes", [])):
        if "mesh" not in node:
            continue
        head_ids = _head_joint_ids(doc, node)
        node_named_head = "head" in node.get("name", "").lower()
        for primitive in doc["meshes"][node["mesh"]].get("primitives", []):
            material = primitive.get("material")
            if material is None:
                continue
            # The collar can be weighted to Head too. It is clothing, not part
            # of the face frame, and otherwise pulls the eyes/mouth downward.
            if doc.get("materials", [])[material].get("extras", {}).get("base_underlayer"):
                continue
            attrs = primitive.get("attributes", {})
            if primitive.get("mode", 4) != 4 or "POSITION" not in attrs or "TEXCOORD_0" not in attrs:
                continue
            positions = [_point(worlds[node_index], value) for value in _accessor(doc, binary, attrs["POSITION"])]
            if head_ids and "JOINTS_0" in attrs and "WEIGHTS_0" in attrs:
                joints = _accessor(doc, binary, attrs["JOINTS_0"])
                weights = _accessor(doc, binary, attrs["WEIGHTS_0"])
                influence = [sum(weight for joint, weight in zip(js, ws) if int(joint) in head_ids)
                             for js, ws in zip(joints, weights)]
            elif node_named_head:
                influence = [1.0] * len(positions)
            else:
                continue
            head_points.extend(point for point, weight in zip(positions, influence) if weight > .6)
            indices = [int(value[0]) for value in _accessor(doc, binary, primitive["indices"])] if "indices" in primitive else list(range(len(positions)))
            tex_info = doc.get("materials", [])[material].get("pbrMetallicRoughness", {}).get("baseColorTexture")
            if tex_info is None:
                continue
            transform = tex_info.get("extensions", {}).get("KHR_texture_transform", {})
            channel = transform.get("texCoord", tex_info.get("texCoord", 0))
            uv_name = f"TEXCOORD_{channel}"
            if uv_name not in attrs:
                continue
            uv = _accessor(doc, binary, attrs[uv_name])
            reserved = doc['materials'][material].get('extras', {}).get('factory_expression_uv') == 'expression-base-color-uv-v1'
            for start in range(0, len(indices) - 2, 3):
                ids = indices[start:start+3]
                if min(influence[index] for index in ids) <= .6:
                    continue
                mapped = tuple(_texture_uv(uv[index], tex_info) for index in ids)
                if reserved and min(point[0] for point in mapped) < .5 - 1e-6:
                    continue
                candidates.append((material, tuple(positions[index] for index in ids), mapped, reserved))
    if not head_points:
        raise PipelineError("missing_head_skin", "Head 관절에 연결된 얼굴 지오메트리를 찾을 수 없습니다.", 422)
    low = tuple(min(point[axis] for point in head_points) for axis in range(3))
    high = tuple(max(point[axis] for point in head_points) for axis in range(3))
    width, height, depth = (high[axis] - low[axis] for axis in range(3))
    side = max(width, height)
    if side <= 1e-8 or depth <= 1e-8:
        raise PipelineError("invalid_head_bounds", "얼굴 지오메트리의 크기가 올바르지 않습니다.", 422)
    center_x, center_y = (low[0] + high[0]) / 2, (low[1] + high[1]) / 2
    result = []
    for material, points, uv, reserved in candidates:
        ab = tuple(points[1][i] - points[0][i] for i in range(3))
        ac = tuple(points[2][i] - points[0][i] for i in range(3))
        normal_z = ab[0] * ac[1] - ab[1] * ac[0]
        if not reserved and (normal_z <= 1e-10 or any(point[2] < low[2] + depth * .45 for point in points)):
            continue
        source = tuple(((point[0] - center_x) / side + .5,
                        .5 - (point[1] - center_y) / side) for point in points)
        result.append(_Triangle(material, points, source, uv))
    if not result:
        raise PipelineError("missing_face_uv", "정면 얼굴 UV 삼각형을 찾을 수 없습니다.", 422)
    return result


def _sample(image, x, y):
    x = min(image.width - 1, max(0, x * image.width - .5))
    y = min(image.height - 1, max(0, y * image.height - .5))
    x0, y0 = int(math.floor(x)), int(math.floor(y))
    x1, y1 = min(image.width - 1, x0 + 1), min(image.height - 1, y0 + 1)
    fx, fy = x - x0, y - y0
    pixels = image.load()
    samples = ((pixels[x0, y0], (1-fx) * (1-fy)), (pixels[x1, y0], fx * (1-fy)),
               (pixels[x0, y1], (1-fx) * fy), (pixels[x1, y1], fx * fy))
    alpha = sum(pixel[3] * weight for pixel, weight in samples)
    if alpha <= 0:
        return (0, 0, 0, 0)
    # Interpolate premultiplied colors so invisible RGB cannot darken PNG edges.
    return tuple(round(sum(pixel[channel] * pixel[3] * weight for pixel, weight in samples) / alpha)
                 for channel in range(3)) + (round(alpha),)


def _paint(atlas, face, triangles, wrap_s, wrap_t):
    pixels = atlas.load()
    # UV overlap is safe only when it addresses the same projected face point.
    owners = {}
    for triangle in triangles:
        uv = [(u * atlas.width, v * atlas.height) for u, v in _wrap_triangle(triangle.uv, wrap_s, wrap_t)]
        area = ((uv[1][0] - uv[0][0]) * (uv[2][1] - uv[0][1])
                - (uv[2][0] - uv[0][0]) * (uv[1][1] - uv[0][1]))
        if abs(area) < 1e-8:
            continue
        left = max(0, math.floor(min(point[0] for point in uv)))
        right = min(atlas.width - 1, math.ceil(max(point[0] for point in uv)))
        top = max(0, math.floor(min(point[1] for point in uv)))
        bottom = min(atlas.height - 1, math.ceil(max(point[1] for point in uv)))
        for y in range(top, bottom + 1):
            for x in range(left, right + 1):
                px, py = x + .5, y + .5
                b = ((px - uv[0][0]) * (uv[2][1] - uv[0][1]) - (py - uv[0][1]) * (uv[2][0] - uv[0][0])) / area
                c = ((uv[1][0] - uv[0][0]) * (py - uv[0][1]) - (uv[1][1] - uv[0][1]) * (px - uv[0][0])) / area
                a = 1 - b - c
                if min(a, b, c) < -1e-7:
                    continue
                source_x = a * triangle.source[0][0] + b * triangle.source[1][0] + c * triangle.source[2][0]
                source_y = a * triangle.source[0][1] + b * triangle.source[1][1] + c * triangle.source[2][1]
                previous = owners.get((x, y))
                if previous is not None:
                    if abs(previous[0] - source_x) + abs(previous[1] - source_y) > .025:
                        raise PipelineError("overlapping_face_uv", "얼굴 UV가 좌우의 서로 다른 위치에서 겹쳐 표정 텍스처를 안전하게 저장할 수 없습니다.", 422)
                    # Adjacent triangles own their shared edge together. The
                    # atlas pixel already contains this projected face sample;
                    # compositing it again would square its transparency and
                    # leave a darker seam around semi-transparent artwork.
                    continue
                owners[x, y] = source_x, source_y
                foreground = _sample(face, source_x, source_y)
                if foreground[3] == 0:
                    continue
                background = pixels[x, y]
                alpha = foreground[3] / 255
                out_alpha = alpha + background[3] / 255 * (1 - alpha)
                if out_alpha <= 0:
                    pixels[x, y] = (0, 0, 0, 0)
                else:
                    pixels[x, y] = tuple(round((foreground[channel] * alpha + background[channel] * background[3] / 255 * (1-alpha)) / out_alpha)
                                         for channel in range(3)) + (round(out_alpha * 255),)


def bake_expression(body_content: bytes, face_content: bytes):
    """Return save-compatible material maps without changing body geometry."""
    try:
        face = Image.open(io.BytesIO(face_content)).convert("RGBA")
        face.load()
    except Exception:
        raise PipelineError("invalid_expression_image", "생성된 얼굴 PNG를 읽을 수 없습니다.", 422) from None
    if face.width < 1 or face.height < 1 or max(face.size) > 2048:
        raise PipelineError("invalid_expression_image", "생성된 얼굴 이미지는 2048px 이하여야 합니다.", 422)
    # The provider contract is square. Padding instead of stretching also keeps
    # custom/manual inputs geometrically correct.
    if face.width != face.height:
        side = max(face.size)
        square = Image.new("RGBA", (side, side))
        square.alpha_composite(face, ((side - face.width) // 2, (side - face.height) // 2))
        face = square
    doc, binary = parse_glb(body_content, strict=True)
    triangles = _triangles(doc, binary)
    maps = []
    for material in sorted({triangle.material for triangle in triangles}):
        atlas, _, texture = _texture_image(doc, binary, material)
        sampler = doc.get("samplers", [])[texture["sampler"]] if "sampler" in texture else {}
        _paint(atlas, face, [triangle for triangle in triangles if triangle.material == material],
               sampler.get("wrapS", 10497), sampler.get("wrapT", 10497))
        output = io.BytesIO()
        atlas.save(output, "PNG", optimize=True)
        maps.append({"material": material, "png": base64.b64encode(output.getvalue()).decode("ascii")})
    return maps
