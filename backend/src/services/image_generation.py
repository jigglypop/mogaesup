from __future__ import annotations

import base64
import logging
from typing import Any, Callable
from src.services.media import (
    _dispatch_image_generation,
    _image_dimensions,
    _image_model_fallbacks,
    _resolve_default_image_model,
    _resolve_media_model_alias,
    _upload_to_s3,
    fetch_public_url,
)
from src.text_utils import redact_url

logger = logging.getLogger(__name__)

MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024


def _first_text(value: Any) -> str:
    return str(value or "").strip()


def collect_reference_images(
    body: dict[str, Any],
    *,
    url_keys: tuple[str, ...] = ("reference_image_url", "image_url"),
    default_role: str = "reference",
) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for item in body.get("reference_images") or []:
        if isinstance(item, dict):
            refs.append(dict(item))
    for key in url_keys:
        url = _first_text(body.get(key))
        if url:
            refs.append({"url": url, "role": default_role})
            break
    return refs


def prepare_image_generation_refs(
    refs: list[dict[str, Any]],
    *,
    user_agent: str = "signight-image-preflight/1.0",
    timeout: int = 30,
) -> list[dict[str, Any]]:
    prepared: list[dict[str, Any]] = []
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        if ref.get("inlineData") or ref.get("inline_data") or ref.get("base64") or ref.get("data"):
            prepared.append(dict(ref))
            continue
        url = _first_text(ref.get("url") or ref.get("image_url") or ref.get("src"))
        if not url:
            continue
        try:
            content, content_type = fetch_public_url(
                url,
                timeout=timeout,
                max_bytes=MAX_REFERENCE_IMAGE_BYTES,
                headers={"Accept": "image/*,*/*", "User-Agent": user_agent},
            )
            if not content:
                continue
            mime_type = (content_type or "image/png").split(";", 1)[0].strip() or "image/png"
            prepared.append({
                **{key: value for key, value in ref.items() if key not in {"url", "image_url", "src"}},
                "inlineData": {
                    "mimeType": mime_type,
                    "data": base64.b64encode(content).decode("ascii"),
                },
                "source_url": redact_url(url),
            })
        except Exception as e:
            logger.warning("image generation reference download failed: url=%s error=%s", redact_url(url), e)
    return prepared


def generate_reference_image(
    *,
    settings: dict[str, str],
    prompt: str,
    body: dict[str, Any],
    user_id: int,
    usage_session: str,
    media_kind: str,
    reference_images: list[dict[str, Any]] | None = None,
    model_keys: tuple[str, ...] = ("image_model",),
    default_size: str = "1024x1024",
    default_aspect_ratio: str = "1:1",
    result_extra: dict[str, Any] | None = None,
    on_warning: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    refs = reference_images or []
    prepared_refs = prepare_image_generation_refs(refs)
    fallbacks = _image_model_fallbacks()
    requested_model = ""
    for key in model_keys:
        requested_model = _first_text(body.get(key))
        if requested_model:
            break
    if not requested_model:
        requested_model = _resolve_default_image_model(settings, fallbacks)
    if not requested_model:
        return {"enabled": True, "status": "skipped", "reason": "no_image_model", **(result_extra or {})}

    model = _resolve_media_model_alias("image", requested_model, settings)
    image_body = {
        "prompt": prompt,
        "model": model,
        "reference_images": prepared_refs,
        "input_images": prepared_refs,
        "strict_reference_images": bool(prepared_refs),
        "aspect_ratio": body.get("aspect_ratio") or default_aspect_ratio,
        "size": body.get("image_size") or default_size,
        "upload_to_s3": True,
    }
    try:
        resolved_model, texts, inline_images, image_refs, usage = _dispatch_image_generation(
            settings=settings,
            model=model,
            prompt=prompt,
            body=image_body,
            user_id=int(user_id or 0),
            usage_session=usage_session,
        )
    except Exception as e:
        if on_warning:
            on_warning(str(e))
        logger.warning("reference image generation failed: media_kind=%s error=%s", media_kind, e)
        return {
            "enabled": True,
            "status": "failed",
            "error": str(e),
            "requested_model": requested_model,
            "prompt": prompt,
            "reference_count": len(refs),
            "prepared_reference_count": len(prepared_refs),
            **(result_extra or {}),
        }

    result: dict[str, Any] = {
        "enabled": True,
        "status": "failed",
        "model": resolved_model,
        "requested_model": requested_model,
        "prompt": prompt,
        "reference_count": len(refs),
        "prepared_reference_count": len(prepared_refs),
        "texts": texts[:2],
        "usage": usage,
        **(result_extra or {}),
    }
    if inline_images:
        content, mime_type = inline_images[0]
        width, height = _image_dimensions(content)
        result.update({"mime_type": mime_type, "width": width, "height": height})
        try:
            uploaded = _upload_to_s3(content, mime_type, media_kind, settings)
            result.update(uploaded)
            result["status"] = "ready"
        except Exception as e:
            result["status"] = "inline_only"
            result["upload_error"] = str(e)
            result["data_url"] = f"data:{mime_type};base64,{base64.b64encode(content).decode('ascii')}"
    elif image_refs:
        url, mime_type = image_refs[0]
        result.update({"status": "ready", "url": url, "mime_type": mime_type})
    else:
        result["reason"] = "image_provider_returned_no_image"
    return result
