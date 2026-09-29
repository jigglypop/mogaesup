from __future__ import annotations

import logging
import re
import time
from uuid import uuid4

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.responses import Response

REQUEST_ID_HEADER = "X-Request-ID"
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

logger = logging.getLogger(__name__)


def resolve_request_id(candidate: str | None) -> str:
    value = (candidate or "").strip()
    if _REQUEST_ID_RE.fullmatch(value):
        return value
    return str(uuid4())


def ensure_request_id(request: Request) -> str:
    state = getattr(request, "state", None)
    if state is None:
        return resolve_request_id(request.headers.get(REQUEST_ID_HEADER))
    current = getattr(state, "request_id", None)
    if isinstance(current, str) and current:
        return current
    request_id = resolve_request_id(request.headers.get(REQUEST_ID_HEADER))
    state.request_id = request_id
    return request_id


def attach_request_id(response: Response, request_id: str) -> Response:
    response.headers[REQUEST_ID_HEADER] = request_id
    return response


async def request_logging_middleware(request: Request, call_next):
    request_id = ensure_request_id(request)
    started_at = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        logger.exception(
            "request failed requestId=%s method=%s path=%s durationMs=%s",
            request_id,
            request.method,
            request.url.path,
            duration_ms,
        )
        raise

    duration_ms = int((time.perf_counter() - started_at) * 1000)
    attach_request_id(response, request_id)
    message = (
        "request completed requestId=%s method=%s path=%s status=%s durationMs=%s"
    )
    args = (request_id, request.method, request.url.path, response.status_code, duration_ms)
    if response.status_code >= 500:
        logger.error(message, *args)
    elif response.status_code >= 400 or duration_ms >= 3000:
        logger.warning(message, *args)
    elif request.url.path in {"/health", "/api/health"}:
        logger.debug(message, *args)
    else:
        logger.info(message, *args)
    return response


async def validation_exception_handler(request: Request, exc: RequestValidationError):
    request_id = ensure_request_id(request)
    logger.warning(
        "request validation failed requestId=%s method=%s path=%s errorCount=%s",
        request_id,
        request.method,
        request.url.path,
        len(exc.errors()),
    )
    return attach_request_id(
        JSONResponse(
            status_code=422,
            content={"detail": jsonable_encoder(exc.errors()), "requestId": request_id},
        ),
        request_id,
    )


async def unhandled_exception_handler(request: Request, exc: Exception):
    request_id = ensure_request_id(request)
    logger.exception(
        "unhandled exception requestId=%s method=%s path=%s",
        request_id,
        request.method,
        request.url.path,
    )
    return attach_request_id(
        JSONResponse(
            status_code=500,
            content={"detail": "Internal server error", "requestId": request_id},
        ),
        request_id,
    )
