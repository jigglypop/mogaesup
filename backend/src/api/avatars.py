"""Avatar views use the same authentication and error envelope as character controls."""

from functools import lru_cache

from fastapi import APIRouter, Depends, Header, Query
from src.services.object_storage import artifact_response as FileResponse
from pydantic import BaseModel, ConfigDict, Field

from src.auth import UserContext, get_current_user
from src.paths import data_root
from src.services.avatar_catalog import AvatarCatalog


router = APIRouter(prefix="/avatars", tags=["avatars"])


@lru_cache
def get_avatar_catalog():
    return AvatarCatalog(data_root())


class AvatarStateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    body: str = Field(min_length=1, max_length=128)
    equipment: dict[str, str] = Field(max_length=13)


@router.get("/catalog")
def catalog(user: UserContext = Depends(get_current_user), service=Depends(get_avatar_catalog)):
    return {"assets": service.records(user.user_id), "rig": "gaesup-humanoid-v1", "visualApproval": "pending"}


@router.get("/assets/{asset_id}/model")
def model(asset_id: str, lod: int = Query(0, ge=0, le=1),
          user: UserContext = Depends(get_current_user), service=Depends(get_avatar_catalog)):
    path, digest = service.model(asset_id, lod, user.user_id)
    return FileResponse(path, media_type="model/gltf-binary", headers={
        "Cache-Control": "private, no-cache", "ETag": f'"{digest}"',
        "X-Content-Type-Options": "nosniff"})


@router.get("/me")
def read(user: UserContext = Depends(get_current_user), service=Depends(get_avatar_catalog)):
    return service.read(user.user_id)


@router.put("/me")
def save(body: AvatarStateInput, if_match: str = Header(), idempotency_key: str = Header(),
         user: UserContext = Depends(get_current_user), service=Depends(get_avatar_catalog)):
    return service.save(user.user_id, body.model_dump(), if_match.strip('"'), idempotency_key)
