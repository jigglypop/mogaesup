from functools import lru_cache
from typing import Annotated, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, Header, Request
from src.services.object_storage import artifact_response as FileResponse
from pydantic import BaseModel, ConfigDict, Field

from src.auth import UserContext, get_current_user
from src.paths import data_root
from src.services.avatar_factory import AvatarFactory, PROFILE, _LOCK
from src.services.avatar_image_pipeline import AvatarImagePipeline, capabilities
from src.services.avatar_equipment import ImageSlot
from src.services.avatar_meshy import AvatarMeshy
from src.services.avatar_native_parts import AvatarNativeParts
from src.services.avatar_native_outfits import AvatarNativeOutfits
from src.services.avatar_stage_resume import AvatarStageResume, ensure_stage_idle
from src.services.avatar_rig_transfer import AvatarRigTransfer
from src.services.character_pipeline import PipelineError
from src.services.meshy_options import MeshyPartOptions

router = APIRouter(prefix='/avatar-factory', tags=['avatar-factory'])


@lru_cache
def get_factory():
    return AvatarFactory(data_root())


class FitAnchorInput(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    name: str = Field(min_length=1, max_length=64)
    source: list[float] = Field(min_length=3, max_length=3)
    target: list[float] | None = Field(default=None, min_length=3, max_length=3)


class FitProfileInput(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    revision: Literal['garment-fit-v1'] | None = None
    sleeve: Literal['source', 'none', 'short', 'long'] | None = None
    kind: Literal['source', 'pants', 'skirt'] | None = None
    ease: Literal['source', 'regular', 'loose'] | None = None
    region_ease: dict[Literal['torso', 'sleeve', 'hip'], Literal['source', 'regular', 'loose']] | None = None
    length_ratio: float | None = Field(default=None, gt=0, le=3)
    sleeve_ratio: float | None = Field(default=None, ge=0, le=1.5)
    anchors: list[FitAnchorInput] | None = Field(default=None, max_length=48)
    source_sha256: str | None = Field(default=None, pattern=r'^[a-f0-9]{64}$')


class ImageProductionInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    character_id: str = Field(min_length=1, max_length=100)
    source_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    blueprint_revision: str = Field(min_length=1, max_length=100)
    production_mode: Literal['legacy', 'character_parts'] = 'legacy'
    view_mode: Literal['single', 'front_side', 'front_side_back'] = 'single'
    hair_length: Literal['source', 'short', 'long'] | None = None
    image_mode: Literal['generate', 'prepared'] = 'generate'
    slots: list[ImageSlot] = Field(default_factory=list, max_length=13)
    rig_with_meshy: bool = False
    body_purpose: Literal['whole_character', 'wardrobe_base'] = 'whole_character'
    motion_actions: dict[str, int] = Field(default_factory=dict, max_length=8)
    reuse_job_id: str | None = Field(default=None, pattern=r'^[a-f0-9]{24}$')
    design_prompts: dict[Literal['body', 'hair', 'hat', 'top', 'bottom', 'shoes'], str] | None = Field(default=None, max_length=6)
    prepare_reference: bool | None = False
    default_expressions: bool | None = False
    base_job_id: str | None = Field(default=None, pattern=r'^[a-f0-9]{24}$')
    base_version: str | None = Field(default=None, pattern=r'^[a-f0-9]{24}$')
    fit_profiles: dict[Literal['top', 'bottom'], FitProfileInput] | None = None
    meshy_options: MeshyPartOptions | None = None
    part_methods: dict[Literal['hair', 'hat', 'top', 'bottom'], Literal['isolated', 'body_shell', 'worn']] | None = None
    model_provider: Literal['meshy', 'tripo'] | None = None


class RecoverPartInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    slot: ImageSlot
    task_id: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,100}$')


class RigTransferInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    source_job_id: str = Field(pattern=r'^[a-f0-9]{24}$')
    source_version: str = Field(pattern=r'^[a-f0-9]{24}$')


class BaseBodyViewsInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    front: str = Field(pattern=r'^[a-f0-9]{64}$')
    side: str = Field(pattern=r'^[a-f0-9]{64}$')
    back: str = Field(pattern=r'^[a-f0-9]{64}$')


class BaseBodyRigSourceInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    job_id: str = Field(pattern=r'^[a-f0-9]{24}$')
    version: str = Field(pattern=r'^[a-f0-9]{24}$')


class BaseBodyInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=100)
    body_type: Literal['male', 'female']
    views: BaseBodyViewsInput
    rig_source: BaseBodyRigSourceInput | None = None


class GlbBodyInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=100)
    body_type: Literal['male', 'female']
    model_asset: str = Field(pattern=r'^[a-f0-9]{64}$')
    import_mode: Literal['register', 'rig'] = 'register'
    generate_motions: bool = False
    prepare_expression_uv: bool = False


@router.post('/base-bodies/glb-assets', status_code=201)
async def upload_body_glb(request: Request, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from starlette.concurrency import run_in_threadpool
    from src.services.avatar_glb_bodies import AvatarGlbBodies, MAX_GLB_BYTES
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > MAX_GLB_BYTES:
            raise PipelineError('glb_too_large', 'GLB는 256MB 이하로 올려 주세요.', 422)
    return await run_in_threadpool(AvatarGlbBodies(factory).upload, user.user_id, bytes(content))


@router.get('/base-bodies/glb-assets/{asset_id}')
def body_glb_info(asset_id: str, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_glb_bodies import AvatarGlbBodies
    return AvatarGlbBodies(factory).asset(user.user_id, asset_id)


@router.post('/base-bodies/glb', status_code=202)
def import_body_glb(body: GlbBodyInput, background: BackgroundTasks,
                    idempotency_key: str = Header(alias='Idempotency-Key'),
                    user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_glb_bodies import AvatarGlbBodies
    job, created = AvatarGlbBodies(factory).create(user.user_id, idempotency_key, body.model_dump(exclude_none=True))
    if created and body.import_mode == 'rig':
        stages = AvatarStageResume(factory)
        _, request_id = stages.start(user.user_id, job['id'], 'rig', 'glb-import-'+job['id'])
        if request_id:
            background.add_task(stages.execute, user.user_id, job['id'], request_id)
    return factory.get(user.user_id, job['id'])


@router.get('/base-bodies')
def base_bodies(user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_base_bodies import AvatarBaseBodies
    return {'jobs': AvatarBaseBodies(factory).listing(user.user_id)}


@router.post('/base-bodies', status_code=202)
def create_base_body(body: BaseBodyInput, background: BackgroundTasks,
                     idempotency_key: str = Header(alias='Idempotency-Key'),
                     user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_base_bodies import AvatarBaseBodies
    service = AvatarBaseBodies(factory)
    job, created = service.create(user.user_id, idempotency_key, body.model_dump(exclude_none=True))
    if created or job['status'] in ('pipeline_queued', 'recovery_required'):
        background.add_task(AvatarImagePipeline(factory).execute, user.user_id, job['id'])
    return job


@router.get('/rig-transfer/sources')
def rig_transfer_sources(user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return AvatarRigTransfer(factory).sources(user.user_id)


@router.get('/jobs/{job_id}/rig-transfer')
def rig_transfer_status(job_id: str, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return AvatarRigTransfer(factory).get(user.user_id, job_id)


@router.post('/jobs/{job_id}/rig-transfer', status_code=202)
def rig_transfer_start(job_id: str, body: RigTransferInput, background: BackgroundTasks,
                       idempotency_key: str = Header(alias='Idempotency-Key'),
                       user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    service = AvatarRigTransfer(factory)
    state, request_id = service.start(user.user_id, job_id, body.source_job_id, body.source_version, idempotency_key)
    if request_id:
        background.add_task(service.execute, user.user_id, job_id, request_id)
    return state


class VariantInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    base_job_id: str = Field(pattern=r'^[a-f0-9]{24}$')
    base_version: str = Field(pattern=r'^[a-f0-9]{24}$')
    slots: list[Literal['hair', 'hat', 'top', 'bottom', 'shoes', 'weapon', 'tool', 'glasses']] = Field(min_length=1, max_length=8)
    hair_length: Literal['source', 'short', 'long'] = 'source'
    bottom_kind: Literal['source', 'pants', 'skirt'] | None = None
    descriptions: dict[str, str] = Field(default_factory=dict, max_length=8)
    fit_profiles: dict[Literal['top', 'bottom'], FitProfileInput] | None = None
    meshy_options: MeshyPartOptions | None = None
    part_methods: dict[Literal['hair', 'hat', 'top', 'bottom'], Literal['isolated', 'body_shell', 'worn']] | None = None
    model_provider: Literal['meshy', 'tripo'] | None = None
    # Front and side by default; the back view gives the 3D provider the rear of long hair and garments.
    view_mode: Literal['front_side', 'front_side_back'] | None = None


class HairRedrawInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    notes: str = Field(default='', max_length=2000)
    source_side_facing: Literal['left', 'right'] = 'right'
    worn: bool = False


class SinglePartVariantInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    base_job_id: str = Field(pattern=r'^[a-f0-9]{24}$')
    base_version: str = Field(pattern=r'^[a-f0-9]{24}$')
    slot: Literal['hair', 'hat', 'top', 'bottom', 'shoes', 'weapon', 'tool', 'glasses']
    hair_length: Literal['source', 'short', 'long'] = 'source'
    bottom_kind: Literal['source', 'pants', 'skirt'] = 'source'
    view_mode: Literal['front_side', 'front_side_back'] | None = None
    fit_profile: FitProfileInput | None = None
    meshy_options: MeshyPartOptions | None = None
    uploaded_views: dict[Literal['front', 'side', 'back'], str] | None = None
    redraw: HairRedrawInput | None = None
    part_name: str | None = Field(default=None, max_length=100)
    # The part's own design brief; without it the owner's prompt library describes the slot.
    description: str | None = Field(default=None, max_length=2000)
    part_method: Literal['isolated', 'body_shell', 'worn'] | None = None
    model_provider: Literal['meshy', 'tripo'] | None = None


@router.get('/meshy-options')
def meshy_options(user: UserContext = Depends(get_current_user)):
    return {'defaults': MeshyPartOptions().model_dump(), 'schema': MeshyPartOptions.model_json_schema(),
            'endpoint': '/openapi/v1/multi-image-to-3d',
            'documentation': 'https://docs.meshy.ai/en/api/multi-image-to-3d'}


@router.post('/meshy-options/texture-assets', status_code=201)
async def upload_meshy_texture(request: Request, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from starlette.concurrency import run_in_threadpool
    from src.services.meshy_options import upload_texture
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > 32*1024*1024:
            raise PipelineError('image_too_large', '텍스처 이미지는 32MB 이하로 올려 주세요.', 422)
    return await run_in_threadpool(upload_texture, factory, user.user_id, bytes(content))


@router.post('/variants', status_code=202)
def create_variant(body: VariantInput, background: BackgroundTasks, idempotency_key: str = Header(),
                   user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_variants import AvatarVariants
    if any(len(value) > 2000 for value in body.descriptions.values()):
        from src.services.character_pipeline import PipelineError
        raise PipelineError('description_too_long', '파츠 설명은 2000자 이내로 입력하세요.', 422)
    job, created = AvatarVariants(factory).create(user.user_id, idempotency_key, body.model_dump(exclude_none=True))
    # Re-dispatch an accepted queue receipt when the HTTP response/background
    # handoff was lost. execute() atomically claims the job before provider I/O.
    if created or job['status'] == 'pipeline_queued':
        background.add_task(AvatarImagePipeline(factory).execute, user.user_id, job['id'])
    return job


@router.post('/variants/single-part', status_code=202)
def create_single_part_variant(body: SinglePartVariantInput, background: BackgroundTasks,
                               idempotency_key: str = Header(alias='Idempotency-Key'),
                               user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_variants import AvatarVariants
    service = AvatarVariants(factory)
    payload = body.model_dump(exclude_none=True)
    if payload.get('redraw') and not payload['redraw'].get('worn'):
        payload['redraw'].pop('worn', None)  # Same fingerprint as requests made before worn redraws.
    job, created = service.create_single_part(user.user_id, idempotency_key, payload)
    if created or job['status'] == 'pipeline_queued':
        background.add_task(AvatarImagePipeline(factory).execute, user.user_id, job['id'])
    return job


class RetryImageInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    slot: ImageSlot | Literal['reference']
    view: Literal['front', 'side', 'back', 'opposite']
    failure_id: str = Field(pattern=r'^[a-f0-9]{12}$')


class RetryImagesInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    images: list[RetryImageInput] = Field(min_length=1, max_length=24)


class MotionDefaultsInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    selections: dict[str, int] = Field(max_length=8)


class MeshyMotionInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    slot: Literal['idle', 'walk', 'run', 'jump', 'fall', 'sit', 'armsUp', 'crouch']
    action_id: int = Field(ge=0, strict=True)


class MeshyRecoverInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    task_id: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,100}$')
    action_id: int | None = Field(default=None, ge=0, strict=True)


class NativeOutfitInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    body_sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    slots: list[str] = Field(max_length=32)
    hair_color: str | None = Field(default=None, pattern='^#[0-9a-fA-F]{6}$')


class GarmentShapeInput(BaseModel):
    """Body-shell garment shape: sleeve 0 (none)..1 (wrist); hem top waist..crotch, bottom shorts..ankle."""
    model_config = ConfigDict(extra='forbid')
    sleeve: float | None = Field(default=None, ge=0, le=1)
    hem: float | None = Field(default=None, ge=0, le=1)
    fit: Literal['tight', 'normal', 'loose'] | None = None


class NativePartRefitInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    source_version: str = Field(pattern=r'^[a-f0-9]{24}$')
    slot: Literal['hair', 'head', 'hairBack', 'hairFront', 'hat', 'top', 'bottom', 'shoes',
                  'weapon', 'tool', 'glasses']
    fit_profile: FitProfileInput | None = None
    part_method: Literal['isolated', 'body_shell'] | None = None
    shape: GarmentShapeInput | None = None


class CommonBodyInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    job_id: str = Field(pattern=r'^[a-f0-9]{24}$')
    version: str = Field(pattern=r'^[a-f0-9]{24}$')
    expected_revision: str = Field(min_length=1, max_length=64)


class NativeVersionInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: str = Field(pattern=r'^[a-f0-9]{24}$')
    expected_version: str = Field(pattern=r'^[a-f0-9]{24}$')


@router.get('/body-profile')
def common_body(user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_fitting_management import FittingManagement
    return FittingManagement(factory, user.user_id).body_default()


@router.put('/body-profile')
def set_common_body(body: CommonBodyInput, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_fitting_management import FittingManagement
    return FittingManagement(factory, user.user_id).save_body_default(body.job_id, body.version, body.expected_revision)


class WardrobeBodyInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: str = Field(pattern=r'^[a-f0-9]{24}$')
    expected_revision: str = Field(min_length=1, max_length=64)


@router.get('/wardrobe/bodies')
def wardrobe_bodies(user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_wardrobe import Wardrobe
    return Wardrobe(factory, user.user_id).bodies()


@router.put('/wardrobe/bodies/{job_id}')
def register_wardrobe_body(job_id: str, body: WardrobeBodyInput, user: UserContext = Depends(get_current_user),
                           factory=Depends(get_factory)):
    from src.services.avatar_wardrobe import Wardrobe
    return Wardrobe(factory, user.user_id).register(job_id, body.version, body.expected_revision)


@router.delete('/wardrobe/bodies/{job_id}')
def unregister_wardrobe_body(job_id: str, if_match: str = Header(alias='If-Match'),
                             user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_wardrobe import Wardrobe
    return Wardrobe(factory, user.user_id).unregister(job_id, if_match)


@router.get('/wardrobe/bodies/{job_id}/parts')
def wardrobe_parts(job_id: str, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_wardrobe import Wardrobe
    return Wardrobe(factory, user.user_id).parts(job_id)


@router.get('/wardrobe/bodies/{body_job_id}/coverage/{job_id}/{slot}')
def wardrobe_coverage(body_job_id: str, job_id: str, slot: str, version: str,
                      user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_wardrobe import Wardrobe
    return Wardrobe(factory, user.user_id).coverage(body_job_id, job_id, slot, version)


@router.get('/wardrobe/colors/{job_id}/{slot}')
def wardrobe_colors(job_id: str, slot: str, version: str, user: UserContext = Depends(get_current_user),
                    factory=Depends(get_factory)):
    from src.services.avatar_wardrobe import Wardrobe
    return Wardrobe(factory, user.user_id).colors(job_id, slot, version)[0]


@router.get('/wardrobe/colors/{job_id}/{slot}/mask')
def wardrobe_color_mask(job_id: str, slot: str, version: str, user: UserContext = Depends(get_current_user),
                        factory=Depends(get_factory)):
    from src.services.avatar_wardrobe import Wardrobe
    return FileResponse(Wardrobe(factory, user.user_id).colors(job_id, slot, version)[1], media_type='image/png')


@router.get('/wardrobe/previews/{job_id}/{slot}')
def wardrobe_preview(job_id: str, slot: str, version: str, user: UserContext = Depends(get_current_user),
                     factory=Depends(get_factory)):
    from src.services.avatar_wardrobe import Wardrobe
    return FileResponse(Wardrobe(factory, user.user_id).preview(job_id, slot, version), media_type='image/png')


class WardrobeRef(BaseModel):
    model_config = ConfigDict(extra='forbid')
    job_id: str = Field(pattern=r'^[a-f0-9]{24}$')
    version: str = Field(pattern=r'^[a-f0-9]{24}$')


class WardrobePartRef(WardrobeRef):
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')


class WardrobeOutfitInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=60)
    body: WardrobeRef
    parts: dict[Literal['hair', 'hairFront', 'hairBack', 'hat', 'top', 'bottom', 'shoes', 'weapon', 'tool', 'glasses'],
                WardrobePartRef] = Field(max_length=10)
    hair_color: str | None = Field(default=None, pattern='^#[0-9a-fA-F]{6}$')
    # Region colours per worn slot: {slot: {"0".."3": "#RRGGBB"}}.
    colors: dict[Literal['hat', 'top', 'bottom', 'shoes', 'weapon', 'tool', 'glasses'],
                 dict[Literal['0', '1', '2', '3'], Annotated[str, Field(pattern='^#[0-9a-fA-F]{6}$')]]] = Field(default_factory=dict, max_length=7)


@router.get('/wardrobe/outfits')
def wardrobe_outfits(user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_wardrobe import Wardrobe
    return Wardrobe(factory, user.user_id).outfits()


@router.put('/wardrobe/outfits/{outfit_id}')
def save_wardrobe_outfit(outfit_id: str, body: WardrobeOutfitInput, if_match: str = Header(alias='If-Match'),
                         idempotency_key: str = Header(alias='Idempotency-Key'),
                         user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_wardrobe import Wardrobe
    return Wardrobe(factory, user.user_id).save_outfit(outfit_id, body.model_dump(), if_match, idempotency_key)


@router.delete('/wardrobe/outfits/{outfit_id}')
def delete_wardrobe_outfit(outfit_id: str, if_match: str = Header(alias='If-Match'),
                           user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_wardrobe import Wardrobe
    return Wardrobe(factory, user.user_id).delete_outfit(outfit_id, if_match)


@router.get('/jobs/{job_id}/fit-profile/{slot}')
def garment_fit_profile(job_id: str, slot: Literal['top', 'bottom'], source_version: str | None = None,
                        user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_fitting_management import FittingManagement
    return FittingManagement(factory, user.user_id).part_profile(job_id, slot, source_version)


@router.get('/jobs/{job_id}/native-parts/versions')
def fitted_versions(job_id: str, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_fitting_management import FittingManagement
    return FittingManagement(factory, user.user_id).versions(job_id)


@router.post('/jobs/{job_id}/native-parts/select')
def select_fitted_version(job_id: str, body: NativeVersionInput, idempotency_key: str = Header(alias='Idempotency-Key'),
                          user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_fitting_management import FittingManagement
    return FittingManagement(factory, user.user_id).select(job_id, body.version, body.expected_version, idempotency_key)


@router.get('/motion-library')
def motion_library(user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return {'items': AvatarMeshy(factory).library(user.user_id)}


@router.get('/motion-defaults')
def motion_defaults(user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return AvatarMeshy(factory).defaults(user.user_id)


@router.put('/motion-defaults')
def save_motion_defaults(body: MotionDefaultsInput, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return AvatarMeshy(factory).defaults(user.user_id, body.selections)


@router.get('/jobs/{job_id}/meshy')
def meshy_state(job_id: str, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return AvatarMeshy(factory).get(user.user_id, job_id)


@router.get('/jobs/{job_id}/motion-defaults')
def body_motion_defaults(job_id: str, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return AvatarMeshy(factory).defaults(user.user_id, job_id=job_id)


@router.put('/jobs/{job_id}/motion-defaults')
def save_body_motion_defaults(job_id: str, body: MotionDefaultsInput,
                              user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return AvatarMeshy(factory).defaults(user.user_id, body.selections, job_id=job_id)


@router.get('/jobs/{job_id}/native-parts')
def native_parts(job_id: str, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return AvatarNativeParts(factory).get(user.user_id, job_id)


@router.post('/jobs/{job_id}/native-parts', status_code=202)
def fit_native_parts(job_id: str, background: BackgroundTasks, canonical_pose: bool = False,
                     user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    service = AvatarNativeParts(factory)
    with _LOCK:
        ensure_stage_idle(factory, user.user_id, job_id)
        state, created = service.start(user.user_id, job_id, canonical_pose=canonical_pose)
    if created or state.get('expression_pending'):
        background.add_task(service.execute_refit, user.user_id, job_id)
    return state


@router.get('/jobs/{job_id}/native-parts/{version}/{name}')
def native_parts_artifact(job_id: str, version: str, name: str, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return FileResponse(AvatarNativeParts(factory).artifact(user.user_id, job_id, version, name))


@router.get('/jobs/{job_id}/native-outfits/{version}')
def native_outfit(job_id: str, version: str, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return AvatarNativeOutfits(AvatarNativeParts(factory)).get(user.user_id, job_id, version)


@router.put('/jobs/{job_id}/native-outfits/{version}')
def save_native_outfit(job_id: str, version: str, body: NativeOutfitInput,
                      if_match: str = Header(alias='If-Match'), idempotency_key: str = Header(alias='Idempotency-Key'),
                      user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return AvatarNativeOutfits(AvatarNativeParts(factory)).put(
        user.user_id, job_id, version, body.model_dump(), if_match, idempotency_key)


@router.post('/jobs/{job_id}/meshy/rig', status_code=202)
def meshy_rig(job_id: str, background: BackgroundTasks, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    service = AvatarMeshy(factory)
    with _LOCK:
        ensure_stage_idle(factory, user.user_id, job_id)
        state = service.start(user.user_id, job_id)
    background.add_task(service.execute, user.user_id, job_id)
    return state


@router.post('/jobs/{job_id}/meshy/actions', status_code=202)
def meshy_action(job_id: str, body: MeshyMotionInput, background: BackgroundTasks,
                 user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    service = AvatarMeshy(factory)
    with _LOCK:
        ensure_stage_idle(factory, user.user_id, job_id)
        state = service.request_action(user.user_id, job_id, body.slot, body.action_id)
    background.add_task(service.execute, user.user_id, job_id)
    return state


@router.get('/jobs/{job_id}/meshy/artifacts/{version}/{name}')
def meshy_artifact(job_id: str, version: str, name: str, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return FileResponse(AvatarMeshy(factory).artifact(user.user_id, job_id, version, name))


@router.get('/jobs/{job_id}/meshy/provider/{name}')
def meshy_provider_artifact(job_id: str, name: str, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return FileResponse(AvatarMeshy(factory).provider_artifact(user.user_id, job_id, name))


@router.post('/jobs/{job_id}/meshy/recover')
def meshy_recover(job_id: str, body: MeshyRecoverInput, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return AvatarMeshy(factory).recover(user.user_id, job_id, body.task_id, body.action_id)


@router.post('/jobs/{job_id}/recover-task')
def recover_part(job_id: str, body: RecoverPartInput, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return AvatarImagePipeline(factory).recover_task(user.user_id, job_id, body.slot, body.task_id)


@router.get('/capabilities')
def provider_capabilities(user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.studio_prompts import StudioPrompts
    from src.services.meshy_status import PART_CREDITS, RIG_CREDITS, meshy_balance
    result = capabilities()
    saved = StudioPrompts(factory, user.user_id).values('parts')
    result['design_prompt_defaults'] = {key: saved[key] for key in result['design_prompt_defaults']}
    result['meshy_balance'] = meshy_balance() if result['meshy_configured'] else None
    result['meshy_credit_estimate'] = {'part': PART_CREDITS, 'rig': RIG_CREDITS}
    return result


@router.post('/image-jobs', status_code=202)
def create_images(body: ImageProductionInput, background: BackgroundTasks, idempotency_key: str = Header(),
                  user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    if body.design_prompts and any(len(value) > 2000 for value in body.design_prompts.values()):
        from src.services.character_pipeline import PipelineError
        raise PipelineError('design_prompt_too_long', '파츠 디자인 프롬프트는 2000자 이내로 입력하세요.', 422)
    service = AvatarImagePipeline(factory)
    payload = body.model_dump()
    if not payload.get('prepare_reference'):
        payload.pop('prepare_reference', None)  # Preserve fingerprints accepted before reference preparation.
    if not payload.get('default_expressions'):
        payload.pop('default_expressions', None)  # Preserve fingerprints accepted before default expressions.
    job, created = service.create(user.user_id, idempotency_key, payload)
    if created or job['status'] == 'pipeline_queued':
        background.add_task(service.execute, user.user_id, job['id'])
    return job


@router.post('/jobs/{job_id}/resume', status_code=202)
def resume_images(job_id: str, background: BackgroundTasks, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    ensure_stage_idle(factory, user.user_id, job_id)
    current = factory.get(user.user_id, job_id)
    if current.get('production_mode') == 'character_parts' and current['status'] == 'review_required':
        from src.services.avatar_character_flow import continue_character
        background.add_task(continue_character, factory, user.user_id, job_id)
        return current
    service = AvatarImagePipeline(factory)
    job = service.resume(user.user_id, job_id)
    background.add_task(service.execute, user.user_id, job_id)
    return job


@router.get('/jobs/{job_id}/stages')
def factory_stages(job_id: str, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return AvatarStageResume(factory).get(user.user_id, job_id)


@router.post('/jobs/{job_id}/stages/{stage}/resume', status_code=202)
def resume_factory_stage(job_id: str, stage: Literal['images', 'models', 'rig', 'assemble', 'expressions'],
                         background: BackgroundTasks, idempotency_key: str = Header(alias='Idempotency-Key'),
                         user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    service = AvatarStageResume(factory)
    state, request_id = service.start(user.user_id, job_id, stage, idempotency_key)
    if request_id:
        background.add_task(service.execute, user.user_id, job_id, request_id)
    return state


@router.post('/jobs/{job_id}/native-parts/refit', status_code=202)
def refit_one_native_part(job_id: str, body: NativePartRefitInput, background: BackgroundTasks,
                          idempotency_key: str = Header(alias='Idempotency-Key'),
                          user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    service = AvatarNativeParts(factory)
    with _LOCK:
        ensure_stage_idle(factory, user.user_id, job_id)
        state, created = service.start_refit(
            user.user_id, job_id, body.source_version, body.slot, idempotency_key,
            fit_profile=body.fit_profile.model_dump(exclude_none=True) if body.fit_profile is not None else None,
            part_method=body.part_method,
            shape=body.shape.model_dump(exclude_none=True) if body.shape is not None else None)
    from src.services.avatar_expression_reuse import expression_reuse_state
    expressions = expression_reuse_state(factory.directory(user.user_id, job_id))
    current_version = service.get(user.user_id, job_id).get('version')
    if (state.get('version') == current_version and
            (created or state.get('status') in ('accepted', 'recovery_required')
             or (state.get('status') == 'review_required' and expressions and expressions['status'] != 'complete'))):
        background.add_task(service.execute_refit, user.user_id, job_id)
    return state


@router.post('/jobs/{job_id}/retry-image', status_code=202)
def retry_image(job_id: str, body: RetryImageInput, background: BackgroundTasks,
                user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    ensure_stage_idle(factory, user.user_id, job_id)
    from src.services.avatar_image_recovery import retry_view
    service = AvatarImagePipeline(factory)
    job, created = retry_view(service, user.user_id, job_id, body.slot, body.view, body.failure_id)
    if created:
        background.add_task(service.execute, user.user_id, job_id)
    return job


@router.post('/jobs/{job_id}/retry-images', status_code=202)
def retry_images(job_id: str, body: RetryImagesInput, background: BackgroundTasks,
                 user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    ensure_stage_idle(factory, user.user_id, job_id)
    from src.services.avatar_image_recovery import retry_views
    service = AvatarImagePipeline(factory)
    job, created = retry_views(service, user.user_id, job_id, [image.model_dump() for image in body.images])
    if created:
        background.add_task(service.execute, user.user_id, job_id)
    return job


@router.get('/profiles')
def profiles(user: UserContext = Depends(get_current_user)):
    return {'profiles': [PROFILE]}


@router.get('/jobs')
def jobs(user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return {'jobs': factory.listing(user.user_id)}


@router.get('/jobs/{job_id}')
def job(job_id: str, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return factory.get(user.user_id, job_id)


@router.get('/jobs/{job_id}/artifacts/{filename}')
def artifact(job_id: str, filename: str, user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    return FileResponse(factory.artifact(user.user_id, job_id, filename))


@router.get('/jobs/{job_id}/model-stats')
def model_stats(job_id: str, name: str, version: str | None = None,
                user: UserContext = Depends(get_current_user), factory=Depends(get_factory)):
    from src.services.avatar_model_stats import model_stats as read_model_stats
    return read_model_stats(factory, user.user_id, job_id, name, version)
