import math
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, Header
from pydantic import BaseModel, ConfigDict, Field, model_validator

from src.api.avatar_factory import HairRedrawInput, get_factory
from src.auth import UserContext, get_current_user
from src.services.avatar_part_batches import PartBatches, split_sheet
from src.services.meshy_options import MeshyPartOptions


router = APIRouter(prefix='/avatar-factory/part-batches', tags=['part-batches'])


def _valid_edges(edges, count):
    return (len(edges) == count+1 and edges[0] == 0 and edges[-1] == 1
            and all(math.isfinite(value) and 0 <= value <= 1 for value in edges)
            and all(a < b for a, b in zip(edges, edges[1:])))


class SheetInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    asset_id: str = Field(pattern=r'^[a-f0-9]{64}$')
    rows: int = Field(ge=1, le=12, strict=True)
    columns: int = Field(ge=1, le=8, strict=True)
    row_edges: list[float] | None = None
    view_edges: list[list[float]] | None = None
    view_order: list[Literal['front', 'side', 'back']] = Field(
        default_factory=lambda: ['front', 'back', 'side'])
    remove_skin: bool = False
    detect_view_seams: bool = False

    @model_validator(mode='after')
    def validate_grid(self):
        if self.detect_view_seams and (self.rows != 1 or self.columns != 1 or self.view_edges is not None):
            raise ValueError('투명 경계 분할은 3뷰 이미지 한 장에만 사용할 수 있습니다.')
        if self.rows*self.columns > 48:
            raise ValueError('시트는 최대 48종까지 자를 수 있습니다.')
        if len(self.view_order) != 3 or set(self.view_order) != {'front', 'side', 'back'}:
            raise ValueError('정면·측면·후면 순서를 각각 한 번씩 입력하세요.')
        if self.row_edges is not None and not _valid_edges(self.row_edges, self.rows):
            raise ValueError('행 경계는 0에서 1까지 오름차순으로 입력하세요.')
        if self.view_edges is not None and (
                len(self.view_edges) != self.rows
                or any(not _valid_edges(edges, self.columns*3) for edges in self.view_edges)):
            raise ValueError('각 행에 3뷰 경계를 0에서 1까지 오름차순으로 입력하세요.')
        return self


class BatchItem(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=100)
    views: dict[Literal['front', 'side', 'back'], str]

    @model_validator(mode='after')
    def validate_views(self):
        if set(self.views) != {'front', 'side', 'back'}:
            raise ValueError('헤어마다 정면·측면·후면 3뷰가 필요합니다.')
        if any(not isinstance(asset_id, str) or len(asset_id) != 64
               or any(char not in '0123456789abcdef' for char in asset_id)
               for asset_id in self.views.values()):
            raise ValueError('각 뷰에 업로드한 이미지 ID가 필요합니다.')
        return self


class BatchInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    base_job_id: str = Field(pattern=r'^[a-f0-9]{24}$')
    base_version: str = Field(pattern=r'^[a-f0-9]{24}$')
    items: list[BatchItem] = Field(min_length=1, max_length=48)
    concurrency: int = Field(default=4, ge=1, le=4, strict=True)
    meshy_options: MeshyPartOptions = Field(default_factory=MeshyPartOptions)
    redraw: HairRedrawInput | None = None


@router.post('/split-sheet')
def split(body: SheetInput, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return split_sheet(factory, user.user_id, body.model_dump(mode='json'))


@router.get('')
def listing(user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return PartBatches(factory).list(user.user_id)


@router.post('', status_code=202)
def create(body: BatchInput, background: BackgroundTasks, idempotency_key: str = Header(),
           user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    service = PartBatches(factory)
    payload = body.model_dump(mode='json')
    if payload['redraw'] is None:
        payload.pop('redraw')  # Preserve the fingerprint of saved three-view requests.
    elif not payload['redraw'].get('worn'):
        payload['redraw'].pop('worn', None)  # Same fingerprint as requests made before worn redraws.
    record, dispatch = service.create(user.user_id, idempotency_key, payload)
    if dispatch:
        background.add_task(service.execute, user.user_id, record['id'])
    return record


@router.get('/{batch_id}')
def get(batch_id: str, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return PartBatches(factory).get(user.user_id, batch_id)


@router.post('/{batch_id}/resume', status_code=202)
def resume(batch_id: str, background: BackgroundTasks,
           user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    service = PartBatches(factory)
    record, dispatch = service.resume(user.user_id, batch_id)
    if dispatch:
        background.add_task(service.execute, user.user_id, batch_id)
    return record
