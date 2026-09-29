"""FastAPI application exposing only the 3D world API."""

from __future__ import annotations

from contextlib import asynccontextmanager
import hmac
import logging
import os
import threading
import time

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse


from src.paths import load_environment

load_environment()

from src import db
from src.api.observability import (
    REQUEST_ID_HEADER,
    attach_request_id,
    ensure_request_id,
    request_logging_middleware,
    unhandled_exception_handler,
    validation_exception_handler,
)
from src.api.world import router as world_router
from src.api.characters import router as character_router, pipeline_error_handler
from src.api.avatars import router as avatar_router
from src.api.avatar_factory import router as factory_router
from src.api.avatar_part_batches import router as part_batch_router
from src.api.avatar_blueprints import router as blueprint_router
from src.api.studio import router as studio_router
from src.api.studio_glb_assets import router as studio_glb_assets_router
from src.services.character_pipeline import PipelineError
from src.services.runtime_activity import ActivityMiddleware, snapshot as activity_snapshot
from src.auth import is_public_path
from src.runtime_identity import runtime_identity


logger = logging.getLogger(__name__)
_RUNTIME = runtime_identity()


def _cors_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "*")
    origins = [item.strip() for item in raw.replace("\n", ",").split(",") if item.strip()]
    return origins or ["*"]


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Continue factory stages stopped with the previous server process.
    from src.api.avatar_factory import get_factory
    from src.services.avatar_auto_resume import start as start_auto_resume
    start_auto_resume(get_factory())
    yield


app = FastAPI(
    title="3D Asset API",
    description="3D world asset generation, storage, and delivery",
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
    if not _API_KEY or is_public_path(request.url.path) or request.method == "OPTIONS":
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


# The middleware added last runs first. The API-key check sits inside CORS and request
# logging so its 401 responses carry CORS headers and are logged like any other response.
app.middleware("http")(auth_middleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[REQUEST_ID_HEADER],
)
app.middleware("http")(request_logging_middleware)
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_exception_handler(Exception, unhandled_exception_handler)
app.add_exception_handler(PipelineError, pipeline_error_handler)


_DB_STATUS: dict = {"value": None, "at": 0.0, "running": False}
_DB_STATUS_LOCK = threading.Lock()


def _public_database_status(value: dict) -> dict:
    """/health is public: report the state only, never the driver's error text."""
    if value.get("error"):
        logger.warning("database health check failed: %s", value["error"])
    return {key: value[key] for key in ("configured", "ok") if key in value}


def _refresh_database_status() -> None:
    value = _public_database_status(db.ping())
    with _DB_STATUS_LOCK:
        _DB_STATUS.update(value=value, at=time.monotonic(), running=False)


def _database_status() -> dict:
    if not db.is_configured():
        return _public_database_status(db.ping())
    # An unreachable database host takes seconds to fail; /health answers from the last check
    # and refreshes it in the background so local launchers can still identify this server.
    with _DB_STATUS_LOCK:
        value = _DB_STATUS["value"]
        if (value is None or time.monotonic() - _DB_STATUS["at"] >= 30) and not _DB_STATUS["running"]:
            _DB_STATUS["running"] = True
            threading.Thread(target=_refresh_database_status, name="db-health", daemon=True).start()
    return value or {"configured": db.is_configured(), "ok": None, "checking": True}


def health() -> dict:
    database = _database_status()
    status = "healthy"
    if database.get("configured") and database.get("ok") is False:
        status = "degraded"
    return {"status": status, "connections": {"database": database}, "runtime": _RUNTIME,
            "activity": activity_snapshot()}


@app.get("/health")
def root_health() -> dict:
    return health()


@app.get("/api/health")
def api_health() -> dict:
    return health()


# Outermost: a request stays counted until its background tasks finish (see /health activity).
app.add_middleware(ActivityMiddleware)

app.include_router(world_router, prefix="/api")
app.include_router(character_router, prefix="/api")
app.include_router(avatar_router, prefix="/api")
app.include_router(factory_router, prefix="/api")
app.include_router(part_batch_router, prefix="/api")
app.include_router(blueprint_router, prefix="/api")
