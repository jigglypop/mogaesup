"""SSE helpers for 3D generation job progress."""
from __future__ import annotations

import json
from typing import Any, AsyncIterable, Iterable, Union

from fastapi.responses import StreamingResponse

_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def sse_event(event: str, data: Any = None) -> str:
    if data is None:
        body = "{}"
    elif isinstance(data, str):
        body = data
    else:
        body = json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {body}\n\n"


def sse_response(generator: Union[Iterable, AsyncIterable]) -> StreamingResponse:
    return StreamingResponse(
        generator,
        media_type="text/event-stream",
        headers=_HEADERS,
    )


def sse_status(message: str, **extra: Any) -> str:
    payload = {"message": message}
    if extra:
        payload.update(extra)
    return sse_event("status", payload)


def sse_error(message: str) -> str:
    return sse_event("error", {"message": message})


def sse_done(payload: Any = None) -> str:
    return sse_event("done", payload if payload is not None else {})


__all__ = (
    "sse_event",
    "sse_response",
    "sse_status",
    "sse_error",
    "sse_done",
)
