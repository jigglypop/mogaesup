"""GLB container reading shared by generation and offline delivery checks."""

from __future__ import annotations

import json
import struct
from typing import Any


def build_glb(doc: dict, binary: bytes) -> bytes:
    encoded = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    encoded += b" " * (-len(encoded) % 4)
    binary += b"\0" * (-len(binary) % 4)
    return (struct.pack("<III", 0x46546C67, 2, 28 + len(encoded) + len(binary))
            + struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
            + struct.pack("<II", len(binary), 0x004E4942) + binary)


def parse_glb(data: bytes, *, strict: bool = False) -> tuple[dict[str, Any], bytes]:
    if len(data) < 20:
        raise ValueError("GLB is too small")
    magic, version, total_length = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67 or version != 2:
        raise ValueError("unsupported GLB header")
    if total_length > len(data):
        raise ValueError("truncated GLB")
    if strict and total_length != len(data):
        raise ValueError("GLB length does not match file size")
    offset = 12
    doc = None
    binary = b""
    seen: list[int] = []
    while offset + 8 <= min(total_length, len(data)):
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        if strict:
            if chunk_length % 4 or offset + chunk_length > total_length:
                raise ValueError("invalid GLB chunk length")
            if not seen and chunk_type != 0x4E4F534A:
                raise ValueError("GLB JSON chunk must be first")
            if chunk_type in {0x4E4F534A, 0x004E4942} and chunk_type in seen:
                raise ValueError("duplicate GLB chunk")
            if chunk_type == 0x004E4942 and len(seen) != 1:
                raise ValueError("GLB BIN chunk must be second")
        chunk = data[offset:offset + chunk_length]
        offset += chunk_length
        seen.append(chunk_type)
        if chunk_type == 0x4E4F534A:
            parsed = json.loads(chunk.decode("utf-8").rstrip(" \t\r\n" if strict else " \t\r\n\x00"))
            if not isinstance(parsed, dict):
                raise ValueError("GLB JSON chunk is not an object")
            doc = parsed
        elif chunk_type == 0x004E4942:
            binary = chunk
    if doc is None:
        raise ValueError("GLB JSON chunk is missing")
    if strict and offset != total_length:
        raise ValueError("incomplete GLB chunk header")
    return doc, binary
