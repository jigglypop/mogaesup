"""Authenticated character control API; existing world responses stay unchanged."""

import os
from functools import lru_cache
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Body, Depends, Header, Query, Request
from fastapi.responses import JSONResponse
from src.services.object_storage import artifact_response as FileResponse
from pydantic import BaseModel, ConfigDict, Field

from src.auth import UserContext, get_current_user
from src.paths import data_root
from src.services.character_actions import execute
from src.services.character_pipeline import CharacterPipeline, PipelineError


router = APIRouter(prefix="/characters", tags=["characters"])


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class CharacterCreate(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    height_meters: float | None = Field(default=None, ge=0.1, le=100)


class CharacterUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    height_meters: float | None = Field(default=None, ge=0.1, le=100)


class Part(StrictModel):
    node_index: int = Field(ge=0)
    role: Literal["body", "head", "hair", "hat", "top", "pants", "skirt", "dress", "shoes", "outfit_base", "accessory", "eyes", "other"]


class FaceSelection(Part):
    primitive_index: int = Field(ge=0)
    faces: list[int] = Field(min_length=1, max_length=300000)


class SegmentationInput(StrictModel):
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    source_artifact_id: Literal["local_fallback", "imported", "rigged", "generated", "animated", "parts_model"] | None = None
    selections: list[FaceSelection] = Field(min_length=1, max_length=100)


class MotionActions(StrictModel):
    idle: int = Field(default=0, ge=0)
    walk: int = Field(default=1, ge=0)
    run: int = Field(default=14, ge=0)
    jump: int = Field(default=466, ge=0)
    fall: int = Field(default=502, ge=0)


class PrepareInput(StrictModel):
    actions: MotionActions = Field(default_factory=MotionActions)
    max_new_tasks: int = Field(default=6, ge=1, le=6)


class GenerationInput(StrictModel):
    profile: Literal["meshy-7", "smart-topology"] = "meshy-7"


class MotionRecovery(StrictModel):
    slot: Literal["rig", "idle", "walk", "run", "jump", "fall"]
    task_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,100}$")


class PartsInput(StrictModel):
    parts: list[Part] = Field(min_length=2, max_length=100)
    body_coverage: Literal["full", "partial", "unknown"]


class ReviewInput(StrictModel):
    decision: Literal["approved", "changes_requested"]
    notes: str = Field(min_length=5, max_length=2000)
    motion_checked: bool = False
    appearance_checked: bool = False


class RecoverInput(StrictModel):
    task_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,100}$")


ACTION_INPUTS = {"inspect_model": StrictModel, "separate_materials": StrictModel, "separate_parts": SegmentationInput, "organize_parts": PartsInput, "record_review": ReviewInput,
                 "prepare_character": PrepareInput, "resume_character": StrictModel, "recover_motion_task": MotionRecovery,
                 "refresh_provider": StrictModel, "recover_task": RecoverInput,
                 "submit_generation": GenerationInput, "submit_rigging": StrictModel,
                 "download_generation": StrictModel, "download_rigging": StrictModel}


@lru_cache
def get_pipeline():
    return CharacterPipeline(data_root(), int(os.getenv("BLENDER_PORT", "9878")),
                             int(os.getenv("CHARACTER_OWNER_ID", "1")))


async def pipeline_error_handler(request: Request, exc: PipelineError):
    return JSONResponse(status_code=exc.status, content={"error": {"code": exc.code, "message": exc.message}})


@router.get("")
def list_characters(user: UserContext = Depends(get_current_user), pipeline=Depends(get_pipeline)):
    return {"characters": pipeline.listing(user.user_id)}


@router.post("", status_code=201)
def create_character(body: CharacterCreate, user: UserContext = Depends(get_current_user), pipeline=Depends(get_pipeline)):
    return pipeline.create(body.name, body.height_meters, user.user_id)


@router.get("/{character_id}")
def detail(character_id: str, user: UserContext = Depends(get_current_user), pipeline=Depends(get_pipeline)):
    return pipeline.detail(character_id, user.user_id)


@router.patch("/{character_id}")
def update(character_id: str, body: CharacterUpdate, if_match: str = Header(),
           user: UserContext = Depends(get_current_user), pipeline=Depends(get_pipeline)):
    values = body.model_dump(exclude_unset=True)
    if values.get("name", "valid") is None:
        raise PipelineError("invalid_name", "이름을 입력해 주세요.", 400)
    return pipeline.update(character_id, user.user_id, values, if_match.strip('"'))


@router.post("/{character_id}/sources")
async def upload(character_id: str, request: Request, kind: Literal["image", "model"] = Query(),
                 if_match: str = Header(), user: UserContext = Depends(get_current_user), pipeline=Depends(get_pipeline)):
    # Raw upload avoids base64 expansion; filenames and local paths are never trusted.
    pipeline.entry(character_id, user.user_id)
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > 25 * 1024 * 1024:
            raise PipelineError("upload_too_large", "파일은 25MB 이하로 준비해 주세요.", 413)
    from starlette.concurrency import run_in_threadpool
    return await run_in_threadpool(pipeline.upload, character_id, user.user_id, bytes(content), kind, if_match.strip('"'))


@router.get("/{character_id}/artifacts/{artifact_id}")
def artifact(character_id: str, artifact_id: str, user: UserContext = Depends(get_current_user), pipeline=Depends(get_pipeline)):
    path = pipeline.artifact(character_id, user.user_id, artifact_id)
    mime = {".glb": "model/gltf-binary", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}.get(path.suffix, "application/octet-stream")
    return FileResponse(path, media_type=mime, headers={"Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff"})


@router.post("/{character_id}/actions/{action_id}", status_code=202)
def action(character_id: str, action_id: str, background: BackgroundTasks,
           body: dict = Body(default={}), if_match: str = Header(), idempotency_key: str = Header(),
           user: UserContext = Depends(get_current_user), pipeline=Depends(get_pipeline)):
    from pydantic import ValidationError
    if action_id not in ACTION_INPUTS:
        raise PipelineError("unknown_action", "지원하지 않는 작업입니다.", 400)
    try:
        payload = ACTION_INPUTS[action_id].model_validate(body).model_dump()
    except ValidationError as exc:
        raise PipelineError("invalid_input", "작업 입력을 확인해 주세요.", 422) from exc
    operation, created = pipeline.accept(character_id, user.user_id, action_id, idempotency_key, if_match.strip('"'), payload)
    if created:
        background.add_task(execute, pipeline, character_id, user.user_id, operation["id"])
    return {"operation": operation}


@router.get("/{character_id}/operations/{operation_id}")
def operation(character_id: str, operation_id: str, user: UserContext = Depends(get_current_user), pipeline=Depends(get_pipeline)):
    return pipeline.operation(character_id, user.user_id, operation_id)


@router.post("/{character_id}/operations/{operation_id}/recover")
def recover_operation(character_id: str, operation_id: str, if_match: str = Header(),
                      user: UserContext = Depends(get_current_user), pipeline=Depends(get_pipeline)):
    from src.services.character_recovery import recover
    return {"operation": recover(pipeline, character_id, user.user_id, operation_id, if_match.strip('"'))}
