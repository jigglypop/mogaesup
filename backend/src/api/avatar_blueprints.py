from functools import lru_cache
from typing import Literal

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse
from src.services.object_storage import artifact_response as FileResponse
from pydantic import BaseModel, ConfigDict, Field

from src.auth import UserContext, get_current_user
from src.paths import data_root
from src.services.avatar_blueprints import AvatarBlueprints
from src.services.avatar_equipment import ImageSlot

router = APIRouter(prefix='/avatar-blueprints', tags=['avatar-blueprints'])

@lru_cache
def get_blueprints():
    return AvatarBlueprints(data_root())

class Layer(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    slot: Literal['body'] | ImageSlot
    label: str = Field(min_length=1, max_length=40)
    asset: str | None
    crop: tuple[float, float, float, float]
    placement: tuple[float, float, float, float]
    visible: bool
    opacity: float = Field(ge=0, le=1)
    order: int = Field(ge=0, le=12)
    description: str = Field(default='', max_length=600)
    background: Literal['alpha', 'border-gray']
    status: Literal['design_candidate', 'needs_image']

class BlueprintInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    layers: list[Layer] = Field(min_length=8, max_length=13)

@router.get('/assets/{asset_id}')
def asset(asset_id: str, user: UserContext = Depends(get_current_user), service=Depends(get_blueprints)):
    return FileResponse(service.asset(user.user_id, asset_id), media_type='image/png')

@router.post('/assets', status_code=201)
async def upload(request: Request, user: UserContext = Depends(get_current_user), service=Depends(get_blueprints)):
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > 32*1024*1024:
            from src.services.character_pipeline import PipelineError
            raise PipelineError('image_too_large', '이미지는 32MB 이하로 올려 주세요.', 422)
    return service.upload(user.user_id, bytes(content))

@router.get('/{character_id}')
def read(character_id: str, user: UserContext = Depends(get_current_user), service=Depends(get_blueprints)):
    return service.read(user.user_id, character_id)

@router.put('/{character_id}')
def save(character_id: str, body: BlueprintInput, if_match: str = Header(), idempotency_key: str = Header(),
         user: UserContext = Depends(get_current_user), service=Depends(get_blueprints)):
    return service.save(user.user_id, character_id, [layer.model_dump() for layer in body.layers], if_match.strip('"'), idempotency_key)

@router.get('/{character_id}/recipe')
def recipe(character_id: str, user: UserContext = Depends(get_current_user), service=Depends(get_blueprints)):
    return JSONResponse(service.recipe(user.user_id, character_id), headers={'Content-Disposition': 'attachment; filename="avatar-blueprint.json"'})
