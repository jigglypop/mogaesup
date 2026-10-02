"""FastAPI application for the character server: the studio gateway's API families and health."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import hmac
import logging
import os
import threading
import time

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


from src import configure_logging
from src.paths import load_environment

load_environment()
# `uvicorn src.api.server:app` never runs src.cli, so without this the INFO logs (requests, auto resume) are dropped.
configure_logging()

from src.api.observability import (
    attach_request_id,
    ensure_request_id,
    request_logging_middleware,
    unhandled_exception_handler,
    validation_exception_handler,
)
from src.api.characters import router as character_router, pipeline_error_handler
from src.api.avatar_factory import router as factory_router
from src.api.avatar_part_batches import router as part_batch_router
from src.api.avatar_blueprints import router as blueprint_router
from src.api.studio import router as studio_router
from src.api.studio_glb_assets import router as studio_glb_assets_router
from src.services.character_pipeline import PipelineError
from src.services.runtime_activity import (ActivityMiddleware, state as activity_state, server_lease,
                                          begin_drain, resume, RuntimeDraining, RuntimeUncertain)
from src.auth import is_public_path, trusted_loopback
from src.runtime_identity import runtime_identity
from src.services import record_store
from src.services.object_storage import assert_records_mode


logger = logging.getLogger(__name__)
_RUNTIME = runtime_identity()


@asynccontextmanager
async def lifespan(_: FastAPI):
    with server_lease():
        # A server that lost CHARACTER_DATABASE_URL must not read the records the database replaced.
        await asyncio.to_thread(assert_records_mode)
        from src.api.avatar_factory import get_factory
        from src.services.avatar_auto_resume import start as start_auto_resume
        start_auto_resume(get_factory())
        yield


app = FastAPI(
    title="Character API",
    description="Character production, storage, and delivery behind the studio gateway",
    version="1.0.0",
    lifespan=lifespan,
)
app.include_router(studio_router, prefix='/api')
app.include_router(studio_glb_assets_router, prefix='/api')


_API_KEY = os.getenv("API_KEY", "").strip()


def _api_key_matches(candidate: str) -> bool:
    return hmac.compare_digest(candidate.encode("utf-8"), _API_KEY.encode("utf-8"))


async def auth_middleware(request: Request, call_next):
    request_id = ensure_request_id(request)
    if (not _API_KEY or is_public_path(request.url.path) or request.method == "OPTIONS"
            or (request.url.path.startswith('/internal/') and trusted_loopback(request))):
        return await call_next(request)
    key = (request.headers.get("x-api-key") or "").strip()
    if _api_key_matches(key):
        return await call_next(request)
    return attach_request_id(
        JSONResponse(
            status_code=401,
            content={"detail": "Unauthorized", "requestId": request_id},
        ),
        request_id,
    )


# The middleware added last runs first. The API-key check sits inside request logging
# so its 401 responses are logged like any other response.
app.middleware("http")(auth_middleware)
app.middleware("http")(request_logging_middleware)
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_exception_handler(Exception, unhandled_exception_handler)
app.add_exception_handler(PipelineError, pipeline_error_handler)


_DB_STATUS: dict = {"value": None, "at": 0.0, "running": False}
_DB_STATUS_LOCK = threading.Lock()


def _public_database_status(value: dict) -> dict:
    """/health is public: report the state only, never the driver's error text."""
    if value.get("error"):
        logger.warning("record database health check failed: %s", value["error"])
    return {key: value[key] for key in ("configured", "ok") if key in value}


def _refresh_database_status() -> None:
    value = _public_database_status(record_store.ping())
    with _DB_STATUS_LOCK:
        _DB_STATUS.update(value=value, at=time.monotonic(), running=False)


def _database_status() -> dict:
    """The record database (CHARACTER_DATABASE_URL) is the only database this server uses."""
    if not record_store.configured():
        return {"configured": False, "ok": False}
    # An unreachable database host takes seconds to fail; /health answers from the last check
    # and refreshes it in the background so local launchers can still identify this server.
    with _DB_STATUS_LOCK:
        value = _DB_STATUS["value"]
        if (value is None or time.monotonic() - _DB_STATUS["at"] >= 30) and not _DB_STATUS["running"]:
            _DB_STATUS["running"] = True
            threading.Thread(target=_refresh_database_status, name="db-health", daemon=True).start()
    return value or {"configured": True, "ok": None, "checking": True}


def health() -> dict:
    database = _database_status()
    status = "healthy"
    activity = activity_state()
    if ((database.get("configured") and database.get("ok") is not True)
            or not activity['admission']['verified']):
        status = "degraded"
    return {"status": status, "connections": {"database": database}, "runtime": _RUNTIME,
            **activity}


class DrainInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    token: str = Field(pattern=r'^[a-f0-9]{32}$')


def _control(request, callback, token):
    if not trusted_loopback(request):
        raise HTTPException(status_code=403, detail='Local runtime control only')
    try:
        return callback(token)
    except (RuntimeDraining, RuntimeUncertain):
        raise HTTPException(status_code=409, detail='Runtime admission state cannot be changed') from None


@app.post('/internal/drain', include_in_schema=False)
async def drain_runtime(request: Request, body: DrainInput):
    return _control(request, begin_drain, body.token)


@app.delete('/internal/drain', include_in_schema=False)
async def resume_runtime(request: Request, body: DrainInput):
    return _control(request, resume, body.token)


# async: health only reads in-memory state, so it never waits for a worker thread the long background tasks hold.
@app.get("/health")
async def root_health() -> dict:
    return health()


@app.get("/api/health")
async def api_health() -> dict:
    return health()


# Outermost: a request stays counted until its background tasks finish (see /health activity).
app.add_middleware(ActivityMiddleware)

app.include_router(character_router, prefix="/api")
app.include_router(factory_router, prefix="/api")
app.include_router(part_batch_router, prefix="/api")
app.include_router(blueprint_router, prefix="/api")
