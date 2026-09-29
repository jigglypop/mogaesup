from __future__ import annotations

import json
import itertools
import logging
import os
import pathlib
import struct
import threading
import time
import uuid
import base64
from copy import deepcopy
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response

try:
    import wasmtime
except Exception:
    wasmtime = None

from src import db
from src.services.media import (
    UnsafeRemoteUrl,
    _s3_client,
    _upload_to_s3,
    fetch_public_url,
)
from src.api.sse import sse_done, sse_error, sse_response, sse_status
from src.auth import UserContext, get_current_user
from src.services.image_generation import collect_reference_images, generate_reference_image
from src.services.glb import parse_glb as _parse_glb
from src.text_utils import redact_url

logger = logging.getLogger(__name__)
router = APIRouter()

_VALID_KINDS = {"character", "tile", "prop", "tree", "house", "pet", "npc"}
_PART_SLOTS = {"top", "bottom", "shoes", "hat", "face", "glasses", "weapon", "accessory"}
_PART_BUNDLE_DEFAULT_SLOTS = ["top", "bottom", "shoes", "hat", "face", "glasses", "weapon", "accessory"]
_PART_SLOT_ALIASES = {
    "top": {"top", "shirt", "jacket", "coat", "hoodie", "upper", "상의", "셔츠", "재킷", "자켓", "코트", "후드"},
    "bottom": {"bottom", "pants", "trousers", "skirt", "shorts", "lower", "하의", "바지", "치마", "반바지"},
    "shoes": {"shoes", "shoe", "boots", "sneakers", "footwear", "신발", "부츠", "운동화"},
    "hat": {"hat", "cap", "helmet", "headwear", "모자", "캡", "헬멧", "머리장식"},
    "glasses": {"glasses", "sunglasses", "goggles", "eyewear", "안경", "선글라스", "고글"},
    "weapon": {"weapon", "sword", "staff", "gun", "wand", "shield", "무기", "검", "칼", "스태프", "지팡이", "방패"},
    "accessory": {"accessory", "necklace", "bag", "backpack", "ring", "bracelet", "액세서리", "악세사리", "목걸이", "가방", "반지", "팔찌"},
}
_PART_SLOT_ALIASES["face"] = {"face", "mask", "beard", "mustache", "facial", "얼굴", "마스크", "수염"}
_QUADRUPED_SOCKETS = {"head", "neck", "back", "tail", "front_legs", "hind_legs"}
_PART_SLOT_DEFAULT_SOCKETS = {
    "hat": "head",
    "face": "face",
    "glasses": "face",
    "weapon": "hand",
    "accessory": "back",
}
_QUADRUPED_PROMPT_TERMS = {
    "quadruped", "four-legged", "four legged", "four legs", "animal", "dog", "cat", "wolf", "fox", "horse",
    "deer", "lion", "tiger", "bear", "rabbit", "펫", "동물", "강아지", "개", "고양이", "늑대", "여우", "말", "사슴", "사자", "호랑이", "곰", "토끼", "4족", "사족",
}
_MEMORY_JOBS: dict[str, dict[str, Any]] = {}
_MEMORY_ASSETS: list[dict[str, Any]] = []
_MEMORY_PLACEMENTS: dict[str, dict[str, Any]] = {}
_MEMORY_LOCK = threading.Lock()
_MEMORY_ASSET_IDS = itertools.count(1)
_MEMORY_JOB_LIMIT = 500
_MEMORY_ASSET_LIMIT = 2000
_MEMORY_PLACEMENT_LIMIT = 500
_TERMINAL_JOB_STATUSES = {"done", "planned", "error"}
_JOB_ID_TAKEN = "이미 다른 사용자가 사용 중인 작업 ID입니다."
_MAX_MODEL_FETCH_BYTES = 256 * 1024 * 1024
_MESHY_ASSET_DOMAIN = "meshy.ai"
_WORLD_MODEL_MEDIA_KIND = "world-model"
# Metadata written by generation and read back by the model proxy and provider refresh.
# PATCH /world/assets/{id} never changes these; see _is_server_owned_metadata_key.
_SERVER_OWNED_METADATA_KEYS = frozenset({
    "provider", "source", "source_asset_id", "task_id", "rigging", "output_contract", "part_bundle_role",
})
_SERVER_OWNED_METADATA_PREFIXES = ("stored_", "original_", "refreshed_", "provider_")

_CHARACTER_KINDS = {"character", "npc"}
_MESHY_CHARACTER_ACTION_PRESET: list[dict[str, Any]] = [
    {"canonical_name": "idle", "action_id": 249, "label": "Idle_9"},
    {"canonical_name": "walk", "action_id": 692, "label": "walking_2_inplace"},
    {"canonical_name": "run", "action_id": 657, "label": "run_fast_10_inplace"},
    {"canonical_name": "jump", "action_id": 466, "label": "Regular_Jump"},
    {"canonical_name": "greet", "action_id": 28, "label": "Big_Wave_Hello"},
    {"canonical_name": "fall", "action_id": 502, "label": "Fall1"},
]
_MESHY_DEFAULT_CHARACTER_ACTION_IDS = [int(item["action_id"]) for item in _MESHY_CHARACTER_ACTION_PRESET]
_MESHY_ANIMATION_SLOT_KEYS = [str(item["canonical_name"]) for item in _MESHY_CHARACTER_ACTION_PRESET]
_MESHY_LEGACY_CHARACTER_ACTION_IDS = [0, 1, 14, 28]
_MESHY_ACTION_LABELS = {
    0: "Idle",
    1: "Walking_Woman",
    14: "Run_02",
    22: "FunnyDancing_01",
    28: "Big_Wave_Hello",
    30: "Casual_Walk",
    44: "Happy_jump_f",
    61: "happy_jump_m",
    86: "Basic_Jump",
    249: "Idle_9",
    466: "Regular_Jump",
    502: "Fall1",
    657: "run_fast_10_inplace",
    692: "walking_2_inplace",
}
_MESHY_ACTION_CANONICAL_NAMES = {
    int(item["action_id"]): str(item["canonical_name"])
    for item in _MESHY_CHARACTER_ACTION_PRESET
}
_MESHY_CHARACTER_ACTION_SLOTS = {str(item["canonical_name"]) for item in _MESHY_CHARACTER_ACTION_PRESET}
_MESHY_BASIC_ANIMATION_CANONICAL_NAMES = {
    "idle": "idle",
    "walking": "walk",
    "walk": "walk",
    "running": "run",
    "run": "run",
    "jump": "jump",
    "jumping": "jump",
    "fall": "fall",
    "falling": "fall",
}
_MESHY_DEFAULT_RIG_HEIGHT_METERS = 1.7
_MESHY_ANIMATION_CATALOG_MEMORY: list[dict[str, Any]] = []

_GLB_MAGIC = 0x46546C67
_GLB_JSON_CHUNK = 0x4E4F534A
_GLB_BIN_CHUNK = 0x004E4942
_GLTF_COMPONENT_FLOAT = 5126
_GLTF_COMPONENT_UNSIGNED_SHORT = 5123
_GLTF_COMPONENT_UNSIGNED_INT = 5125
_GLTF_TYPE_COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
_FACE_LOCK_MIN_Y_RATIO = 0.58
_FACE_LOCK_MIN_Z_RATIO = 0.52
_FACE_LOCK_HALF_WIDTH_RATIO = 0.42
_FACE_LOCK_STRICT_MIN_Y_RATIO = 0.50
_FACE_LOCK_STRICT_MIN_Z_RATIO = 0.45
_FACE_LOCK_STRICT_HALF_WIDTH_RATIO = 0.50
_WASM_SKIN_INSTANCE: Any = None


class MeshyInsufficientFundsError(RuntimeError):
    pass


def _now_ms() -> int:
    return int(time.time() * 1000)


def _job_id() -> str:
    return str(uuid.uuid4())


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _parse_json(raw: Any, default: Any) -> Any:
    if raw is None:
        return default
    if isinstance(raw, (dict, list)):
        return raw
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="ignore")
    if not isinstance(raw, str) or not raw.strip():
        return default
    try:
        return json.loads(raw)
    except Exception:
        return default


def _settings() -> dict[str, str]:
    return db.load_settings(prefixes=("world_", "gemini_"))


def _setting(settings: dict[str, str], key: str, env_key: str = "", default: str = "") -> str:
    return db.setting_or_env(key, env_key, default, settings=settings)


_TEXTURE_KIND_PALETTES: dict[str, tuple[str, str, str]] = {
    "brick": ("#8f4b3e", "#c98267", "#4b2f2a"),
    "castle_stone": ("#8b9194", "#c4c9c9", "#4f5658"),
    "flag": ("#3158a7", "#f2d25c", "#14213d"),
    "torch": ("#5b3524", "#ffb03b", "#2a160f"),
    "magic_circle": ("#27345f", "#76e4f7", "#f7f1a1"),
}


def _clean_texture_kind(kind: Any) -> str:
    raw = str(kind or "").strip().lower().replace("-", "_").replace(" ", "_")
    return raw if raw in _TEXTURE_KIND_PALETTES else "brick"


def _texture_svg_pattern(kind: str, prompt: str, primary: str, accent: str, dark: str) -> str:
    label = (prompt or kind).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")[:80]
    if kind in {"brick", "castle_stone"}:
        return f"""
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="{primary}"/>
  <g fill="{accent}" opacity="0.55">
    <rect x="0" y="0" width="112" height="54"/><rect x="128" y="0" width="128" height="54"/><rect x="272" y="0" width="112" height="54"/><rect x="400" y="0" width="112" height="54"/>
    <rect x="48" y="64" width="128" height="54"/><rect x="192" y="64" width="112" height="54"/><rect x="320" y="64" width="144" height="54"/>
    <rect x="0" y="128" width="144" height="54"/><rect x="160" y="128" width="128" height="54"/><rect x="304" y="128" width="112" height="54"/><rect x="432" y="128" width="80" height="54"/>
    <rect x="64" y="192" width="112" height="54"/><rect x="192" y="192" width="144" height="54"/><rect x="352" y="192" width="128" height="54"/>
    <rect x="0" y="256" width="128" height="54"/><rect x="144" y="256" width="112" height="54"/><rect x="272" y="256" width="144" height="54"/><rect x="432" y="256" width="80" height="54"/>
    <rect x="48" y="320" width="144" height="54"/><rect x="208" y="320" width="112" height="54"/><rect x="336" y="320" width="144" height="54"/>
    <rect x="0" y="384" width="112" height="54"/><rect x="128" y="384" width="128" height="54"/><rect x="272" y="384" width="128" height="54"/><rect x="416" y="384" width="96" height="54"/>
    <rect x="64" y="448" width="128" height="54"/><rect x="208" y="448" width="144" height="54"/><rect x="368" y="448" width="112" height="54"/>
  </g>
  <g stroke="{dark}" stroke-width="6" opacity="0.7"><path d="M0 60h512M0 124h512M0 188h512M0 252h512M0 316h512M0 380h512M0 444h512"/></g>
  <text x="18" y="494" font-size="18" fill="{dark}" opacity="0.5">{label}</text>
</svg>"""
    if kind == "flag":
        return f"""
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="{primary}"/>
  <path d="M0 72C92 24 160 128 256 80s164 56 256 8v128c-92 48-160-56-256-8S92 152 0 200z" fill="{accent}" opacity="0.9"/>
  <path d="M0 288C120 224 196 352 320 288c72-37 124-30 192 8v128c-92-48-160-56-256-8S92 472 0 424z" fill="{dark}" opacity="0.45"/>
</svg>"""
    if kind == "magic_circle":
        return f"""
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="{primary}"/>
  <g fill="none" stroke="{accent}" stroke-width="8" opacity="0.9"><circle cx="256" cy="256" r="190"/><circle cx="256" cy="256" r="132"/><path d="M256 70l161 279H95z"/><path d="M256 442L95 163h322z"/></g>
  <g fill="{accent}" opacity="0.75"><circle cx="256" cy="70" r="14"/><circle cx="417" cy="349" r="14"/><circle cx="95" cy="349" r="14"/><circle cx="256" cy="256" r="18"/></g>
</svg>"""
    return f"""
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="{dark}"/>
  <g fill="{primary}"><rect x="180" y="48" width="152" height="416" rx="42"/><path d="M256 20c68 76 94 136 78 181-14 42-51 62-78 62s-64-20-78-62c-16-45 10-105 78-181z" fill="{accent}"/></g>
  <g fill="{accent}" opacity="0.7"><path d="M256 78c36 48 48 84 36 110-8 18-22 28-36 28s-28-10-36-28c-12-26 0-62 36-110z"/></g>
</svg>"""


def _texture_data_url(svg: str) -> str:
    encoded = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{encoded}"


def _model_mime_from_url(url: str, content_type: str = "") -> str:
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    if mime in {"model/gltf-binary", "model/gltf+json", "application/octet-stream"}:
        return "model/gltf-binary" if mime != "model/gltf+json" else mime
    path = url.split("?", 1)[0].lower()
    if path.endswith(".gltf"):
        return "model/gltf+json"
    if path.endswith(".glb"):
        return "model/gltf-binary"
    return "model/gltf-binary"


def _url_host(url: str) -> str:
    try:
        return (httpx.URL(str(url or "").strip()).host or "").strip().lower().rstrip(".")
    except Exception:
        return ""


def _configured_provider_host(settings: dict[str, str]) -> str:
    return _url_host(_setting(settings, "world_3d_api_url", "WORLD_3D_API_URL", ""))


def _fetch_model_bytes(model_url: str, timeout: int = 180) -> tuple[bytes, str]:
    headers = {
        "Accept": "model/gltf-binary,model/gltf+json,application/octet-stream,*/*",
        "User-Agent": "signight-world-model-proxy/1.0",
    }
    # Every hop must resolve to a public address; only the operator-configured provider host is exempt.
    content, content_type = fetch_public_url(
        model_url,
        timeout=timeout,
        max_bytes=_MAX_MODEL_FETCH_BYTES,
        headers=headers,
        trusted_hosts=(_configured_provider_host(_settings()),),
    )
    if not content:
        raise RuntimeError("empty model response")
    return content, _model_mime_from_url(model_url, content_type)


def _world_model_storage(settings: dict[str, str]) -> tuple[str, str, str]:
    """Bucket, region and key prefix that _upload_to_s3(..., "world-model", ...) writes to."""
    bucket = _setting(settings, "gemini_s3_bucket", "AWS_S3_BUCKET", "")
    region = _setting(settings, "gemini_s3_region", "AWS_REGION", "ap-northeast-2")
    root = (_setting(settings, "gemini_s3_prefix", "AWS_S3_DIR", "images") or "images").strip("/") or "images"
    return bucket, region, f"{root}/gemini/{_WORLD_MODEL_MEDIA_KIND}/"


def _world_proxy_hosts(settings: dict[str, str]) -> set[str]:
    """Hosts the world pipeline itself records model URLs on: Meshy assets, the configured
    provider, the world-model bucket, and any extra hosts the operator lists."""
    bucket, region, _ = _world_model_storage(settings)
    hosts = {_MESHY_ASSET_DOMAIN, _url_host(_meshy_base(settings)), _configured_provider_host(settings)}
    if bucket:
        hosts.update({f"{bucket}.s3.{region}.amazonaws.com".lower(), f"{bucket}.s3.amazonaws.com".lower()})
    extra = _setting(settings, "world_model_proxy_hosts", "WORLD_MODEL_PROXY_HOSTS", "")
    hosts.update(item.strip().lower().rstrip(".") for item in extra.split(","))
    return {host for host in hosts if host}


def _fetch_proxied_model_bytes(url: str, settings: dict[str, str]) -> tuple[bytes, str]:
    host = _url_host(url)
    if not host or not any(host == allowed or host.endswith(f".{allowed}") for allowed in _world_proxy_hosts(settings)):
        raise UnsafeRemoteUrl(f"model host is not a recorded provider or storage host: {host or '-'}")
    return _fetch_model_bytes(url, timeout=120)


def _pad4(data: bytes, pad_byte: bytes = b"\x00") -> bytes:
    remainder = len(data) % 4
    return data if remainder == 0 else data + (pad_byte * (4 - remainder))


def _build_glb(doc: dict[str, Any], binary: bytes) -> bytes:
    json_bytes = _pad4(json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), b" ")
    bin_bytes = _pad4(binary, b"\x00")
    total_length = 12 + 8 + len(json_bytes) + (8 + len(bin_bytes) if bin_bytes else 0)
    parts = [
        struct.pack("<III", _GLB_MAGIC, 2, total_length),
        struct.pack("<II", len(json_bytes), _GLB_JSON_CHUNK),
        json_bytes,
    ]
    if bin_bytes:
        parts.extend([struct.pack("<II", len(bin_bytes), _GLB_BIN_CHUNK), bin_bytes])
    return b"".join(parts)


def _skin_wasm_path() -> pathlib.Path | None:
    configured = os.getenv("WORLD_SKIN_WASM_PATH", "").strip()
    path = pathlib.Path(configured) if configured else None
    return path if path and path.is_file() else None


def _skin_wasm_exports() -> dict[str, Any] | None:
    global _WASM_SKIN_INSTANCE
    if wasmtime is None:
        return None
    if _WASM_SKIN_INSTANCE is None:
        path = _skin_wasm_path()
        if path is None:
            return None
        store = wasmtime.Store()
        module = wasmtime.Module.from_file(store.engine, str(path))
        instance = wasmtime.Instance(store, module, [])
        _WASM_SKIN_INSTANCE = (store, instance)
    store, instance = _WASM_SKIN_INSTANCE
    exports = instance.exports(store)
    required = ("memory", "alloc_f32", "dealloc_f32", "alloc_u16", "dealloc_u16", "lock_skin_weights_region")
    if not all(name in exports for name in required):
        return None
    return {"store": store, **{name: exports[name] for name in required}}


def _accessor_layout(doc: dict[str, Any], accessor_index: int) -> dict[str, Any] | None:
    accessors = doc.get("accessors") if isinstance(doc.get("accessors"), list) else []
    views = doc.get("bufferViews") if isinstance(doc.get("bufferViews"), list) else []
    if accessor_index < 0 or accessor_index >= len(accessors):
        return None
    accessor = accessors[accessor_index]
    if not isinstance(accessor, dict) or "bufferView" not in accessor or "sparse" in accessor:
        return None
    view_index = int(accessor.get("bufferView") or 0)
    if view_index < 0 or view_index >= len(views):
        return None
    view = views[view_index]
    if not isinstance(view, dict) or int(view.get("buffer") or 0) != 0:
        return None
    component_type = int(accessor.get("componentType") or 0)
    component_size = {
        5121: 1,
        _GLTF_COMPONENT_UNSIGNED_SHORT: 2,
        _GLTF_COMPONENT_UNSIGNED_INT: 4,
        _GLTF_COMPONENT_FLOAT: 4,
    }.get(component_type)
    components = _GLTF_TYPE_COMPONENTS.get(str(accessor.get("type") or ""))
    count = int(accessor.get("count") or 0)
    if not component_size or not components or count <= 0:
        return None
    stride = int(view.get("byteStride") or component_size * components)
    offset = int(view.get("byteOffset") or 0) + int(accessor.get("byteOffset") or 0)
    return {
        "accessor": accessor,
        "component_type": component_type,
        "component_size": component_size,
        "components": components,
        "count": count,
        "normalized": bool(accessor.get("normalized")),
        "offset": offset,
        "stride": stride,
    }


def _read_accessor_values(binary: bytes | bytearray, layout: dict[str, Any]) -> list[list[float]]:
    values: list[list[float]] = []
    component_type = int(layout["component_type"])
    offset = int(layout["offset"])
    stride = int(layout["stride"])
    components = int(layout["components"])
    normalized = bool(layout["normalized"])
    for index in range(int(layout["count"])):
        row: list[float] = []
        base = offset + index * stride
        for component in range(components):
            cursor = base + component * int(layout["component_size"])
            if component_type == _GLTF_COMPONENT_FLOAT:
                value = struct.unpack_from("<f", binary, cursor)[0]
            elif component_type == _GLTF_COMPONENT_UNSIGNED_SHORT:
                raw = struct.unpack_from("<H", binary, cursor)[0]
                value = raw / 65535.0 if normalized else float(raw)
            elif component_type == _GLTF_COMPONENT_UNSIGNED_INT:
                value = float(struct.unpack_from("<I", binary, cursor)[0])
            elif component_type == 5121:
                raw = binary[cursor]
                value = raw / 255.0 if normalized else float(raw)
            else:
                raise ValueError("unsupported accessor component type")
            row.append(value)
        values.append(row)
    return values


def _write_joint_weight_accessors(
    binary: bytearray,
    joints_layout: dict[str, Any],
    weights_layout: dict[str, Any],
    joints: list[int],
    weights: list[float],
) -> None:
    for index in range(int(joints_layout["count"])):
        base = int(joints_layout["offset"]) + index * int(joints_layout["stride"])
        for component in range(4):
            cursor = base + component * int(joints_layout["component_size"])
            value = int(joints[index * 4 + component])
            if int(joints_layout["component_type"]) == 5121:
                if value > 255:
                    raise ValueError("joint index does not fit uint8 accessor")
                binary[cursor] = value
            elif int(joints_layout["component_type"]) == _GLTF_COMPONENT_UNSIGNED_SHORT:
                struct.pack_into("<H", binary, cursor, value)
            else:
                raise ValueError("unsupported JOINTS_0 component type")

    for index in range(int(weights_layout["count"])):
        base = int(weights_layout["offset"]) + index * int(weights_layout["stride"])
        for component in range(4):
            cursor = base + component * int(weights_layout["component_size"])
            value = max(0.0, min(1.0, float(weights[index * 4 + component])))
            if int(weights_layout["component_type"]) == _GLTF_COMPONENT_FLOAT:
                struct.pack_into("<f", binary, cursor, value)
            elif int(weights_layout["component_type"]) == 5121:
                binary[cursor] = int(round(value * 255.0))
            elif int(weights_layout["component_type"]) == _GLTF_COMPONENT_UNSIGNED_SHORT:
                struct.pack_into("<H", binary, cursor, int(round(value * 65535.0)))
            else:
                raise ValueError("unsupported WEIGHTS_0 component type")


def _head_joint_index(doc: dict[str, Any], skin_index: int) -> int:
    skins = doc.get("skins") if isinstance(doc.get("skins"), list) else []
    nodes = doc.get("nodes") if isinstance(doc.get("nodes"), list) else []
    if skin_index < 0 or skin_index >= len(skins):
        return -1
    skin = skins[skin_index]
    joints = skin.get("joints") if isinstance(skin, dict) and isinstance(skin.get("joints"), list) else []
    candidates: list[tuple[int, str]] = []
    for joint_index, node_index in enumerate(joints):
        try:
            node = nodes[int(node_index)]
        except Exception:
            continue
        name = _first_text(node.get("name") if isinstance(node, dict) else "").lower()
        if name:
            candidates.append((joint_index, name))
    for joint_index, name in candidates:
        if name == "head" or name.endswith("head"):
            return joint_index
    for joint_index, name in candidates:
        if "head" in name:
            return joint_index
    return -1


def _face_region_from_positions(positions: list[list[float]], mode: str = "normal") -> tuple[float, float, float, float, float, float] | None:
    if not positions:
        return None
    xs = [row[0] for row in positions if len(row) >= 3]
    ys = [row[1] for row in positions if len(row) >= 3]
    zs = [row[2] for row in positions if len(row) >= 3]
    if not xs or not ys or not zs:
        return None
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    min_z, max_z = min(zs), max(zs)
    size_x = max_x - min_x
    size_y = max_y - min_y
    size_z = max_z - min_z
    if size_x <= 0 or size_y <= 0 or size_z <= 0:
        return None
    center_x = (min_x + max_x) * 0.5
    strict = mode == "strict"
    min_y_ratio = _FACE_LOCK_STRICT_MIN_Y_RATIO if strict else _FACE_LOCK_MIN_Y_RATIO
    min_z_ratio = _FACE_LOCK_STRICT_MIN_Z_RATIO if strict else _FACE_LOCK_MIN_Z_RATIO
    half_width = size_x * (_FACE_LOCK_STRICT_HALF_WIDTH_RATIO if strict else _FACE_LOCK_HALF_WIDTH_RATIO)
    return (
        center_x - half_width,
        center_x + half_width,
        min_y + size_y * min_y_ratio,
        max_y,
        min_z + size_z * min_z_ratio,
        max_z,
    )


def _wasm_lock_skin_region(
    positions: list[list[float]],
    joints: list[int],
    weights: list[float],
    target_joint: int,
    region: tuple[float, float, float, float, float, float],
) -> tuple[int, list[int], list[float]]:
    exports = _skin_wasm_exports()
    if exports is None:
        return 0, joints, weights
    store = exports["store"]
    memory = exports["memory"]
    count = len(positions)
    flat_positions = [float(value) for row in positions for value in row[:3]]
    positions_bytes = struct.pack(f"<{len(flat_positions)}f", *flat_positions)
    joints_bytes = struct.pack(f"<{len(joints)}H", *[int(value) for value in joints])
    weights_bytes = struct.pack(f"<{len(weights)}f", *[float(value) for value in weights])
    pos_ptr = exports["alloc_f32"](store, len(flat_positions))
    joints_ptr = exports["alloc_u16"](store, len(joints))
    weights_ptr = exports["alloc_f32"](store, len(weights))
    try:
        memory.write(store, positions_bytes, pos_ptr)
        memory.write(store, joints_bytes, joints_ptr)
        memory.write(store, weights_bytes, weights_ptr)
        changed = int(exports["lock_skin_weights_region"](
            store,
            count,
            pos_ptr,
            joints_ptr,
            weights_ptr,
            int(target_joint),
            *region,
        ))
        if changed <= 0:
            return 0, joints, weights
        next_joints = list(struct.unpack(f"<{len(joints)}H", memory.read(store, joints_ptr, joints_ptr + len(joints_bytes))))
        next_weights = list(struct.unpack(f"<{len(weights)}f", memory.read(store, weights_ptr, weights_ptr + len(weights_bytes))))
        return changed, next_joints, next_weights
    finally:
        exports["dealloc_f32"](store, pos_ptr, len(flat_positions))
        exports["dealloc_u16"](store, joints_ptr, len(joints))
        exports["dealloc_f32"](store, weights_ptr, len(weights))


def _postprocess_glb_face_lock(data: bytes, mode: str = "normal") -> tuple[bytes, dict[str, Any]]:
    doc, binary = _parse_glb(data)
    target_binary = bytearray(binary)
    meshes = doc.get("meshes") if isinstance(doc.get("meshes"), list) else []
    nodes = doc.get("nodes") if isinstance(doc.get("nodes"), list) else []
    changed_total = 0
    mesh_count = 0

    for node in nodes:
        if not isinstance(node, dict) or "mesh" not in node or "skin" not in node:
            continue
        mesh_index = int(node.get("mesh") or 0)
        skin_index = int(node.get("skin") or 0)
        if mesh_index < 0 or mesh_index >= len(meshes):
            continue
        head_joint = _head_joint_index(doc, skin_index)
        if head_joint < 0:
            continue
        mesh = meshes[mesh_index]
        primitives = mesh.get("primitives") if isinstance(mesh, dict) and isinstance(mesh.get("primitives"), list) else []
        for primitive in primitives:
            attributes = primitive.get("attributes") if isinstance(primitive, dict) and isinstance(primitive.get("attributes"), dict) else {}
            if not {"POSITION", "JOINTS_0", "WEIGHTS_0"}.issubset(attributes):
                continue
            positions_layout = _accessor_layout(doc, int(attributes["POSITION"]))
            joints_layout = _accessor_layout(doc, int(attributes["JOINTS_0"]))
            weights_layout = _accessor_layout(doc, int(attributes["WEIGHTS_0"]))
            if not positions_layout or not joints_layout or not weights_layout:
                continue
            if int(positions_layout["component_type"]) != _GLTF_COMPONENT_FLOAT or int(positions_layout["components"]) < 3:
                continue
            if int(joints_layout["components"]) < 4 or int(weights_layout["components"]) < 4:
                continue
            if int(joints_layout["count"]) != int(positions_layout["count"]) or int(weights_layout["count"]) != int(positions_layout["count"]):
                continue
            positions = _read_accessor_values(target_binary, positions_layout)
            region = _face_region_from_positions(positions, mode)
            if region is None:
                continue
            joints_rows = _read_accessor_values(target_binary, joints_layout)
            weights_rows = _read_accessor_values(target_binary, weights_layout)
            joints = [int(value) for row in joints_rows for value in row[:4]]
            weights = [float(value) for row in weights_rows for value in row[:4]]
            changed, next_joints, next_weights = _wasm_lock_skin_region(positions, joints, weights, head_joint, region)
            if changed <= 0:
                continue
            _write_joint_weight_accessors(target_binary, joints_layout, weights_layout, next_joints, next_weights)
            changed_total += changed
            mesh_count += 1

    if changed_total <= 0:
        return data, {"enabled": True, "mode": mode, "status": "no_change", "changed_vertices": 0, "meshes": 0}
    return _build_glb(doc, bytes(target_binary)), {
        "enabled": True,
        "mode": mode,
        "status": "applied",
        "changed_vertices": changed_total,
        "meshes": mesh_count,
    }


def _should_lock_face_weights(settings: dict[str, str], body: dict[str, Any]) -> bool:
    requested = body.get("lock_face_weights")
    if requested is not None:
        return _truthy(requested)
    return _truthy(_setting(settings, "world_meshy_lock_face_weights", "MESHY_LOCK_FACE_WEIGHTS", "true"), True)


def _face_lock_mode(settings: dict[str, str], body: dict[str, Any]) -> str:
    mode = _first_text(body.get("face_lock_mode") or _setting(settings, "world_meshy_face_lock_mode", "MESHY_FACE_LOCK_MODE", "strict")).lower()
    return mode if mode in {"normal", "strict"} else "strict"


def _postprocess_and_upload_face_locked_model(
    *,
    settings: dict[str, str],
    model_url: str,
    mode: str,
    timeout: int,
) -> dict[str, Any]:
    content, mime = _fetch_model_bytes(model_url, timeout=min(max(timeout, 30), 180))
    if _model_mime_from_url(model_url, mime) != "model/gltf-binary":
        return {"status": "skipped", "reason": "not_glb"}
    processed, face_lock = _postprocess_glb_face_lock(content, mode)
    if face_lock.get("status") != "applied":
        return face_lock
    uploaded = _upload_to_s3(processed, "model/gltf-binary", "world-model", settings)
    return {
        **face_lock,
        "model_url": _first_text(uploaded.get("url")),
        "stored_model_url": _first_text(uploaded.get("url")),
        "stored_model_bucket": uploaded.get("bucket") or "",
        "stored_model_key": uploaded.get("key") or "",
        "stored_model_mime_type": uploaded.get("mime_type") or "model/gltf-binary",
        "stored_model_size": len(processed),
    }


from src.services.animation_glb import _copy_animation_accessor


def _node_index_map(source_doc: dict[str, Any], target_doc: dict[str, Any]) -> dict[int, int]:
    source_nodes = source_doc.get("nodes") if isinstance(source_doc.get("nodes"), list) else []
    target_nodes = target_doc.get("nodes") if isinstance(target_doc.get("nodes"), list) else []
    target_by_name: dict[str, int] = {}
    for index, node in enumerate(target_nodes):
        if isinstance(node, dict):
            name = _first_text(node.get("name"))
            if name and name not in target_by_name:
                target_by_name[name] = index
    mapping: dict[int, int] = {}
    for index, node in enumerate(source_nodes):
        source_name = _first_text(node.get("name") if isinstance(node, dict) else "")
        if source_name and source_name in target_by_name:
            mapping[index] = target_by_name[source_name]
        elif index < len(target_nodes):
            mapping[index] = index
    return mapping


def _combine_glb_animations(base_glb: bytes, animation_sources: list[dict[str, Any]]) -> tuple[bytes, list[dict[str, Any]]]:
    base_doc, base_binary = _parse_glb(base_glb)
    target_binary = bytearray(base_binary)
    if not isinstance(base_doc.get("buffers"), list) or not base_doc["buffers"]:
        base_doc["buffers"] = [{"byteLength": len(target_binary)}]
    base_doc["buffers"] = [base_doc["buffers"][0]]
    base_doc["buffers"][0].pop("uri", None)
    merged: list[dict[str, Any]] = []
    target_animations = base_doc.setdefault("animations", [])
    if not isinstance(target_animations, list):
        target_animations = []
        base_doc["animations"] = target_animations

    for source in animation_sources:
        model_url = _first_text(source.get("model_url") or source.get("glb_url") or source.get("url") or source.get("animation_url"))
        content = source.get("content")
        if not model_url or not isinstance(content, (bytes, bytearray)):
            continue
        try:
            source_doc, source_binary = _parse_glb(bytes(content))
            source_animations = source_doc.get("animations") if isinstance(source_doc.get("animations"), list) else []
            if not source_animations:
                continue
            node_map = _node_index_map(source_doc, base_doc)
            buffer_view_map: dict[int, int] = {}
            accessor_map: dict[int, int] = {}
            canonical_name = _first_text(source.get("canonical_name")) or _first_text(source.get("name")) or f"clip_{len(target_animations) + 1}"
            source_name = _first_text(source.get("source_name") or source.get("name"))
            animation = deepcopy(source_animations[0])
            if not isinstance(animation, dict):
                continue
            animation["name"] = canonical_name
            extras = animation.get("extras") if isinstance(animation.get("extras"), dict) else {}
            animation["extras"] = {
                **extras,
                "canonicalName": canonical_name,
                "sourceName": source_name or animation.get("name") or canonical_name,
                "sourceUrl": model_url,
                **({"actionId": int(source["action_id"])} if source.get("action_id") is not None else {}),
            }
            samplers = animation.get("samplers") if isinstance(animation.get("samplers"), list) else []
            for sampler in samplers:
                if not isinstance(sampler, dict):
                    continue
                if "input" in sampler:
                    sampler["input"] = _copy_animation_accessor(
                        source_doc=source_doc,
                        target_doc=base_doc,
                        source_binary=source_binary,
                        target_binary=target_binary,
                        source_accessor_index=int(sampler["input"]),
                        buffer_view_map=buffer_view_map,
                        accessor_map=accessor_map,
                    )
                if "output" in sampler:
                    sampler["output"] = _copy_animation_accessor(
                        source_doc=source_doc,
                        target_doc=base_doc,
                        source_binary=source_binary,
                        target_binary=target_binary,
                        source_accessor_index=int(sampler["output"]),
                        buffer_view_map=buffer_view_map,
                        accessor_map=accessor_map,
                    )
            channels = animation.get("channels") if isinstance(animation.get("channels"), list) else []
            kept_channels = []
            for channel in channels:
                if not isinstance(channel, dict):
                    continue
                target = channel.get("target")
                if not isinstance(target, dict) or "node" not in target:
                    kept_channels.append(channel)
                    continue
                source_node = int(target["node"])
                if source_node not in node_map:
                    continue
                target["node"] = node_map[source_node]
                kept_channels.append(channel)
            if not kept_channels:
                continue
            animation["channels"] = kept_channels
            target_animations.append(animation)
            merged.append({
                "canonical_name": canonical_name,
                "name": canonical_name,
                "source_name": source_name,
                "model_url": model_url,
                **({"action_id": int(source["action_id"])} if source.get("action_id") is not None else {}),
            })
        except Exception as e:
            logger.warning("animation GLB merge skipped: url=%s error=%s", redact_url(model_url), e)

    base_doc["buffers"][0]["byteLength"] = len(target_binary)
    if not merged:
        raise ValueError("no animation clips could be merged")
    return _build_glb(base_doc, bytes(target_binary)), merged


def _stored_model_bytes(metadata: dict[str, Any]) -> tuple[bytes, str] | None:
    bucket = str(metadata.get("stored_model_bucket") or "").strip()
    key = str(metadata.get("stored_model_key") or "").strip()
    if not bucket or not key:
        return None
    expected_bucket, region, prefix = _world_model_storage(_settings())
    if not expected_bucket or bucket != expected_bucket or not key.startswith(prefix) or ".." in key.split("/"):
        logger.warning("world stored model ignored: object is outside the world-model storage prefix")
        return None
    obj = _s3_client(region).get_object(Bucket=bucket, Key=key)
    body = obj.get("Body")
    content = body.read() if body is not None else b""
    if not content:
        raise RuntimeError("empty stored model object")
    mime = str(metadata.get("stored_model_mime_type") or obj.get("ContentType") or "model/gltf-binary")
    return content, _model_mime_from_url(key, mime)


def _stabilize_world_asset_model_url(item: dict[str, Any]) -> dict[str, Any]:
    model_url = (item.get("model_url") or "").strip()
    if not model_url or model_url.startswith("data:"):
        return item
    metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    if metadata.get("stored_model_url"):
        item["model_url"] = str(metadata["stored_model_url"])
        return item
    try:
        content, mime = _fetch_model_bytes(model_url)
        uploaded = _upload_to_s3(content, mime, "world-model", _settings())
        stable_url = uploaded.get("url") or ""
        if stable_url:
            metadata = {
                **metadata,
                "original_model_url": model_url,
                "stored_model_url": stable_url,
                "stored_model_bucket": uploaded.get("bucket") or "",
                "stored_model_key": uploaded.get("key") or "",
                "stored_model_mime_type": uploaded.get("mime_type") or mime,
                "stored_model_size": len(content),
            }
            item["model_url"] = stable_url
            item["metadata"] = metadata
    except Exception as e:
        logger.warning("world model stabilize skipped: url=%s error=%s", redact_url(model_url), e)
    return item


def _stabilize_animation_url(url: str) -> str:
    if not url or url.startswith("data:"):
        return url
    try:
        content, mime = _fetch_model_bytes(url)
        uploaded = _upload_to_s3(content, mime, "world-model", _settings())
        return str(uploaded.get("url") or url)
    except Exception as e:
        logger.warning("world animation stabilize skipped: url=%s error=%s", redact_url(url), e)
        return url


def _stabilize_world_asset_animation_urls(item: dict[str, Any]) -> dict[str, Any]:
    metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    rigging = metadata.get("rigging") if isinstance(metadata.get("rigging"), dict) else {}
    if not rigging:
        return item

    original_urls: dict[str, str] = {}
    clips = rigging.get("animation_clips") if isinstance(rigging.get("animation_clips"), list) else []
    for index, clip in enumerate(clips):
        if not isinstance(clip, dict):
            continue
        for key in ("model_url", "glb_url", "url", "animation_url"):
            url = str(clip.get(key) or "").strip()
            if not url:
                continue
            stable_url = _stabilize_animation_url(url)
            if stable_url != url:
                original_urls[f"animation_clips.{index}.{key}"] = url
                clip[key] = stable_url

    basic = rigging.get("basic_animations") if isinstance(rigging.get("basic_animations"), dict) else {}
    for key, value in list(basic.items()):
        url = str(value or "").strip()
        if not url or not key.endswith("_url"):
            continue
        stable_url = _stabilize_animation_url(url)
        if stable_url != url:
            original_urls[f"basic_animations.{key}"] = url
            basic[key] = stable_url

    if original_urls:
        rigging["original_animation_urls"] = {**(rigging.get("original_animation_urls") if isinstance(rigging.get("original_animation_urls"), dict) else {}), **original_urls}
        metadata["rigging"] = rigging
        item["metadata"] = metadata
    return item


def _refresh_world_asset_model_from_provider(asset_id: int, user_id: int, metadata: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    if metadata.get("provider") != "meshy":
        return "", metadata
    candidates: list[tuple[str, str]] = []
    rigging = metadata.get("rigging") if isinstance(metadata.get("rigging"), dict) else {}
    if rigging.get("task_id"):
        candidates.append(("/openapi/v1/rigging", str(rigging["task_id"])))
    source = str(metadata.get("source") or "").strip()
    task_id = str(metadata.get("task_id") or "").strip()
    if task_id:
        path = "/openapi/v1/image-to-3d" if source == "image-to-3d" else "/openapi/v2/text-to-3d"
        candidates.append((path, task_id))
    settings = _settings()
    for path, task_id in candidates:
        try:
            result = _wait_meshy_task(settings=settings, path=path, task_id=task_id, timeout=60)
            model_url = _meshy_model_url(result)
            if not model_url:
                continue
            item = _stabilize_world_asset_model_url({
                "model_url": model_url,
                "metadata": {
                    **metadata,
                    "refreshed_model_url": model_url,
                    "refreshed_model_task_id": task_id,
                    "refreshed_model_at": _now_ms(),
                },
            })
            refreshed_url = str(item.get("model_url") or "").strip()
            refreshed_metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else metadata
            if db.is_configured() and refreshed_url:
                try:
                    db.execute(
                        "UPDATE world_asset SET model_url=%s, metadata_json=%s WHERE id=%s AND user_id=%s",
                        (refreshed_url, _json(refreshed_metadata), asset_id, int(user_id)),
                    )
                except Exception as e:
                    logger.warning("world_asset refreshed model update failed: asset_id=%s error=%s", asset_id, e)
            return refreshed_url, refreshed_metadata
        except Exception as e:
            logger.warning("world_asset provider refresh failed: asset_id=%s path=%s task_id=%s error=%s", asset_id, path, task_id, e)
    return "", metadata


def _safe_int(value: Any, default: int, min_value: int = 0, max_value: int = 100000) -> int:
    try:
        parsed = int(value)
    except Exception:
        return default
    return max(min_value, min(parsed, max_value))


def _safe_float(value: Any, default: float, min_value: float = 0.0, max_value: float = 100000.0) -> float:
    try:
        parsed = float(value)
    except Exception:
        return default
    return max(min_value, min(parsed, max_value))


def _vector(x: float, y: float = 0.0, z: float = 0.0) -> dict[str, float]:
    return {"x": float(x), "y": float(y), "z": float(z)}


def _tile(tile_id: str, x: float, z: float, *, size: float = 2.0, object_type: str = "none") -> dict[str, Any]:
    return {
        "id": tile_id,
        "position": _vector(x, 0, z),
        "size": size,
        "material_id": "signight-floor",
        "object_type": object_type,
    }


def _wall(wall_id: str, x: float, z: float, rot_y: float = 0.0) -> dict[str, Any]:
    return {
        "id": wall_id,
        "position": _vector(x, 1, z),
        "rotation": _vector(0, rot_y, 0),
        "width": 2,
        "height": 2.2,
        "depth": 0.22,
        "material_id": "signight-wall",
    }


def _default_world_props(title: str, kind: str) -> list[dict[str, Any]]:
    props = [
        {"id": "signight-title-board", "kind": "sign", "position": _vector(0, 0.1, -5), "label": title, "color": "#111827"},
        {"id": "signight-night-light", "kind": "fire", "position": _vector(-4, 0, -1.5), "label": "기록의 빛", "color": "#f6c96d"},
        {"id": "signight-archive-marker", "kind": "prop", "position": _vector(4, 0, 1.5), "label": "오늘의 장면", "color": "#9bd3c7"},
    ]
    if kind in {"pet", "npc"}:
        props.append({"id": f"signight-{kind}-companion", "kind": kind, "position": _vector(2, 0, -2), "label": "SIG 동료", "color": "#fde68a"})
    elif kind in {"prop", "tree"}:
        props.append({"id": f"signight-{kind}-object", "kind": "tree" if kind == "tree" else "prop", "position": _vector(-2, 0, 2), "label": "월드 오브젝트", "color": "#bbf7d0"})
    elif kind == "character":
        props.append({"id": "signight-character-marker", "kind": "npc", "position": _vector(0, 0, 2), "label": "대표 캐릭터", "color": "#bfdbfe"})
    return props


def compose_world_plan(body: dict[str, Any], provider_payload: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """프론트가 바로 적용할 수 있는 world plan JSON 을 만든다.

    외부 3D API가 반환한 `plan` 이 있으면 우선 사용하고, 없으면 요청값으로
    안정적인 기본 배치안을 만든다. 텍스트 생성 프롬프트는 이 함수에 두지 않는다.
    """
    provider_payload = provider_payload or {}
    provider_plan = provider_payload.get("plan")
    if isinstance(provider_plan, dict):
        return _normalize_plan(provider_plan, body)

    title = (body.get("title") or "").strip() or "시그 월드"
    sig_id = (body.get("sig_id") or "").strip()
    kind = (body.get("kind") or "house").strip()

    tiles: list[dict[str, Any]] = []
    for ix, x in enumerate(range(-6, 8, 2)):
        for iz, z in enumerate(range(-6, 8, 2)):
            object_type = "grass" if (ix + iz) % 3 == 0 else "none"
            tiles.append(_tile(f"tile-{ix}-{iz}", x, z, object_type=object_type))
    for idx, x in enumerate(range(-2, 4, 2)):
        tiles.append(_tile(f"house-floor-{idx}", x, -8, object_type="none"))

    walls = [
        _wall("house-wall-back-1", -2, -10),
        _wall("house-wall-back-2", 0, -10),
        _wall("house-wall-back-3", 2, -10),
        _wall("house-wall-left", -4, -8, 1.5708),
        _wall("house-wall-right", 4, -8, 1.5708),
    ]
    props = _default_world_props(title, kind)

    assets = _extract_provider_assets(provider_payload)
    return {
        "id": _job_id(),
        "title": title,
        "locale": "ko",
        "sig_id": sig_id,
        "tiles": tiles,
        "walls": walls,
        "props": props,
        "assets": assets,
        "edits": {
            "ko": {
                "title": title,
                "description": f"{title}: 타일 {len(tiles)}개, 벽 {len(walls)}개, 기물 {len(props)}개로 구성된 생성 배치안",
            }
        },
    }


def _normalize_plan(plan: dict[str, Any], request_body: dict[str, Any]) -> dict[str, Any]:
    title = (plan.get("title") or request_body.get("title") or "시그 월드").strip()
    return {
        "id": str(plan.get("id") or _job_id()),
        "title": title,
        "locale": plan.get("locale") if plan.get("locale") in {"ko", "en", "ja"} else "ko",
        "sig_id": (plan.get("sig_id") or request_body.get("sig_id") or "").strip(),
        "tiles": plan.get("tiles") if isinstance(plan.get("tiles"), list) else [],
        "walls": plan.get("walls") if isinstance(plan.get("walls"), list) else [],
        "props": plan.get("props") if isinstance(plan.get("props"), list) else [],
        "assets": plan.get("assets") if isinstance(plan.get("assets"), list) else [],
        "edits": plan.get("edits") if isinstance(plan.get("edits"), dict) else {"ko": {"title": title, "description": ""}},
    }


def _extract_provider_assets(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_assets = payload.get("assets")
    if isinstance(raw_assets, list):
        return [a for a in raw_assets if isinstance(a, dict)]
    model_url = (payload.get("model_url") or payload.get("url") or "").strip()
    if not model_url:
        return []
    return [{
        "kind": (payload.get("kind") or "model").strip() or "model",
        "label": payload.get("label") or "generated model",
        "model_url": model_url,
        "thumbnail_url": payload.get("thumbnail_url") or "",
        "metadata": payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {},
    }]


def _call_provider(settings: dict[str, str], body: dict[str, Any], job_id: str) -> tuple[bool, dict[str, Any]]:
    provider = _setting(settings, "world_3d_provider", "WORLD_3D_PROVIDER", "").strip().lower()
    if provider == "meshy":
        if _first_text(body.get("workflow_step")).lower() == "rig":
            return _call_meshy_rig_provider(settings, body, job_id)
        return _call_meshy_provider(settings, body, job_id)

    url = _setting(settings, "world_3d_api_url", "WORLD_3D_API_URL", "")
    if not url:
        return False, {}
    timeout = _safe_int(_setting(settings, "world_3d_api_timeout_seconds", "WORLD_3D_API_TIMEOUT_SECONDS", "900"), 900, 5, 1800)
    token = _setting(settings, "world_3d_api_token", "WORLD_3D_API_TOKEN", "")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    payload = {
        "job_id": job_id,
        "kind": body.get("kind"),
        "prompt": body.get("prompt"),
        "title": body.get("title"),
        "sig_id": body.get("sig_id"),
        "source_image_asset_id": body.get("source_image_asset_id"),
        "reference_image_url": body.get("reference_image_url"),
        "reference_images": body.get("reference_images") or [],
        "texture_prompt": body.get("texture_prompt"),
        "rig_character": body.get("rig_character"),
        "target_polycount": body.get("target_polycount"),
        "topology": body.get("topology"),
        "decimation_mode": body.get("decimation_mode"),
    }
    response = httpx.post(url, headers=headers, json=payload, timeout=timeout)
    response.raise_for_status()
    data = response.json()
    return True, data if isinstance(data, dict) else {}


def _part_bundle_requested(body: dict[str, Any]) -> bool:
    if body.get("part_slot") or body.get("slot"):
        return False
    return _truthy(
        body.get("generate_part_bundle")
        or body.get("part_bundle")
        or body.get("auto_part_bundle")
        or body.get("generate_parts"),
        False,
    )


def _part_bundle_slots(body: dict[str, Any]) -> list[str]:
    raw = body.get("part_bundle_slots") or body.get("part_slots") or body.get("slots")
    values = raw if isinstance(raw, list) else _PART_BUNDLE_DEFAULT_SLOTS
    slots: list[str] = []
    for value in values:
        slot = _normalize_part_slot(value)
        if slot and slot not in slots:
            slots.append(slot)
    return slots or list(_PART_BUNDLE_DEFAULT_SLOTS)


def _part_bundle_prompt(base_prompt: str, slot: str) -> str:
    if slot in {"top", "bottom", "shoes"}:
        allowed_region = {
            "top": "torso clothing only: neck-to-waist garment surface, sleeves if present, no head, no legs below hips, no hands",
            "bottom": "lower-body clothing only: waist-to-ankle pants/skirt surface, no torso, no head, no shoes unless inseparable cuffs",
            "shoes": "footwear only: left and right shoes/boots at foot scale, no legs above ankles, no body",
        }.get(slot, f"{slot} clothing only")
        part_rule = (
            f"Create a separate swappable GLB for the {slot} slot only. "
            f"Allowed geometry: {allowed_region}. "
            "The output must be the isolated wearable mesh, not a full character and not a mannequin. "
            "Delete/hide all body skin, head, hair, face, hands, unrelated clothing, background, camera, lights, ground, and reference sheet panels. "
            "Same scale and origin as the base character, same forward direction, A-pose or T-pose, "
            "game-ready skinned mesh clothing part, GLB with embedded textures. "
            f"Name every mesh with prefix meshy_part_{slot}_ and include metadata part_slot={slot}."
        )
    else:
        socket = _PART_SLOT_DEFAULT_SOCKETS.get(slot) or ("rightHand" if slot == "weapon" else "back")
        allowed_region = {
            "hat": "headwear prop only, no head or hair",
            "face": "face accessory only, no full face/head",
            "glasses": "eyewear only, no face/head",
            "weapon": "single handheld weapon only, no hand/arm/body",
            "accessory": "single accessory prop only, no body",
        }.get(slot, f"{slot} prop only")
        part_rule = (
            f"Create a separate swappable GLB for the {slot} slot only. "
            f"Allowed geometry: {allowed_region}. "
            "The output must be one isolated prop/accessory, not a full character and not a mannequin. "
            "Delete/hide all body skin, head, hair, hands, unrelated clothing, background, camera, lights, ground, and reference sheet panels. "
            f"Standalone GLB, origin at the attachment point for socket {socket}, clean game-ready mesh, embedded textures. "
            f"Name every mesh with prefix meshy_part_{slot}_ and include metadata part_slot={slot}, attachment_socket={socket}."
        )
    return f"{base_prompt}. {part_rule}"[:1200]


def _part_bundle_retry_prompt(base_prompt: str, slot: str, reasons: list[str]) -> str:
    reason_text = "; ".join(reasons[:4]) or "previous output was not an isolated slot part"
    return (
        f"{_part_bundle_prompt(base_prompt, slot)} "
        "Regenerate from scratch as a strict correction pass. "
        f"The previous attempt failed validation because: {reason_text}. "
        "Do not reuse the failed mesh. Do not output a full character. "
        "Output only the single requested slot geometry, with every unrelated body/clothing part removed. "
        "If the reference is ambiguous, prefer a smaller isolated asset over a complete body."
    )[:1400]


def _part_bundle_slot_references(body: dict[str, Any], reference_sheet_url: str, slot: str) -> list[dict[str, Any]]:
    references = [
        {
            **item,
            "role": "part_reference",
            "part_slot": slot,
        }
        for item in (body.get("reference_images") or [])
        if isinstance(item, dict)
    ]
    if reference_sheet_url:
        references.insert(0, {
            "url": reference_sheet_url,
            "role": "part_sheet_reference",
            "part_slot": slot,
            "part_bundle": True,
        })
    if not references and body.get("reference_image_url"):
        references = [{
            "url": body.get("reference_image_url"),
            "role": "part_reference",
            "part_slot": slot,
        }]
    return references


def _asset_reference_image_url(asset: dict[str, Any]) -> str:
    metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
    thumbnail_urls = metadata.get("thumbnail_urls") if isinstance(metadata.get("thumbnail_urls"), dict) else {}
    return _first_text(
        asset.get("thumbnail_url")
        or metadata.get("thumbnail_url")
        or thumbnail_urls.get("front")
        or metadata.get("preview_url")
        or metadata.get("rendered_image")
    )


def _base_generated_references(assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
        if metadata.get("part_bundle_role") != "base_character":
            continue
        image_url = _asset_reference_image_url(asset)
        if image_url:
            refs.append({
                "url": image_url,
                "role": "generated_base_character_reference",
                "source": "base_character_thumbnail",
                "part_bundle": True,
            })
    return refs


def _body_with_extra_reference_images(body: dict[str, Any], refs: list[dict[str, Any]]) -> dict[str, Any]:
    if not refs:
        return body
    existing = [item for item in (body.get("reference_images") or []) if isinstance(item, dict)]
    return {
        **body,
        "reference_images": [*refs, *existing],
    }


def _part_bundle_reference_sheet_enabled(settings: dict[str, str], body: dict[str, Any]) -> bool:
    explicit = body.get("pre_generate_part_sheet")
    if explicit is None:
        explicit = body.get("generate_part_reference_sheet")
    if explicit is not None:
        return _truthy(explicit, False)
    default_value = _setting(
        settings,
        "world_part_bundle_pre_generate_reference_sheet",
        "WORLD_PART_BUNDLE_PRE_GENERATE_REFERENCE_SHEET",
        "true",
    )
    return _truthy(default_value, True)


def _part_bundle_reference_sheet_prompt(label: str, base_prompt: str, slots: list[str]) -> str:
    slot_list = ", ".join(slots)
    return (
        f"Create a clean front-facing character parts reference sheet for '{label}'. "
        f"Use the provided full character image as the style and proportion reference. "
        f"Separate and label these slots: {slot_list}. "
        "Each slot must show only that isolated part on its own transparent-looking cell; do not duplicate the full character inside any slot cell. "
        "For clothing cells, show just the wearable garment surface aligned to A-pose or T-pose, with body/mannequin removed. "
        "For prop cells, show only the prop with its attachment point. "
        "Each part must be readable, same character scale, same forward direction, "
        "no perspective distortion, no full scene, "
        "plain light background, high contrast edges, game asset production sheet. "
        f"Base character description: {base_prompt}"
    )[:1400]


def _generate_part_reference_sheet(
    settings: dict[str, str],
    body: dict[str, Any],
    job_id: str,
    slots: list[str],
    label: str,
    base_prompt: str,
) -> dict[str, Any]:
    refs = collect_reference_images(body, default_role="character_reference")
    if not _part_bundle_reference_sheet_enabled(settings, body):
        return {"enabled": False, "status": "skipped", "reason": "disabled_or_no_reference", "slots": slots}

    _set_job_progress(
        job_id,
        step="part-bundle:reference-sheet",
        message="Character part reference sheet pre-generation",
        extra={"slots": slots, "reference_count": len(refs)},
    )
    prompt = _part_bundle_reference_sheet_prompt(label, base_prompt, slots)
    sheet_body = {
        **body,
        "aspect_ratio": body.get("part_sheet_aspect_ratio") or body.get("aspect_ratio") or "1:1",
        "image_size": body.get("part_sheet_image_size") or body.get("image_size") or "1024x1024",
    }
    return generate_reference_image(
        settings=settings,
        prompt=prompt,
        body=sheet_body,
        user_id=int(body.get("_user_id") or 0),
        usage_session="world_part_bundle_reference_sheet",
        media_kind="part-reference-sheet",
        reference_images=refs,
        model_keys=("part_sheet_image_model", "reference_sheet_image_model", "image_model"),
        default_size="1024x1024",
        default_aspect_ratio="1:1",
        result_extra={"slots": slots},
    )


def _part_bundle_manifest(
    *,
    label: str,
    base_prompt: str,
    slots: list[str],
    reference_sheet: dict[str, Any],
) -> dict[str, Any]:
    return {
        "label": label,
        "source_prompt": base_prompt,
        "slots": [
            {
                "slot": slot,
                "mode": "skinned" if slot in {"top", "bottom", "shoes"} else "attachment",
                "attachment_socket": _PART_SLOT_DEFAULT_SOCKETS.get(slot) or ("rightHand" if slot == "weapon" else ""),
                "prompt": _part_bundle_prompt(base_prompt, slot),
            }
            for slot in slots
        ],
        "reference_sheet": {
            key: value
            for key, value in reference_sheet.items()
            if key not in {"data_url", "prompt"}
        },
        "output_contract": {
            "runtime_format": "glb",
            "origin_policy": "same-origin-same-scale-same-forward",
            "requires_slot_metadata": True,
            "requires_validation": True,
        },
    }


def _combine_bbox(current: dict[str, list[float]] | None, mn: list[float], mx: list[float]) -> dict[str, list[float]]:
    if current is None:
        return {"min": [float(v) for v in mn[:3]], "max": [float(v) for v in mx[:3]]}
    current["min"] = [min(float(current["min"][i]), float(mn[i])) for i in range(3)]
    current["max"] = [max(float(current["max"][i]), float(mx[i])) for i in range(3)]
    return current


def _glb_bbox_from_doc(doc: dict[str, Any], binary: bytes) -> dict[str, Any] | None:
    meshes = doc.get("meshes") if isinstance(doc.get("meshes"), list) else []
    accessors = doc.get("accessors") if isinstance(doc.get("accessors"), list) else []
    bbox: dict[str, list[float]] | None = None
    vertex_count = 0
    mesh_count = 0
    decoded_count = 0
    for mesh in meshes:
        if not isinstance(mesh, dict):
            continue
        primitives = mesh.get("primitives") if isinstance(mesh.get("primitives"), list) else []
        for primitive in primitives:
            attrs = primitive.get("attributes") if isinstance(primitive, dict) else {}
            if not isinstance(attrs, dict) or "POSITION" not in attrs:
                continue
            try:
                accessor_index = int(attrs.get("POSITION"))
            except Exception:
                continue
            if accessor_index < 0 or accessor_index >= len(accessors):
                continue
            accessor = accessors[accessor_index]
            if not isinstance(accessor, dict):
                continue
            mn = accessor.get("min") if isinstance(accessor.get("min"), list) else None
            mx = accessor.get("max") if isinstance(accessor.get("max"), list) else None
            if mn and mx and len(mn) >= 3 and len(mx) >= 3:
                bbox = _combine_bbox(bbox, [float(v) for v in mn[:3]], [float(v) for v in mx[:3]])
                vertex_count += int(accessor.get("count") or 0)
                mesh_count += 1
                continue
            layout = _accessor_layout(doc, accessor_index)
            if layout is None:
                continue
            values = _read_accessor_values(binary, layout)
            if not values:
                continue
            mins = [min(row[i] for row in values if len(row) > i) for i in range(3)]
            maxs = [max(row[i] for row in values if len(row) > i) for i in range(3)]
            bbox = _combine_bbox(bbox, mins, maxs)
            vertex_count += len(values)
            decoded_count += len(values)
            mesh_count += 1
    if bbox is None:
        return None
    size = [float(bbox["max"][i]) - float(bbox["min"][i]) for i in range(3)]
    center = [(float(bbox["max"][i]) + float(bbox["min"][i])) / 2.0 for i in range(3)]
    return {
        "min": bbox["min"],
        "max": bbox["max"],
        "size": size,
        "center": center,
        "vertex_count": vertex_count,
        "mesh_count": mesh_count,
        "decoded_vertex_count": decoded_count,
    }


def _asset_model_url(asset: dict[str, Any]) -> str:
    metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
    return _first_text(
        asset.get("model_url")
        or asset.get("url")
        or asset.get("preview_url")
        or metadata.get("model_url")
        or metadata.get("url")
    )


def _inspect_asset_glb_bbox(asset: dict[str, Any]) -> dict[str, Any] | None:
    model_url = _asset_model_url(asset)
    if not model_url or _runtime_format_from_model_url(model_url) != "glb":
        return None
    content, mime_type = _fetch_model_bytes(model_url, timeout=60)
    if _model_mime_from_url(model_url, mime_type) != "model/gltf-binary":
        return None
    doc, binary = _parse_glb(content)
    bbox = _glb_bbox_from_doc(doc, binary)
    if bbox is not None:
        bbox["url"] = redact_url(model_url)
    return bbox


def _part_bundle_validation_status(checks: list[dict[str, Any]], warnings: list[str]) -> str:
    if any(check.get("status") == "failed" for check in checks):
        return "failed"
    if warnings or any(check.get("status") == "warning" for check in checks):
        return "warning"
    return "passed"


def _part_bundle_size_limits(slot: str) -> dict[str, float]:
    limits = {
        "top": {"height_ratio": 0.78, "width_ratio": 1.15, "depth_ratio": 1.25, "max_ratio": 1.15},
        "bottom": {"height_ratio": 0.70, "width_ratio": 1.15, "depth_ratio": 1.25, "max_ratio": 1.15},
        "shoes": {"height_ratio": 0.35, "width_ratio": 1.20, "depth_ratio": 1.45, "max_ratio": 0.55},
        "hat": {"height_ratio": 0.35, "width_ratio": 0.85, "depth_ratio": 0.85, "max_ratio": 0.60},
        "face": {"height_ratio": 0.30, "width_ratio": 0.70, "depth_ratio": 0.70, "max_ratio": 0.45},
        "glasses": {"height_ratio": 0.22, "width_ratio": 0.75, "depth_ratio": 0.55, "max_ratio": 0.40},
        "weapon": {"height_ratio": 1.20, "width_ratio": 1.20, "depth_ratio": 1.20, "max_ratio": 1.20},
        "accessory": {"height_ratio": 0.75, "width_ratio": 1.00, "depth_ratio": 1.00, "max_ratio": 0.90},
    }
    return limits.get(slot, {"height_ratio": 0.80, "width_ratio": 1.10, "depth_ratio": 1.10, "max_ratio": 1.00})


def _validate_part_bundle_asset(
    asset: dict[str, Any],
    slot: str,
    base_bbox: dict[str, Any] | None,
) -> dict[str, Any]:
    metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
    contract = metadata.get("output_contract") if isinstance(metadata.get("output_contract"), dict) else {}
    model_url = _asset_model_url(asset)
    runtime_format = _runtime_format_from_model_url(model_url)
    checks: list[dict[str, Any]] = []
    warnings: list[str] = []
    checks.append({"name": "runtime_format_glb", "status": "passed" if runtime_format == "glb" else "failed", "value": runtime_format})
    checks.append({"name": "model_url_present", "status": "passed" if bool(model_url) else "failed"})
    effective_slot = _normalize_part_slot(asset.get("part_slot") or asset.get("slot") or metadata.get("part_slot") or metadata.get("slot"))
    checks.append({"name": "part_slot_metadata", "status": "passed" if effective_slot == slot else "failed", "expected": slot, "value": effective_slot})
    origin_policy = _first_text(contract.get("origin_policy"))
    checks.append({
        "name": "origin_policy",
        "status": "passed" if origin_policy == "same-origin-same-scale-same-forward" else "warning",
        "value": origin_policy,
    })

    bbox = None
    if model_url and runtime_format == "glb":
        try:
            bbox = _inspect_asset_glb_bbox(asset)
        except Exception as e:
            warnings.append(f"glb_bbox_inspection_failed: {e}")
    checks.append({"name": "bbox_present", "status": "passed" if bbox else "warning"})
    if bbox:
        size = bbox.get("size") if isinstance(bbox.get("size"), list) else [0, 0, 0]
        max_size = max([float(value or 0) for value in size] or [0])
        min_positive = min([float(value or 0) for value in size if float(value or 0) > 0] or [0])
        bbox_status = "passed" if max_size > 0 and min_positive > 0 else "failed"
        checks.append({"name": "bbox_nonzero_size", "status": bbox_status, "size": size})
        if max_size > 12:
            warnings.append(f"bbox_size_unusually_large: {max_size:.3f}")
        if base_bbox:
            base_size = base_bbox.get("size") if isinstance(base_bbox.get("size"), list) else []
            base_max = max([float(value or 0) for value in base_size] or [0])
            part_size = [float(value or 0) for value in size[:3]]
            base_xyz = [float(value or 0) for value in base_size[:3]]
            limits = _part_bundle_size_limits(slot)
            if base_max > 0:
                max_ratio = max_size / base_max
                max_status = "passed" if max_ratio <= limits["max_ratio"] else "failed"
                checks.append({"name": "slot_max_size_ratio", "status": max_status, "value": round(max_ratio, 3), "limit": limits["max_ratio"]})
                if max_status == "failed":
                    warnings.append(f"part_too_large_for_slot_max_ratio: {max_ratio:.3f}")
            if len(part_size) >= 3 and len(base_xyz) >= 3 and all(value > 0 for value in base_xyz):
                axis_ratios = {
                    "width": part_size[0] / base_xyz[0],
                    "height": part_size[1] / base_xyz[1],
                    "depth": part_size[2] / base_xyz[2],
                }
                checks.append({
                    "name": "slot_axis_size_ratio",
                    "status": "passed"
                    if axis_ratios["width"] <= limits["width_ratio"]
                    and axis_ratios["height"] <= limits["height_ratio"]
                    and axis_ratios["depth"] <= limits["depth_ratio"]
                    else "failed",
                    "value": {key: round(value, 3) for key, value in axis_ratios.items()},
                    "limit": limits,
                })
                if any(
                    axis_ratios[key] > limits[f"{key}_ratio"]
                    for key in ("width", "height", "depth")
                ):
                    warnings.append(
                        "part_axis_ratio_exceeds_slot_limit: "
                        + ", ".join(f"{key}={value:.3f}" for key, value in axis_ratios.items())
                    )
                if slot in {"top", "bottom", "shoes", "hat", "face", "glasses"} and axis_ratios["height"] >= 0.88:
                    checks.append({"name": "full_body_overlap_guard", "status": "failed", "height_ratio": round(axis_ratios["height"], 3)})
                    warnings.append(f"part_looks_like_full_body_height_ratio: {axis_ratios['height']:.3f}")
    return {
        "slot": slot,
        "status": _part_bundle_validation_status(checks, warnings),
        "checks": checks,
        "warnings": warnings,
        "bbox": bbox,
    }


def _validate_part_bundle_assets(assets: list[dict[str, Any]], slots: list[str]) -> dict[str, Any]:
    base_asset = next(
        (
            asset
            for asset in assets
            if isinstance(asset, dict)
            and (
                (asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}).get("part_bundle_role")
                == "base_character"
            )
        ),
        None,
    )
    base_bbox = None
    if isinstance(base_asset, dict):
        try:
            base_bbox = _inspect_asset_glb_bbox(base_asset)
        except Exception as e:
            metadata = base_asset.get("metadata") if isinstance(base_asset.get("metadata"), dict) else {}
            base_asset["metadata"] = {**metadata, "validation": {"status": "warning", "warnings": [f"base_bbox_inspection_failed: {e}"]}}

    per_asset: list[dict[str, Any]] = []
    generated_slots: set[str] = set()
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        slot = _normalize_part_slot(asset.get("part_slot") or asset.get("slot"))
        if not slot:
            metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
            if metadata.get("part_bundle_role") == "base_character":
                asset["metadata"] = {
                    **metadata,
                    "validation": {
                        "role": "base_character",
                        "status": "passed" if base_bbox else "warning",
                        "bbox": base_bbox,
                        "warnings": [] if base_bbox else ["base_bbox_not_available"],
                    },
                }
            continue
        generated_slots.add(slot)
        validation = _validate_part_bundle_asset(asset, slot, base_bbox)
        metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
        asset["metadata"] = {
            **metadata,
            "validation": validation,
            "normalization": {
                "status": "metadata_and_bbox_checked",
                "origin_policy": "same-origin-same-scale-same-forward",
                "bbox": validation.get("bbox"),
                "requires_blender_review": validation.get("status") != "passed",
            },
        }
        per_asset.append(validation)

    missing_slots = [slot for slot in slots if slot not in generated_slots]
    passed_slots = {
        _normalize_part_slot(item.get("slot"))
        for item in per_asset
        if item.get("status") == "passed" and _normalize_part_slot(item.get("slot"))
    }
    unresolved_items = [
        item
        for item in per_asset
        if _normalize_part_slot(item.get("slot")) not in passed_slots
    ]
    failed = [item for item in unresolved_items if item.get("status") == "failed"]
    warning = [item for item in unresolved_items if item.get("status") == "warning"]
    status = "failed" if failed or missing_slots else "warning" if warning else "passed"
    return {
        "status": status,
        "expected_slots": slots,
        "generated_slots": sorted(generated_slots),
        "passed_slots": sorted(passed_slots),
        "missing_slots": missing_slots,
        "base_bbox": base_bbox,
        "assets": per_asset,
        "summary": {
            "passed": len([item for item in per_asset if item.get("status") == "passed"]),
            "warning": len(warning),
            "failed": len(failed),
            "missing": len(missing_slots),
        },
    }


def _call_part_bundle_provider(settings: dict[str, str], body: dict[str, Any], job_id: str) -> tuple[bool, dict[str, Any]]:
    kind = _first_text(body.get("kind") or "character")
    label = _first_text(body.get("title") or body.get("label") or "character parts")
    slots = _part_bundle_slots(body)
    assets: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    provider_configured = False
    base_prompt = _first_text(body.get("prompt") or label or "character reference")
    base_payload: dict[str, Any] = {}
    reference_sheet = _generate_part_reference_sheet(settings, body, job_id, slots, label, base_prompt)
    reference_sheet_url = _first_text(reference_sheet.get("url"))
    manifest = _part_bundle_manifest(
        label=label,
        base_prompt=base_prompt,
        slots=slots,
        reference_sheet=reference_sheet,
    )
    base_references = [
        {
            **item,
            "role": "character_reference",
        }
        for item in (body.get("reference_images") or [])
        if isinstance(item, dict)
    ]
    if reference_sheet_url:
        base_references.insert(0, {
            "url": reference_sheet_url,
            "role": "part_sheet_reference",
            "part_bundle": True,
        })

    if _first_text(body.get("workflow_step")).lower() != "rig":
        _set_job_progress(
            job_id,
            step="part-bundle:base",
            message="Meshy base character generation and rigging",
            extra={"slot": "base", "part_index": 0, "part_total": len(slots)},
        )
        base_body = {
            **body,
            "title": label,
            "prompt": base_prompt,
            "part_slot": "",
            "slot": "",
            "generate_part_bundle": False,
            "part_bundle": False,
            "auto_part_bundle": False,
            "generate_parts": False,
            "reference_images": base_references,
        }
        try:
            configured, base_payload = _call_provider(settings, base_body, job_id)
            provider_configured = provider_configured or configured
            for asset in _extract_provider_assets(base_payload):
                metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
                asset["metadata"] = {
                    **metadata,
                    "part_bundle": True,
                    "part_bundle_role": "base_character",
                    "part_bundle_source_job_id": job_id,
                    "part_bundle_manifest": manifest,
                    "part_bundle_reference_sheet": reference_sheet,
                }
                assets.append(asset)
        except Exception as e:
            logger.warning("Meshy part bundle base character failed: %s", e)
            errors.append({"slot": "base", "error": str(e)})

    generated_base_refs = _base_generated_references(assets)
    part_source_body = _body_with_extra_reference_images(body, generated_base_refs)
    if generated_base_refs:
        base_reference_sheet = _generate_part_reference_sheet(settings, part_source_body, job_id, slots, label, base_prompt)
        if _first_text(base_reference_sheet.get("url")):
            reference_sheet = {
                **base_reference_sheet,
                "generated_from_base_character": True,
                "previous_reference_sheet": {
                    key: value
                    for key, value in reference_sheet.items()
                    if key not in {"data_url", "prompt"}
                },
            }
            reference_sheet_url = _first_text(reference_sheet.get("url"))
            manifest = _part_bundle_manifest(
                label=label,
                base_prompt=base_prompt,
                slots=slots,
                reference_sheet=reference_sheet,
            )
            for asset in assets:
                metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
                if metadata.get("part_bundle_role") == "base_character":
                    asset["metadata"] = {
                        **metadata,
                        "part_bundle_manifest": manifest,
                        "part_bundle_reference_sheet": reference_sheet,
                    }

    if _truthy(body.get("part_bundle_review_only") or body.get("part_reference_review_only"), False):
        return provider_configured, {
            "provider": "meshy",
            "base_task_id": base_payload.get("task_id"),
            "base_preview_task_id": base_payload.get("preview_task_id"),
            "kind": kind,
            "label": label,
            "assets": assets,
            "part_bundle": {
                "enabled": True,
                "review_only": True,
                "awaiting_approval": True,
                "slots": slots,
                "generated_count": len(assets),
                "errors": errors,
                "reference_sheet": reference_sheet,
                "manifest": manifest,
                "validation": {
                    "status": "pending_approval",
                    "expected_slots": slots,
                    "generated_slots": [],
                    "missing_slots": slots,
                },
            },
        }

    for index, slot in enumerate(slots, start=1):
        _set_job_progress(
            job_id,
            step=f"part-bundle:{slot}",
            message=f"Meshy 파츠 묶음 생성 중 ({index}/{len(slots)}): {slot}",
            extra={"slot": slot, "part_index": index, "part_total": len(slots)},
        )
        slot_body = {
            **body,
            "title": f"{label} {slot}",
            "prompt": _part_bundle_prompt(base_prompt, slot),
            "part_slot": slot,
            "slot": slot,
            "generate_part_bundle": False,
            "part_bundle": False,
            "auto_part_bundle": False,
            "generate_parts": False,
            "workflow_step": "model",
            "rig_character": False,
            "generate_basic_animations": False,
            "animation_mode": "none",
            "reference_images": _part_bundle_slot_references(part_source_body, reference_sheet_url, slot),
        }
        try:
            configured, payload = _call_provider(settings, slot_body, job_id)
            provider_configured = provider_configured or configured
            for asset in _extract_provider_assets(payload):
                metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
                tags = asset.get("tags") if isinstance(asset.get("tags"), list) else []
                asset["label"] = asset.get("label") or f"{label} {slot}"
                asset["kind"] = "characterPart"
                asset["slot"] = slot
                asset["part_slot"] = slot
                asset["tags"] = [*tags, "meshy", "character-part", slot]
                asset["metadata"] = {
                    **metadata,
                    "part_bundle": True,
                    "part_bundle_source_job_id": job_id,
                    "slot": slot,
                    "part_slot": slot,
                    "character_part_slot": slot,
                    "tags": [*tags, "meshy", "character-part", slot],
                    "part_bundle_manifest": manifest,
                    "part_bundle_reference_sheet": reference_sheet,
                    "output_contract": {
                        **(metadata.get("output_contract") if isinstance(metadata.get("output_contract"), dict) else {}),
                        **_output_contract_for_asset({"kind": kind, "part_slot": slot, "metadata": metadata}, kind),
                    },
                }
                assets.append(asset)
        except Exception as e:
            logger.warning("Meshy part bundle slot failed: slot=%s error=%s", slot, e)
            errors.append({"slot": slot, "error": str(e)})

    validation = _validate_part_bundle_assets(assets, slots)
    retry_failed_parts = _truthy(
        body.get("retry_failed_part_bundle_parts")
        if body.get("retry_failed_part_bundle_parts") is not None
        else _setting(settings, "world_part_bundle_retry_failed_parts", "WORLD_PART_BUNDLE_RETRY_FAILED_PARTS", "true"),
        True,
    )
    if retry_failed_parts:
        failed_reasons: dict[str, list[str]] = {}
        for item in validation.get("assets") if isinstance(validation.get("assets"), list) else []:
            if not isinstance(item, dict):
                continue
            slot = _normalize_part_slot(item.get("slot"))
            if not slot or item.get("status") == "passed":
                continue
            failed_reasons[slot] = [
                _first_text(warning)
                for warning in (item.get("warnings") if isinstance(item.get("warnings"), list) else [])
                if _first_text(warning)
            ]
        for missing_slot in validation.get("missing_slots") if isinstance(validation.get("missing_slots"), list) else []:
            slot = _normalize_part_slot(missing_slot)
            if slot:
                failed_reasons.setdefault(slot, ["slot_missing"])
        retry_slots = [slot for slot in slots if slot in failed_reasons]
        for retry_index, slot in enumerate(retry_slots, start=1):
            _set_job_progress(
                job_id,
                step=f"part-bundle:retry:{slot}",
                message=f"Meshy part isolation retry ({retry_index}/{len(retry_slots)}): {slot}",
                extra={"slot": slot, "part_retry_index": retry_index, "part_retry_total": len(retry_slots)},
            )
            slot_body = {
                **body,
                "title": f"{label} {slot} isolated retry",
                "prompt": _part_bundle_retry_prompt(base_prompt, slot, failed_reasons.get(slot, [])),
                "part_slot": slot,
                "slot": slot,
                "generate_part_bundle": False,
                "part_bundle": False,
                "auto_part_bundle": False,
                "generate_parts": False,
                "workflow_step": "model",
                "rig_character": False,
                "generate_basic_animations": False,
                "animation_mode": "none",
                "reference_images": _part_bundle_slot_references(part_source_body, reference_sheet_url, slot),
            }
            try:
                configured, payload = _call_provider(settings, slot_body, job_id)
                provider_configured = provider_configured or configured
                for asset in _extract_provider_assets(payload):
                    metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
                    tags = asset.get("tags") if isinstance(asset.get("tags"), list) else []
                    asset["label"] = asset.get("label") or f"{label} {slot} isolated"
                    asset["kind"] = "characterPart"
                    asset["slot"] = slot
                    asset["part_slot"] = slot
                    asset["tags"] = [*tags, "meshy", "character-part", slot, "retry-isolated"]
                    asset["metadata"] = {
                        **metadata,
                        "part_bundle": True,
                        "part_bundle_source_job_id": job_id,
                        "part_bundle_retry": True,
                        "part_bundle_retry_reasons": failed_reasons.get(slot, []),
                        "slot": slot,
                        "part_slot": slot,
                        "character_part_slot": slot,
                        "tags": [*tags, "meshy", "character-part", slot, "retry-isolated"],
                        "part_bundle_manifest": manifest,
                        "part_bundle_reference_sheet": reference_sheet,
                        "output_contract": {
                            **(metadata.get("output_contract") if isinstance(metadata.get("output_contract"), dict) else {}),
                            **_output_contract_for_asset({"kind": kind, "part_slot": slot, "metadata": metadata}, kind),
                        },
                    }
                    assets.append(asset)
            except Exception as e:
                logger.warning("Meshy part bundle retry failed: slot=%s error=%s", slot, e)
                errors.append({"slot": slot, "error": f"retry_failed: {e}"})
        if retry_slots:
            validation = _validate_part_bundle_assets(assets, slots)
    manifest["validation"] = validation
    return provider_configured, {
        "provider": "meshy",
        "base_task_id": base_payload.get("task_id"),
        "base_preview_task_id": base_payload.get("preview_task_id"),
        "kind": kind,
        "label": label,
        "assets": assets,
        "part_bundle": {
            "enabled": True,
            "slots": slots,
            "generated_count": len(assets),
            "errors": errors,
            "reference_sheet": reference_sheet,
            "manifest": manifest,
            "validation": validation,
        },
    }


def _truthy(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _first_text(value: Any) -> str:
    return str(value or "").strip()


def _is_quadruped_request(body: dict[str, Any]) -> bool:
    kind = _first_text(body.get("kind")).lower()
    if kind == "pet":
        return True
    if _truthy(body.get("quadruped") or body.get("four_legged"), False):
        return True
    metadata = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}
    if _truthy(metadata.get("quadruped") or metadata.get("four_legged"), False):
        return True
    text = " ".join(
        _first_text(value).lower()
        for value in (
            body.get("prompt"),
            body.get("title"),
            body.get("texture_prompt"),
            metadata.get("prompt"),
            metadata.get("description"),
        )
    )
    return any(term in text for term in _QUADRUPED_PROMPT_TERMS)


def _meshy_generation_prompt(body: dict[str, Any], prompt: str) -> str:
    if not _is_quadruped_request(body):
        return prompt
    guard = (
        "quadruped animal character, four legs, neutral standing pose, paws on ground, "
        "body facing forward, clean topology, no humanoid A-pose or T-pose, no floating limbs"
    )
    if guard.lower() in prompt.lower():
        return prompt[:600]
    return f"{prompt}, {guard}"[:600]


def _safe_asset_slug(value: Any, fallback: str = "world-asset") -> str:
    raw = _first_text(value).lower()
    chars: list[str] = []
    previous_dash = False
    for char in raw:
        if char.isascii() and char.isalnum():
            chars.append(char)
            previous_dash = False
        elif char in {"-", "_", " "} and not previous_dash:
            chars.append("-")
            previous_dash = True
    slug = "".join(chars).strip("-")
    return slug[:80] or fallback


def _asset_naming(asset: dict[str, Any], kind: str, label: str) -> dict[str, Any]:
    requested = _first_text(asset.get("asset_name") or asset.get("runtime_name") or label or kind)
    slug = _safe_asset_slug(asset.get("mesh_name") or asset.get("mesh_name_prefix") or requested or kind)
    return {
        "asset_name": requested or kind or "Generated asset",
        "runtime_name": requested or kind or "Generated asset",
        "mesh_name_prefix": slug,
        "root_node_name": f"{slug}-root",
        "material_name_prefix": f"{slug}-mat",
    }


def _normalize_part_slot(value: Any) -> str:
    raw = _first_text(value).lower().replace("-", "_").replace(" ", "_")
    if raw in _PART_SLOTS:
        return raw
    compact = raw.replace("_", "")
    for slot, aliases in _PART_SLOT_ALIASES.items():
        if raw in aliases or compact in {alias.replace("_", "").replace(" ", "") for alias in aliases}:
            return slot
    return ""


def _infer_part_slot(asset: dict[str, Any], kind: str, label: str = "") -> str:
    metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
    explicit = (
        asset.get("slot")
        or asset.get("part_slot")
        or asset.get("character_part_slot")
        or metadata.get("slot")
        or metadata.get("part_slot")
        or metadata.get("character_part_slot")
    )
    slot = _normalize_part_slot(explicit)
    if slot:
        return slot
    contract = metadata.get("output_contract") if isinstance(metadata.get("output_contract"), dict) else {}
    slot = _normalize_part_slot(contract.get("part_slot"))
    if slot:
        return slot
    text = " ".join(
        _first_text(value)
        for value in (
            kind,
            label,
            asset.get("title"),
            asset.get("prompt"),
            asset.get("texture_prompt"),
            metadata.get("prompt"),
            metadata.get("description"),
        )
    ).lower()
    for candidate, aliases in _PART_SLOT_ALIASES.items():
        if any(alias.lower() in text for alias in aliases):
            return candidate
    return ""


def _default_attachment_socket(slot: str, metadata: dict[str, Any]) -> str:
    attachment = metadata.get("attachment") if isinstance(metadata.get("attachment"), dict) else {}
    return _first_text(attachment.get("socket") or metadata.get("socket") or _PART_SLOT_DEFAULT_SOCKETS.get(slot, "")).lower()


def _output_contract_for_asset(asset: dict[str, Any], kind: str) -> dict[str, Any]:
    metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
    slot = _infer_part_slot(asset, kind, _first_text(asset.get("label") or asset.get("title")))
    socket = _default_attachment_socket(slot, metadata)
    quadruped = kind == "pet" or socket in _QUADRUPED_SOCKETS or _truthy(metadata.get("quadruped"), False)
    replacement_part = slot in {"top", "bottom", "shoes"}
    attachment_part = bool(slot and not replacement_part) or bool(socket)
    return {
        "runtime_format": "glb",
        "preferred_export": "glb",
        "intermediate_formats": ["fbx"] if kind in _CHARACTER_KINDS or quadruped else [],
        "allow_runtime_source_import": False,
        "asset_role": "character_part" if slot else "world_asset",
        "part_slot": slot or None,
        "attachment_socket": socket or None,
        "attachment_sockets_allowed": sorted(_QUADRUPED_SOCKETS) if quadruped else ["face", "hand", "head", "back"],
        "replacement_part": replacement_part,
        "attachment_part": attachment_part,
        "quadruped": quadruped,
        "base_pose": "quadruped-neutral" if quadruped else ("a-pose" if kind in _CHARACTER_KINDS else "world-origin"),
        "origin_policy": "same-origin-same-scale-same-forward",
    }


def _merge_output_contract(asset: dict[str, Any], kind: str) -> dict[str, Any]:
    metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
    contract = {
        **_output_contract_for_asset(asset, kind),
        **(metadata.get("output_contract") if isinstance(metadata.get("output_contract"), dict) else {}),
    }
    slot = _normalize_part_slot(contract.get("part_slot")) or _infer_part_slot(asset, kind, _first_text(asset.get("label") or asset.get("title")))
    socket = _first_text(contract.get("attachment_socket")).lower()
    attachment = metadata.get("attachment") if isinstance(metadata.get("attachment"), dict) else {}
    if slot:
        contract = {
            **contract,
            "asset_role": "character_part",
            "part_slot": slot,
            "attachment_socket": socket or _default_attachment_socket(slot, metadata) or None,
            "replacement_part": slot in {"top", "bottom", "shoes"},
            "attachment_part": slot not in {"top", "bottom", "shoes"},
        }
    if slot and contract.get("attachment_part") and not attachment:
        attachment = {
            "socket": contract.get("attachment_socket"),
            "position": [0, 0, 0],
            "rotation": [0, 0, 0],
            "scale": [1, 1, 1],
        }
    return {
        **metadata,
        **({"slot": slot} if slot else {}),
        **({"attachment": attachment} if attachment else {}),
        "output_contract": contract,
    }


def _runtime_format_from_model_url(url: Any) -> str:
    value = _first_text(url).split("?", 1)[0].split("#", 1)[0].lower()
    if value.endswith(".glb"):
        return "glb"
    if value.endswith(".gltf"):
        return "gltf"
    if value.endswith(".fbx"):
        return "fbx"
    if value.endswith(".obj"):
        return "obj"
    return ""


def _ensure_runtime_glb_asset(asset: dict[str, Any]) -> None:
    metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
    contract = metadata.get("output_contract") if isinstance(metadata.get("output_contract"), dict) else {}
    expected = _first_text(contract.get("runtime_format") or "glb").lower()
    model_url = _first_text(asset.get("model_url"))
    runtime_format = _first_text(contract.get("actual_runtime_format") or _runtime_format_from_model_url(model_url)).lower()
    status = _first_text(asset.get("status")).lower()
    if expected == "glb" and status in {"ready", "done", "converted", "completed"} and runtime_format and runtime_format != "glb":
        raise RuntimeError(f"Meshy runtime asset must be GLB, got {runtime_format}")


def _is_character_kind(body: dict[str, Any]) -> bool:
    return _first_text(body.get("kind")).lower() in _CHARACTER_KINDS


def _body_or_setting(
    body: dict[str, Any],
    settings: dict[str, str],
    body_key: str,
    setting_key: str,
    env_key: str,
    default: str = "",
) -> Any:
    value = body.get(body_key)
    if value not in (None, ""):
        return value
    return _setting(settings, setting_key, env_key, default)


def _bool_option(
    body: dict[str, Any],
    settings: dict[str, str],
    body_key: str,
    setting_key: str,
    env_key: str,
    default: bool,
) -> bool:
    value = _body_or_setting(body, settings, body_key, setting_key, env_key, "true" if default else "false")
    return _truthy(value, default)


def _source_image_url(body: dict[str, Any], user_id: int) -> str:
    direct_url = _first_text(body.get("reference_image_url") or body.get("image_url"))
    if direct_url:
        return direct_url
    for item in body.get("reference_images") or []:
        if isinstance(item, dict):
            url = _first_text(item.get("url") or item.get("image_url") or item.get("uri"))
            if url:
                return url
    source_id = body.get("source_image_asset_id")
    if not source_id or not db.is_configured():
        return ""
    try:
        row = db.fetch_one(
            """
            SELECT url
            FROM agent_media_asset
            WHERE id=%s AND (user_id=%s OR visibility='public')
            """,
            (int(source_id), int(user_id)),
        )
        return _first_text(row.get("url") if row else "")
    except Exception as e:
        logger.warning("source image asset lookup failed: %s", e)
        return ""


def _source_image_urls(body: dict[str, Any], user_id: int) -> list[str]:
    urls: list[str] = []
    for value in (body.get("reference_image_url"), body.get("image_url")):
        url = _first_text(value)
        if url and url not in urls:
            urls.append(url)
    for item in body.get("reference_images") or []:
        if isinstance(item, dict):
            url = _first_text(item.get("url") or item.get("image_url") or item.get("uri"))
        else:
            url = _first_text(item)
        if url and url not in urls:
            urls.append(url)
    source_url = _source_image_url(body, user_id)
    if source_url and source_url not in urls:
        urls.append(source_url)
    return urls[:4]


def _meshy_headers(settings: dict[str, str]) -> dict[str, str]:
    token = _setting(settings, "world_meshy_api_key", "MESHY_API_KEY", "")
    if not token:
        token = _setting(settings, "world_3d_api_token", "WORLD_3D_API_TOKEN", "")
    if not token:
        raise HTTPException(status_code=400, detail="Meshy API 키가 설정되지 않았습니다.")
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def _meshy_base(settings: dict[str, str]) -> str:
    return _setting(settings, "world_meshy_api_base", "MESHY_API_BASE_URL", "https://api.meshy.ai").rstrip("/")


def _meshy_task_id(payload: dict[str, Any]) -> str:
    raw = payload.get("result") or payload.get("id") or payload.get("task_id")
    if isinstance(raw, dict):
        raw = raw.get("id") or raw.get("task_id")
    return _first_text(raw)


def _meshy_status(payload: dict[str, Any]) -> str:
    return _first_text(payload.get("status") or payload.get("state")).upper()


def _meshy_model_url(payload: dict[str, Any]) -> str:
    result = payload.get("result")
    if isinstance(result, dict):
        nested_url = _meshy_model_url(result)
        if nested_url:
            return nested_url
    model_urls = payload.get("model_urls")
    if isinstance(model_urls, dict):
        for key in ("glb", "gltf", "fbx", "obj"):
            url = _first_text(model_urls.get(key))
            if url:
                return url
    for key in ("model_url", "url", "model_mesh"):
        value = payload.get(key)
        if isinstance(value, dict):
            value = value.get("url")
        url = _first_text(value)
        if url:
            return url
    return ""


def _meshy_model_format(payload: dict[str, Any], model_url: str = "") -> str:
    result = payload.get("result")
    if isinstance(result, dict):
        nested = _meshy_model_format(result, model_url)
        if nested:
            return nested
    model_urls = payload.get("model_urls")
    if isinstance(model_urls, dict):
        for key in ("glb", "gltf", "fbx", "obj"):
            url = _first_text(model_urls.get(key))
            if url and (not model_url or url == model_url):
                return key
    return _runtime_format_from_model_url(model_url)


def _meshy_thumbnail_url(payload: dict[str, Any]) -> str:
    result = payload.get("result")
    if isinstance(result, dict):
        nested_url = _meshy_thumbnail_url(result)
        if nested_url:
            return nested_url
    for key in ("thumbnail_url", "thumbnail", "rendered_image"):
        value = payload.get(key)
        if isinstance(value, dict):
            value = value.get("url")
        url = _first_text(value)
        if url:
            return url
    return ""


def _wait_meshy_task(
    *,
    settings: dict[str, str],
    path: str,
    task_id: str,
    timeout: int,
    progress_job_id: str = "",
    progress_step: str = "",
    progress_message: str = "",
) -> dict[str, Any]:
    headers = _meshy_headers(settings)
    base = _meshy_base(settings)
    interval = _safe_float(
        _setting(settings, "world_meshy_poll_interval_seconds", "MESHY_POLL_INTERVAL_SECONDS", "5"),
        5,
        1,
        30,
    )
    deadline = time.time() + timeout
    last_payload: dict[str, Any] = {}
    started_at = time.time()
    while time.time() < deadline:
        response = httpx.get(f"{base}{path}/{task_id}", headers=headers, timeout=30)
        response.raise_for_status()
        payload = response.json()
        last_payload = payload if isinstance(payload, dict) else {}
        status = _meshy_status(last_payload)
        if progress_job_id:
            _set_job_progress(
                progress_job_id,
                step=progress_step or path.rsplit("/", 1)[-1],
                message=progress_message or f"Meshy {path} 대기 중",
                provider_task_id=task_id,
                provider_status=status or "PENDING",
                elapsed_seconds=int(time.time() - started_at),
            )
        if status in {"SUCCEEDED", "SUCCESS", "COMPLETED", "FINISHED"}:
            return last_payload
        if status in {"FAILED", "FAILURE", "CANCELED", "CANCELLED"}:
            task_error = last_payload.get("task_error")
            task_message = task_error.get("message") if isinstance(task_error, dict) else ""
            raise RuntimeError(
                last_payload.get("error")
                or last_payload.get("message")
                or task_message
                or f"Meshy task failed: {status}"
            )
        time.sleep(interval)
    raise TimeoutError(f"Meshy task timeout: {task_id}, last={last_payload}")


def _create_meshy_task(settings: dict[str, str], path: str, payload: dict[str, Any], timeout: int) -> str:
    response = httpx.post(f"{_meshy_base(settings)}{path}", headers=_meshy_headers(settings), json=payload, timeout=timeout)
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as e:
        detail = response.text[:1000] if response.text else str(e)
        if response.status_code == 402 or "insufficient funds" in detail.lower():
            raise MeshyInsufficientFundsError(
                f"Meshy 크레딧이 부족해서 작업을 만들 수 없습니다. Meshy 결제/크레딧을 충전하거나, 리깅/애니메이션 없이 모델만 생성해 주세요. ({path})"
            ) from e
        raise RuntimeError(f"Meshy task create failed {response.status_code} {path}: {detail}") from e
    data = response.json()
    task_id = _meshy_task_id(data if isinstance(data, dict) else {})
    if not task_id:
        raise RuntimeError("Meshy task id를 받지 못했습니다.")
    return task_id


def _meshy_int_option(
    body: dict[str, Any],
    settings: dict[str, str],
    body_key: str,
    setting_key: str,
    env_key: str,
    default: int,
    min_value: int,
    max_value: int,
) -> int:
    value = body.get(body_key)
    if value in (None, ""):
        value = _setting(settings, setting_key, env_key, str(default))
    return _safe_int(value, default, min_value, max_value)


def _meshy_preview_options(settings: dict[str, str], body: dict[str, Any], *, image_to_3d: bool = False) -> dict[str, Any]:
    quadruped = _is_quadruped_request(body)
    character_like = (_is_character_kind(body) or _truthy(body.get("rig_character"), False)) and not quadruped
    default_polycount = 30000 if character_like else 30000
    polycount_setting = "world_meshy_character_target_polycount" if character_like else "world_meshy_target_polycount"
    polycount_env = "MESHY_CHARACTER_TARGET_POLYCOUNT" if character_like else "MESHY_TARGET_POLYCOUNT"
    target_polycount = _meshy_int_option(
        body,
        settings,
        "target_polycount",
        polycount_setting,
        polycount_env,
        default_polycount,
        100,
        300000,
    )
    ai_model = _first_text(
        _body_or_setting(body, settings, "ai_model", "world_meshy_ai_model", "MESHY_AI_MODEL", "latest")
    ).lower()
    if ai_model not in {"latest", "meshy-5", "meshy-6"}:
        ai_model = "latest"
    model_type = _first_text(
        _body_or_setting(body, settings, "model_type", "world_meshy_model_type", "MESHY_MODEL_TYPE", "standard")
    ).lower()
    if model_type not in {"standard", "lowpoly"}:
        model_type = "standard"
    topology_default = _setting(settings, "world_meshy_character_topology", "MESHY_CHARACTER_TOPOLOGY", "quad") if character_like else _setting(settings, "world_meshy_topology", "MESHY_TOPOLOGY", "quad")
    topology = _first_text(body.get("topology") or topology_default).lower()
    if topology not in {"quad", "triangle"}:
        topology = "quad"
    should_texture = _bool_option(body, settings, "should_texture", "world_meshy_should_texture", "MESHY_SHOULD_TEXTURE", True)
    should_remesh = _bool_option(body, settings, "should_remesh", "world_meshy_should_remesh", "MESHY_SHOULD_REMESH", True)
    options: dict[str, Any] = {}
    if image_to_3d:
        options.update({
            "model_type": model_type,
            "should_texture": should_texture,
            "target_formats": ["glb"],
            "image_enhancement": _bool_option(body, settings, "image_enhancement", "world_meshy_image_enhancement", "MESHY_IMAGE_ENHANCEMENT", True),
            "remove_lighting": _bool_option(body, settings, "remove_lighting", "world_meshy_remove_lighting", "MESHY_REMOVE_LIGHTING", True),
            "moderation": _bool_option(body, settings, "moderation", "world_meshy_moderation", "MESHY_MODERATION", False),
        })
    if model_type != "lowpoly":
        if image_to_3d:
            options["ai_model"] = ai_model
        options["should_remesh"] = should_remesh
        if should_remesh:
            options["target_polycount"] = target_polycount
            options["topology"] = topology
            save_pre_remeshed = _bool_option(
                body,
                settings,
                "save_pre_remeshed_model",
                "world_meshy_save_pre_remeshed_model",
                "MESHY_SAVE_PRE_REMESHED_MODEL",
                character_like,
            )
            if save_pre_remeshed:
                options["save_pre_remeshed_model"] = True
    if image_to_3d and should_texture:
        matte_texture = _texture_finish(settings, body) == "matte"
        options["enable_pbr"] = False if matte_texture else _bool_option(body, settings, "enable_pbr", "world_meshy_enable_pbr", "MESHY_ENABLE_PBR", True)
        options["hd_texture"] = False if matte_texture else _bool_option(body, settings, "hd_texture", "world_meshy_hd_texture", "MESHY_HD_TEXTURE", False)
    decimation_mode = body.get("decimation_mode")
    if decimation_mode in (None, "") and not character_like:
        decimation_mode = _setting(settings, "world_meshy_decimation_mode", "MESHY_DECIMATION_MODE", "")
    if decimation_mode not in (None, "") and model_type != "lowpoly":
        options["decimation_mode"] = _safe_int(decimation_mode, 3, 1, 4)
    symmetry_mode = _first_text(body.get("symmetry_mode") or _setting(settings, "world_meshy_symmetry_mode", "MESHY_SYMMETRY_MODE", "auto")).lower()
    if symmetry_mode in {"off", "on", "auto"}:
        options["symmetry_mode"] = symmetry_mode
    pose_mode = _first_text(body.get("pose_mode") or "")
    if not pose_mode and character_like:
        pose_mode = _setting(settings, "world_meshy_character_pose_mode", "MESHY_CHARACTER_POSE_MODE", "a-pose")
    if pose_mode in {"a-pose", "t-pose"}:
        options["pose_mode"] = pose_mode
    auto_size = image_to_3d and _bool_option(body, settings, "auto_size", "world_meshy_auto_size", "MESHY_AUTO_SIZE", character_like or quadruped)
    if auto_size:
        options["auto_size"] = True
        origin_at = _first_text(body.get("origin_at") or _setting(settings, "world_meshy_origin_at", "MESHY_ORIGIN_AT", "bottom")).lower()
        if origin_at in {"bottom", "center"}:
            options["origin_at"] = origin_at
    return options


def _texture_finish(settings: dict[str, str], body: dict[str, Any]) -> str:
    finish = _first_text(body.get("texture_finish") or _setting(settings, "world_meshy_texture_finish", "MESHY_TEXTURE_FINISH", "matte")).lower()
    return finish if finish in {"matte", "pbr"} else "matte"


def _texture_prompt(settings: dict[str, str], body: dict[str, Any], fallback: str = "") -> str:
    prompt = _first_text(body.get("texture_prompt") or fallback)
    if _texture_finish(settings, body) != "matte":
        return prompt[:600]
    guard = "matte material, flat diffuse color, no glow, no bloom, no emission, no glossy highlights, no baked lighting"
    if not prompt:
        return guard
    prompt_lower = prompt.lower()
    if "no bloom" in prompt_lower and "matte" in prompt_lower:
        return prompt[:600]
    return f"{prompt}, {guard}"[:600]


def _should_rig_character(settings: dict[str, str], body: dict[str, Any]) -> bool:
    kind = _first_text(body.get("kind")).lower()
    if kind not in _CHARACTER_KINDS or _is_quadruped_request(body):
        return False
    requested = body.get("rig_character")
    if requested is not None:
        return _truthy(requested)
    return _truthy(_setting(settings, "world_meshy_auto_rig_character", "MESHY_AUTO_RIG_CHARACTER", "true"), True)


def _should_generate_basic_animations(settings: dict[str, str], body: dict[str, Any]) -> bool:
    if _is_quadruped_request(body):
        return False
    requested = body.get("generate_basic_animations")
    if requested is not None:
        return _truthy(requested)
    kind = _first_text(body.get("kind")).lower()
    if kind not in _CHARACTER_KINDS and not _truthy(body.get("rig_character"), False):
        return False
    return _truthy(
        _setting(settings, "world_meshy_generate_basic_animations", "MESHY_GENERATE_BASIC_ANIMATIONS", "true"),
        True,
    )


def _meshy_rigged_result(payload: dict[str, Any]) -> dict[str, Any]:
    result = payload.get("result")
    data = result if isinstance(result, dict) else payload
    model_url = _first_text(data.get("rigged_character_glb_url"))
    animations = data.get("basic_animations") if isinstance(data.get("basic_animations"), dict) else {}
    basic_clips = _meshy_basic_animation_clips(animations)
    return {
        "model_url": model_url,
        "runtime_format": "glb" if model_url else "",
        "fbx_url": _first_text(data.get("rigged_character_fbx_url")),
        "basic_animations": animations,
        "animations": animations,
        "animation_clips": basic_clips,
    }


def _meshy_basic_animation_clips(animations: dict[str, Any]) -> list[dict[str, Any]]:
    clips: dict[str, dict[str, Any]] = {}
    for key, value in animations.items():
        url = _first_text(value)
        if not url or "_" not in key:
            continue
        name, suffix = key.split("_", 1)
        canonical_name = _MESHY_BASIC_ANIMATION_CANONICAL_NAMES.get(name.lower(), name.lower())
        clip = clips.setdefault(canonical_name, {
            "name": name,
            "canonical_name": canonical_name,
            "gaesup_action": canonical_name,
            "source": "meshy-basic",
        })
        if suffix == "glb_url":
            clip["model_url"] = url
        elif suffix == "fbx_url":
            clip["fbx_url"] = url
        elif suffix == "armature_glb_url":
            clip["armature_glb_url"] = url
    return list(clips.values())


def _meshy_animation_label(action_id: int) -> str:
    return _MESHY_ACTION_LABELS.get(action_id) or f"Action_{action_id}"


def _meshy_animation_canonical_name(action_id: int) -> str:
    return _MESHY_ACTION_CANONICAL_NAMES.get(action_id) or _meshy_animation_label(action_id).lower()


def _meshy_animation_result(payload: dict[str, Any], action_id: int, canonical_name: str = "") -> dict[str, Any]:
    result = payload.get("result")
    data = result if isinstance(result, dict) else payload
    label = _meshy_animation_label(action_id)
    resolved_name = canonical_name or _meshy_animation_canonical_name(action_id)
    return {
        "name": label,
        "label": label,
        "canonical_name": resolved_name,
        "gaesup_action": resolved_name,
        "model_url": _first_text(data.get("animation_glb_url") or data.get("animation_fbx_url")),
        "fbx_url": _first_text(data.get("animation_fbx_url")),
        "usdz_url": _first_text(data.get("processed_usdz_url")),
        "armature_fbx_url": _first_text(data.get("processed_armature_fbx_url")),
        "fps_fbx_url": _first_text(data.get("processed_animation_fps_fbx_url")),
    }


def _parse_meshy_animation_action_slots(raw: Any, action_ids: list[int]) -> list[str]:
    if isinstance(raw, str):
        items = [item.strip() for item in raw.split(",")]
    elif isinstance(raw, list):
        items = raw
    else:
        items = []
    slots: list[str] = []
    for item in items:
        slot = _first_text(item).lower()
        slots.append(slot if slot in _MESHY_CHARACTER_ACTION_SLOTS else "")
    if len(slots) != len(action_ids):
        return ["" for _ in action_ids]
    return slots


def _parse_meshy_animation_action_ids(raw: Any) -> list[int]:
    if isinstance(raw, str):
        items = [item.strip() for item in raw.split(",")]
    elif isinstance(raw, list):
        items = raw
    else:
        items = []
    action_ids: list[int] = []
    for item in items:
        try:
            action_id = int(item)
        except Exception:
            continue
        if action_id not in action_ids:
            action_ids.append(action_id)
    return action_ids


def _meshy_animation_catalog_url(settings: dict[str, str]) -> str:
    return _setting(
        settings,
        "world_meshy_animation_catalog_url",
        "MESHY_ANIMATION_CATALOG_URL",
        "https://api.meshy.ai/web/public/animations/resources",
    )


def _normalize_meshy_animation_catalog_item(item: dict[str, Any]) -> dict[str, Any] | None:
    try:
        action_id = int(item.get("id"))
    except Exception:
        return None
    rig_type = _first_text(item.get("rigType"))
    if rig_type and rig_type != "biped" and not rig_type.startswith("style_"):
        return None
    key = _first_text(item.get("key")) or _meshy_animation_label(action_id)
    name = _first_text(item.get("name")) or key
    category = _first_text(item.get("category")) or "Other"
    sub_category = _first_text(item.get("subCategory")) or category
    return {
        "action_id": action_id,
        "action_key": key,
        "name": name,
        "category": category,
        "sub_category": sub_category,
        "rig_type": rig_type,
        "tag": _first_text(item.get("tag")),
        "preview_url": _first_text(item.get("previewUrl")),
        "is_default": bool(item.get("isDefault")),
        "is_free": bool(item.get("isFree")),
        "created_at_ms": _safe_int(item.get("createdAt"), 0, 0, 9999999999999),
        "source_json": item,
    }


def _fetch_meshy_animation_catalog(settings: dict[str, str], timeout: int) -> list[dict[str, Any]]:
    response = httpx.get(_meshy_animation_catalog_url(settings), timeout=min(max(timeout, 5), 30))
    response.raise_for_status()
    payload = response.json()
    result = payload.get("result") if isinstance(payload, dict) else {}
    items = result.get("list") if isinstance(result, dict) else []
    if not isinstance(items, list):
        return []
    normalized: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        normalized_item = _normalize_meshy_animation_catalog_item(item)
        if normalized_item is not None:
            normalized.append(normalized_item)
    normalized.sort(key=lambda item: (
        str(item["category"]),
        str(item["sub_category"]),
        not bool(item["is_free"]),
        str(item["name"]),
        int(item["action_id"]),
    ))
    return normalized


def _sync_meshy_animation_catalog(settings: dict[str, str], timeout: int) -> list[dict[str, Any]]:
    global _MESHY_ANIMATION_CATALOG_MEMORY
    items = _fetch_meshy_animation_catalog(settings, timeout)
    _MESHY_ANIMATION_CATALOG_MEMORY = items
    if not db.is_configured() or not items:
        return items
    db.execute_many(
        """
        INSERT INTO world_meshy_animation_catalog (
            action_id, action_key, name, category, sub_category, rig_type, tag,
            preview_url, is_default, is_free, created_at_ms, source_json
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (action_id) DO UPDATE SET
            action_key=EXCLUDED.action_key,
            name=EXCLUDED.name,
            category=EXCLUDED.category,
            sub_category=EXCLUDED.sub_category,
            rig_type=EXCLUDED.rig_type,
            tag=EXCLUDED.tag,
            preview_url=EXCLUDED.preview_url,
            is_default=EXCLUDED.is_default,
            is_free=EXCLUDED.is_free,
            created_at_ms=EXCLUDED.created_at_ms,
            source_json=EXCLUDED.source_json,
            synced_at=CURRENT_TIMESTAMP
        """,
        [
            (
                int(item["action_id"]),
                str(item["action_key"]),
                str(item["name"]),
                str(item["category"]),
                str(item["sub_category"]),
                str(item["rig_type"]),
                str(item["tag"]),
                str(item["preview_url"]) or None,
                bool(item["is_default"]),
                bool(item["is_free"]),
                int(item["created_at_ms"]),
                _json(item["source_json"]),
            )
            for item in items
        ],
    )
    default_by_slot = {str(item["canonical_name"]): int(item["action_id"]) for item in _MESHY_CHARACTER_ACTION_PRESET}
    slot_rows = []
    for slot_key in _MESHY_ANIMATION_SLOT_KEYS:
        for index, item in enumerate(items):
            action_id = int(item["action_id"])
            slot_rows.append((slot_key, action_id, index, default_by_slot.get(slot_key) == action_id))
    db.execute("DELETE FROM world_meshy_animation_slot_option WHERE slot_key IN (%s, %s, %s, %s, %s, %s)", tuple(_MESHY_ANIMATION_SLOT_KEYS))
    db.execute_many(
        """
        INSERT INTO world_meshy_animation_slot_option (slot_key, action_id, sort_order, is_default)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (slot_key, action_id) DO UPDATE SET
            sort_order=EXCLUDED.sort_order,
            is_default=EXCLUDED.is_default,
            synced_at=CURRENT_TIMESTAMP
        """,
        slot_rows,
    )
    return items


def _load_meshy_animation_catalog_from_db() -> list[dict[str, Any]]:
    if not db.is_configured():
        return []
    try:
        rows = db.fetch_all(
            """
            SELECT action_id, action_key, name, category, sub_category, rig_type, tag,
                   preview_url, is_default, is_free, created_at_ms
            FROM world_meshy_animation_catalog
            ORDER BY category ASC, sub_category ASC, is_free DESC, name ASC, action_id ASC
            """
        )
    except Exception as e:
        logger.warning("Meshy animation catalog DB load failed: %s", e)
        return []
    return [
        {
            "action_id": int(row.get("action_id") or 0),
            "action_key": _first_text(row.get("action_key")),
            "name": _first_text(row.get("name")),
            "category": _first_text(row.get("category")) or "Other",
            "sub_category": _first_text(row.get("sub_category")) or _first_text(row.get("category")) or "Other",
            "rig_type": _first_text(row.get("rig_type")),
            "tag": _first_text(row.get("tag")),
            "preview_url": _first_text(row.get("preview_url")),
            "is_default": bool(row.get("is_default")),
            "is_free": bool(row.get("is_free")),
            "created_at_ms": int(row.get("created_at_ms") or 0),
        }
        for row in rows
    ]


def _meshy_animation_catalog_payload(settings: dict[str, str], *, sync: bool, timeout: int) -> dict[str, Any]:
    items = _sync_meshy_animation_catalog(settings, timeout) if sync else _load_meshy_animation_catalog_from_db()
    if not items:
        try:
            items = _sync_meshy_animation_catalog(settings, timeout)
        except Exception as e:
            logger.warning("Meshy animation catalog sync failed: %s", e)
            items = _MESHY_ANIMATION_CATALOG_MEMORY
    default_by_slot = {str(item["canonical_name"]): int(item["action_id"]) for item in _MESHY_CHARACTER_ACTION_PRESET}
    slots = [
        {
            "slot": slot_key,
            "default_action_id": default_by_slot.get(slot_key),
            "options": items,
        }
        for slot_key in _MESHY_ANIMATION_SLOT_KEYS
    ]
    return {"items": items, "slots": slots, "total": len(items)}


def _meshy_catalog_animation_action_ids(settings: dict[str, str], mode: str, timeout: int) -> list[int]:
    action_ids: list[int] = []
    for item in _fetch_meshy_animation_catalog(settings, timeout):
        is_default = bool(item.get("is_default"))
        is_free = bool(item.get("is_free"))
        if mode == "default" and not is_default:
            continue
        if mode == "free" and (not is_free or is_default):
            continue
        if mode == "all" and is_default:
            continue
        action_id = int(item.get("action_id") or 0)
        if action_id not in action_ids:
            action_ids.append(action_id)
    return action_ids


def _meshy_animation_action_ids(settings: dict[str, str], body: dict[str, Any]) -> list[int]:
    mode = _first_text(
        body.get("animation_mode")
        or _setting(settings, "world_meshy_animation_mode", "MESHY_ANIMATION_MODE", "preset")
    ).lower()
    if "animation_action_ids" in body:
        raw = body.get("animation_action_ids")
        action_ids = _parse_meshy_animation_action_ids(raw)
    else:
        if mode in {"none", "off", "disabled"}:
            return []
        configured_ids = _setting(settings, "world_meshy_animation_action_ids", "MESHY_ANIMATION_ACTION_IDS", "")
        action_ids = _parse_meshy_animation_action_ids(configured_ids)
        if action_ids == _MESHY_LEGACY_CHARACTER_ACTION_IDS and mode in {"preset", "default", "basic", ""}:
            action_ids = list(_MESHY_DEFAULT_CHARACTER_ACTION_IDS)
        if not action_ids:
            catalog_enabled = _truthy(_setting(settings, "world_meshy_animation_catalog_enabled", "MESHY_ANIMATION_CATALOG_ENABLED", "false"), False)
            if mode in {"preset", "default", "basic", ""}:
                action_ids = list(_MESHY_DEFAULT_CHARACTER_ACTION_IDS)
            elif mode in {"catalog_default", "catalog-free", "catalog_free", "catalog-all", "catalog_all"}:
                catalog_mode = mode.replace("-", "_").split("_", 1)[1]
                action_ids = _meshy_catalog_animation_action_ids(
                    settings,
                    catalog_mode,
                    _safe_int(
                        _setting(settings, "world_3d_api_timeout_seconds", "WORLD_3D_API_TIMEOUT_SECONDS", "900"),
                        900,
                        30,
                        1800,
                    ),
                )
            elif catalog_enabled and mode in {"default", "free", "all"}:
                action_ids = _meshy_catalog_animation_action_ids(
                    settings,
                    mode,
                    _safe_int(
                        _setting(settings, "world_3d_api_timeout_seconds", "WORLD_3D_API_TIMEOUT_SECONDS", "900"),
                        900,
                        30,
                        1800,
                    ),
                )
            else:
                action_ids = []
    max_count = _safe_int(_setting(settings, "world_meshy_animation_max_count", "MESHY_ANIMATION_MAX_COUNT", "6"), 6, 0, 100)
    if max_count <= 0 and action_ids == _MESHY_DEFAULT_CHARACTER_ACTION_IDS:
        max_count = len(_MESHY_DEFAULT_CHARACTER_ACTION_IDS)
    if action_ids == _MESHY_DEFAULT_CHARACTER_ACTION_IDS and max_count < len(_MESHY_DEFAULT_CHARACTER_ACTION_IDS):
        max_count = len(_MESHY_DEFAULT_CHARACTER_ACTION_IDS)
    return action_ids[:max_count] if max_count > 0 else action_ids


def _animate_meshy_character(
    *,
    settings: dict[str, str],
    rig_task_id: str,
    action_ids: list[int],
    action_slots: list[str] | None = None,
    animation_fps: int = 0,
    timeout: int,
) -> list[dict[str, Any]]:
    animations: list[dict[str, Any]] = []
    path = "/openapi/v1/animations"
    slots = action_slots if isinstance(action_slots, list) and len(action_slots) == len(action_ids) else ["" for _ in action_ids]
    for index, action_id in enumerate(action_ids):
        payload: dict[str, Any] = {"rig_task_id": rig_task_id, "action_id": action_id}
        fps = animation_fps or _safe_int(_setting(settings, "world_meshy_animation_fps", "MESHY_ANIMATION_FPS", "0"), 0, 0, 60)
        if fps in {24, 25, 30, 60}:
            payload["post_process"] = {"operation_type": "change_fps", "fps": fps}
        try:
            task_id = _create_meshy_task(settings, path, payload, timeout)
            result = _wait_meshy_task(settings=settings, path=path, task_id=task_id, timeout=timeout)
            animation = _meshy_animation_result(result, action_id, slots[index])
            if animation.get("model_url"):
                animations.append({"task_id": task_id, "action_id": action_id, "status": "ready", **animation, "raw": result})
        except Exception as e:
            logger.warning("Meshy animation skipped: rig_task_id=%s action_id=%s error=%s", rig_task_id, action_id, e)
            animations.append({
                "action_id": action_id,
                "name": _meshy_animation_label(action_id),
                **({"canonical_name": slots[index], "gaesup_action": slots[index]} if slots[index] else {}),
                "status": "error",
                "error": str(e),
            })
    return animations


def _clip_canonical_name(clip: dict[str, Any]) -> str:
    canonical = _first_text(clip.get("canonical_name") or clip.get("gaesup_action"))
    if canonical:
        return canonical
    action_id = clip.get("action_id")
    try:
        return _meshy_animation_canonical_name(int(action_id))
    except Exception:
        pass
    name = _first_text(clip.get("name") or clip.get("label")).lower()
    for token, canonical_name in _MESHY_BASIC_ANIMATION_CANONICAL_NAMES.items():
        if token and token in name:
            return canonical_name
    return name


def _combine_meshy_character_animation_model(
    *,
    settings: dict[str, str],
    rigged: dict[str, Any],
    timeout: int,
    lock_face_weights: bool = False,
    face_lock_mode: str = "normal",
) -> dict[str, Any]:
    clips = [
        clip for clip in (rigged.get("animation_clips") if isinstance(rigged.get("animation_clips"), list) else [])
        if isinstance(clip, dict) and clip.get("status", "ready") != "error"
    ]
    if len(clips) < 2:
        return rigged
    source_model_url = _first_text(rigged.get("model_url"))
    if not source_model_url:
        return rigged
    sources: list[dict[str, Any]] = []
    for clip in clips:
        model_url = _first_text(clip.get("model_url") or clip.get("glb_url") or clip.get("url") or clip.get("animation_url"))
        canonical_name = _clip_canonical_name(clip)
        if not model_url or not canonical_name:
            continue
        sources.append({
            "model_url": model_url,
            "canonical_name": canonical_name,
            "name": _first_text(clip.get("name") or clip.get("label")) or canonical_name,
            **({"action_id": int(clip["action_id"])} if clip.get("action_id") is not None else {}),
        })
    if not sources:
        return rigged
    order = {str(item["canonical_name"]): index for index, item in enumerate(_MESHY_CHARACTER_ACTION_PRESET)}
    sources.sort(key=lambda item: order.get(str(item.get("canonical_name") or ""), len(order)))
    try:
        base_bytes, _ = _fetch_model_bytes(source_model_url, timeout=min(max(timeout, 30), 180))
        for source in sources:
            content, _ = _fetch_model_bytes(str(source["model_url"]), timeout=min(max(timeout, 30), 180))
            source["content"] = content
        combined_bytes, merged = _combine_glb_animations(base_bytes, sources)
        face_lock: dict[str, Any] = {"enabled": lock_face_weights, "status": "disabled"}
        if lock_face_weights:
            combined_bytes, face_lock = _postprocess_glb_face_lock(combined_bytes, face_lock_mode)
        uploaded = _upload_to_s3(combined_bytes, "model/gltf-binary", "world-model", settings)
        combined_url = _first_text(uploaded.get("url"))
        if not combined_url:
            return rigged
        animation_map = {item["canonical_name"]: item["canonical_name"] for item in merged if item.get("canonical_name")}
        expected_names = [str(item["canonical_name"]) for item in _MESHY_CHARACTER_ACTION_PRESET]
        merged_names = {str(item["canonical_name"]) for item in merged if item.get("canonical_name")}
        return {
            **rigged,
            "model_url": combined_url,
            "single_model_url": combined_url,
            "combined_model_url": combined_url,
            "source_rigged_model_url": source_model_url,
            "combined_animation_clips": merged,
            "combined_animation_count": len(merged),
            "face_lock": face_lock,
            "expected_combined_animations": expected_names,
            "missing_combined_animations": [name for name in expected_names if name not in merged_names],
            "animation_map": animation_map,
            "gaesup_animation_map": animation_map,
            "stored_model_url": combined_url,
            "stored_model_bucket": uploaded.get("bucket") or "",
            "stored_model_key": uploaded.get("key") or "",
            "stored_model_mime_type": uploaded.get("mime_type") or "model/gltf-binary",
            "stored_model_size": len(combined_bytes),
        }
    except Exception as e:
        logger.warning("Meshy combined animation GLB skipped: url=%s error=%s", redact_url(source_model_url), e)
        return {
            **rigged,
            "combine_error": str(e),
        }


def _rig_meshy_character(
    *,
    settings: dict[str, str],
    body: dict[str, Any],
    input_task_id: str,
    model_url: str,
    timeout: int,
    job_id: str = "",
) -> tuple[str, dict[str, Any]]:
    path = "/openapi/v1/rigging"
    if job_id:
        _set_job_progress(job_id, step="rigging:create", message="Meshy 캐릭터 리깅 작업 생성 중")
    height = _safe_float(
        body.get("height_meters")
        or _setting(
            settings,
            "world_meshy_character_height_meters",
            "MESHY_CHARACTER_HEIGHT_METERS",
            str(_MESHY_DEFAULT_RIG_HEIGHT_METERS),
        ),
        _MESHY_DEFAULT_RIG_HEIGHT_METERS,
        0.1,
        100.0,
    )
    payload: dict[str, Any] = {
        "height_meters": height,
    }
    basic_animations_requested = _should_generate_basic_animations(settings, body)
    if basic_animations_requested:
        payload["generate_basic_animations"] = True
    if input_task_id:
        payload["input_task_id"] = input_task_id
    else:
        payload["model_url"] = model_url
    task_id = _create_meshy_task(settings, path, payload, timeout)
    result = _wait_meshy_task(
        settings=settings,
        path=path,
        task_id=task_id,
        timeout=timeout,
        progress_job_id=job_id,
        progress_step="rigging",
        progress_message="Meshy 캐릭터 리깅/기본 애니메이션 생성 중",
    )
    rigged = _meshy_rigged_result(result)
    if not rigged.get("model_url"):
        raise RuntimeError("Meshy rigging 결과에 rigged model URL이 없습니다.")
    lock_face_weights = _should_lock_face_weights(settings, body)
    face_lock_mode = _face_lock_mode(settings, body)
    if lock_face_weights:
        try:
            face_lock = _postprocess_and_upload_face_locked_model(
                settings=settings,
                model_url=str(rigged["model_url"]),
                mode=face_lock_mode,
                timeout=timeout,
            )
            rigged["face_lock"] = face_lock
            if face_lock.get("model_url"):
                rigged["source_rigged_model_url"] = rigged["model_url"]
                rigged["model_url"] = face_lock["model_url"]
                for key in ("stored_model_url", "stored_model_bucket", "stored_model_key", "stored_model_mime_type", "stored_model_size"):
                    if face_lock.get(key):
                        rigged[key] = face_lock[key]
        except Exception as e:
            logger.warning("Meshy face-lock postprocess skipped: url=%s error=%s", redact_url(str(rigged.get("model_url") or "")), e)
            rigged["face_lock"] = {"enabled": True, "status": "error", "error": str(e)}
    requested_action_ids = _meshy_animation_action_ids(settings, body)
    requested_action_slots = _parse_meshy_animation_action_slots(body.get("animation_action_slots"), requested_action_ids)
    has_slot_overrides = any(requested_action_slots)
    existing_clips = rigged.get("animation_clips") if isinstance(rigged.get("animation_clips"), list) else []
    existing_canonical_names = {
        _clip_canonical_name(clip)
        for clip in existing_clips
        if isinstance(clip, dict) and _clip_canonical_name(clip)
    }
    action_pairs = list(zip(requested_action_ids, requested_action_slots))
    if not has_slot_overrides:
        action_pairs = [
            (action_id, slot)
            for action_id, slot in action_pairs
            if _meshy_animation_canonical_name(action_id) not in existing_canonical_names
        ]
    action_ids = [action_id for action_id, _slot in action_pairs]
    action_slots = [slot for _action_id, slot in action_pairs]
    rigged["requested_animation_action_ids"] = requested_action_ids
    if has_slot_overrides:
        rigged["requested_animation_slots"] = requested_action_slots
    rigged["existing_animation_names"] = sorted(existing_canonical_names)
    rigged["missing_animation_action_ids"] = action_ids
    if has_slot_overrides:
        rigged["missing_animation_slots"] = action_slots
    if action_ids:
        animation_fps = _safe_int(body.get("animation_fps"), 0, 0, 60)
        applied = _animate_meshy_character(
            settings=settings,
            rig_task_id=task_id,
            action_ids=action_ids,
            action_slots=action_slots,
            animation_fps=animation_fps,
            timeout=timeout,
        )
        rigged["applied_animations"] = applied
        preserved_clips = rigged.get("animation_clips") if isinstance(rigged.get("animation_clips"), list) else []
        if has_slot_overrides:
            override_slots = {slot for slot in requested_action_slots if slot}
            preserved_clips = [
                clip for clip in preserved_clips
                if not isinstance(clip, dict) or _clip_canonical_name(clip) not in override_slots
            ]
        rigged["animation_clips"] = [
            *preserved_clips,
            *[clip for clip in applied if clip.get("status") == "ready"],
        ]
    rigged = _combine_meshy_character_animation_model(settings=settings, rigged=rigged, lock_face_weights=lock_face_weights, face_lock_mode=face_lock_mode, timeout=timeout)
    combined_clips = rigged.get("combined_animation_clips") if isinstance(rigged.get("combined_animation_clips"), list) else []
    combined_names = {
        _clip_canonical_name(clip)
        for clip in combined_clips
        if isinstance(clip, dict) and _clip_canonical_name(clip)
    }
    expected_names = {str(item["canonical_name"]) for item in _MESHY_CHARACTER_ACTION_PRESET}
    missing_names = sorted(expected_names - combined_names)
    if set(requested_action_slots or []) == expected_names or set(requested_action_ids) == set(_MESHY_DEFAULT_CHARACTER_ACTION_IDS):
        rigged["expected_combined_animations"] = sorted(expected_names)
        rigged["missing_combined_animations"] = missing_names
        if not rigged.get("combined_model_url") or missing_names:
            raise RuntimeError(
                "Meshy six-action combined GLB was not created"
                f" (missing: {', '.join(missing_names) or 'combined_model_url'})"
            )
    return task_id, {**rigged, "raw": result}


def _call_meshy_provider(settings: dict[str, str], body: dict[str, Any], job_id: str) -> tuple[bool, dict[str, Any]]:
    prompt = _meshy_generation_prompt(body, _first_text(body.get("prompt")))
    timeout = _safe_int(_setting(settings, "world_3d_api_timeout_seconds", "WORLD_3D_API_TIMEOUT_SECONDS", "900"), 900, 30, 1800)
    user_id = _safe_int(body.get("_user_id"), 0, 0, 10**18)
    image_urls = _source_image_urls(body, user_id)
    image_url = image_urls[0] if image_urls else ""
    if not prompt and not image_url:
        raise HTTPException(status_code=400, detail="프롬프트 또는 참고 이미지가 필요합니다.")
    target_formats = ["glb"]
    kind = _first_text(body.get("kind") or "model")
    label = _first_text(body.get("title") or kind or "generated model")
    rig_character = _should_rig_character(settings, body)

    if len(image_urls) > 1:
        path = "/openapi/v1/multi-image-to-3d"
        _set_job_progress(job_id, step="multi-image-to-3d:create", message="Meshy multi-image-to-3D task create")
        payload = {
            "image_urls": image_urls,
            **_meshy_preview_options(settings, body, image_to_3d=True),
        }
        texture_prompt = _texture_prompt(settings, body, prompt)
        if texture_prompt:
            payload["texture_prompt"] = texture_prompt
        task_id = _create_meshy_task(settings, path, payload, timeout)
        result = _wait_meshy_task(
            settings=settings,
            path=path,
            task_id=task_id,
            timeout=timeout,
            progress_job_id=job_id,
            progress_step="multi-image-to-3d",
            progress_message="Meshy multi-image-to-3D model generation",
        )
        model_url = _meshy_model_url(result)
        if not model_url:
            raise RuntimeError("Meshy multi-image-to-3D result has no model URL.")
        metadata: dict[str, Any] = {
            "provider": "meshy",
            "task_id": task_id,
            "source": "multi-image-to-3d",
            "reference_image_count": len(image_urls),
            "raw": result,
            "output_contract": {
                **_output_contract_for_asset({"kind": kind}, kind),
                "actual_runtime_format": _meshy_model_format(result, model_url) or "glb",
            },
        }
        final_assets = [{
            "kind": kind,
            "label": label,
            "model_url": model_url,
            "thumbnail_url": _meshy_thumbnail_url(result),
            "status": "ready",
            "metadata": metadata,
        }]
        return True, {
            "provider": "meshy",
            "task_id": task_id,
            "kind": kind,
            "label": label,
            "model_url": model_url,
            "thumbnail_url": _meshy_thumbnail_url(result),
            "assets": final_assets,
        }

    if image_url:
        path = "/openapi/v1/image-to-3d"
        _set_job_progress(job_id, step="image-to-3d:create", message="Meshy image-to-3D 작업 생성 중")
        payload = {
            "image_url": image_url,
            **_meshy_preview_options(settings, body, image_to_3d=True),
        }
        texture_prompt = _texture_prompt(settings, body)
        if texture_prompt:
            payload["texture_prompt"] = texture_prompt
        elif (_is_character_kind(body) or rig_character) and _truthy(
            _setting(settings, "world_meshy_character_texture_from_reference", "MESHY_CHARACTER_TEXTURE_FROM_REFERENCE", "true"),
            True,
        ):
            payload["texture_image_url"] = image_url
        task_id = _create_meshy_task(settings, path, payload, timeout)
        result = _wait_meshy_task(
            settings=settings,
            path=path,
            task_id=task_id,
            timeout=timeout,
            progress_job_id=job_id,
            progress_step="image-to-3d",
            progress_message="Meshy image-to-3D 모델 생성 중",
        )
        model_url = _meshy_model_url(result)
        if not model_url:
            raise RuntimeError("Meshy image-to-3D 결과에 model URL이 없습니다.")
        metadata: dict[str, Any] = {
            "provider": "meshy",
            "task_id": task_id,
            "source": "image-to-3d",
            "raw": result,
            "output_contract": {
                **_output_contract_for_asset({"kind": kind}, kind),
                "actual_runtime_format": _meshy_model_format(result, model_url) or "glb",
            },
        }
        converted_asset = {
            "kind": kind,
            "label": f"{label} image-to-3D",
            "model_url": model_url,
            "thumbnail_url": _meshy_thumbnail_url(result),
            "status": "converted",
            "metadata": {
                **metadata,
                "stage": "image-to-3d",
                "is_intermediate": True,
            },
        }
        if body.get("_backend_owns_assets") or body.get("backend_owns_assets"):
            _set_job_progress(
                job_id,
                step="save-intermediate",
                message="image-to-3D 중간 모델 저장 중",
                provider_task_id=task_id,
                provider_status="SUCCEEDED",
            )
            saved_intermediate = _save_assets(
                int(user_id),
                _first_text(body.get("sig_id")),
                job_id,
                [converted_asset],
            )
            if saved_intermediate:
                converted_asset = {
                    **saved_intermediate[0],
                    "metadata": {
                        **(saved_intermediate[0].get("metadata") if isinstance(saved_intermediate[0].get("metadata"), dict) else {}),
                        "saved_by_agent": True,
                    },
                }
                _set_job_progress(
                    job_id,
                    step="save-intermediate",
                    message="image-to-3D 중간 모델 저장 완료",
                    provider_task_id=task_id,
                    provider_status="SUCCEEDED",
                    extra={
                        "asset_id": converted_asset.get("id"),
                        "asset_status": converted_asset.get("status"),
                    },
                )
            else:
                _set_job_progress(
                    job_id,
                    step="save-intermediate",
                    message="image-to-3D 중간 모델 저장 실패: DB 설정 또는 저장 결과 없음",
                    provider_task_id=task_id,
                    provider_status="SUCCEEDED",
                )
        if rig_character:
            try:
                rig_task_id, rigged = _rig_meshy_character(
                    settings=settings,
                    body=body,
                    input_task_id=task_id,
                    model_url=model_url,
                    timeout=timeout,
                    job_id=job_id,
                )
                metadata["rigging"] = {"task_id": rig_task_id, **rigged}
                for key in ("stored_model_url", "stored_model_bucket", "stored_model_key", "stored_model_mime_type", "stored_model_size"):
                    if rigged.get(key):
                        metadata[key] = rigged[key]
                metadata["original_model_url"] = model_url
                model_url = rigged["model_url"]
                metadata["output_contract"] = {
                    **(metadata.get("output_contract") if isinstance(metadata.get("output_contract"), dict) else {}),
                    "actual_runtime_format": rigged.get("runtime_format") or "glb",
                }
            except Exception as e:
                logger.warning("Meshy rigging skipped: %s", e)
                metadata["rigging"] = {"status": "skipped", "error": str(e)}
                converted_asset["metadata"] = {
                    **converted_asset["metadata"],
                    "rigging": metadata["rigging"],
                }
        final_assets = [converted_asset]
        if model_url and model_url != converted_asset.get("model_url"):
            final_assets.append({
                "kind": kind,
                "label": label,
                "model_url": model_url,
                "thumbnail_url": _meshy_thumbnail_url(result),
                "status": "ready",
                "metadata": metadata,
            })
        return True, {
            "provider": "meshy",
            "task_id": task_id,
            "kind": kind,
            "label": label,
            "model_url": model_url,
            "thumbnail_url": _meshy_thumbnail_url(result),
            "assets": final_assets,
        }

    path = "/openapi/v2/text-to-3d"
    _set_job_progress(job_id, step="preview:create", message="Meshy preview 작업 생성 중")
    preview_payload = {
        "mode": "preview",
        "prompt": prompt,
        "target_formats": target_formats,
        **_meshy_preview_options(settings, body),
    }
    preview_task_id = _create_meshy_task(settings, path, preview_payload, timeout)
    preview_result = _wait_meshy_task(
        settings=settings,
        path=path,
        task_id=preview_task_id,
        timeout=timeout,
        progress_job_id=job_id,
        progress_step="preview",
        progress_message="Meshy preview 모델 생성 중",
    )
    refine = _truthy(_setting(settings, "world_meshy_refine", "MESHY_REFINE", "true"), True) or rig_character
    final_task_id = preview_task_id
    final_result = preview_result
    if refine:
        _set_job_progress(job_id, step="refine:create", message="Meshy refine 작업 생성 중")
        refine_payload = {
            "mode": "refine",
            "preview_task_id": preview_task_id,
            "texture_prompt": _texture_prompt(settings, body, prompt),
            "target_formats": target_formats,
        }
        final_task_id = _create_meshy_task(settings, path, refine_payload, timeout)
        final_result = _wait_meshy_task(
            settings=settings,
            path=path,
            task_id=final_task_id,
            timeout=timeout,
            progress_job_id=job_id,
            progress_step="refine",
            progress_message="Meshy refine 모델 생성 중",
        )
    model_url = _meshy_model_url(final_result)
    if not model_url:
        raise RuntimeError("Meshy text-to-3D 결과에 model URL이 없습니다.")
    metadata = {
        "provider": "meshy",
        "task_id": final_task_id,
        "preview_task_id": preview_task_id,
        "source": "text-to-3d",
        "raw": final_result,
        "output_contract": {
            **_output_contract_for_asset({"kind": kind}, kind),
            "actual_runtime_format": _meshy_model_format(final_result, model_url) or "glb",
        },
    }
    base_3d_asset = {
        "kind": kind,
        "label": f"{label} 3D",
        "model_url": model_url,
        "thumbnail_url": _meshy_thumbnail_url(final_result),
        "status": "converted",
        "metadata": {
            **metadata,
            "stage": "text-to-3d",
            "is_intermediate": True,
        },
    }
    if body.get("_backend_owns_assets") or body.get("backend_owns_assets"):
        _set_job_progress(
            job_id,
            step="save-3d",
            message="3D 모델 저장 중",
            provider_task_id=final_task_id,
            provider_status="SUCCEEDED",
        )
        saved_base_3d = _save_assets(
            int(user_id),
            _first_text(body.get("sig_id")),
            job_id,
            [base_3d_asset],
        )
        if saved_base_3d:
            base_3d_asset = {
                **saved_base_3d[0],
                "metadata": {
                    **(saved_base_3d[0].get("metadata") if isinstance(saved_base_3d[0].get("metadata"), dict) else {}),
                    "saved_by_agent": True,
                },
            }
            _set_job_progress(
                job_id,
                step="save-3d",
                message="3D 모델 저장 완료",
                provider_task_id=final_task_id,
                provider_status="SUCCEEDED",
                extra={
                    "asset_id": base_3d_asset.get("id"),
                    "asset_status": base_3d_asset.get("status"),
                },
            )
    if rig_character:
        try:
            rig_task_id, rigged = _rig_meshy_character(
                settings=settings,
                body=body,
                input_task_id=final_task_id,
                model_url=model_url,
                timeout=timeout,
                job_id=job_id,
            )
            metadata["rigging"] = {"task_id": rig_task_id, **rigged}
            for key in ("stored_model_url", "stored_model_bucket", "stored_model_key", "stored_model_mime_type", "stored_model_size"):
                if rigged.get(key):
                    metadata[key] = rigged[key]
            metadata["original_model_url"] = model_url
            model_url = rigged["model_url"]
            metadata["output_contract"] = {
                **(metadata.get("output_contract") if isinstance(metadata.get("output_contract"), dict) else {}),
                "actual_runtime_format": rigged.get("runtime_format") or "glb",
            }
        except Exception as e:
            logger.warning("Meshy rigging skipped: %s", e)
            metadata["rigging"] = {"status": "skipped", "error": str(e)}
            base_3d_asset["metadata"] = {
                **(base_3d_asset.get("metadata") if isinstance(base_3d_asset.get("metadata"), dict) else {}),
                "rigging": metadata["rigging"],
            }
    final_assets = [base_3d_asset]
    if model_url and model_url != base_3d_asset.get("model_url"):
        final_assets.append({
            "kind": kind,
            "label": label,
            "model_url": model_url,
            "thumbnail_url": _meshy_thumbnail_url(final_result),
            "status": "ready",
            "metadata": metadata,
        })
    return True, {
        "provider": "meshy",
        "task_id": final_task_id,
        "preview_task_id": preview_task_id,
        "kind": kind,
        "label": label,
        "model_url": model_url,
        "thumbnail_url": _meshy_thumbnail_url(final_result),
        "assets": final_assets,
    }


def _call_meshy_rig_provider(settings: dict[str, str], body: dict[str, Any], job_id: str) -> tuple[bool, dict[str, Any]]:
    timeout = _safe_int(_setting(settings, "world_3d_api_timeout_seconds", "WORLD_3D_API_TIMEOUT_SECONDS", "900"), 900, 30, 1800)
    kind = _first_text(body.get("kind") or "character")
    label = _first_text(body.get("title") or body.get("label") or "rigged character")
    model_url = _first_text(body.get("source_model_url") or body.get("model_url"))
    if not model_url:
        raise HTTPException(status_code=400, detail="source_model_url is required for rig-only workflow")
    _set_job_progress(job_id, step="rigging:prepare", message="선택한 3D 모델 리깅 준비 중")
    rig_task_id, rigged = _rig_meshy_character(
        settings=settings,
        body={
            **body,
            "rig_character": True,
            "generate_basic_animations": body.get("generate_basic_animations", True),
        },
        input_task_id="",
        model_url=model_url,
        timeout=timeout,
        job_id=job_id,
    )
    metadata = {
        "provider": "meshy",
        "source": "rig-only",
        "source_asset_id": body.get("source_asset_id"),
        "original_model_url": model_url,
        "rigging": {"task_id": rig_task_id, **rigged},
        "output_contract": {
            **_output_contract_for_asset({"kind": kind}, kind),
            "actual_runtime_format": rigged.get("runtime_format") or "glb",
        },
    }
    for key in ("stored_model_url", "stored_model_bucket", "stored_model_key", "stored_model_mime_type", "stored_model_size"):
        if rigged.get(key):
            metadata[key] = rigged[key]
    return True, {
        "provider": "meshy",
        "task_id": rig_task_id,
        "kind": kind,
        "label": label,
        "model_url": rigged["model_url"],
        "thumbnail_url": "",
        "assets": [{
            "kind": kind,
            "label": f"{label} rigged",
            "model_url": rigged["model_url"],
            "thumbnail_url": "",
            "status": "ready",
            "metadata": metadata,
        }],
    }


def _is_server_owned_metadata_key(key: Any) -> bool:
    name = str(key or "").strip().lower()
    return (
        name in _SERVER_OWNED_METADATA_KEYS
        or name.startswith(_SERVER_OWNED_METADATA_PREFIXES)
        or name in {"url", "uri"}
        or name.endswith(("_url", "_urls", "_uri"))
    )


def _client_metadata_patch(patch: dict[str, Any]) -> dict[str, Any]:
    """Drop server-owned keys so a PATCH merge keeps the stored values for them."""
    return {key: value for key, value in patch.items() if not _is_server_owned_metadata_key(key)}


def _memory_job_owner_conflict(job_id: str, user_id: int) -> bool:
    existing = _MEMORY_JOBS.get(job_id)
    return existing is not None and int(existing.get("user_id") or -1) != int(user_id)


def _trim_memory_jobs() -> None:
    excess = len(_MEMORY_JOBS) - _MEMORY_JOB_LIMIT
    if excess <= 0:
        return
    finished = [job_id for job_id, job in _MEMORY_JOBS.items() if job.get("status") in _TERMINAL_JOB_STATUSES]
    for job_id in finished[:excess]:
        _MEMORY_JOBS.pop(job_id, None)


def _save_job(job: dict[str, Any]) -> None:
    """Persist a job. A job id owned by another user is never overwritten (409)."""
    job_id = str(job["job_id"])
    owner = int(job["user_id"])
    with _MEMORY_LOCK:
        if _memory_job_owner_conflict(job_id, owner):
            raise HTTPException(status_code=409, detail=_JOB_ID_TAKEN)
    if db.is_configured():
        affected: Optional[int] = None
        try:
            affected = db.execute(
                """
                INSERT INTO world_generation_job (
                    id, user_id, sig_id, session_id, kind, source_image_asset_id, prompt, status,
                    provider_configured, provider_payload_json, plan_json, error_message
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                    status = EXCLUDED.status,
                    provider_configured = EXCLUDED.provider_configured,
                    provider_payload_json = EXCLUDED.provider_payload_json,
                    plan_json = EXCLUDED.plan_json,
                    error_message = EXCLUDED.error_message,
                    updated_at = CURRENT_TIMESTAMP
                WHERE world_generation_job.user_id = EXCLUDED.user_id
                """,
                (
                    job_id,
                    owner,
                    job.get("sig_id") or None,
                    job.get("session_id") or None,
                    job.get("kind") or "house",
                    job.get("source_image_asset_id") or None,
                    job.get("prompt") or "",
                    job.get("status") or "planned",
                    bool(job.get("provider_configured")),
                    _json(job.get("provider_payload") or {}),
                    _json(job.get("plan") or {}),
                    job.get("error") or None,
                ),
            )
        except Exception as e:
            logger.warning("world_generation_job save failed: %s", e)
        if affected == 0:
            # The id exists and belongs to another user; the guarded upsert left it untouched.
            raise HTTPException(status_code=409, detail=_JOB_ID_TAKEN)
    with _MEMORY_LOCK:
        if _memory_job_owner_conflict(job_id, owner):
            raise HTTPException(status_code=409, detail=_JOB_ID_TAKEN)
        _MEMORY_JOBS[job_id] = job
        _trim_memory_jobs()


def _set_job_progress(
    job_id: str,
    *,
    step: str,
    message: str,
    provider_task_id: str = "",
    provider_status: str = "",
    elapsed_seconds: int = 0,
    status: str = "running",
    extra: Optional[dict[str, Any]] = None,
) -> None:
    job = _MEMORY_JOBS.get(job_id)
    if not job:
        return
    provider_payload = job.get("provider_payload") if isinstance(job.get("provider_payload"), dict) else {}
    progress = {
        "step": step,
        "message": message,
        "provider_task_id": provider_task_id,
        "provider_status": provider_status,
        "elapsed_seconds": elapsed_seconds,
        "updated_at": _now_ms(),
    }
    if extra:
        progress.update(extra)
    job["status"] = status
    job["provider_payload"] = {**provider_payload, "progress": progress}
    _save_job(job)


def _prepare_world_asset_item(user_id: int, sig_id: str, job_id: str, asset: dict[str, Any]) -> dict[str, Any]:
    kind = _first_text(asset.get("kind") or "model")
    label = _first_text(asset.get("label") or asset.get("title") or kind)
    metadata = _merge_output_contract(asset, kind)
    output_contract = metadata.get("output_contract") if isinstance(metadata.get("output_contract"), dict) else {}
    actual_runtime_format = _runtime_format_from_model_url(asset.get("model_url")) or _first_text(output_contract.get("actual_runtime_format"))
    if actual_runtime_format:
        metadata["output_contract"] = {
            **output_contract,
            "actual_runtime_format": actual_runtime_format,
        }
    naming = {
        **_asset_naming(asset, kind, label),
        **(metadata.get("naming") if isinstance(metadata.get("naming"), dict) else {}),
    }
    item = {
        "id": asset.get("id"),
        "user_id": user_id,
        "sig_id": sig_id,
        "job_id": job_id,
        "kind": kind or "model",
        "source_image_asset_id": asset.get("source_image_asset_id"),
        "label": label,
        "model_url": asset.get("model_url") or "",
        "thumbnail_url": asset.get("thumbnail_url") or "",
        "metadata": {
            **metadata,
            "naming": naming,
        },
        "status": asset.get("status") or "ready",
    }
    _ensure_runtime_glb_asset(item)
    item = _stabilize_world_asset_model_url(item)
    item = _stabilize_world_asset_animation_urls(item)
    return item


def _save_assets(user_id: int, sig_id: str, job_id: str, assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    saved: list[dict[str, Any]] = []
    for asset in assets:
        item = _prepare_world_asset_item(user_id, sig_id, job_id, asset)
        if db.is_configured():
            try:
                item["id"] = db.execute_returning_id(
                    """
                    INSERT INTO world_asset (
                        user_id, sig_id, job_id, kind, source_image_asset_id, label, model_url,
                        thumbnail_url, metadata_json, status
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING id
                    """,
                    (
                        user_id,
                        sig_id or None,
                        job_id,
                        item["kind"],
                        item.get("source_image_asset_id") or None,
                        item["label"],
                        item["model_url"],
                        item["thumbnail_url"],
                        _json(item["metadata"]),
                        item["status"],
                    ),
                )
            except Exception as e:
                logger.warning("world_asset save failed: %s", e)
        if not item.get("id"):
            item["id"] = next(_MEMORY_ASSET_IDS)
        with _MEMORY_LOCK:
            _MEMORY_ASSETS.append(item)
            if len(_MEMORY_ASSETS) > _MEMORY_ASSET_LIMIT:
                del _MEMORY_ASSETS[: len(_MEMORY_ASSETS) - _MEMORY_ASSET_LIMIT]
        saved.append(item)
    return saved


def _job_from_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "job_id": row.get("id"),
        "user_id": int(row.get("user_id") or 0),
        "sig_id": row.get("sig_id") or "",
        "session_id": row.get("session_id") or "",
        "kind": row.get("kind") or "house",
        "source_image_asset_id": row.get("source_image_asset_id"),
        "prompt": row.get("prompt") or "",
        "status": row.get("status") or "planned",
        "provider_configured": bool(row.get("provider_configured")),
        "provider_payload": _parse_json(row.get("provider_payload_json"), {}),
        "plan": _parse_json(row.get("plan_json"), {}),
        "error": row.get("error_message") or "",
    }


def _get_job(job_id: str, user: UserContext) -> dict[str, Any]:
    job = _MEMORY_JOBS.get(job_id)
    if db.is_configured():
        try:
            row = db.fetch_one(
                "SELECT * FROM world_generation_job WHERE id=%s AND user_id=%s",
                (job_id, int(user.user_id)),
            )
            if row:
                job = _job_from_row(row)
        except Exception as e:
            logger.warning("world_generation_job fetch failed: %s", e)
    if not job or int(job.get("user_id") or -1) != int(user.user_id):
        raise HTTPException(status_code=404, detail="월드 생성 작업을 찾을 수 없습니다.")
    return job


def _response(job: dict[str, Any], assets: Optional[list[dict[str, Any]]] = None) -> dict[str, Any]:
    plan = job.get("plan") or {}
    provider_payload = job.get("provider_payload") if isinstance(job.get("provider_payload"), dict) else {}
    return {
        "job_id": job["job_id"],
        "status": job.get("status") or "planned",
        "provider_configured": bool(job.get("provider_configured")),
        "plan": plan,
        "assets": assets if assets is not None else plan.get("assets", []),
        "error": job.get("error") or "",
        "progress": provider_payload.get("progress") if isinstance(provider_payload.get("progress"), dict) else {},
    }


@router.post("/world/textures/generate")
def world_generate_texture(
    body: dict[str, Any] = Body(default_factory=dict),
    user: UserContext = Depends(get_current_user),
):
    prompt = str(body.get("prompt") or "").strip()
    kind = _clean_texture_kind(body.get("kind") or body.get("texture_kind"))
    palette = body.get("palette") if isinstance(body.get("palette"), dict) else {}
    primary, accent, dark = _TEXTURE_KIND_PALETTES[kind]
    primary = str(palette.get("primary") or body.get("primary_color") or primary)
    accent = str(palette.get("accent") or body.get("accent_color") or accent)
    dark = str(palette.get("dark") or body.get("dark_color") or dark)
    svg = _texture_svg_pattern(kind, prompt, primary, accent, dark)
    texture_url = _texture_data_url(svg)
    material_id = f"world-texture-{kind}-{uuid.uuid4().hex[:8]}"
    return {
        "material_id": material_id,
        "name": body.get("name") or f"{kind.replace('_', ' ').title()} Material",
        "kind": kind,
        "texture_url": texture_url,
        "color": primary,
        "roughness": 0.82 if kind in {"brick", "castle_stone"} else 0.58,
        "metalness": 0.0,
        "provider_configured": True,
        "metadata": {
            "source": "signight-world-texture-agent",
            "prompt": prompt,
            "owner_user_id": getattr(user, "user_id", None),
            "palette": {"primary": primary, "accent": accent, "dark": dark},
        },
    }


@router.post("/world/generate")
def world_generate(
    body: dict[str, Any] = Body(...),
    user: UserContext = Depends(get_current_user),
):
    prompt = (body.get("prompt") or "").strip()
    has_reference = bool(
        body.get("source_image_asset_id")
        or (body.get("reference_image_url") or "").strip()
        or body.get("image_url")
        or body.get("reference_images")
    )
    if not prompt and not has_reference:
        raise HTTPException(status_code=400, detail="프롬프트 또는 참고 이미지가 필요합니다.")
    kind = (body.get("kind") or "house").strip()
    if kind not in _VALID_KINDS:
        raise HTTPException(status_code=400, detail="지원하지 않는 world kind 입니다.")

    settings = _settings()
    requested_job_id = _first_text(body.get("client_job_id") or body.get("job_id") or body.get("session_id"))
    job_id = requested_job_id if requested_job_id and all(ch.isalnum() or ch in "-_" for ch in requested_job_id) else _job_id()
    body = dict(body)
    body["kind"] = kind
    body["prompt"] = prompt
    body["_user_id"] = int(user.user_id)
    provider_configured = False
    provider_payload: dict[str, Any] = {}
    error = ""
    status = "planned"
    _save_job({
        "job_id": job_id,
        "user_id": int(user.user_id),
        "sig_id": (body.get("sig_id") or "").strip(),
        "session_id": (body.get("session_id") or "").strip(),
        "kind": kind,
        "source_image_asset_id": body.get("source_image_asset_id") or None,
        "prompt": prompt,
        "status": "queued",
        "provider_configured": True,
        "provider_payload": {"progress": {"step": "queued", "message": "생성 요청 접수", "updated_at": _now_ms()}},
        "plan": {"id": job_id, "assets": []},
        "error": "",
    })
    try:
        _set_job_progress(job_id, step="provider", message="3D provider 준비 중")
        if _part_bundle_requested(body) and kind in _CHARACTER_KINDS:
            provider_configured, provider_payload = _call_part_bundle_provider(settings, body, job_id)
        else:
            provider_configured, provider_payload = _call_provider(settings, body, job_id)
        status = "done" if provider_configured else "planned"
    except Exception as e:
        logger.warning("world 3d provider failed: %s", e)
        provider_configured = True
        status = "error"
        error = str(e)

    _set_job_progress(job_id, step="compose", message="생성 결과 정리 중")
    plan = compose_world_plan(body, provider_payload)
    plan["id"] = job_id
    plan_assets = plan.get("assets") if isinstance(plan.get("assets"), list) else []
    for asset in plan_assets:
        if isinstance(asset, dict) and not asset.get("source_image_asset_id"):
            asset["source_image_asset_id"] = body.get("source_image_asset_id") or None
    backend_owns_assets = bool(body.get("_backend_owns_assets") or body.get("backend_owns_assets"))
    if backend_owns_assets:
        saved_assets = []
        _set_job_progress(job_id, step="prepare-assets", message="모델 URL 안정화 중")
        response_assets = [
            _prepare_world_asset_item(int(user.user_id), body.get("sig_id") or "", job_id, asset)
            for asset in plan_assets
            if isinstance(asset, dict)
        ]
        plan["assets"] = response_assets
    else:
        _set_job_progress(job_id, step="save-assets", message="모델/애니메이션 저장 중")
        saved_assets = _save_assets(int(user.user_id), body.get("sig_id") or "", job_id, plan_assets)
        response_assets = saved_assets
        if saved_assets:
            plan["assets"] = saved_assets

    job = {
        "job_id": job_id,
        "user_id": int(user.user_id),
        "sig_id": (body.get("sig_id") or "").strip(),
        "session_id": (body.get("session_id") or "").strip(),
        "kind": kind,
        "source_image_asset_id": body.get("source_image_asset_id") or None,
        "prompt": prompt,
        "status": status,
        "provider_configured": provider_configured,
        "provider_payload": provider_payload,
        "plan": plan,
        "error": error,
    }
    if status == "done":
        job["provider_payload"] = {
            **(job.get("provider_payload") if isinstance(job.get("provider_payload"), dict) else {}),
            "progress": {"step": "done", "message": "생성 완료", "updated_at": _now_ms()},
        }
    _save_job(job)
    return _response(job, response_assets)


@router.get("/world/jobs/{job_id}")
def world_job(job_id: str, user: UserContext = Depends(get_current_user)):
    return _response(_get_job(job_id, user))


@router.get("/world/jobs/{job_id}/stream")
def world_job_stream(job_id: str, user: UserContext = Depends(get_current_user)):
    def _events():
        last_progress_key = ""
        started_at = time.time()
        try:
            while True:
                try:
                    job = _get_job(job_id, user)
                except HTTPException as e:
                    if e.status_code == 404 and time.time() - started_at < 60:
                        progress = {
                            "step": "waiting",
                            "message": "generation request pending",
                            "updated_at": _now_ms(),
                        }
                        progress_key = _json({"status": "waiting", "progress": progress})
                        if progress_key != last_progress_key:
                            last_progress_key = progress_key
                            yield sse_status(
                                progress["message"],
                                job_id=job_id,
                                status="waiting",
                                progress=progress,
                            )
                        time.sleep(1)
                        continue
                    raise
                response = _response(job)
                progress = response.get("progress") if isinstance(response.get("progress"), dict) else {}
                progress_key = _json({
                    "status": response.get("status"),
                    "progress": progress,
                    "error": response.get("error"),
                })
                if progress_key != last_progress_key:
                    last_progress_key = progress_key
                    yield sse_status(
                        progress.get("message") or response.get("status") or "running",
                        job_id=job_id,
                        status=response.get("status"),
                        progress=progress,
                    )
                if response.get("error"):
                    yield sse_error(response["error"])
                    return
                if response.get("status") in {"done", "planned", "error"}:
                    yield sse_done(response)
                    return
                time.sleep(2)
        except Exception as e:
            yield sse_error(str(e))

    return sse_response(_events())


@router.get("/world/animations/catalog")
def world_animation_catalog(
    sync: bool = Query(False, description="Fetch Meshy catalog and upsert DB relation tables"),
    user: UserContext = Depends(get_current_user),
):
    _ = user
    settings = _settings()
    timeout = _safe_int(_setting(settings, "world_3d_api_timeout_seconds", "WORLD_3D_API_TIMEOUT_SECONDS", "900"), 900, 30, 1800)
    try:
        return _meshy_animation_catalog_payload(settings, sync=sync, timeout=timeout)
    except Exception as e:
        logger.warning("world animation catalog failed: %s", e)
        if _MESHY_ANIMATION_CATALOG_MEMORY:
            default_by_slot = {str(item["canonical_name"]): int(item["action_id"]) for item in _MESHY_CHARACTER_ACTION_PRESET}
            return {
                "items": _MESHY_ANIMATION_CATALOG_MEMORY,
                "slots": [
                    {
                        "slot": slot_key,
                        "default_action_id": default_by_slot.get(slot_key),
                        "options": _MESHY_ANIMATION_CATALOG_MEMORY,
                    }
                    for slot_key in _MESHY_ANIMATION_SLOT_KEYS
                ],
                "total": len(_MESHY_ANIMATION_CATALOG_MEMORY),
            }
        raise HTTPException(status_code=502, detail="Meshy animation catalog could not be loaded.") from e


@router.get("/world/assets")
def world_assets(
    sig_id: str = Query("", description="SIG/category id"),
    kind: str = Query("", description="asset kind"),
    scope: str = Query("sig", description="mine | sig"),
    user: UserContext = Depends(get_current_user),
):
    safe_scope = (scope or "sig").strip().lower()
    if db.is_configured():
        where: list[str] = []
        params: list[Any] = []
        if safe_scope == "mine" or not sig_id:
            where.append("user_id=%s")
            params.append(int(user.user_id))
            if sig_id:
                where.append("sig_id=%s")
                params.append(sig_id)
        elif sig_id:
            where.append("sig_id=%s")
            params.append(sig_id)
        if kind:
            where.append("kind=%s")
            params.append(kind)
        if not where:
            where = ["user_id=%s"]
            params = [int(user.user_id)]
        try:
            rows = db.fetch_all(
                f"""
                SELECT id, kind, source_image_asset_id, label, model_url, thumbnail_url, metadata_json, status, created_at
                FROM world_asset
                WHERE {' AND '.join(where)}
                ORDER BY id DESC
                LIMIT 100
                """,
                tuple(params),
            )
            return {"items": [
                {
                    "id": int(r["id"]),
                    "kind": r.get("kind") or "",
                    "source_image_asset_id": r.get("source_image_asset_id"),
                    "label": r.get("label") or "",
                    "model_url": r.get("model_url") or "",
                    "thumbnail_url": r.get("thumbnail_url") or "",
                    "metadata": _parse_json(r.get("metadata_json"), {}),
                    "status": r.get("status") or "ready",
                    "created_at": str(r.get("created_at") or ""),
                }
                for r in rows
            ]}
        except Exception as e:
            logger.warning("world_asset list failed: %s", e)
    items = [
        a for a in _MEMORY_ASSETS
        if (
            int(a.get("user_id") or -1) == int(user.user_id)
            if safe_scope == "mine" or not sig_id
            else a.get("sig_id") == sig_id
        )
        and (not sig_id or a.get("sig_id") == sig_id)
        and (not kind or a.get("kind") == kind)
    ]
    return {"items": items[-100:][::-1]}


@router.patch("/world/assets/{asset_id}")
def world_update_asset(
    asset_id: int,
    body: dict[str, Any] = Body(...),
    user: UserContext = Depends(get_current_user),
):
    label = _first_text(body.get("label"))
    description = _first_text(body.get("description"))
    metadata_patch = _client_metadata_patch(body["metadata"]) if isinstance(body.get("metadata"), dict) else None
    if db.is_configured():
        try:
            row = db.fetch_one(
                """
                SELECT id, kind, source_image_asset_id, label, model_url, thumbnail_url,
                       metadata_json, status, created_at
                FROM world_asset
                WHERE id=%s AND user_id=%s
                """,
                (asset_id, int(user.user_id)),
            )
            if not row:
                raise HTTPException(status_code=404, detail="world asset not found")
            metadata = _parse_json(row.get("metadata_json"), {})
            if not isinstance(metadata, dict):
                metadata = {}
            if metadata_patch:
                metadata = {**metadata, **metadata_patch}
            if description:
                metadata["description"] = description
            next_label = label or row.get("label") or ""
            db.execute(
                """
                UPDATE world_asset
                SET label=%s, metadata_json=%s
                WHERE id=%s AND user_id=%s
                """,
                (next_label, _json(metadata), asset_id, int(user.user_id)),
            )
            return {
                "id": int(row["id"]),
                "kind": row.get("kind") or "",
                "source_image_asset_id": row.get("source_image_asset_id"),
                "label": next_label,
                "model_url": row.get("model_url") or "",
                "thumbnail_url": row.get("thumbnail_url") or "",
                "metadata": metadata,
                "status": row.get("status") or "ready",
                "created_at": str(row.get("created_at") or ""),
            }
        except HTTPException:
            raise
        except Exception as e:
            logger.warning("world_asset update failed: %s", e)
            raise HTTPException(status_code=500, detail="world asset update failed") from e

    for asset in _MEMORY_ASSETS:
        if int(asset.get("id") or 0) != asset_id or int(asset.get("user_id") or -1) != int(user.user_id):
            continue
        metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
        if metadata_patch:
            metadata = {**metadata, **metadata_patch}
        if description:
            metadata["description"] = description
        asset["metadata"] = metadata
        if label:
            asset["label"] = label
        return asset
    raise HTTPException(status_code=404, detail="world asset not found")


@router.delete("/world/assets/{asset_id}")
def world_delete_asset(
    asset_id: int,
    user: UserContext = Depends(get_current_user),
):
    if db.is_configured():
        try:
            deleted = db.execute(
                "DELETE FROM world_asset WHERE id=%s AND user_id=%s",
                (asset_id, int(user.user_id)),
            )
            if not deleted:
                raise HTTPException(status_code=404, detail="world asset not found")
            return {"status": "deleted", "id": asset_id}
        except HTTPException:
            raise
        except Exception as e:
            logger.warning("world_asset delete failed: %s", e)
            raise HTTPException(status_code=500, detail="world asset delete failed") from e

    before = len(_MEMORY_ASSETS)
    _MEMORY_ASSETS[:] = [
        asset
        for asset in _MEMORY_ASSETS
        if not (
            int(asset.get("id") or 0) == asset_id
            and int(asset.get("user_id") or -1) == int(user.user_id)
        )
    ]
    if len(_MEMORY_ASSETS) == before:
        raise HTTPException(status_code=404, detail="world asset not found")
    return {"status": "deleted", "id": asset_id}


@router.get("/world/assets/{asset_id}/model")
def world_asset_model_proxy(
    asset_id: int,
    user: UserContext = Depends(get_current_user),
):
    model_url = ""
    metadata: dict[str, Any] = {}
    if db.is_configured():
        try:
            row = db.fetch_one(
                """
                SELECT model_url, metadata_json
                FROM world_asset
                WHERE id=%s AND user_id=%s
                """,
                (asset_id, int(user.user_id)),
            )
            model_url = (row.get("model_url") if row else "") or ""
            metadata = _parse_json(row.get("metadata_json") if row else None, {})
        except Exception as e:
            logger.warning("world_asset model lookup failed: %s", e)
    if not model_url:
        for asset in _MEMORY_ASSETS:
            if int(asset.get("id") or -1) == int(asset_id) and int(asset.get("user_id") or -1) == int(user.user_id):
                model_url = asset.get("model_url") or ""
                metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
                break
    if not model_url:
        raise HTTPException(status_code=404, detail="3D 모델을 찾을 수 없습니다.")

    stored_model_url = str(metadata.get("stored_model_url") or "").strip()
    if stored_model_url:
        model_url = stored_model_url

    settings = _settings()
    try:
        stored = _stored_model_bytes(metadata)
        content, mime = stored if stored else _fetch_proxied_model_bytes(model_url, settings)
    except Exception as e:
        logger.warning("world_asset model proxy failed: asset_id=%s url=%s error=%s", asset_id, redact_url(model_url), e)
        refreshed_url, refreshed_metadata = _refresh_world_asset_model_from_provider(asset_id, int(user.user_id), metadata)
        if not refreshed_url:
            raise HTTPException(status_code=502, detail="3D model source could not be loaded.") from e
        try:
            stored = _stored_model_bytes(refreshed_metadata)
            content, mime = stored if stored else _fetch_proxied_model_bytes(refreshed_url, settings)
        except Exception as retry_error:
            logger.warning("world_asset refreshed model proxy failed: asset_id=%s error=%s", asset_id, retry_error)
            raise HTTPException(status_code=502, detail="3D model source could not be loaded.") from retry_error
    return Response(
        content=content,
        media_type=mime,
        headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/world/assets/{asset_id}/animations/{clip_index}/model")
def world_asset_animation_model_proxy(
    asset_id: int,
    clip_index: int,
    user: UserContext = Depends(get_current_user),
):
    metadata: dict[str, Any] = {}
    if db.is_configured():
        try:
            row = db.fetch_one(
                """
                SELECT metadata_json
                FROM world_asset
                WHERE id=%s AND user_id=%s
                """,
                (asset_id, int(user.user_id)),
            )
            metadata = _parse_json(row.get("metadata_json") if row else None, {})
        except Exception as e:
            logger.warning("world_asset animation lookup failed: %s", e)
    if not metadata:
        for asset in _MEMORY_ASSETS:
            if int(asset.get("id") or -1) == int(asset_id) and int(asset.get("user_id") or -1) == int(user.user_id):
                metadata = asset.get("metadata") if isinstance(asset.get("metadata"), dict) else {}
                break
    if not metadata:
        raise HTTPException(status_code=404, detail="3D 에셋을 찾을 수 없습니다.")

    rigging = metadata.get("rigging") if isinstance(metadata.get("rigging"), dict) else {}
    clips = rigging.get("animation_clips") if isinstance(rigging.get("animation_clips"), list) else []
    if clip_index < 0 or clip_index >= len(clips):
        raise HTTPException(status_code=404, detail="애니메이션 클립을 찾을 수 없습니다.")
    clip = clips[clip_index] if isinstance(clips[clip_index], dict) else {}
    model_url = _first_text(
        clip.get("model_url")
        or clip.get("glb_url")
        or clip.get("url")
        or clip.get("animation_url")
        or clip.get("armature_glb_url")
    )
    if not model_url:
        raise HTTPException(status_code=404, detail="애니메이션 모델 URL이 없습니다.")
    try:
        content, mime = _fetch_proxied_model_bytes(model_url, _settings())
    except Exception as e:
        logger.warning("world_asset animation proxy failed: asset_id=%s clip_index=%s url=%s error=%s", asset_id, clip_index, redact_url(model_url), e)
        raise HTTPException(status_code=502, detail="Animation model source could not be loaded.") from e
    return Response(
        content=content,
        media_type=mime,
        headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"},
    )


@router.post("/world/placements")
def world_save_placement(
    body: dict[str, Any] = Body(...),
    user: UserContext = Depends(get_current_user),
):
    plan = body.get("plan")
    if not isinstance(plan, dict):
        raise HTTPException(status_code=400, detail="plan은 필수입니다.")
    sig_id = (body.get("sig_id") or plan.get("sig_id") or "").strip()
    owner = int(user.user_id)
    job_id = (body.get("job_id") or plan.get("id") or "").strip()
    # A SIG keeps one row per user: the first saver owns "sig-<id>", later users get their own row.
    # /world/placements/latest still returns the newest plan in the SIG.
    candidates = [f"sig-{sig_id}", f"sig-{sig_id}-u{owner}"] if sig_id else [_job_id()]
    for placement_id in candidates:
        with _MEMORY_LOCK:
            existing = _MEMORY_PLACEMENTS.get(placement_id)
            if existing is not None and int(existing.get("user_id") or -1) != owner:
                continue
        if db.is_configured():
            affected: Optional[int] = None
            try:
                affected = db.execute(
                    """
                    INSERT INTO world_placement (id, user_id, sig_id, job_id, plan_json)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                        plan_json=EXCLUDED.plan_json,
                        updated_at=CURRENT_TIMESTAMP
                    WHERE world_placement.user_id = EXCLUDED.user_id
                    """,
                    (
                        placement_id,
                        owner,
                        sig_id or None,
                        job_id or None,
                        _json(plan),
                    ),
                )
            except Exception as e:
                logger.warning("world_placement save failed: %s", e)
            if affected == 0:
                continue
        payload = {
            "placement_id": placement_id,
            "user_id": owner,
            "sig_id": sig_id,
            "job_id": job_id,
            "plan": plan,
            "created_at": _now_ms(),
        }
        with _MEMORY_LOCK:
            existing = _MEMORY_PLACEMENTS.get(placement_id)
            if existing is not None and int(existing.get("user_id") or -1) != owner:
                continue
            _MEMORY_PLACEMENTS.pop(placement_id, None)
            _MEMORY_PLACEMENTS[placement_id] = payload
            while len(_MEMORY_PLACEMENTS) > _MEMORY_PLACEMENT_LIMIT:
                _MEMORY_PLACEMENTS.pop(next(iter(_MEMORY_PLACEMENTS)))
        return {"status": "saved", "placement_id": placement_id}
    raise HTTPException(status_code=409, detail="이 시그 월드 배치는 다른 사용자가 소유하고 있습니다.")


@router.get("/world/placements/latest")
def world_latest_placement(
    sig_id: str = Query("", description="SIG/category id"),
    user: UserContext = Depends(get_current_user),
):
    if not sig_id:
        raise HTTPException(status_code=400, detail="sig_id는 필수입니다.")

    if db.is_configured():
        try:
            row = db.fetch_one(
                """
                SELECT id, user_id, sig_id, job_id, plan_json, created_at, updated_at
                FROM world_placement
                WHERE sig_id=%s
                ORDER BY updated_at DESC, created_at DESC
                LIMIT 1
                """,
                (sig_id,),
            )
            if row:
                return {
                    "placement_id": row.get("id"),
                    "sig_id": row.get("sig_id") or sig_id,
                    "job_id": row.get("job_id") or "",
                    "owner_user_id": int(row.get("user_id") or 0),
                    "plan": _parse_json(row.get("plan_json"), {}),
                    "updated_at": str(row.get("updated_at") or row.get("created_at") or ""),
                }
        except Exception as e:
            logger.warning("world_placement latest fetch failed: %s", e)

    with _MEMORY_LOCK:
        candidates = [p for p in _MEMORY_PLACEMENTS.values() if p.get("sig_id") == sig_id]
    if not candidates:
        raise HTTPException(status_code=404, detail="저장된 시그 월드가 없습니다.")
    latest = sorted(candidates, key=lambda item: int(item.get("created_at") or 0), reverse=True)[0]
    return {
        "placement_id": latest.get("placement_id"),
        "sig_id": sig_id,
        "job_id": latest.get("job_id") or "",
        "owner_user_id": int(latest.get("user_id") or 0),
        "plan": latest.get("plan") or {},
        "updated_at": str(latest.get("created_at") or ""),
    }


__all__ = (
    "router",
    "compose_world_plan",
    "world_generate",
    "world_job",
    "world_animation_catalog",
    "world_assets",
    "world_save_placement",
    "world_latest_placement",
)
