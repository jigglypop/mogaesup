"""Image-reference and object-storage helpers used by the 3D pipeline."""

from __future__ import annotations

import base64
import io
import ipaddress
import json
import logging
import os
import re
import socket
import time
import uuid
from contextlib import suppress
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from threading import Lock
from typing import Any, Iterable, Mapping, Optional

import httpx
import requests
from fastapi import HTTPException
from urllib3.exceptions import NewConnectionError

from src import db


def resolve_openai_api_key(settings: Optional[dict] = None) -> str:
    return db.setting_or_env("openai_api_key", "OPENAI_API_KEY", "", settings=settings)


logger = logging.getLogger(__name__)


_GEMINI_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta"


_GEMINI_FALLBACK_BASES = (
    _GEMINI_DEFAULT_BASE,
    "https://generativelanguage.googleapis.com/v1",
)


_IMAGE_MODEL_HARD_FALLBACKS = (
    "gemini-3.1-flash-image-preview",
    "gemini-3-pro-image-preview",
    "gemini-2.5-flash-image",
)


_MODEL_ALIAS_HARD_FALLBACKS = {
    "image": {
        "nano banana": "gemini-3.1-flash-image-preview",
        "nano-banana": "gemini-3.1-flash-image-preview",
        "nano-banana-fast": "gemini-3.1-flash-image-preview",
        "nano banana fast": "gemini-3.1-flash-image-preview",
        "nanobanana": "gemini-3.1-flash-image-preview",
        "nanobananafast": "gemini-3.1-flash-image-preview",
        "나노바나나": "gemini-3.1-flash-image-preview",
        "나노바나나 패스트": "gemini-3.1-flash-image-preview",
        "gpt image 2": "gpt-image-2",
        "gpt image 2.0": "gpt-image-2",
        "gpt image2": "gpt-image-2",
        "gpt-image-2.0": "gpt-image-2",
        "gpt-image2": "gpt-image-2",
        "gptimage20": "gpt-image-2",
        "gptimage2": "gpt-image-2",
    },
}


_catalog_cache: dict[str, Any] = {"ts": 0.0, "data": {}}


_catalog_lock = Lock()


_CATALOG_TTL = 60.0


def _model_alias_key(value: str) -> str:
    return " ".join((value or "").strip().lower().replace("_", "-").split())


def _model_alias_compact_key(value: str) -> str:
    return "".join(ch for ch in _model_alias_key(value) if ch.isalnum())


def _load_model_catalog(modality: str) -> list[dict[str, Any]]:
    """`media_model_catalog` 의 활성 모델 목록을 정렬 순으로 반환.

    DB 미설정/테이블 미존재 등 모든 실패 케이스에서는 빈 리스트를 돌려준다.
    호출자는 빈 리스트일 때 `_*_HARD_FALLBACKS` 로 대체한다.
    """
    now = time.time()
    with _catalog_lock:
        cached = _catalog_cache["data"].get(modality)
        if cached is not None and now - _catalog_cache["ts"] < _CATALOG_TTL:
            return cached
    try:
        rows = db.fetch_all(
            "SELECT id, modality, provider, model_id, label, description, is_default,"
            " is_enabled, sort_order, extra"
            " FROM media_model_catalog"
            " WHERE modality=%s AND is_enabled=TRUE"
            " ORDER BY sort_order ASC, id ASC",
            (modality,),
        )
    except Exception as e:
        logger.warning("media_model_catalog load failed (modality=%s): %s", modality, e)
        rows = []

    catalog_ids = [int(r["id"]) for r in rows if r.get("id") is not None]
    options_by_catalog: dict[int, dict[str, list[dict[str, Any]]]] = {}
    capabilities_by_catalog: dict[int, dict[str, bool]] = {}
    if catalog_ids:
        ph = ",".join(["%s"] * len(catalog_ids))
        try:
            opt_rows = db.fetch_all(
                f"SELECT catalog_id, option_group, option_value, label, is_default, sort_order"
                f" FROM media_model_option WHERE catalog_id IN ({ph})"
                f" ORDER BY catalog_id, option_group, sort_order, id",
                tuple(catalog_ids),
            )
        except Exception as e:
            logger.warning("media_model_option load failed: %s", e)
            opt_rows = []
        for o in opt_rows:
            cid = int(o["catalog_id"])
            grp = (o.get("option_group") or "").strip()
            options_by_catalog.setdefault(cid, {}).setdefault(grp, []).append({
                "value": o.get("option_value") or "",
                "label": o.get("label") or o.get("option_value") or "",
                "is_default": bool(o.get("is_default")),
                "sort_order": int(o.get("sort_order") or 100),
            })
        try:
            cap_rows = db.fetch_all(
                f"SELECT catalog_id, capability_key, enabled, note"
                f" FROM media_model_capability WHERE catalog_id IN ({ph})",
                tuple(catalog_ids),
            )
        except Exception as e:
            logger.warning("media_model_capability load failed: %s", e)
            cap_rows = []
        for cap in cap_rows:
            cid = int(cap["catalog_id"])
            key = (cap.get("capability_key") or "").strip()
            if key:
                capabilities_by_catalog.setdefault(cid, {})[key] = bool(cap.get("enabled"))

    items: list[dict[str, Any]] = []
    for r in rows:
        extra_raw = r.get("extra")
        if isinstance(extra_raw, (bytes, bytearray)):
            try:
                extra_raw = extra_raw.decode("utf-8")
            except Exception:
                extra_raw = None
        if isinstance(extra_raw, str) and extra_raw:
            try:
                extra = json.loads(extra_raw)
            except Exception:
                extra = None
        else:
            extra = extra_raw if isinstance(extra_raw, dict) else None
        cid = int(r["id"]) if r.get("id") is not None else 0
        items.append(
            {
                "id": cid,
                "modality": r.get("modality"),
                "provider": r.get("provider"),
                "model_id": r.get("model_id"),
                "label": r.get("label") or r.get("model_id"),
                "description": r.get("description") or "",
                "is_default": bool(r.get("is_default")),
                "sort_order": int(r.get("sort_order") or 100),
                "extra": extra or {},
                "options": options_by_catalog.get(cid, {}),
                "capabilities": capabilities_by_catalog.get(cid, {}),
            }
        )
    with _catalog_lock:
        _catalog_cache["data"][modality] = items
        _catalog_cache["ts"] = now
    return items


def _catalog_model_ids(modality: str, hard_fallback: tuple[str, ...]) -> tuple[str, ...]:
    items = _load_model_catalog(modality)
    if not items:
        return hard_fallback
    ordered: list[str] = []
    default_id: Optional[str] = None
    for it in items:
        mid = (it.get("model_id") or "").strip()
        if not mid:
            continue
        if it.get("is_default") and not default_id:
            default_id = mid
        if mid not in ordered:
            ordered.append(mid)
    if default_id and ordered and ordered[0] != default_id:
        ordered.remove(default_id)
        ordered.insert(0, default_id)
    return tuple(ordered)


def _catalog_model_aliases(modality: str) -> dict[str, str]:
    aliases: dict[str, str] = {}
    for it in _load_model_catalog(modality):
        mid = (it.get("model_id") or "").strip()
        if not mid:
            continue
        extra = it.get("extra") or {}
        raw_aliases = extra.get("aliases") if isinstance(extra, dict) else None
        if isinstance(raw_aliases, str):
            raw_aliases = [raw_aliases]
        if not isinstance(raw_aliases, list):
            continue
        for alias in raw_aliases:
            key = _model_alias_key(str(alias))
            if key:
                aliases[key] = mid
    return aliases


def _settings_model_aliases(settings: Optional[dict[str, str]], modality: str) -> dict[str, str]:
    if not settings:
        return {}
    aliases: dict[str, str] = {}
    for key in (f"{modality}_model_aliases", "media_model_aliases"):
        raw = _setting(settings, key, key.upper(), "")
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except Exception:
            logger.warning("media model aliases JSON parse failed: key=%s", key)
            continue
        scoped = data.get(modality) if isinstance(data, dict) else None
        source = scoped if isinstance(scoped, dict) else data
        if not isinstance(source, dict):
            continue
        for alias, model_id in source.items():
            alias_key = _model_alias_key(str(alias))
            model_value = str(model_id or "").strip()
            if alias_key and model_value:
                aliases[alias_key] = model_value
    return aliases


def _resolve_media_model_alias(modality: str, model: str, settings: Optional[dict[str, str]] = None) -> str:
    raw = (model or "").strip()
    if not raw:
        return ""
    key = _model_alias_key(raw)
    hard_aliases = dict(_MODEL_ALIAS_HARD_FALLBACKS.get(modality, {}))
    if key in hard_aliases:
        return hard_aliases[key]
    compact_key = _model_alias_compact_key(raw)
    for alias, target in hard_aliases.items():
        if _model_alias_compact_key(alias) == compact_key:
            return target
    if modality == "image" and compact_key in {"gptimage2", "gptimage20"}:
        return "gpt-image-2"

    catalog_ids = {
        (it.get("model_id") or "").strip().lower()
        for it in _load_model_catalog(modality)
        if (it.get("model_id") or "").strip()
    }
    if raw.lower() in catalog_ids:
        return raw
    aliases = dict(hard_aliases)
    aliases.update(_catalog_model_aliases(modality))
    aliases.update(_settings_model_aliases(settings, modality))
    if key in aliases:
        return aliases[key]
    for alias, target in aliases.items():
        if _model_alias_compact_key(alias) == compact_key:
            return target
    return raw


def _image_model_fallbacks() -> tuple[str, ...]:
    return _catalog_model_ids("image", _IMAGE_MODEL_HARD_FALLBACKS)


_KNOWN_IMAGE_PROVIDERS = {"openai", "google"}


def _image_model_provider(model: str) -> str:
    """이미지 모델의 provider 를 결정.

    - 우선 `media_model_catalog` 의 `provider` 컬럼 사용 (DB 기반 분기).
    - 카탈로그에 없거나 provider 가 비어있거나 화이트리스트 외 값이면
      model_id prefix 로 fallback: `gpt-image-*` / `dall-e-*` → openai, 그 외 → google.
      (운영자가 카탈로그 row 의 provider 를 잘못 입력해도 prefix 로 복구된다.)
    """
    mid = _resolve_media_model_alias("image", model).lower()
    if not mid:
        return "google"
    for it in _load_model_catalog("image"):
        if (it.get("model_id") or "").lower() == mid:
            prov = (it.get("provider") or "").lower().strip()
            if prov in _KNOWN_IMAGE_PROVIDERS:
                return prov
            break
    if mid.startswith("gpt-image") or mid.startswith("dall-e"):
        return "openai"
    return "google"


def _is_openai_image_model(model: str) -> bool:
    """OpenAI 이미지 모델인지 판정. 카탈로그 provider 우선."""
    return _image_model_provider(model) == "openai"


def _is_gpt_image_2_model(model: str) -> bool:
    mid = _resolve_media_model_alias("image", model).strip().lower()
    return mid.startswith("gpt-image-2")


def _gemini_supports_image_size(model: str) -> bool:
    mid = _resolve_media_model_alias("image", model).strip().lower()
    return "gemini-3" in mid or "gemini-3.1" in mid


def _model_capabilities(modality: str, model_id: str) -> dict[str, bool]:
    """`media_model_capability` 자식 테이블에서 capability 조회. 없으면 빈 dict."""
    if not model_id:
        return {}
    model_id = _resolve_media_model_alias(modality, model_id)
    for it in _load_model_catalog(modality):
        if (it.get("model_id") or "") == model_id:
            return dict(it.get("capabilities") or {})
    return {}


def _decode_inline_image_input(value: Any) -> Optional[tuple[bytes, str]]:
    """프론트가 보낸 input_images 단일 항목을 (bytes, mime) 으로 디코딩.

    수용 형식:
      * {"inlineData": {"mimeType": "...", "data": "<base64>"}}
      * {"mime_type": "...", "base64": "<base64>"}
      * {"data": "data:image/png;base64,..."}
      * "data:image/png;base64,..."
    """
    if value is None:
        return None
    if isinstance(value, str):
        return _decode_inline_data(value)
    if isinstance(value, dict):
        return _decode_inline_data(value)
    return None


def _resolve_openai_image_size(body: dict[str, Any]) -> str:
    """프론트가 보낸 size 또는 aspect_ratio 를 OpenAI images API 의 size 로 매핑.

    OpenAI 가 지원하는 값: 1024x1024, 1024x1536(세로), 1536x1024(가로), auto.
    """
    raw_size = (body.get("size") or "").strip().lower()
    if raw_size and raw_size != "auto" and "x" in raw_size:
        return raw_size
    aspect = (body.get("aspect_ratio") or "1:1").strip()
    mapping = {
        "1:1": "1024x1024",
        "16:9": "1536x1024",
        "3:2": "1536x1024",
        "4:3": "1536x1024",
        "21:9": "1536x1024",
        "9:16": "1024x1536",
        "2:3": "1024x1536",
        "3:4": "1024x1536",
        "4:5": "1024x1536",
        "5:4": "1536x1024",
    }
    return mapping.get(aspect, "1024x1024")


_OPENAI_IMAGES_GEN_URL = "https://api.openai.com/v1/images/generations"


_OPENAI_IMAGES_EDIT_URL = "https://api.openai.com/v1/images/edits"


_OPENAI_HTTP_RETRY_ATTEMPTS = 3


_OPENAI_HTTP_RETRY_BACKOFF_SEC = 1.5


_OPENAI_EDIT_MAX_SIDE = 1024


_OPENAI_EDIT_MAX_BYTES = 900 * 1024


_OPENAI_CONNECT_TIMEOUT_SEC = 30.0


_RETRY_AFTER_MAX_SEC = 30.0


def _request_not_sent(exc: BaseException) -> bool:
    """True only when a failure provably happened before the request reached the provider.

    Read timeouts, resets, TLS errors and broken responses can occur after the provider already
    accepted a paid request, so they are never treated as safe to resend.
    """
    if isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout)):
        return True
    if isinstance(exc, requests.exceptions.ConnectTimeout):
        return True
    if isinstance(exc, requests.exceptions.SSLError):
        return False
    if isinstance(exc, requests.exceptions.ConnectionError):
        inner = exc.args[0] if exc.args else None
        return isinstance(getattr(inner, "reason", None), NewConnectionError)
    return False


def _retry_after_seconds(headers: Mapping[str, str]) -> Optional[float]:
    raw = str(headers.get("retry-after") or "").strip()
    if not raw:
        return None
    try:
        return max(0.0, float(raw))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())


def _rejection_retry_delay(status_code: int, headers: Mapping[str, str]) -> Optional[float]:
    """Delay before resending a request the provider refused (429/503 carrying Retry-After)."""
    if status_code not in {429, 503}:
        return None
    delay = _retry_after_seconds(headers)
    if delay is None or delay > _RETRY_AFTER_MAX_SEC:
        return None
    return delay


def _openai_transport_exception(exc: BaseException, model: str, label: str) -> HTTPException:
    if _request_not_sent(exc):
        return HTTPException(
            status_code=502,
            detail={"error": f"{label}: OpenAI 연결 실패 ({type(exc).__name__}: {str(exc)[:300]})", "model": model, "delivery": "not_sent"},
        )
    return HTTPException(
        status_code=502,
        detail={
            "error": f"{label}: 응답을 확인하지 못했습니다. 요청이 접수되었을 수 있어 재전송하지 않습니다 ({type(exc).__name__}: {str(exc)[:300]})",
            "model": model,
            "delivery": "uncertain",
        },
    )


def _openai_image_payload(model: str, prompt: str, body: dict[str, Any], caps: dict[str, bool]) -> dict[str, Any]:
    """OpenAI Images API 공통 파라미터를 capability 인지 방식으로 구성.

    capability 가 꺼진 옵션은 자동으로 무시한다 (e.g. dall-e-3 = quality 미지원).
    """
    n_raw = body.get("count") or body.get("n") or body.get("candidate_count") or 1
    payload: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "size": _resolve_openai_image_size(body),
        "n": max(1, min(int(n_raw), 4)) if caps.get("multi_count", False) else 1,
    }
    # capability 가 비어있으면(=DB 미시드 상태) OpenAI 가 거절할 수 있는 옵션은
    # 보내지 않는 것이 가장 안전하다. V052 시드 적용 시에만 자동으로 켜진다.
    if caps.get("quality_levels", False):
        quality = (body.get("quality") or "").strip().lower()
        if quality and quality != "auto":
            payload["quality"] = quality
    if caps.get("transparent_background", False):
        background = (body.get("background") or "").strip().lower()
        # gpt-image-2 는 입력 이미지를 high-fidelity 로 처리하지만 transparent background 는 미지원.
        if _is_gpt_image_2_model(model) and background == "transparent":
            logger.info("OpenAI %s: transparent background ignored", model)
        elif background in {"transparent", "opaque", "auto"}:
            payload["background"] = background
    if caps.get("output_format_choice", False):
        output_format = (body.get("output_format") or "").strip().lower()
        if output_format in {"png", "jpeg", "webp"}:
            payload["output_format"] = output_format
    return payload


def _openai_post_json(
    api_key: str,
    url: str,
    payload: dict[str, Any],
    model: str,
    action_label: str = "생성",
) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Connection": "close",
    }
    label = f"OpenAI 이미지 {action_label} 실패"
    for attempt in range(1, _OPENAI_HTTP_RETRY_ATTEMPTS + 1):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=(_OPENAI_CONNECT_TIMEOUT_SEC, 240.0))
        except Exception as e:
            if not _request_not_sent(e) or attempt >= _OPENAI_HTTP_RETRY_ATTEMPTS:
                raise _openai_transport_exception(e, model, label) from e
            logger.warning(
                "OpenAI %s connection failed before sending (attempt %d/%d, model=%s): %s",
                action_label, attempt, _OPENAI_HTTP_RETRY_ATTEMPTS, model, e,
            )
            time.sleep(_OPENAI_HTTP_RETRY_BACKOFF_SEC * attempt)
            continue
        if resp.status_code >= 400:
            delay = _rejection_retry_delay(resp.status_code, resp.headers)
            if delay is not None and attempt < _OPENAI_HTTP_RETRY_ATTEMPTS:
                logger.warning(
                    "OpenAI %s refused with HTTP %s; retrying after %.1fs (attempt %d/%d, model=%s)",
                    action_label, resp.status_code, delay, attempt, _OPENAI_HTTP_RETRY_ATTEMPTS, model,
                )
                time.sleep(delay)
                continue
            raise HTTPException(
                status_code=resp.status_code,
                detail={"error": f"{label}: {_openai_response_error_message(resp)}", "model": model},
            )
        try:
            return resp.json()
        except ValueError as e:
            raise HTTPException(
                status_code=502,
                detail={"error": f"{label}: 응답 JSON을 읽지 못했습니다.", "model": model, "delivery": "uncertain"},
            ) from e
    raise HTTPException(status_code=502, detail={"error": label, "model": model, "delivery": "uncertain"})


def _is_openai_transport_failure(exc: HTTPException) -> bool:
    """Only failures where OpenAI never received the request may fall back to another paid provider."""
    detail = exc.detail
    return exc.status_code == 502 and isinstance(detail, dict) and detail.get("delivery") == "not_sent"


def _openai_post_multipart(
    api_key: str,
    url: str,
    fields: dict[str, Any],
    files: list[tuple[str, tuple[str, bytes, str]]],
    model: str,
) -> dict[str, Any]:
    """`/v1/images/edits` multipart 호출.

    OpenAI 문서의 curl multipart 형식은 `image[]` 이다. 다만 GPT Image 계열은
    JSON `images[].image_url` 도 지원하므로, 이 함수는 JSON 입력을 못 쓰는
    구형/특수 모델 fallback 용으로만 남긴다.
    """
    headers = {"Authorization": f"Bearer {api_key}"}
    label = "OpenAI 이미지 편집 실패"
    for attempt in range(1, _OPENAI_HTTP_RETRY_ATTEMPTS + 1):
        try:
            resp = requests.post(url, headers=headers, data=fields, files=files, timeout=(_OPENAI_CONNECT_TIMEOUT_SEC, 240.0))
        except Exception as e:
            if not _request_not_sent(e) or attempt >= _OPENAI_HTTP_RETRY_ATTEMPTS:
                raise _openai_transport_exception(e, model, label) from e
            logger.warning(
                "OpenAI edits connection failed before sending (attempt %d/%d, model=%s): %s",
                attempt, _OPENAI_HTTP_RETRY_ATTEMPTS, model, e,
            )
            time.sleep(_OPENAI_HTTP_RETRY_BACKOFF_SEC * attempt)
            continue
        if resp.status_code >= 400:
            delay = _rejection_retry_delay(resp.status_code, resp.headers)
            if delay is not None and attempt < _OPENAI_HTTP_RETRY_ATTEMPTS:
                logger.warning(
                    "OpenAI edits refused with HTTP %s; retrying after %.1fs (attempt %d/%d, model=%s)",
                    resp.status_code, delay, attempt, _OPENAI_HTTP_RETRY_ATTEMPTS, model,
                )
                time.sleep(delay)
                continue
            try:
                err_payload = resp.json().get("error") or {}
                msg = (err_payload.get("message") or "").strip() or (resp.text or "")[:600]
            except Exception:
                msg = (resp.text or "")[:600]
            raise HTTPException(
                status_code=resp.status_code,
                detail={"error": f"{label}: {msg}", "model": model},
            )
        try:
            return resp.json()
        except ValueError as e:
            raise HTTPException(
                status_code=502,
                detail={"error": f"{label}: 응답 JSON을 읽지 못했습니다.", "model": model, "delivery": "uncertain"},
            ) from e
    raise HTTPException(status_code=502, detail={"error": label, "model": model, "delivery": "uncertain"})


def _openai_response_error_message(resp: requests.Response) -> str:
    try:
        err = resp.json().get("error") or {}
        msg = (err.get("message") or "").strip()
        if msg:
            return msg
    except Exception:
        pass
    text = (resp.text or "").strip()
    text_start = text[:300].lower()
    if "<!doctype html" in text_start or "<html" in text_start:
        title = ""
        with suppress(Exception):
            title = re.sub(r"\s+", " ", re.search(r"<title[^>]*>(.*?)</title>", text, re.I | re.S).group(1)).strip()
        return f"HTTP {resp.status_code} {resp.reason or ''}: {title or 'HTML error page'}".strip()
    return text[:600] or f"HTTP {resp.status_code}"


def _openai_collect_images(data: dict[str, Any], default_mime: str) -> list[tuple[bytes, str]]:
    items = data.get("data") or []
    inline_images: list[tuple[bytes, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        b64 = item.get("b64_json")
        if b64:
            try:
                inline_images.append((base64.b64decode(b64), default_mime))
            except Exception as e:
                logger.warning("OpenAI image b64 decode failed: %s", e)
            continue
        uri = item.get("url")
        if uri:
            try:
                with httpx.Client(timeout=60.0, follow_redirects=True) as client:
                    img_resp = client.get(uri)
                    img_resp.raise_for_status()
                    inline_images.append((img_resp.content, default_mime))
            except Exception as e:
                logger.warning("OpenAI image url download failed: %s", e)
    return inline_images


def _normalize_openai_edit_image(raw: bytes, mime: str) -> Optional[tuple[bytes, str]]:
    """OpenAI edits 참조 이미지를 작고 안정적인 JPEG 로 정규화.

    gpt-image-2 편집 입력은 high-fidelity 로 처리되므로 원본 PNG/RGBA 를 그대로
    data URL 로 보내면 TLS reset 이 반복될 수 있다. 참조용 입력은 긴 변 1024px,
    약 900KB 이하 JPEG 로 줄여 전송 안정성을 우선한다.
    """
    try:
        from PIL import Image, ImageOps

        with Image.open(io.BytesIO(raw)) as img:
            img = ImageOps.exif_transpose(img)
            img.thumbnail((_OPENAI_EDIT_MAX_SIDE, _OPENAI_EDIT_MAX_SIDE), Image.Resampling.LANCZOS)
            if img.mode in {"RGBA", "LA"} or (img.mode == "P" and "transparency" in img.info):
                base = Image.new("RGB", img.size, (255, 255, 255))
                base.paste(img.convert("RGBA"), mask=img.convert("RGBA").getchannel("A"))
                img = base
            else:
                img = img.convert("RGB")

            for quality in (88, 82, 76, 70, 64, 58):
                out = io.BytesIO()
                img.save(out, format="JPEG", quality=quality, optimize=True)
                data = out.getvalue()
                if len(data) <= _OPENAI_EDIT_MAX_BYTES or quality == 58:
                    logger.info(
                        "OpenAI edit reference normalized: %s -> %s bytes, mime=%s, size=%sx%s, quality=%s",
                        len(raw), len(data), "image/jpeg", img.width, img.height, quality,
                    )
                    return data, "image/jpeg"
    except Exception as e:
        logger.warning("OpenAI edits reference normalize failed: mime=%s err=%s", mime, e)
        return None


def _http_exc_text(exc: HTTPException) -> str:
    detail = exc.detail
    if isinstance(detail, dict):
        return str(detail.get("error") or detail)
    return str(detail or "")


def _openai_image_generate(
    api_key: str,
    model: str,
    prompt: str,
    body: dict[str, Any],
) -> tuple[list[tuple[bytes, str]], dict[str, int]]:
    """OpenAI Images API 호출. 결과 (inline_images, usage) 반환.

    참조 이미지(`input_images`)가 있으면 `/v1/images/edits` (multipart) 로 전송하고
    capability 가 꺼진 옵션은 자동으로 제거한다.
    """
    caps = _model_capabilities("image", model)
    payload = _openai_image_payload(model, prompt, body, caps)

    raw_refs = body.get("input_images") or body.get("reference_images") or []
    strict_refs = bool(body.get("strict_reference_images"))
    decoded_refs: list[tuple[bytes, str]] = []
    skipped_refs = 0
    if isinstance(raw_refs, list) and caps.get("reference_images", True):
        for ref in raw_refs[:16]:
            decoded = _decode_inline_image_input(ref)
            if decoded:
                decoded_refs.append(decoded)
            else:
                skipped_refs += 1
        if skipped_refs:
            logger.warning(
                "OpenAI image: input_images %d개 중 %d개 디코드 실패",
                len(raw_refs), skipped_refs,
            )
            if strict_refs:
                raise HTTPException(
                    status_code=400,
                    detail={"error": f"OpenAI 이미지 편집 실패: 레퍼런스 이미지 {skipped_refs}개를 디코드하지 못했습니다.", "model": model},
                )
    elif isinstance(raw_refs, list) and raw_refs:
        logger.info("OpenAI model %s 는 참조 이미지를 지원하지 않아 %d개 무시됨", model, len(raw_refs))
        if strict_refs:
            raise HTTPException(
                status_code=400,
                detail={"error": "OpenAI 이미지 편집 실패: 모델이 레퍼런스 이미지를 지원하지 않는 것으로 설정되어 있습니다.", "model": model},
            )

    if decoded_refs:
        normalized_refs: list[tuple[bytes, str]] = []
        for raw, mime in decoded_refs:
            normalized = _normalize_openai_edit_image(raw, mime)
            if normalized:
                normalized_refs.append(normalized)
        decoded_refs = normalized_refs
        if strict_refs and not decoded_refs:
            raise HTTPException(
                status_code=400,
                detail={"error": "OpenAI 이미지 편집 실패: 레퍼런스 이미지를 편집 입력으로 정규화하지 못했습니다.", "model": model},
            )

    if decoded_refs:
        ref_bytes_total = sum(len(raw) for raw, _ in decoded_refs)
        logger.info(
            "OpenAI edits: model=%s refs=%d total_bytes=%d size=%s quality=%s bg=%s fmt=%s transport=%s",
            model, len(decoded_refs), ref_bytes_total,
            payload.get("size"), payload.get("quality"), payload.get("background"), payload.get("output_format"),
            "multipart",
        )
        try:
            files: list[tuple[str, tuple[str, bytes, str]]] = []
            for idx, (raw, mime) in enumerate(decoded_refs):
                ext = _mime_to_ext(mime) or "png"
                files.append(("image", (f"reference_{idx}.{ext}", raw, mime or "image/png")))
            fields = {k: (str(v) if not isinstance(v, (list, dict)) else json.dumps(v))
                      for k, v in payload.items() if k != "model"}
            fields["model"] = payload["model"]
            try:
                data = _openai_post_multipart(api_key, _OPENAI_IMAGES_EDIT_URL, fields, files, model)
            except HTTPException as e:
                msg = _http_exc_text(e).lower()
                if e.status_code in {400, 422} and ("image" in msg or "parameter" in msg):
                    data = _openai_post_multipart(
                        api_key,
                        _OPENAI_IMAGES_EDIT_URL,
                        fields,
                        [("image[]", file_tuple) for _, file_tuple in files],
                        model,
                    )
                else:
                    raise
        except HTTPException as e:
            msg = _http_exc_text(e).lower()
            # OpenAI 측에서 참조 이미지 포맷/모드를 거절하면 edits 를 포기하고 generations 로 자동 fallback.
            # 모델/provider 는 유지하고 "입력 이미지 없는 생성"만 수행해 작업 자체가 먹통이 되지 않게 한다.
            if strict_refs:
                raise
            if e.status_code in {400, 422} and ("invalid_image_file" in msg or "invalid image file" in msg or "image file or mode" in msg):
                logger.warning("OpenAI edits invalid reference -> fallback generations (model=%s)", model)
                data = _openai_post_json(api_key, _OPENAI_IMAGES_GEN_URL, payload, model)
            else:
                raise
    else:
        if strict_refs:
            raise HTTPException(
                status_code=400,
                detail={"error": "OpenAI 이미지 편집 실패: 레퍼런스 이미지가 요청에 포함되지 않았습니다.", "model": model},
            )
        logger.info(
            "OpenAI generations: model=%s size=%s quality=%s bg=%s fmt=%s",
            model, payload.get("size"), payload.get("quality"), payload.get("background"), payload.get("output_format"),
        )
        data = _openai_post_json(api_key, _OPENAI_IMAGES_GEN_URL, payload, model)

    out_fmt = payload.get("output_format") or "png"
    mime = f"image/{out_fmt if out_fmt in {'png','jpeg','webp'} else 'png'}"
    inline_images = _openai_collect_images(data, mime)

    usage_raw = data.get("usage") or {}
    usage = {
        "input_tokens": int(usage_raw.get("input_tokens") or 0),
        "output_tokens": int(usage_raw.get("output_tokens") or 0),
        "total_tokens": int(usage_raw.get("total_tokens") or 0),
    }
    return inline_images, usage


_MIME_TO_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "model/gltf-binary": "glb",
    "model/gltf+json": "gltf",
}


def _setting(settings: dict[str, str], key: str, env_key: str = "", default: str = "") -> str:
    value = (settings.get(key) or "").strip()
    if value:
        return value
    if env_key:
        env_value = (os.getenv(env_key) or "").strip()
        if env_value:
            return env_value
    return default


def _model_candidates(requested: str, defaults: tuple[str, ...]) -> list[str]:
    seen: list[str] = []
    if requested:
        seen.append(requested)
    for d in defaults:
        if d not in seen:
            seen.append(d)
    return seen


def _reference_safe_image_model_candidates(settings: dict[str, str], requested: str = "") -> list[str]:
    candidates: list[str] = []

    def add(raw: str) -> None:
        resolved = _resolve_media_model_alias("image", (raw or "").strip(), settings)
        if not resolved or _is_openai_image_model(resolved):
            return
        if resolved not in candidates:
            candidates.append(resolved)

    add(_setting(settings, "gemini_image_model", "GEMINI_IMAGE_MODEL", ""))
    add(requested)
    for fallback in _image_model_fallbacks():
        add(fallback)
    for fallback in (
        "gemini-3-pro-image-preview",
        "gemini-3.1-flash-image-preview",
        "gemini-2.5-flash-image-preview",
        "gemini-2.5-flash-image",
    ):
        add(fallback)
    return candidates


def _gemini_base_candidates(settings: dict[str, str]) -> list[str]:
    configured = _setting(settings, "gemini_api_base", "GEMINI_API_BASE", _GEMINI_DEFAULT_BASE).rstrip("/")
    seen = [configured]
    for d in _GEMINI_FALLBACK_BASES:
        if d not in seen:
            seen.append(d)
    return seen


def _mime_to_ext(mime: str) -> str:
    norm = (mime or "").strip().lower()
    if norm in _MIME_TO_EXT:
        return _MIME_TO_EXT[norm]
    if "/" in norm:
        return norm.split("/", 1)[1].split(";", 1)[0] or "bin"
    return "bin"


def _decode_inline_data(value: Any, default_mime: str = "image/png") -> Optional[tuple[bytes, str]]:
    if value is None:
        return None
    if isinstance(value, dict):
        inner = value.get("inlineData") or value.get("inline_data") or value
        data = inner.get("data") if isinstance(inner, dict) else None
        mime = (inner.get("mimeType") or inner.get("mime_type") or default_mime) if isinstance(inner, dict) else default_mime
        if not data:
            data = value.get("base64") or value.get("data")
            mime = value.get("mime_type") or value.get("mimeType") or mime
    else:
        data = str(value)
        mime = default_mime
    if not data:
        return None
    try:
        if isinstance(data, str) and data.startswith("data:"):
            comma = data.find(",")
            head = data[5:comma] if comma > 0 else ""
            payload = data[comma + 1 :] if comma > 0 else data
            if ";" in head:
                head_mime, _ = head.split(";", 1)
                if head_mime:
                    mime = head_mime
            data = payload
        decoded = base64.b64decode(str(data))
    except Exception:
        return None
    if not decoded:
        return None
    return decoded, mime or default_mime


def _image_dimensions(content: bytes) -> tuple[Optional[int], Optional[int]]:
    try:
        from PIL import Image

        with Image.open(io.BytesIO(content)) as img:
            return int(img.width or 0) or None, int(img.height or 0) or None
    except Exception:
        return None, None


def _s3_client(region: str):
    import boto3

    return boto3.client("s3", region_name=region)


def _upload_to_s3(content: bytes, mime_type: str, media_kind: str, settings: dict[str, str]) -> dict[str, str]:
    bucket = _setting(settings, "gemini_s3_bucket", "AWS_S3_BUCKET")
    region = _setting(settings, "gemini_s3_region", "AWS_REGION", "ap-northeast-2")
    if not bucket:
        raise RuntimeError("S3 버킷 설정이 없습니다 (gemini_s3_bucket/AWS_S3_BUCKET).")
    root = (_setting(settings, "gemini_s3_prefix", "AWS_S3_DIR", "images") or "images").strip("/") or "images"
    ext = _mime_to_ext(mime_type)
    object_key = f"{root}/gemini/{media_kind}/{int(time.time() * 1000)}_{uuid.uuid4().hex[:12]}.{ext}"
    client = _s3_client(region)
    put_object = getattr(client, "put_object", None)
    if not callable(put_object):
        raise RuntimeError("S3 client is not configured correctly.")
    put_object(
        Bucket=bucket,
        Key=object_key,
        Body=content,
        ContentType=mime_type or "application/octet-stream",
        ContentLength=len(content),
    )
    return {
        "bucket": bucket,
        "key": object_key,
        "url": f"https://{bucket}.s3.{region}.amazonaws.com/{object_key}",
        "mime_type": mime_type or "application/octet-stream",
    }


def _record_usage(user_id: int, session_id: str, model: str, usage: dict[str, int]) -> None:
    if not usage:
        return
    # Gemini reports prompt/completion tokens; the OpenAI Images API reports input/output tokens.
    prompt_tokens = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
    completion_tokens = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
    total_tokens = int(usage.get("total_tokens") or 0) or prompt_tokens + completion_tokens
    try:
        db.execute(
            """
            INSERT INTO agent_usage (user_id, session_id, model, prompt_tokens, completion_tokens, total_tokens)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            [
                int(user_id),
                session_id or "",
                model or "",
                prompt_tokens,
                completion_tokens,
                total_tokens,
            ],
        )
    except Exception as e:
        logger.debug("recordUsage failed: %s", e)


def _should_retry_gemini(exc: Exception) -> bool:
    """Move to the next base/model only when Gemini provably did not accept the request.

    404 (unknown model or API version) and 429 are refusals; 503 counts only with Retry-After.
    Other 5xx responses and read/write failures may follow an accepted paid request.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        status_code = exc.response.status_code
        if status_code in {404, 429}:
            return True
        return status_code == 503 and _retry_after_seconds(exc.response.headers) is not None
    return _request_not_sent(exc)


def _post_gemini_with_fallback(
    api_key: str,
    base_urls: list[str],
    models: list[str],
    action: str,
    payload: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    last_exc: Optional[Exception] = None
    timeout = httpx.Timeout(connect=15.0, read=300.0, write=120.0, pool=15.0)
    headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}
    with httpx.Client(timeout=timeout) as client:
        for base in base_urls:
            for model in models:
                uri = f"{base.rstrip('/')}/models/{model}:{action}"
                try:
                    response = client.post(uri, headers=headers, json=payload)
                    response.raise_for_status()
                    return model, response.json() or {}
                except Exception as e:
                    last_exc = e
                    if not _should_retry_gemini(e):
                        raise
                    logger.warning(
                        "Gemini fallback retry: action=%s base=%s model=%s error=%s",
                        action, base, model, e,
                    )
    raise last_exc or RuntimeError("Gemini 호출 실패")


def _download_bytes(uri: str, api_key: str) -> bytes:
    """Gemini/외부 URI 에서 바이트 다운로드.

    Gemini files API (`/v1beta/files/{id}:download`) 는 실제 CDN (`/download/v1beta/...`)
    으로 302 리다이렉트로 돌려주므로 `follow_redirects=True` 가 반드시 필요하다.
    또한 리다이렉트된 download 호스트에서도 같은 Google 도메인이면 API 키 헤더를 유지한다.
    """
    is_google = "generativelanguage.googleapis.com" in uri or "googleapis.com" in uri
    headers = {"x-goog-api-key": api_key} if is_google else {}
    timeout = httpx.Timeout(connect=15.0, read=300.0, write=60.0, pool=15.0)
    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        response = client.get(uri, headers=headers)
        response.raise_for_status()
        return response.content


class UnsafeRemoteUrl(ValueError):
    """A remote URL the server refuses to fetch (non-public destination, bad scheme, size limit)."""


def _normalize_host(host: str) -> str:
    return (host or "").strip().lower().rstrip(".")


def _is_public_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        embedded = ip.ipv4_mapped or ip.sixtofour
        if embedded is not None:
            ip = embedded
    return ip.is_global and not (
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified
    )


def assert_public_http_url(url: str, *, trusted_hosts: Iterable[str] = ()) -> httpx.URL:
    """Validate an outbound fetch target: http(s), no credentials, every resolved address public.

    `trusted_hosts` names operator-configured hosts that may resolve to private addresses.
    """
    try:
        parsed = httpx.URL(str(url or "").strip())
    except Exception as e:
        raise UnsafeRemoteUrl("invalid URL") from e
    if parsed.scheme not in {"http", "https"}:
        raise UnsafeRemoteUrl(f"unsupported URL scheme: {parsed.scheme or '-'}")
    if parsed.userinfo:
        raise UnsafeRemoteUrl("URL credentials are not allowed")
    host = _normalize_host(parsed.host)
    if not host:
        raise UnsafeRemoteUrl("URL has no host")
    if host in {_normalize_host(item) for item in trusted_hosts if item}:
        return parsed
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(parsed.raw_host.decode("ascii"), port, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError) as e:
        raise UnsafeRemoteUrl(f"host could not be resolved: {host}") from e
    addresses = {str(info[4][0]) for info in infos}
    if not addresses or not all(_is_public_address(address) for address in addresses):
        raise UnsafeRemoteUrl(f"host does not resolve to a public address: {host}")
    return parsed


def fetch_public_url(
    url: str,
    *,
    timeout: float,
    max_bytes: int,
    headers: Optional[dict[str, str]] = None,
    trusted_hosts: Iterable[str] = (),
    max_redirects: int = 5,
) -> tuple[bytes, str]:
    """GET a remote file, re-validating the destination on every redirect hop and capping its size.

    Returns (content, content_type).
    """
    trusted = tuple(trusted_hosts)
    current = str(url or "").strip()
    with httpx.Client(timeout=timeout, follow_redirects=False) as client:
        for _ in range(max_redirects + 1):
            target = assert_public_http_url(current, trusted_hosts=trusted)
            with client.stream("GET", target, headers=headers) as response:
                if response.has_redirect_location:
                    current = str(response.url.join(response.headers["location"]))
                    continue
                response.raise_for_status()
                declared = str(response.headers.get("content-length") or "").strip()
                if declared.isdigit() and int(declared) > max_bytes:
                    raise UnsafeRemoteUrl(f"remote file exceeds {max_bytes} bytes")
                chunks: list[bytes] = []
                size = 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > max_bytes:
                        raise UnsafeRemoteUrl(f"remote file exceeds {max_bytes} bytes")
                    chunks.append(chunk)
                return b"".join(chunks), str(response.headers.get("content-type") or "")
    raise UnsafeRemoteUrl("too many redirects")


def _extract_image_bytes(response: dict[str, Any]) -> tuple[list[str], list[tuple[bytes, str]], list[tuple[str, str]]]:
    texts: list[str] = []
    inline_images: list[tuple[bytes, str]] = []
    refs: list[tuple[str, str]] = []
    candidates = response.get("candidates") or []
    for cand in candidates:
        content = (cand or {}).get("content") or {}
        for part in (content.get("parts") or []):
            if not isinstance(part, dict):
                continue
            text = part.get("text")
            if isinstance(text, str) and text.strip():
                texts.append(text)
            inline = part.get("inlineData") or part.get("inline_data")
            if isinstance(inline, dict):
                data = inline.get("data") or ""
                mime = inline.get("mimeType") or inline.get("mime_type") or "image/png"
                if data:
                    with suppress(Exception):
                        inline_images.append((base64.b64decode(data), mime))
            file_data = part.get("fileData") or part.get("file_data")
            if isinstance(file_data, dict):
                uri = file_data.get("fileUri") or file_data.get("file_uri") or ""
                mime = file_data.get("mimeType") or file_data.get("mime_type") or "image/png"
                if uri:
                    refs.append((uri, mime))
    return texts, inline_images, refs


def _image_response_summary(response: dict[str, Any]) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for cand in (response.get("candidates") or [])[:2]:
        if not isinstance(cand, dict):
            continue
        content = cand.get("content") or {}
        parts = content.get("parts") or []
        part_keys: list[str] = []
        text_chars = 0
        for part in parts[:8]:
            if not isinstance(part, dict):
                continue
            keys = [
                key
                for key in ("text", "inlineData", "inline_data", "fileData", "file_data", "functionCall")
                if key in part
            ]
            if not keys:
                keys = sorted(str(key) for key in part.keys())[:4]
            part_keys.append("+".join(keys))
            text = part.get("text")
            if isinstance(text, str):
                text_chars += len(text.strip())
        summaries.append(
            {
                "finish": cand.get("finishReason") or cand.get("finish_reason") or "",
                "parts": part_keys,
                "text_chars": text_chars,
            }
        )
    return summaries


def _first_text_preview(texts: list[str], limit: int = 240) -> str:
    text = next((t.strip() for t in texts if isinstance(t, str) and t.strip()), "")
    if len(text) > limit:
        return f"{text[: max(0, limit - 3)]}..."
    return text


def _extract_usage(response: dict[str, Any]) -> dict[str, int]:
    meta = response.get("usageMetadata") or response.get("usage_metadata") or {}
    if not isinstance(meta, dict):
        return {}
    prompt = int(meta.get("promptTokenCount") or meta.get("prompt_token_count") or 0)
    completion = int(meta.get("candidatesTokenCount") or meta.get("candidates_token_count") or 0)
    total = int(meta.get("totalTokenCount") or meta.get("total_token_count") or (prompt + completion))
    if not (prompt or completion or total):
        return {}
    return {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": total}


def _gemini_error_message(exc: Exception) -> tuple[int, str]:
    if isinstance(exc, httpx.HTTPStatusError):
        try:
            data = exc.response.json()
        except Exception:
            data = {}
        message = ""
        details_str = ""
        if isinstance(data, dict):
            err = data.get("error")
            if isinstance(err, dict):
                message = str(err.get("message") or "")
                # error.details[*].fieldViolations 등에 실제 원인이 들어있는 경우가 많음.
                raw_details = err.get("details")
                if isinstance(raw_details, list) and raw_details:
                    try:
                        details_str = json.dumps(raw_details, ensure_ascii=False)[:600]
                    except Exception:
                        details_str = str(raw_details)[:600]
        if not message:
            try:
                # JSON 으로 못 까지면 본문 일부라도 노출.
                message = exc.response.text[:600] or str(exc)
            except Exception:
                message = str(exc)
        if details_str:
            message = f"{message} | details={details_str}"
        return exc.response.status_code, message
    return 502, str(exc)


def _build_image_payload(body: dict[str, Any], prompt: str, model: str) -> dict[str, Any]:
    """Gemini image generation payload 빌더.

    Google `generativelanguage` v1beta 의 image 전용 preview 모델
    (`gemini-3-pro-image-preview`, `gemini-3.1-flash-image-preview`,
    `gemini-2.5-flash-image`) 은 `generationConfig` 에 받지 않는 필드가 들어오면
    `400 INVALID_ARGUMENT` 로 거절한다.

    - `imageConfig` 는 `aspectRatio` 만 안전. `imageSize` 는 모델별 미지원.
    - `thinkingConfig` 는 텍스트 모델 전용. image preview 에서는 거절됨.
    - `candidateCount`, `temperature`, `topP/topK`, `maxOutputTokens` 도 image
      모델에서는 무시되거나 거절될 수 있어 명시 요청이 있을 때만 추가한다.
    - text+image 동시 요청을 원할 때만 `responseModalities` 를 ["IMAGE","TEXT"]
      로 보낸다. 단일 IMAGE 만 요구되는 경우 일부 신모델은 modality 자체가 없는
      쪽이 더 안정적이라 모델별 분기는 호출자에서 추후 확장한다.
    """
    include_text = bool(body.get("include_text"))
    response_modalities_input = body.get("response_modalities") or []
    if isinstance(response_modalities_input, str):
        response_modalities_input = [response_modalities_input]
    if response_modalities_input:
        response_modalities = [str(v) for v in response_modalities_input if v]
    elif include_text:
        response_modalities = ["IMAGE", "TEXT"]
    else:
        response_modalities = ["IMAGE"]

    generation_config: dict[str, Any] = {"responseModalities": response_modalities}
    for src_key, dst_key, caster in (
        ("candidate_count", "candidateCount", int),
        ("seed", "seed", int),
        ("temperature", "temperature", float),
        ("top_p", "topP", float),
        ("top_k", "topK", int),
        ("max_output_tokens", "maxOutputTokens", int),
    ):
        if src_key in body and body[src_key] is not None:
            with suppress(Exception):
                generation_config[dst_key] = caster(body[src_key])

    image_config: dict[str, Any] = {}
    aspect = (body.get("aspect_ratio") or "").strip()
    if aspect:
        image_config["aspectRatio"] = aspect
    image_size = (body.get("image_size") or "").strip()
    if image_size and _gemini_supports_image_size(model):
        image_config["imageSize"] = image_size
    if image_config:
        generation_config["imageConfig"] = image_config

    parts: list[dict[str, Any]] = [{"text": prompt}]
    decoded_image_count = 0
    for image in (body.get("input_images") or []):
        decoded = _decode_inline_data(image, "image/png")
        if not decoded:
            continue
        raw, mime = decoded
        decoded_image_count += 1
        parts.append({"inlineData": {"mimeType": mime, "data": base64.b64encode(raw).decode("ascii")}})
    if body.get("strict_reference_images") and decoded_image_count <= 0:
        raise HTTPException(status_code=400, detail="Reference image generation failed: no valid input image was included.")

    payload: dict[str, Any] = {
        "contents": [{"parts": parts}],
        "generationConfig": generation_config,
    }

    tools: list[dict[str, Any]] = []
    for raw_tool in (body.get("tools") or []):
        if isinstance(raw_tool, dict):
            cleaned = {k: v for k, v in raw_tool.items() if k and v is not None}
            if cleaned:
                tools.append(cleaned)
    if body.get("use_google_search"):
        tools.append({"googleSearch": {}})
    if tools:
        payload["tools"] = tools

    safety = body.get("safety_settings") or []
    if isinstance(safety, list) and safety:
        payload["safetySettings"] = [s for s in safety if isinstance(s, dict)]

    system_instruction = (body.get("system_instruction") or "").strip()
    if system_instruction:
        payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}
    return payload


def _resolve_default_image_model(settings: dict[str, str], fallbacks: tuple[str, ...]) -> str:
    """`media_image_generate` 가 사용할 기본 모델을 결정.

    우선순위:
      1) `agent_settings.gemini_image_model` / `GEMINI_IMAGE_MODEL` 환경변수가
         현재 카탈로그(`media_model_catalog`) 활성 모델 목록에 들어있으면 그 값.
         (카탈로그 로드 실패/공백이면 explicit 값을 그대로 신뢰.)
      2) 그 외에는 카탈로그의 `is_default` (= fallbacks[0]).
      3) 둘 다 없으면 explicit 또는 빈 문자열.

    이 헬퍼는 settings 키 이름이 'gemini_*' 라는 이유만으로 OpenAI 기본값이 가려지는
    분기 사고를 방지한다.
    """
    explicit = _setting(settings, "gemini_image_model", "GEMINI_IMAGE_MODEL", "")
    catalog = tuple(
        (it.get("model_id") or "").strip()
        for it in _load_model_catalog("image")
        if (it.get("model_id") or "").strip()
    )
    if explicit and (not catalog or explicit in catalog):
        return explicit
    if fallbacks:
        return fallbacks[0]
    return explicit


def _dispatch_gemini_image_generation(
    *,
    api_key: str,
    base_urls: list[str],
    models: list[str],
    prompt: str,
    body: dict[str, Any],
    user_id: int,
    usage_session: str,
) -> tuple[str, list[str], list[tuple[bytes, str]], list[tuple[str, str]], dict[str, int]]:
    remaining_models = list(models)
    last_empty: tuple[str, list[str], list[tuple[bytes, str]], list[tuple[str, str]], dict[str, int]] | None = None

    while remaining_models:
        payload_model = remaining_models[0]
        payload = _build_image_payload(body, prompt, payload_model)
        try:
            resolved_model, response = _post_gemini_with_fallback(
                api_key=api_key,
                base_urls=base_urls,
                models=remaining_models,
                action="generateContent",
                payload=payload,
            )
        except Exception as e:
            status_code, message = _gemini_error_message(e)
            try:
                generation_config = payload.get("generationConfig") or {}
                payload_keys = {
                    "generationConfig": sorted(generation_config.keys()),
                    "imageConfig": sorted((generation_config.get("imageConfig") or {}).keys()),
                    "thinkingConfig": sorted((generation_config.get("thinkingConfig") or {}).keys()),
                    "input_images": len(body.get("input_images") or []),
                    "tools": [list(t.keys())[0] for t in (payload.get("tools") or []) if isinstance(t, dict) and t],
                }
            except Exception:
                payload_keys = {}
            logger.warning(
                "Gemini image generate failed: status=%s models=%s payload=%s | message=%s",
                status_code,
                remaining_models,
                payload_keys,
                message,
            )
            raise HTTPException(
                status_code=status_code,
                detail={"error": f"Gemini image generation failed: {message}", "attempted_models": models},
            )

        texts, inline_images, image_refs = _extract_image_bytes(response)
        usage = _extract_usage(response)
        _record_usage(user_id, usage_session, resolved_model, usage)

        if not inline_images and image_refs:
            resolved: list[tuple[bytes, str]] = []
            for uri, mime in image_refs:
                try:
                    resolved.append((_download_bytes(uri, api_key), mime))
                except Exception as e:
                    logger.warning("Gemini image ref download failed: uri=%s error=%s", uri, e)
            if resolved:
                inline_images = resolved
                image_refs = []

        if inline_images or image_refs:
            return resolved_model, texts, inline_images, image_refs, usage

        last_empty = (resolved_model, texts, [], image_refs, usage)
        try:
            resolved_idx = remaining_models.index(resolved_model)
            remaining_models = remaining_models[resolved_idx + 1:]
        except ValueError:
            remaining_models = []
        logger.warning(
            "Gemini image response had no image data: model=%s summary=%s text_preview=%r next_models=%s",
            resolved_model,
            _image_response_summary(response),
            _first_text_preview(texts),
            remaining_models,
        )

    if last_empty:
        return last_empty
    requested_model = models[0] if models else ""
    return requested_model, [], [], [], {}


def _dispatch_image_generation(
    *,
    settings: dict[str, str],
    model: str,
    prompt: str,
    body: dict[str, Any],
    user_id: int,
    usage_session: str,
) -> tuple[str, list[str], list[tuple[bytes, str]], list[tuple[str, str]], dict[str, int]]:
    """3D 참조 이미지용 OpenAI / Gemini 생성 진입점.

    Returns: (resolved_model, texts, inline_images, image_refs, usage)
    """
    if _is_openai_image_model(model):
        api_key = resolve_openai_api_key(settings)
        if not api_key:
            raise HTTPException(status_code=400, detail="OpenAI API 키가 없습니다.")
        try:
            inline_images, usage = _openai_image_generate(api_key, model, prompt, body)
        except HTTPException as e:
            strict_refs = bool(body.get("strict_reference_images"))
            if not strict_refs or not _is_openai_transport_failure(e):
                raise
            gemini_key = _setting(settings, "gemini_api_key", "GEMINI_API_KEY")
            gemini_models = _reference_safe_image_model_candidates(settings, model)
            if not gemini_key or not gemini_models:
                raise
            logger.warning(
                "OpenAI strict reference edit failed; retrying with Gemini reference model. openai_model=%s fallback_models=%s error=%s",
                model,
                gemini_models,
                _http_exc_text(e),
            )
            return _dispatch_gemini_image_generation(
                api_key=gemini_key,
                base_urls=_gemini_base_candidates(settings),
                models=gemini_models,
                prompt=prompt,
                body=body,
                user_id=user_id,
                usage_session=f"{usage_session}_reference_fallback",
            )
        _record_usage(user_id, usage_session, model, usage)
        return model, [], inline_images, [], usage

    api_key = _setting(settings, "gemini_api_key", "GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=400, detail="Gemini API 키가 없습니다.")

    models = _model_candidates(model, _image_model_fallbacks())
    base_urls = _gemini_base_candidates(settings)
    return _dispatch_gemini_image_generation(
        api_key=api_key,
        base_urls=base_urls,
        models=models,
        prompt=prompt,
        body=body,
        user_id=user_id,
        usage_session=usage_session,
    )
