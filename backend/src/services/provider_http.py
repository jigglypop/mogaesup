"""CDN downloads of provider output, checked before a stored artifact is replaced."""

from __future__ import annotations

from contextlib import contextmanager
from src.services.object_storage import StoredPath as Path
from src.services.object_storage import is_remote

import httpx

from src.services.asset_delivery import DeliveryPolicy, inspect_glb


def download_failure(exc: httpx.HTTPError):
    """The public error of a download that failed. It names the status and never reads the response body."""
    from src.services.character_pipeline import PipelineError
    reason = f"HTTP {exc.response.status_code}" if isinstance(exc, httpx.HTTPStatusError) else "연결 오류"
    return PipelineError("download_failed", f"3D 파일을 내려받지 못했습니다 ({reason}). 저장된 작업 기록은 그대로이며 다시 시도할 수 있습니다.", 502)


@contextmanager
def download_stream(client: httpx.Client, url: str):
    """Stream a CDN file. A failed request is PipelineError('download_failed'): an error response is streamed,
    so its body was never read and cannot be shown, and callers need not tell httpx error types apart."""
    try:
        with client.stream("GET", url) as response:
            response.raise_for_status()
            yield response
    except httpx.HTTPError as exc:
        raise download_failure(exc) from None


def download_glb(client: httpx.Client, url: str, output: Path, *, preserve_detail: bool = False) -> dict:
    """Validate a CDN download before replacing an artifact; client has no API key."""
    policy = DeliveryPolicy(max_file_bytes=256 * 1024 * 1024) if preserve_detail else DeliveryPolicy()
    data = bytearray()
    with download_stream(client, url) as response:
        for chunk in response.iter_bytes():
            data.extend(chunk)
            if len(data) > policy.max_file_bytes:
                raise ValueError("Generated GLB exceeds file budget")
    quality = inspect_glb(bytes(data), policy, budget_warnings=preserve_detail)
    if quality["errors"]:
        raise ValueError("Generated GLB rejected: " + "; ".join(quality["errors"]))
    if is_remote(output):
        # One PUT of the final key is atomic; staging a temporary object and renaming it costs a copy and a delete.
        output.write_bytes(data)
    else:
        temporary = output.with_suffix(".glb.part")
        temporary.write_bytes(data)
        temporary.replace(output)
    return quality
