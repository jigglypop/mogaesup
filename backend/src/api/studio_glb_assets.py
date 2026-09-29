"""Raw GLB asset-library endpoints for Asset Studio."""
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, Header, Request
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from src.api.avatar_factory import get_factory
from src.auth import UserContext, get_current_user
from src.services.avatar_image_pipeline import AvatarImagePipeline
from src.services.avatar_stage_resume import AvatarStageResume
from src.services.character_pipeline import PipelineError
from src.services.object_storage import artifact_response
from src.services.studio_glb_assets import StudioGlbAssets


router = APIRouter(prefix='/studio/glb-assets', tags=['studio-glb-assets'])


class GlbAssetInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=100)
    slot: Literal['body', 'hair', 'hat', 'top', 'bottom', 'shoes', 'weapon', 'tool', 'glasses', 'prop']
    model_asset: str = Field(pattern=r'^[a-f0-9]{64}$')


class PrepareInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    action: Literal['fit', 'rig']
    base_job_id: str | None = Field(default=None, pattern=r'^[a-f0-9]{24}$')
    base_version: str | None = Field(default=None, pattern=r'^[a-f0-9]{24}$')
    body_type: Literal['male', 'female'] | None = None


@router.post('/upload', status_code=201)
async def upload_glb(request: Request, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_glb_bodies import MAX_GLB_BYTES
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > MAX_GLB_BYTES:
            raise PipelineError('glb_too_large', 'GLB는 256MiB 이하여야 합니다.', 413)
    return await run_in_threadpool(StudioGlbAssets(factory, user.user_id).upload, bytes(content))


@router.get('')
def glb_assets(user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return StudioGlbAssets(factory, user.user_id).listing()


@router.post('', status_code=201)
def register_glb_asset(body: GlbAssetInput, idempotency_key: str = Header(alias='Idempotency-Key'),
                       user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    record, _ = StudioGlbAssets(factory, user.user_id).create(idempotency_key, body.model_dump())
    return record


@router.get('/{asset_id}')
def glb_asset(asset_id: str, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return StudioGlbAssets(factory, user.user_id).get(asset_id)


@router.get('/{asset_id}/source.glb')
def glb_asset_source(asset_id: str, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return artifact_response(StudioGlbAssets(factory, user.user_id).source(asset_id),
                             media_type='model/gltf-binary', filename='source.glb')


@router.post('/{asset_id}/prepare', status_code=202)
def prepare_glb_asset(asset_id: str, body: PrepareInput, background: BackgroundTasks,
                      idempotency_key: str = Header(alias='Idempotency-Key'),
                      user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    job, created = StudioGlbAssets(factory, user.user_id).prepare(
        asset_id, idempotency_key, body.model_dump(exclude_none=True))
    if created and body.action == 'fit':
        background.add_task(AvatarImagePipeline(factory).execute, user.user_id, job['id'])
    elif body.action == 'rig':
        stages = AvatarStageResume(factory)
        _, request_id = stages.start(user.user_id, job['id'], 'rig', 'glb-import-'+job['id'])
        if request_id:
            background.add_task(stages.execute, user.user_id, job['id'], request_id)
    return factory.get(user.user_id, job['id'])
