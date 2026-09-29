"""Validated Meshy 7.1 multi-image settings frozen with each accepted part."""
import base64
from copy import deepcopy
import hashlib
import io
from typing import Literal

from PIL import Image, ImageOps
from pydantic import BaseModel, ConfigDict, Field, model_validator

from src.services.character_pipeline import PipelineError

# Wearable budgets of production-v1 runtime.part_triangles (hair less its rear backing reserve).
SHARED_PART_POLYCOUNT = {'body': 24000, 'hair': 30000, 'hat': 8000, 'top': 18000, 'bottom': 12000, 'shoes': 8000,
                         'weapon': 8000, 'tool': 6000, 'glasses': 3000}


class MeshyPartOptions(BaseModel):
    model_config = ConfigDict(extra='forbid')
    ai_model: Literal['meshy-7.1'] = 'meshy-7.1'
    geometry_resolution: Literal['standard', '2k'] = '2k'
    should_texture: bool = True
    enable_pbr: bool = True
    texture_resolution: Literal['2k', '4k', '8k'] = '2k'
    texture_mode: Literal['source', 'prompt', 'image', 'images'] = 'source'
    texture_image_assets: list[str] = Field(default_factory=list, max_length=4)
    should_remesh: bool = True
    topology: Literal['triangle', 'quad'] = 'triangle'
    target_polycount: int = Field(default=30000, ge=100, le=300000, strict=True)
    decimation_mode: Literal[1, 2, 3, 4] | None = None
    save_pre_remeshed_model: bool = False
    pose_mode: Literal['', 'a-pose', 't-pose'] = ''
    image_enhancement: bool = False
    remove_lighting: bool = True
    moderation: bool = False
    target_formats: list[Literal['glb', 'obj', 'fbx', 'stl', 'usdz', '3mf']] = Field(default_factory=lambda: ['glb'], min_length=1, max_length=6)
    auto_size: bool = False
    origin_at: Literal['bottom', 'center'] = 'bottom'
    alpha_thumbnail: bool = False
    multi_view_thumbnails: bool = False

    @model_validator(mode='after')
    def validate_inputs(self):
        import re
        if 'glb' not in self.target_formats or len(set(self.target_formats)) != len(self.target_formats):
            raise ValueError('조립용 GLB를 포함하고 출력 형식을 중복 없이 선택하세요.')
        if any(not re.fullmatch('[a-f0-9]{64}', asset) for asset in self.texture_image_assets):
            raise ValueError('업로드한 텍스처 이미지 ID가 필요합니다.')
        if self.should_texture:
            count = len(self.texture_image_assets)
            if (self.texture_mode == 'image' and count != 1) or (self.texture_mode == 'images' and not 1 <= count <= 4):
                raise ValueError('단일 텍스처는 1장, 다중 텍스처는 1~4장을 선택하세요.')
        return self


def upload_texture(factory, owner, content):
    from src.services.avatar_blueprints import AvatarBlueprints
    try:
        with Image.open(io.BytesIO(content)) as original:
            if original.format not in ('PNG', 'JPEG') or original.width*original.height > 32_000_000:
                raise ValueError('Invalid texture image')
            original.load()
            image = ImageOps.exif_transpose(original).convert('RGBA')
            output = io.BytesIO()
            image.save(output, format='PNG')
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        raise PipelineError('invalid_texture_image', '3,200만 픽셀 이하의 PNG/JPEG 이미지를 선택하세요.', 422) from None
    return AvatarBlueprints(factory.data).upload(owner, output.getvalue())


def freeze_options(factory, owner, value, slot, prompts, *, shared=False):
    """shared: one submitted setting covers a whole part set, so each slot keeps its own budget and pose."""
    from src.services.avatar_blueprints import AvatarBlueprints
    options = MeshyPartOptions.model_validate(value or {}).model_dump()
    if value is None and slot == 'body':
        options['pose_mode'] = 't-pose'
        options['texture_mode'] = 'prompt' if prompts.get(slot) else 'source'
    elif shared and value is not None:
        if slot == 'body' and not options['pose_mode']:
            options['pose_mode'] = 't-pose'
        elif slot != 'body':
            options['pose_mode'] = ''
    if (slot != 'body' and options['should_remesh'] and options['decimation_mode'] is None
            and slot in SHARED_PART_POLYCOUNT):
        # The provider remeshes to the wearable budget: smaller downloads and no local decimation.
        options['target_polycount'] = min(options['target_polycount'], SHARED_PART_POLYCOUNT[slot])
    frozen = {'options': options, 'texture_prompt': None, 'texture_images': []}
    if not options['should_texture']:
        return frozen
    if options['texture_mode'] == 'prompt':
        prompt = prompts.get(slot, '').strip()
        if not 1 <= len(prompt) <= 800:
            raise PipelineError('texture_prompt_required', '프롬프트 관리에서 해당 파츠의 3D 텍스처 문장을 저장하세요. (1~800자)', 422)
        frozen['texture_prompt'] = prompt
    elif options['texture_mode'] in ('image', 'images'):
        assets = AvatarBlueprints(factory.data)
        for asset in options['texture_image_assets']:
            content = assets.asset(owner, asset).read_bytes()
            if hashlib.sha256(content).hexdigest() != asset:
                raise PipelineError('texture_source_changed', '텍스처 참조 원본이 변경되었습니다.', 409)
            with Image.open(io.BytesIO(content)) as reference:
                mime = {'PNG': 'image/png', 'JPEG': 'image/jpeg'}.get(reference.format)
                reference.verify()
            if not mime:
                raise PipelineError('invalid_texture_image', 'PNG 또는 JPEG 텍스처를 선택하세요.', 422)
            frozen['texture_images'].append({'asset': asset, 'sha256': asset, 'mime': mime})
    return frozen


def provider_options(factory, owner, frozen):
    from src.services.avatar_blueprints import AvatarBlueprints
    options = deepcopy(frozen['options'])
    mode = options.pop('texture_mode')
    options.pop('texture_image_assets')
    if not options['should_remesh']:
        for key in ('topology', 'target_polycount', 'decimation_mode', 'save_pre_remeshed_model'):
            options.pop(key, None)
    elif options.get('decimation_mode') is not None:
        options.pop('target_polycount')
    else:
        options.pop('decimation_mode', None)
    if not options['auto_size']:
        options.pop('origin_at')
    if not options['should_texture']:
        for key in ('enable_pbr', 'texture_resolution', 'remove_lighting'):
            options.pop(key, None)
    elif mode == 'prompt':
        options['texture_prompt'] = frozen['texture_prompt']
    elif mode in ('image', 'images'):
        assets, urls = AvatarBlueprints(factory.data), []
        for image in frozen['texture_images']:
            content = assets.asset(owner, image['asset']).read_bytes()
            if hashlib.sha256(content).hexdigest() != image['sha256']:
                raise PipelineError('texture_source_changed', '접수한 텍스처 참조 원본이 변경되었습니다.', 409)
            urls.append('data:'+image['mime']+';base64,'+base64.b64encode(content).decode('ascii'))
        options['texture_image_url' if mode == 'image' else 'texture_image_urls'] = urls[0] if mode == 'image' else urls
    return options


def worn_polycount(options, slot):
    """A worn request returns the mannequin too; give the whole figure twice the part budget."""
    options = deepcopy(options)
    if options.get('should_remesh') and 'target_polycount' in options:
        options['target_polycount'] = min(300000, 2*SHARED_PART_POLYCOUNT.get(slot, options['target_polycount']))
    return options
