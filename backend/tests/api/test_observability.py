from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.exceptions import RequestValidationError

from src.api.observability import (
    REQUEST_ID_HEADER,
    ensure_request_id,
    request_logging_middleware,
    resolve_request_id,
    validation_exception_handler,
)


def test_resolve_request_id_preserves_safe_values_and_replaces_unsafe_values():
    assert resolve_request_id(" client-req_1:abc ") == "client-req_1:abc"
    assert resolve_request_id("bad header value") != "bad header value"
    assert len(resolve_request_id("")) >= 32


def test_ensure_request_id_stores_on_request_state():
    request = SimpleNamespace(
        headers={REQUEST_ID_HEADER: "client-request-1"},
        state=SimpleNamespace(),
    )

    assert ensure_request_id(request) == "client-request-1"
    assert request.state.request_id == "client-request-1"
    assert ensure_request_id(request) == "client-request-1"


@pytest.mark.anyio
@pytest.mark.parametrize("anyio_backend", ["asyncio"])
async def test_request_logging_middleware_attaches_header():
    request = SimpleNamespace(
        headers={},
        state=SimpleNamespace(),
        method="GET",
        url=SimpleNamespace(path="/api/test"),
    )
    response = SimpleNamespace(status_code=204, headers={})

    async def call_next(_request):
        return response
    result = await request_logging_middleware(request, call_next)
    assert result is response
    assert response.headers[REQUEST_ID_HEADER] == request.state.request_id


@pytest.mark.anyio
@pytest.mark.parametrize("anyio_backend", ["asyncio"])
async def test_validation_exception_handler_preserves_detail_shape():
    request = SimpleNamespace(
        headers={REQUEST_ID_HEADER: "client-request-2"},
        state=SimpleNamespace(),
        method="POST",
        url=SimpleNamespace(path="/api/test"),
    )
    exc = RequestValidationError([{"loc": ("body", "name"), "msg": "Field required", "type": "missing"}])

    response = await validation_exception_handler(request, exc)

    assert response.status_code == 422
    assert response.headers[REQUEST_ID_HEADER] == "client-request-2"
