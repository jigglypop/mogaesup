"""The studio gateway authenticates the paid operator before forwarding AI requests."""
from typing import Literal

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, ConfigDict, Field, model_validator

from src.auth import UserContext, get_current_user
from src.services.character_pipeline import PipelineError
from src.services.store_layouts import LayoutIntent, StoreLayouts, capabilities as layout_capabilities

router = APIRouter(prefix='/studio/layouts', tags=['studio layouts'])


@router.get('/capabilities')
def capabilities(user: UserContext = Depends(get_current_user)):
    result = layout_capabilities()
    result['ai'] = result['ai'] and not any(str(role).upper() == 'MEMBER' for role in user.roles)
    return result


class InterpretInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    description: str = Field(min_length=1, max_length=2000)
    mode: Literal['rules', 'ai'] = 'rules'
    requestId: str | None = Field(default=None, pattern=r'^[A-Za-z0-9_-]{8,80}$')

    @model_validator(mode='after')
    def require_paid_receipt(self):
        if self.mode == 'ai' and not self.requestId:
            raise ValueError('AI 해석에는 요청 식별자가 필요합니다.')
        return self


@router.post('/interpret', response_model=LayoutIntent)
def interpret(body: InterpretInput, user: UserContext = Depends(get_current_user),
              idempotency_key: str | None = Header(default=None, alias='Idempotency-Key')):
    if body.mode == 'ai' and any(str(role).upper() == 'MEMBER' for role in user.roles):
        raise PipelineError('forbidden', 'AI 해석 권한이 필요합니다.', 403)
    if body.mode == 'ai' and idempotency_key != body.requestId:
        raise PipelineError('invalid_request_id', '요청 식별자와 Idempotency-Key가 같아야 합니다.', 422)
    return StoreLayouts(user.user_id).interpret(body.description, body.mode, body.requestId)
