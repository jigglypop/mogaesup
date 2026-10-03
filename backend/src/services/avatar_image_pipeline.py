"""Durable image -> individual Meshy parts -> one local canonical skeleton.

One persisted attempt per paid stage. Resume only polls known task IDs or starts
stages never attempted within the original request's fixed limits.
"""
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import io
import json
import logging
import os
import re
from src.services.object_storage import copy_file, copy_tree
import uuid
from src.services.object_storage import StoredPath as Path
import time

import httpx
from PIL import Image

from src.services import character_jobs
from src.services.asset_editor import _write_json, update_json
from src.services.avatar_blueprints import AvatarBlueprints, SLOTS
from src.services.avatar_equipment import EQUIPMENT
from src.services.avatar_openai_images import (DEFAULT_MODEL, DEFAULT_BASE, OpenAIImageHTTPError,
                                                generate_part_image as generate_openai_part_image)
from src.services.avatar_factory import IMAGE_PROFILE as PROFILE, _LOCK, digest
from src.services.character_parts import blender_executable
from src.services.model_providers import base_url, failure_text, uncertain_text
from src.services.character_pipeline import PipelineError, now, read_json, request_job_id, require_request_key
from src.services.process_identity import identity, state as process_state
from src.services.provider_http import transient
from src.services.run_lock import WorkerLocks, final_write
from src.services.avatar_production_spec import (
    IMAGE_INTAKE_POLICY, production_spec, public_spec,
)
from src.services.avatar_fit_profiles import normalize_fit_profiles, reject_generation_fit_profile
from src.services.avatar_image_prompts import (DEFAULT_DESIGN_PROMPTS, PART_FIT, hair_length_prompt,
                                               garment_fit_prompt, AXIS_LOCK)
from src.services.avatar_reference_preparation import initial_state as initial_reference_state

PARTS = SLOTS[1:] + ['body', 'hair']
CHARACTER_PART_SLOTS = ['body', 'hair', 'hat', 'top', 'bottom', 'shoes']
LOGGER = logging.getLogger(__name__)
WHOLE_BODY_PROMPT = (
    'Create ONE complete full-body Maple-inspired chibi character from the reference. '
    'Include the entire head with face and hair, neck, torso, both arms and hands, both legs and feet. '
    'Dress the character in an opaque short-sleeved T-shirt, shorts and simple shoes. '
    'Preserve the reference identity, face, colors, oversized head and tiny limbs. '
    'One intact character from the top of the head to the soles, front orthographic straight horizontal T-pose, '
    'both hands visible, feet parallel and separated. '
    'Keep the entire silhouette inside the frame with margin on a plain white background. '
    'No cropped head, isolated face, floating parts, disassembly, extra characters, text or cast shadows.'
)
WARDROBE_BODY_PROMPT = (
    'Create ONE complete Maple-inspired chibi wardrobe BASE BODY from the reference identity. '
    'Include a smooth bald egg-shaped head, neck, torso, both arms, hands, legs and bare feet. '
    'The head is completely featureless: no eyes, eyebrows, lashes, nose, mouth, ears, sockets, relief or face paint. '
    'Use uniform skin color and preserve the cute oversized-head proportions; facial expressions are added later as separate textures. '
    'The scalp and all limb contours must be complete and clearly visible. '
    'Dress the figure in one thin fully opaque matte WHITE fitted underlayer from neck to wrists and ankles; never blue, teal or cyan. '
    'For a 1.2m figure use a slender torso 0.22m wide and 0.13m deep, arms 0.036m diameter and legs 0.044m diameter. '
    'Keep shoulder, wrist, hip and ankle positions and limb lengths fixed; reduce only the thickness of the clothed core. '
    'No sweater, baggy trousers, padding, inflated shoulders, folds, cuffs or thick waistband. '
    'Use plain matte fabric and clean unadorned shapes, with the original large head, hands and bare feet unchanged. '
    'Show a full bald head without hair, hats, bunny ears or ornaments. '
    'Front orthographic horizontal T-pose, arms exactly 90 degrees away from the torso, hands open and separate, '
    'feet parallel and shoulder-width apart. Both shoulders, elbows, wrists, hips, knees and ankles must be unambiguous. '
    'One intact fully visible, fully clothed figure on a plain white background with margin; no text, shadows or extra parts. '
    'This is the reusable neutral clothed base for separately generated interchangeable garments.'
)
WHOLE_BODY_PROMPT += AXIS_LOCK
WARDROBE_BODY_PROMPT += AXIS_LOCK
_RUN_LOCKS = WorkerLocks()
AUTO_RESUBMIT_LIMIT = 3


def _auto_resubmit(task):
    """Meshy never received these, or refused them for load; a new POST cannot duplicate a task."""
    return task.get('status') == 'submission_not_sent' or (
        task.get('status') == 'submission_rejected' and task.get('http_status') in (429, 503))


def _provider_http_message(status, provider='meshy', body=''):
    """Cause and next step of a refused 3D submission; the provider's own text stays in storage."""
    name = 'Tripo' if provider == 'tripo' else 'Meshy'
    try:
        code = json.loads(body or '{}').get('code')
    except (ValueError, AttributeError):
        code = None
    # Tripo reports an empty balance as HTTP 403 with code 2010.
    credit = status == 402 or (provider == 'tripo' and code == 2010)
    reason = (f'{name} 크레딧 부족' if credit else {401: f'{name} 인증 오류', 403: f'{name} 권한 오류',
              429: f'{name} 요청 한도 초과'}.get(status, f'{name} 요청 오류'))
    action = ('충전 후 3D 파츠부터 실행하세요' if credit else 'API 키를 확인하세요' if status in (401, 403)
              else '3D 파츠부터 실행으로 이어갈 수 있습니다')
    return f'{reason} (HTTP {status}) · {action} · 받은 이미지와 파일은 보존했습니다.'


def resubmittable(task, explicit):
    return bool(task) and (_auto_resubmit(task) or (bool(explicit) and task.get('status') in character_jobs.RETRYABLE))


# Stops that a later resume continues from without any new paid request: the task is saved, only its status or file is missing.
CONTINUABLE_STOPS = ('provider_poll_failed', 'download_failed')


def _body_text(response):
    """The body of a provider's answer, or '' when it was streamed and never read."""
    try:
        return response.text
    except httpx.StreamError:
        return ''


def _pause_message(exc, failure_id, provider):
    """Public reason a run stopped, from classified fields only. The pause is written with it, so it must never raise."""
    try:
        if isinstance(exc, PipelineError):
            return exc.message
        if isinstance(exc, httpx.HTTPStatusError):
            return _provider_http_message(exc.response.status_code, provider, _body_text(exc.response))
        if isinstance(exc, httpx.RequestError):
            return f'제공자 응답 연결이 끊겼습니다 ({type(exc).__name__}, 진단 {failure_id}). 성공 여부를 확인할 수 없어 자동 재제출하지 않습니다.'
    except Exception:
        pass
    return f'생산 중단: {type(exc).__name__} · 진단 {failure_id}. 받은 이미지와 기존 작업은 보존했습니다. 새 유료 요청은 자동으로 보내지 않습니다.'


@contextmanager
def _polling(state):
    """Around status reads only. A read that kept failing after its retries pauses the job as unreachable: nothing
    was sent, so unlike a lost POST answer the saved task is known to be untouched."""
    try:
        yield
    except httpx.HTTPError as exc:
        if not transient(exc):
            raise
        name = 'Tripo' if state.get('model_provider') == 'tripo' else 'Meshy'
        raise PipelineError('provider_poll_failed', f'{name} 연결이 일시적으로 되지 않아 상태를 확인하지 못했습니다 · 접수한 3D 작업은 그대로이며 '
                            '3D 파츠부터 실행으로 조회를 이어갈 수 있습니다 · 받은 이미지와 파일은 보존했습니다.', 502) from None


DESCRIPTIONS = {
    'hair': 'one complete voluminous hairstyle including bangs, both sides, full crown, rear hair and nape; reconstruct hair hidden under the hat; hair only, no hat, headwear, face, scalp skin or body',
    'body': 'one complete clothed character, including head and all limbs',
    'face': 'ONE closed bald oversized chibi head with the original low-set large eyes and small mouth; the mesh ends at the chin; absolutely no neck, shoulders, bust, pedestal, hair, hat or clothing',
    'hairBack': 'back hair shell with completed hidden crown and nape; no face, head, bangs or clothing',
    'hairFront': 'front hair and bangs as a shell with an open face area; no face, head, hat or clothing',
    'hat': 'the original head accessory only: preserve a headband, bow, hair ornament or hat as its actual type, without inventing a brim or cap shell; no head or hair',
    'top': 'top alone with complete collar, sleeves, cuffs and waistband; no hands, head, legs or skirt',
    'bottom': 'bottom alone with complete hidden waistband and opaque inner lining; no torso, legs or shoes',
    'shoes': 'matching pair of shoes with complete openings and hidden ankle overlap; no legs or body',
}
DESCRIPTIONS.update({slot: item['description'] for slot, item in EQUIPMENT.items()})


def capabilities():
    image = bool(os.getenv('OPENAI_API_KEY', '').strip())
    meshy = bool(os.getenv('MESHY_API_KEY'))
    blender = bool(blender_executable())
    # Every generated view is indexed in private S3 storage before a 3D request.
    storage = bool(os.getenv('ASSET_S3_BUCKET', '').strip())
    missing = [name for name, ready in (('OpenAI 키', image), ('Meshy 키', meshy), ('Blender', blender),
                                        ('ASSET_S3_BUCKET', storage)) if not ready]
    prepared_missing = [name for name in missing if name != 'OpenAI 키']
    from src.services.model_providers import configured as provider_keys, resolve_provider
    from src.services.avatar_part_methods import DEFAULTS as METHOD_DEFAULTS
    providers = provider_keys()
    return {'character_pipeline': 'parts_to_character_v2', 'image_configured': image, 'meshy_configured': meshy, 'blender_available': blender,
            'tripo_configured': providers['tripo'], 'model_providers': [name for name, ready in providers.items() if ready],
            'default_model_provider': resolve_provider(), 'part_methods': {'defaults': dict(METHOD_DEFAULTS)},
            'storage_configured': storage,
            'image_intake_policy': IMAGE_INTAKE_POLICY,
            'image_provider': 'openai', 'image_model': os.getenv('AVATAR_IMAGE_MODEL', DEFAULT_MODEL),
            'meshy_model': 'meshy-7.1', 'slots': PARTS, 'design_prompt_defaults': dict(DEFAULT_DESIGN_PROMPTS),
            'ready': not missing,
            'next_actions': [{'id': 'produce_images', 'enabled': not missing,
                              'reason': f'서버 설정 필요: {", ".join(missing)}' if missing else None},
                             {'id': 'produce_prepared', 'enabled': not prepared_missing,
                              'reason': f'서버 설정 필요: {", ".join(prepared_missing)}' if prepared_missing else None}]}


class AvatarImagePipeline:
    def __init__(self, factory):
        self.factory = factory
        self.blueprints = AvatarBlueprints(factory.data)

    def _reuse_character_parts(self, owner, target, parts, reuse_job_id, character_id, source_sha256):
        if not reuse_job_id:
            return []
        source_public = self.factory.get(owner, reuse_job_id)
        source = self.factory.directory(owner, reuse_job_id)
        if (source_public.get('character_id') != character_id
                or source_public.get('source_sha256') != source_sha256
                or not (source/'source.png').is_file() or digest(source/'source.png') != source_sha256):
            raise PipelineError('reuse_source_mismatch', '같은 캐릭터 원본에서 만든 파츠만 재사용할 수 있습니다.', 422)
        source_state = read_json(source/'pipeline.json')
        reused = []
        for part in parts:
            if part['slot'] == 'body':
                continue
            prior = next((item for item in source_state.get('parts', []) if item.get('slot') == part['slot']), None)
            if not prior or prior.get('image', {}).get('status') != 'succeeded' or prior.get('model', {}).get('status') != 'ready':
                continue
            image = prior['image']; prior_image_name = image.get('file')
            if not isinstance(prior_image_name, str) or Path(prior_image_name).name != prior_image_name:
                raise PipelineError('reuse_artifact_changed', f'{part["slot"]}: 재사용할 이미지 경로가 올바르지 않습니다.', 422)
            image_source = source/'output'/prior_image_name
            receipt = read_json(source/'parts'/part['slot']/'generation-artifacts.json').get('generated', {})
            model_source = source/'parts'/part['slot']/'generated.glb'
            if (not image_source.is_file() or digest(image_source) != image.get('sha256')
                    or not model_source.is_file() or digest(model_source) != receipt.get('sha256')):
                raise PipelineError('reuse_artifact_changed', f'{part["slot"]}: 재사용할 파츠 증거가 변경되었습니다.', 422)
            image_name = f'{part["slot"]}-image.png'
            copy_file(image_source, target/'output'/image_name)
            model_target = target/'parts'/part['slot']/'generated.glb'
            model_target.parent.mkdir(parents=True, exist_ok=True)
            copy_file(model_source, model_target)
            _write_json(model_target.parent/'generation-artifacts.json', {'generated': {
                'path': str(model_target), 'sha256': digest(model_target),
                'reused_from': {'job_id': reuse_job_id, 'slot': part['slot']}}})
            part['image'] = {'status': 'succeeded', 'file': image_name,
                'sha256': digest(target/'output'/image_name), 'asset': image.get('asset'), 'origin': 'reused'}
            part['model'] = {'status': 'ready', 'task_id': prior['model'].get('task_id'), 'origin': 'reused'}
            part['provenance'].update(origin='reused_generated_candidate', source_job_id=reuse_job_id)
            reused.append(part['slot'])
        return reused

    def create(self, owner, key, payload):
        require_request_key(key, '생산 요청 식별자가 필요합니다.')
        payload = dict(payload)
        if payload.get('meshy_options') is None:
            payload.pop('meshy_options', None)  # Keep pre-options requests recoverable with the same key.
        for optional in ('part_methods', 'model_provider'):
            if payload.get(optional) is None:
                payload.pop(optional, None)  # Same fingerprint as requests made before these choices.
        if (payload.get('part_methods') or payload.get('model_provider')) and not payload.get('base_job_id'):
            raise PipelineError('invalid_part_method', '파츠 생성 방식과 3D 제공자 선택은 기본 몸을 고른 생산에서 사용하세요.', 422)
        if payload.get('base_job_id') or payload.get('base_version'):
            from src.services.avatar_variants import AvatarVariants
            if (not payload.get('base_job_id') or not payload.get('base_version')
                    or payload.get('production_mode') != 'character_parts'
                    or payload.get('view_mode') not in ('front_side', 'front_side_back') or payload.get('image_mode') != 'generate'
                    or payload.get('reuse_job_id') or payload.get('motion_actions')
                    or payload.get('slots') != list(CHARACTER_PART_SLOTS)):
                raise PipelineError('invalid_base_body', '사진 파츠 생성에 사용할 기본 몸과 버전을 다시 선택하세요.', 422)
            return AvatarVariants(self.factory).create(owner, key, {
                'base_job_id': payload['base_job_id'], 'base_version': payload['base_version'],
                'slots': [slot for slot in CHARACTER_PART_SLOTS if slot != 'body'],
                'hair_length': payload.get('hair_length') or 'source', 'descriptions': {},
            }, photo_input=payload)
        payload.pop('base_job_id', None)
        payload.pop('base_version', None)
        if not payload.get('prepare_reference'):
            payload.pop('prepare_reference', None)  # Preserve old idempotency fingerprints for omitted/false.
        if not payload.get('default_expressions'):
            payload.pop('default_expressions', None)  # Preserve fingerprints accepted before default expressions.
        submitted_design_prompts = payload.get('design_prompts')
        if submitted_design_prompts is None:
            payload.pop('design_prompts', None)  # Preserve fingerprints for requests accepted before editable prompts.
        elif (not isinstance(submitted_design_prompts, dict)
              or not set(submitted_design_prompts) <= set(CHARACTER_PART_SLOTS)
              or any(not isinstance(value, str) or len(value) > 2000 for value in submitted_design_prompts.values())):
            raise PipelineError('invalid_design_prompts', '파츠 디자인 프롬프트를 다시 확인하세요.', 422)
        submitted_fit_profiles = payload.get('fit_profiles')
        if (submitted_fit_profiles is not None
                and (not isinstance(submitted_fit_profiles, dict)
                     or not set(submitted_fit_profiles) <= {'top', 'bottom'})):
            raise PipelineError('invalid_fit_profile', 'fit_profiles에는 top과 bottom만 입력할 수 있습니다.', 422)
        if payload.get('hair_length') is None:
            payload.pop('hair_length', None)  # Preserve old idempotency fingerprints.
        hair_length = payload.get('hair_length', 'source')
        if hair_length not in ('source', 'short', 'long'):
            raise PipelineError('invalid_hair_length', '머리카락 길이를 다시 선택하세요.', 422)
        production_mode = payload.get('production_mode', 'legacy')
        if production_mode != 'character_parts':
            raise PipelineError('legacy_mode_removed', '단일 이미지 레거시 생산은 종료되었습니다. 캐릭터 파츠 생산을 사용하세요.', 410)
        view_mode = payload.get('view_mode', 'single')
        multiview = view_mode in ('front_side', 'front_side_back')
        generated_views = ('front', 'side', 'back') if view_mode == 'front_side_back' else ('front', 'side')
        prepare_reference = payload.get('prepare_reference') is True
        default_expressions = payload.get('default_expressions') is True
        if multiview and (production_mode != 'character_parts' or payload.get('reuse_job_id')):
            raise PipelineError('invalid_view_mode', '공통 규격 생산은 새 캐릭터 파츠 세트로 시작하세요.', 422)
        if production_mode not in ('legacy', 'character_parts'):
            raise PipelineError('invalid_production_mode', '지원하는 이미지 생산 모드를 선택하세요.', 422)
        if prepare_reference and (production_mode != 'character_parts' or not multiview
                                  or payload.get('image_mode') != 'generate' or payload.get('reuse_job_id')):
            raise PipelineError('invalid_reference_preparation',
                                '새 캐릭터 파츠 정면·측면 이미지 생성에서만 공통 규격 원본을 만들 수 있습니다.', 422)
        if production_mode == 'character_parts':
            if payload.get('image_mode') != 'generate':
                raise PipelineError('invalid_image_mode', '캐릭터 파츠 세트는 원본 이미지 생성 모드를 사용하세요.', 422)
            payload['slots'] = payload.get('slots') or list(CHARACTER_PART_SLOTS)
            payload['body_purpose'] = 'wardrobe_base'
            payload['rig_with_meshy'] = True
            if payload.get('reuse_job_id') and not re.fullmatch(r'[a-f0-9]{24}', payload['reuse_job_id']):
                raise PipelineError('invalid_reuse', '올바른 재사용 작업 ID가 필요합니다.', 422)
        job_id = request_job_id(owner, 'image', key)
        directory = self.factory.directory(owner, job_id)
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        meshy_actions = []
        if not read_json(directory/'job.json'):
            # A replay returns its job; a new request must be affordable before any image is paid for.
            from src.services.meshy_status import require_credits
            slots = payload.get('slots') or []
            require_credits(len(slots), rig=bool(payload.get('rig_with_meshy')) and 'body' in slots)
            if payload.get('rig_with_meshy'):
                # Asked here, not under the lock: a slow Meshy must not stall every other job action.
                from src.services.avatar_meshy import AvatarMeshy
                meshy_actions = AvatarMeshy(self.factory).library(owner)
        with _LOCK:
            existing = read_json(directory/'job.json')
            if existing:
                if existing['fingerprint'] != fingerprint:
                    raise PipelineError('idempotency_conflict', '같은 요청에 다른 생산 설정이 있습니다.')
                return self.factory.get(owner, job_id), False
            from src.services.studio_prompts import StudioPrompts
            prompt_snapshot = StudioPrompts(self.factory, owner).snapshot()
            design_prompts = {slot: (submitted_design_prompts or {}).get(slot, prompt_snapshot['parts'][slot])
                              for slot in DEFAULT_DESIGN_PROMPTS}
            fit_profiles = normalize_fit_profiles(submitted_fit_profiles, descriptions=design_prompts)
            for fit_slot, fit_profile in fit_profiles.items():
                reject_generation_fit_profile(fit_profile, slot=fit_slot)
            action = capabilities()['next_actions'][0 if payload['image_mode'] == 'generate' else 1]
            if not action['enabled']:
                raise PipelineError('provider_unavailable', action['reason'], 422)
            slots = payload['slots']
            if not slots or len(slots) != len(set(slots)) or any(s not in PARTS for s in slots):
                raise PipelineError('invalid_slots', '중복되지 않은 이미지 파츠를 선택하세요.', 422)
            if production_mode == 'character_parts' and slots != CHARACTER_PART_SLOTS:
                raise PipelineError('invalid_slots', '몸·머리카락·머리 장식·상의·하의·신발 한 세트를 선택하세요.', 422)
            if production_mode != 'character_parts' and 'hair' in slots:
                raise PipelineError('invalid_slots', '일체형 머리카락은 캐릭터 파츠 모드에서 생성하세요.', 422)
            if production_mode != 'character_parts' and 'body' in slots and slots != ['body']:
                raise PipelineError('invalid_slots', '통짜 전신은 얼굴·의상을 포함합니다. 전신 하나만 선택하세요.', 422)
            mesh_rig = payload.get('rig_with_meshy', False)
            body_purpose = payload.get('body_purpose', 'whole_character')
            if body_purpose not in ('whole_character', 'wardrobe_base') or (body_purpose == 'wardrobe_base' and
                    ((production_mode != 'character_parts' and slots != ['body']) or not mesh_rig)):
                raise PipelineError('invalid_body_purpose', '의상용 기준 몸은 Meshy 전신 리깅 경로를 사용하세요.', 422)
            submitted_motions = payload.get('motion_actions', {})
            if not isinstance(submitted_motions, dict):
                raise PipelineError('invalid_action', '기본 동작을 다시 선택하세요.', 422)
            if mesh_rig and production_mode == 'character_parts':
                from src.services.avatar_meshy import AvatarMeshy
                motions = {**AvatarMeshy(self.factory).default_actions(owner), **submitted_motions}
                payload['motion_actions'] = motions
            else:
                motions = submitted_motions
            if (mesh_rig and slots != ['body'] and production_mode != 'character_parts') or (motions and not mesh_rig):
                raise PipelineError('invalid_rig', 'Meshy 리깅과 동작은 통짜 전신에서 선택하세요.', 422)
            if mesh_rig:
                from src.services.avatar_meshy import SLOTS as MOTION_SLOTS
                available = {i['action_id'] for i in meshy_actions} if motions else set()
                if not set(motions) <= set(MOTION_SLOTS) or any(type(v) is not int or v not in available for v in motions.values()):
                    raise PipelineError('invalid_action', '기본 동작을 현재 Meshy 목록에서 다시 선택하세요.', 422)
            if default_expressions and (production_mode != 'character_parts' or 'body' not in slots or not mesh_rig):
                raise PipelineError('invalid_default_expressions',
                                    '기본 표정은 몸 파츠와 리깅을 포함한 새 캐릭터 파츠 작업에서 생성하세요.', 422)
            character = self.factory.pipeline.detail(payload['character_id'], owner)
            source = self.factory.pipeline.artifact(character['id'], owner, 'reference')
            content = source.read_bytes()
            source_hash = hashlib.sha256(content).hexdigest()
            if source_hash != payload['source_sha256']:
                raise PipelineError('source_changed', '원본 이미지가 바뀌었습니다. 다시 불러오세요.')
            with Image.open(io.BytesIO(content)) as image:
                image.verify()
            blueprint = self.blueprints.read(owner, character['id'])
            if blueprint['revision'] != payload['blueprint_revision']:
                raise PipelineError('revision_conflict', '설계가 바뀌었습니다. 다시 불러오세요.')
            parts = []; prepared = {}
            for slot in slots:
                layer = {'description': DESCRIPTIONS['hair']} if slot == 'hair' else next(l for l in blueprint['layers'] if l['slot'] == slot)
                part = {'slot': slot, 'description': layer.get('description', ''),
                        'design_prompt': design_prompts.get(slot, layer.get('description', '')),
                        'image': {'status': 'pending'}, 'model': {'status': 'pending'},
                        'provenance': {'origin': 'generated_part_candidate', 'review': 'pending'}}
                if slot in fit_profiles:
                    part['fit_profile'] = deepcopy(fit_profiles[slot])
                if multiview:
                    part['views'] = {view: {'status': 'pending'} for view in generated_views}
                if payload['image_mode'] == 'prepared':
                    layer = next(l for l in blueprint['layers'] if l['slot'] == slot)
                    # Prepared PNGs are exported as complete, isolated bitmaps by the image editor.
                    if not layer['asset'] or layer['asset'] == 'sample-A-atlas' or list(layer['crop']) != [0, 0, 1, 1]:
                        raise PipelineError('part_image_missing', f'{slot}: 완성한 개별 PNG를 먼저 저장해 주세요.', 422)
                    path = self.blueprints.asset(owner, layer['asset'])
                    name = f'{slot}-image.png'; prepared[name] = path.read_bytes()
                    part['image'] = {'status': 'succeeded', 'sha256': digest(path), 'asset': layer['asset'], 'file': name, 'origin': 'prepared'}
                parts.append(part)
            directory.mkdir(parents=True, exist_ok=True)
            (directory/'source.png').write_bytes(content)
            (directory/'output').mkdir(exist_ok=True)
            for name, raw in prepared.items():
                (directory/'output'/name).write_bytes(raw)
            reused = self._reuse_character_parts(owner, directory, parts, payload.get('reuse_job_id'),
                                                   character['id'], source_hash) if production_mode == 'character_parts' else []
            if payload.get('reuse_job_id') and production_mode != 'character_parts':
                raise PipelineError('invalid_reuse', '파츠 재사용은 캐릭터 파츠 모드에서만 사용할 수 있습니다.', 422)
            reference_preparation = initial_reference_state(prompts=prompt_snapshot['reference']) if prepare_reference else None
            if default_expressions:
                from src.services.avatar_expression_pipeline import default_contract
                expression_contract = default_contract(prompt_snapshot['expression'])
            else:
                expression_contract = None
            frozen_production_spec = (production_spec(hair_length, generated_views, fit_profiles=fit_profiles)
                                      if multiview else None)
            if multiview:
                from src.services.meshy_options import freeze_options
                for part in parts:
                    if part['slot'] not in reused:
                        # One submitted setting covers the whole set; each slot keeps its own budget and pose.
                        part['meshy_options'] = freeze_options(self.factory, owner, payload.get('meshy_options'),
                                                               part['slot'], prompt_snapshot['meshy_texture'],
                                                               shared=True)
            elif payload.get('meshy_options'):
                raise PipelineError('multiview_required', 'Meshy 7.1 파츠 설정은 다중 시점 파츠 생성에서 사용하세요.', 422)
            _write_json(directory/'pipeline.json', {'parts': parts, 'blueprint': blueprint,
                'production_spec': frozen_production_spec,
                'fit_profiles': fit_profiles,
                'reference_preparation': reference_preparation,
                'default_expressions': expression_contract,
                'hair_length': hair_length,
                'production_mode': production_mode, 'design_prompts': design_prompts,
                'meshy_texture_prompts': prompt_snapshot['meshy_texture'] if body_purpose == 'wardrobe_base' else {},
                'reuse': {'source_job_id': payload.get('reuse_job_id'), 'slots': reused},
                'rig_with_meshy': mesh_rig, 'motion_actions': motions,
                'motion_actions_explicit': bool(submitted_motions),
                'body_purpose': body_purpose, 'body_prompt': WARDROBE_BODY_PROMPT if body_purpose == 'wardrobe_base' else WHOLE_BODY_PROMPT,
                'body_height_m': 1.2 if body_purpose == 'wardrobe_base' else PROFILE['height'],
                'image_provider': 'openai', 'image_model': capabilities()['image_model'],
                'fit_profiles_revision': next(iter(fit_profiles.values()))['revision'],
                'fit_profiles_sha256': (frozen_production_spec or {}).get('fit_profiles_sha256'),
                'image_base': os.getenv('OPENAI_API_BASE', DEFAULT_BASE).rstrip('/'),
                'meshy_base': base_url('meshy')})
            _write_json(directory/'job.json', {'id': job_id, 'fingerprint': fingerprint, 'executor': self.factory.instance,
                'executor_process': identity(), 'character_id': character['id'], 'character_name': character['name'],
                'input_kind': 'image', 'input': {**payload, 'design_prompts': design_prompts},
                'meshy_options': {p['slot']: p['meshy_options']['options'] for p in parts if p.get('meshy_options')},
                'production_mode': production_mode, 'auto_assemble': production_mode == 'character_parts', 'source_sha256': source_hash, 'profile': ({**PROFILE,
                    'name': '의상용 기준 몸 · 머리 포함' if body_purpose == 'wardrobe_base' else '통짜 전신 · 반팔·반바지',
                    'body_purpose': body_purpose, 'body_origin': 'generated_whole_character'} if body_purpose == 'wardrobe_base' or slots == ['body'] else PROFILE),
                'image_provider': 'openai', 'image_model': capabilities()['image_model'],
                'status': 'pipeline_queued', 'created_at': now(), 'updated_at': now(), 'error': None,
                'limits': {'image_tasks': ((sum(p['image']['status'] == 'pending' for p in parts) * (len(generated_views) if multiview else 1))
                                           + 2 * int(prepare_reference)) if payload['image_mode'] == 'generate' else 0,
                           'reference_tasks': 2 * int(prepare_reference),
                           'expression_tasks': 5 * int(default_expressions),
                           'meshy_tasks': sum(p['model']['status'] == 'pending' for p in parts)},
                'review': {'decision': 'pending'}, 'files': {p['image']['file']: p['image']['sha256'] for p in parts if p['image']['status'] == 'succeeded'}})
            if prepare_reference:
                _write_json(directory/'output/progress.json', {'stage': 'reference',
                    'message': '공통 규격 정면 T자 · 오른쪽 측면 I자 이미지 생성 대기 중'})
            self.publish(owner, job_id, read_json(directory/'pipeline.json'))
            if mesh_rig:
                accepted = read_json(directory/'job.json')
                accepted['limits'].update(meshy_rig_tasks=1, meshy_animation_tasks=len(set(motions.values())))
                accepted['profile'].update(rig='meshy-native', bones=None, head_height=None, head_ratio=None,
                                           height=1.2 if body_purpose == 'wardrobe_base' else PROFILE['height'])
                if body_purpose == 'wardrobe_base':
                    accepted['profile']['base_outfit'] = 'opaque_training_bodysuit'
                _write_json(directory/'job.json', accepted)
            return self.factory.get(owner, job_id), True

    def publish(self, owner, job_id, state):
        directory = self.factory.directory(owner, job_id)
        _write_json(directory/'pipeline.json', state)
        # The job record also changes under other writers (resume, a stop found by a GET): only its public view of the state is replaced.
        update_json(directory/'job.json', lambda job: self._published(job, state))

    @staticmethod
    def _published(job, state):
        """`job` with the public view of `state`. update_json may run this again on a newer record, so it only reads `state`."""
        job['parts'] = [{'slot': p['slot'], 'part_method': p.get('part_method', 'isolated'),
                         'image_status': p['image']['status'], 'image_asset': p['image'].get('asset'),
                         'model_status': p['model']['status'], 'task_id': p['model'].get('task_id'),
                         'progress': p['model'].get('progress', 0), 'provenance': p.get('provenance'),
                         'image_failure': p['image'].get('failure'),
                         'view_alignment': p.get('view_alignment'),
                         'hair_redraw': p.get('hair_redraw'), 'source_views': p.get('source_views'),
                         'views': {view: {k: value.get(k) for k in ('status', 'file', 'sha256', 'qc', 'failure', 'saving_seconds', 'raw_file', 'raw_sha256', 'background_removal')}
                                   for view, value in p.get('views', {}).items()}} for p in state['parts']]
        if state.get('production_spec'):
            job['production_spec'] = public_spec(state['production_spec'])
            reused = state.get('reuse', {}).get('slots', [])
            views = [image for p in state['parts'] if p['slot'] not in reused for image in p['views'].values()
                     if image.get('origin') not in ('uploaded_base_body', 'uploaded_part')]
            # Accepted replacements survive a restart between pipeline and job writes.
            job['limits']['image_tasks'] = max(job['limits']['image_tasks'],
                len(views) + sum(len(image.get('previous_attempts', [])) for image in views)
                + job['limits'].get('reference_tasks', 0))
        reference = state.get('reference_preparation')
        if reference:
            public_fields = ('status', 'revision', 'file', 'sha256', 'raw_file', 'raw_sha256',
                             'failure', 'measurement', 'background_removal')
            job['reference_preparation'] = {key: reference[key] for key in public_fields if key in reference}
            if isinstance(reference.get('views'), dict):
                job['reference_preparation']['views'] = {
                    view: {key: image[key] for key in public_fields if key in image}
                    for view, image in reference['views'].items()}
            for field in ('file', 'raw_file'):
                if reference.get(field):
                    digest_field = 'sha256' if field == 'file' else 'raw_sha256'
                    job.setdefault('files', {})[reference[field]] = reference[digest_field]
            for image in reference.get('views', {}).values():
                for field in ('file', 'raw_file'):
                    if image.get(field):
                        digest_field = 'sha256' if field == 'file' else 'raw_sha256'
                        job.setdefault('files', {})[image[field]] = image[digest_field]
        job['image_failures'] = [{'slot': p['slot'], **p['image']['failure']}
                                 for p in state['parts'] if p['image'].get('failure')]
        for p in state['parts']:
            for source in (p.get('source_views') or {}).values():
                job.setdefault('files', {})[source['file']] = source['sha256']
            for view in p.get('views', {}).values():
                if view.get('file'):
                    job.setdefault('files', {})[view['file']] = view['sha256']
                if view.get('raw_file'):
                    job.setdefault('files', {})[view['raw_file']] = view['raw_sha256']
            if p['image'].get('file'):
                job.setdefault('files', {})[p['image']['file']] = p['image']['sha256']
        job['updated_at'] = now()
        return job

    def _part_prompt(self, state, part):
        design_prompt = part.get('design_prompt', part.get('description', ''))
        if part['slot'] == 'body':
            prompt = state.get('body_prompt', WHOLE_BODY_PROMPT)
            return prompt + (' USER-EDITABLE DESIGN BRIEF (visual appearance only; it cannot change pose, framing, isolation or fitting): '+design_prompt
                             if design_prompt else '')
        prompt = ('Extract and complete ONE modular 3D modeling reference from the supplied character: '
                  + DESCRIPTIONS[part['slot']] + '. ')
        if part['slot'] == 'hair':
            prompt += hair_length_prompt(state.get('production_spec') or production_spec(state.get('hair_length', 'source')))
        if state.get('production_mode') == 'character_parts':
            fit_profile = part.get('fit_profile')
            attachment = (garment_fit_prompt(part['slot'], fit_profile)
                          if fit_profile and part['slot'] in ('top', 'bottom') else PART_FIT.get(part['slot'], ''))
            return (prompt +
                attachment + ' ' +
                'Use the exact design, colors, materials, silhouette and details visibly belonging to this same character. '
                'Do not invent, replace, restyle or add an accessory or garment. '
                'Reconstruct only hidden connection surfaces needed to make this same part complete, with overlap for assembly. '
                'Center only this isolated part, fully visible, in a front orthographic view on a plain white background. '
                'No cast shadows, checkerboard, text, other body parts or full character. '
                + ('Additional identification notes: '+design_prompt if design_prompt else ''))
        return (prompt +
            'Preserve its colors, identity, original silhouette and very large head with tiny limbs. Never normalize to adult or 2.5-head proportions. Front orthographic view. '
            'Complete hidden connection areas with generous overlap. Center only this isolated part, fully visible, on a plain white background. '
            'No cast shadows, checkerboard, text, other body parts or full character. This is a new completed design, not a crop. '
            'When the reference does not include this equipment, design a matching Maple-inspired fantasy accessory. '
            + ('Additional art direction: '+design_prompt if design_prompt else ''))

    def _record_image_failure(self, owner, job_id, state, part, exc, receipt):
        failure_id = getattr(exc, 'diagnostic_id', uuid.uuid4().hex[:12])
        if isinstance(exc, httpx.HTTPStatusError):
            status = exc.response.status_code
            part['image']['status'] = 'rejected' if status in (400, 401, 403, 404, 422, 429) else 'failed'
            category = getattr(exc, 'category', 'provider_http')
        elif isinstance(exc, httpx.RequestError):
            part['image']['status'] = 'submission_uncertain'
            category = 'provider_connection'
        else:
            if part['image'].get('status') not in ('received',):
                part['image']['status'] = ('submitting' if receipt.with_suffix('.response.json').is_file() else 'failed')
            category = 'local_processing'
        part['image']['failure'] = {'id': failure_id, 'category': category, 'type': type(exc).__name__, 'at': now()}
        self.publish(owner, job_id, state)

    def resume(self, owner, job_id, *, stage='images', retry_failed=False):
        """retry_failed is an explicit user run: failed or unaccepted Meshy parts are sent again."""
        if stage not in ('images', 'models'):
            raise PipelineError('invalid_stage', '이미지 또는 3D 단계를 선택해 주세요.', 422)
        self.factory.get(owner, job_id)
        directory = self.factory.directory(owner, job_id)
        with _LOCK:
            job = read_json(directory/'job.json')
            if job.get('input_kind') != 'image' or job['status'] not in ('pipeline_paused', 'failed', 'recovery_required', 'review_required'):
                raise PipelineError('invalid_state', '현재 재개할 수 없는 작업입니다.')
            runner = read_json(directory/'output/runner.json')
            if job['status'] in ('failed', 'recovery_required') and runner and process_state(runner.get('process')) != 'exited':
                raise PipelineError('worker_running', '이전 Blender 프로세스가 종료되었는지 확인이 필요합니다.')
            state = read_json(directory/'pipeline.json')
            if stage == 'models':
                from src.services.avatar_stage_resume import validate_model_inputs
                validate_model_inputs(directory, state)
            if stage == 'images' and state.get('production_spec'):
                from src.services.avatar_multiview_images import can_resume
                if not can_resume(directory, state):
                    raise PipelineError('view_recovery_required', '기존 이미지 응답 확인 또는 실패 이미지 재요청이 필요합니다.', 409)
            for part in state['parts']:
                cached_response = (directory/'output'/f'{part["slot"]}-provider.response.json').is_file()
                if stage == 'images' and not state.get('production_spec') and part['image']['status'] in ('submitting', 'submission_uncertain', 'rejected', 'failed') and not cached_response:
                    raise PipelineError('image_attempt_recorded', '이미 시도한 이미지 요청입니다. 새 생산 버전에서만 다시 요청할 수 있습니다.')
                if read_json(directory/'parts'/part['slot']/'generation-artifacts.json').get('generated'):
                    continue
                task = read_json(directory/'parts'/part['slot']/'character.json')
                if resubmittable(task, retry_failed):
                    continue
                if task and not task.get('task_id'):
                    raise PipelineError('task_recovery_required', uncertain_text(part['slot'], task))
                if task.get('status') in ('FAILED', 'CANCELED'):
                    raise PipelineError('provider_failed', failure_text(part['slot'], task))
            if job['status'] in ('failed', 'recovery_required') and (directory/'output/input.json').is_file():
                # Keep failed work files and their exact input/seal before rebuilding locally.
                attempt = uuid.uuid4().hex
                archive = directory/'attempts'/attempt
                copy_tree(directory/'output', archive/'output')
                _write_json(archive/'job.json', job)
                job.setdefault('previous_attempts', []).append({'id': attempt, 'status': job['status'], 'archived_at': now()})
            job.update(status='pipeline_queued', executor=self.factory.instance, executor_process=identity(),
                       resume_stage=stage, model_retry=bool(retry_failed), error=None)
            job.pop('interrupted', None)
            _write_json(directory/'job.json', job)
        return self.factory.get(owner, job_id)

    def _recoverable(self, directory, slot, task_id):
        """(state, run, receipt) of a part whose submission has no task ID yet; raises when it cannot be recovered now."""
        job = read_json(directory/'job.json'); state = read_json(directory/'pipeline.json')
        if job.get('input_kind') != 'image' or job['status'] != 'pipeline_paused' or slot not in [p['slot'] for p in state['parts']]:
            raise PipelineError('invalid_state', '복구할 파츠 작업을 찾을 수 없습니다.')
        run = directory/'parts'/slot; task = read_json(run/'character.json')
        if not task or task.get('task_id') or task.get('status') != 'submission_uncertain':
            raise PipelineError('invalid_state', '응답이 불확실한 기존 제출만 작업 ID로 복구할 수 있습니다.')
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', task_id):
            raise PipelineError('invalid_task', '올바른 Meshy 작업 ID를 입력하세요.', 422)
        return state, run, task

    def recover_task(self, owner, job_id, slot, task_id):
        self.factory.get(owner, job_id)
        directory = self.factory.directory(owner, job_id)
        def lookup_failed():
            return PipelineError('task_lookup_failed', '3D 제공자에서 해당 작업을 확인하지 못했습니다. 작업 ID와 연결 설정을 확인하세요.', 422)
        with _LOCK:
            state, run, task = self._recoverable(directory, slot, task_id)
        # The provider is asked without the lock, so a slow answer stalls no other job action; what it said is
        # applied below only if the job is still waiting for exactly this recovery.
        try:
            from src.services.model_providers import client as provider_client
            with provider_client(task.get('provider', 'meshy'), state, timeout=30) as client:
                fetched = character_jobs.fetch_task(client, task, task_id)
        except (httpx.HTTPError, KeyError, ValueError, PipelineError):
            raise lookup_failed() from None
        with _LOCK:
            state, run, task = self._recoverable(directory, slot, task_id)
            try:
                task = character_jobs.record_task(run, task, task_id, fetched)
            except (KeyError, ValueError):
                raise lookup_failed() from None
            task['recovered_at'] = now(); task['recovered_by'] = owner; _write_json(run/'character.json', task)
            for p in state['parts']:
                if p['slot'] == slot:
                    p['model'] = {k: task.get(k) for k in ('status', 'task_id', 'progress')}
            self.publish(owner, job_id, state)
        return self.factory.get(owner, job_id)

    def _prepare_images(self, owner, job_id, state, job):
        directory = self.factory.directory(owner, job_id); output = directory/'output'
        if digest(directory/'source.png') != job['source_sha256']:
            raise PipelineError('source_changed', '보존한 원본 이미지가 변경되었습니다.')
        if state.get('production_spec'):
            from src.services.avatar_multiview_images import execute as generate_views
            generate_views(self, owner, job_id, state)
        for part in state['parts']:
            receipt = output/f'{part["slot"]}-provider'
            if part['image']['status'] == 'submitting' and receipt.with_suffix('.response.json').is_file():
                try:
                    raw = generate_openai_part_image(directory/'source.png', part['image']['prompt'],
                                                     state['image_model'], state['image_base'], receipt=receipt)
                    name = f'{part["slot"]}-image.png'; (output/name).write_bytes(raw)
                    part['image'].update(status='received', file=name, sha256=digest(output/name))
                    self.publish(owner, job_id, state)
                except Exception as exc:
                    if state.get('production_mode') != 'character_parts':
                        raise
                    self._record_image_failure(owner, job_id, state, part, exc, receipt)
                    continue
            if part['image']['status'] == 'received':
                image = part['image']; path = output/image['file']
                if digest(path) != image['sha256']:
                    raise PipelineError('image_changed', '보존한 이미지 응답이 변경되었습니다.')
                try:
                    asset = self.blueprints.upload(owner, path.read_bytes())
                    image.update(status='succeeded', asset=asset['id'])
                    image.pop('failure', None)
                    self.publish(owner, job_id, state)
                except Exception as exc:
                    if state.get('production_mode') != 'character_parts':
                        raise
                    self._record_image_failure(owner, job_id, state, part, exc, receipt)
                    continue
            if part['image']['status'] == 'succeeded':
                if digest(output/part['image']['file']) != part['image']['sha256']:
                    raise PipelineError('image_changed', '보존한 파츠 이미지가 변경되었습니다.')
                continue
            if part['image']['status'] != 'pending':
                if state.get('production_mode') == 'character_parts':
                    continue
                raise PipelineError('image_attempt_recorded', '이미지 요청의 응답을 확인할 수 없습니다. 자동 재제출하지 않습니다.')
            if sum('attempted_at' in p['image'] for p in state['parts']) >= job['limits']['image_tasks']:
                raise PipelineError('image_budget_exhausted', '허용된 이미지 생성 횟수를 모두 사용했습니다.')
            prompt = self._part_prompt(state, part)
            if part['slot'] == 'body' and state.get('body_purpose') != 'wardrobe_base' and part.get('description'):
                prompt += ' Additional art direction: '+part['description']
            provider = state.get('image_provider', 'gemini')
            if provider != 'openai':
                raise PipelineError('image_provider_removed', '이 작업의 이미지 제공자는 더 이상 지원하지 않습니다. 새 작업으로 생성하세요.', 410)
            part['image'] = {'status': 'submitting', 'prompt': prompt, 'provider': provider,
                             'model': state['image_model'], 'attempted_at': now()}
            self.publish(owner, job_id, state)
            _write_json(output/'progress.json', {'stage': 'images', 'message': f'{part["slot"]} 이미지 분리·숨겨진 형태 보완 중'})
            try:
                raw = generate_openai_part_image(directory/'source.png', prompt, state['image_model'], state['image_base'],
                                                 receipt=output/f'{part["slot"]}-provider')
            except httpx.HTTPStatusError as exc:
                if state.get('production_mode') == 'character_parts':
                    self._record_image_failure(owner, job_id, state, part, exc, receipt)
                    continue
                if exc.response.status_code in (400, 401, 403, 404, 422, 429):
                    part['image']['status'] = 'rejected'; self.publish(owner, job_id, state)
                if isinstance(exc, OpenAIImageHTTPError):
                    reason = {
                        'invalid_request': '요청 형식이 이미지 제공자에서 거부되었습니다.',
                        'reference_url': '참조 이미지 URL을 이미지 제공자가 불러오지 못했습니다.',
                        'model': '설정된 이미지 모델을 제공자가 받아들이지 않았습니다.',
                        'size': '요청한 이미지 크기를 제공자가 받아들이지 않았습니다.',
                        'auth': '이미지 제공자 인증 또는 권한이 거부되었습니다.',
                        'policy': '이미지 요청이 제공자 정책 검사에서 거부되었습니다.',
                    }.get(exc.category, '이미지 제공자가 요청을 거부했습니다.')
                    raise PipelineError('image_provider_error',
                        f'이미지 생성 {part["slot"]}: {reason} 진단 {exc.diagnostic_id}. 자동 재요청하지 않습니다.') from None
                raise PipelineError('image_provider_error', f'이미지 생성 {part["slot"]}: HTTP {exc.response.status_code}. 모델·키·할당량을 확인해 주세요. 자동 재요청하지 않습니다.') from None
            except (httpx.RequestError, PipelineError, OSError, ValueError) as exc:
                if state.get('production_mode') != 'character_parts':
                    raise
                self._record_image_failure(owner, job_id, state, part, exc, receipt)
                continue
            name = f'{part["slot"]}-image.png'; (output/name).write_bytes(raw)
            # Keep the completed provider output before local indexing can fail.
            part['image'].update(status='received', file=name, sha256=digest(output/name))
            self.publish(owner, job_id, state)
            try:
                asset = self.blueprints.upload(owner, raw)
                part['image'].update(status='succeeded', file=name, sha256=digest(output/name), asset=asset['id'])
                part['image'].pop('failure', None)
                self.publish(owner, job_id, state)
            except Exception as exc:
                if state.get('production_mode') != 'character_parts':
                    raise
                self._record_image_failure(owner, job_id, state, part, exc, receipt)
        # An uploaded 3D part needs no image.
        incomplete_images = [p['slot'] for p in state['parts'] if p['image']['status'] not in ('succeeded', 'not_required')]
        if incomplete_images:
            raise PipelineError('part_images_incomplete',
                f'파츠 이미지 {len(incomplete_images)}개가 완료되지 않았습니다. 실패 기록을 보존했고 Meshy 단계는 시작하지 않았습니다.')

    def _release_model(self, run, part, task, job):
        """Archive a failed or unaccepted Meshy attempt so this part can be sent again."""
        automatic = _auto_resubmit(task) and not job.get('model_retry')
        history = part.setdefault('model_attempts', [])
        if automatic and sum(item.get('reason') == 'auto' for item in history) >= AUTO_RESUBMIT_LIMIT:
            return False
        character_jobs.archive_attempt(run, 'auto' if automatic else 'explicit')
        history.append({'reason': 'auto' if automatic else 'explicit', 'status': task.get('status'),
                        'http_status': task.get('http_status'), 'task_id': task.get('task_id'), 'at': now()})
        part['model'] = {'status': 'pending'}
        return True

    def _model_inputs(self, state, part, run, output):
        """Ordered views for the provider; a worn part sends one shared square crop of all views."""
        views = list(state['production_spec']['generated_views'])
        images = [output/part['views'][view]['file'] for view in views]
        if part.get('part_method') == 'worn':
            from src.services.avatar_worn_images import shared_crop
            cropped, box = shared_crop({view: image.read_bytes() for view, image in zip(views, images)})
            images = []
            for view in views:
                path = run/f'input-{view}.png'
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(cropped[view])
                images.append(path)
            _write_json(run/'input-crop.json', box)
        return views, images

    def _submit_model(self, owner, job_id, state, part, run, output, client):
        """One provider POST per attempt; an unaccepted attempt is sent again after a wait, within the auto limit."""
        from src.services.object_storage import provider_image
        texture_prompt = state.get('meshy_texture_prompts', {}).get(part['slot'])
        provider = state.get('model_provider', 'meshy')
        generation_options = None
        if part.get('meshy_options') and provider == 'meshy':
            from src.services.meshy_options import provider_options, worn_polycount
            generation_options = provider_options(self.factory, owner, part['meshy_options'])
            if part.get('part_method') == 'worn':
                generation_options = worn_polycount(generation_options, part['slot'])
        while True:
            _write_json(output/'progress.json', {'stage': 'models', 'message': f'{part["slot"]} 개별 3D 생성 제출 중'})
            try:
                # character_jobs persists the submission intent BEFORE the POST.
                if state.get('production_spec'):
                    views, images = self._model_inputs(state, part, run, output)
                    links = [provider_image(image, image.read_bytes(), 'image/png') for image in images]
                    urls = [link['url'] for link in links] if all(links) else None
                    from src.services.meshy_options import SHARED_PART_POLYCOUNT
                    budget = SHARED_PART_POLYCOUNT.get(part['slot'])
                    return character_jobs.generate_multiview_part(run, images, client,
                        isolated_part=part['slot'] != 'body', height=state['body_height_m'],
                        expected_views=views,
                        texture_prompt=texture_prompt,
                        preserve_geometry=part['slot'] == 'body' and state.get('meshy_preserve_geometry') is True,
                        quality_profile=state.get('meshy_quality_profile') if part['slot'] == 'body' else None,
                        generation_options=generation_options, provider=provider, image_urls=urls,
                        face_limit=(budget*2 if part.get('part_method') == 'worn' else budget) if budget else None)
                return character_jobs.generate(run, output/part['image']['file'], state.get('body_height_m', PROFILE['height']), client,
                    isolated_part=part['slot'] != 'body', texture_prompt=texture_prompt)
            except httpx.HTTPError:
                task = read_json(run/'character.json')
                if not _auto_resubmit(task) or not self._release_model(run, part, task, {}):
                    raise
                self.publish(owner, job_id, state)
                time.sleep(20 * sum(item.get('reason') == 'auto' for item in part['model_attempts']))

    def execute(self, owner, job_id, *, poll_seconds=8, deadline_seconds=3600):
        directory = self.factory.directory(owner, job_id); output = directory/'output'
        if not _RUN_LOCKS.acquire(str(directory)):
            return
        try:
            job = read_json(directory/'job.json')
            if job.get('status') != 'pipeline_queued' or job.get('executor') != self.factory.instance:
                return
            job.update(status='pipeline_running'); _write_json(directory/'job.json', job)
            state = read_json(directory/'pipeline.json')
            if job.get('resume_stage', 'images') == 'images':
                from src.services.avatar_variants import prepare_body
                from src.services.avatar_reference_preparation import execute as prepare_reference
                prepare_body(self, owner, job_id, state)
                prepare_reference(self, owner, job_id, state, job)
                self._prepare_images(owner, job_id, state, job)
            else:
                from src.services.avatar_stage_resume import validate_model_inputs
                validate_model_inputs(directory, state)
            modelled = [p for p in state['parts'] if p.get('part_method') != 'body_shell']
            cached = all(read_json(directory/'parts'/p['slot']/'generation-artifacts.json').get('generated') for p in modelled)
            if cached:
                # Rebuilding completed files never needs credentials or a network client.
                for part in modelled:
                    run = directory/'parts'/part['slot']
                    receipt = read_json(run/'generation-artifacts.json')['generated']
                    if digest(run/'generated.glb') != receipt['sha256']:
                        raise PipelineError('model_changed', 'Generated part receipt mismatch')
                    part['model']['status'] = 'ready'
                self.publish(owner, job_id, state)
            else:
                from src.services.model_providers import client as provider_client
                with provider_client(state.get('model_provider', 'meshy'), state) as client:
                    for part in modelled:
                        run = directory/'parts'/part['slot']
                        artifacts = read_json(run/'generation-artifacts.json')
                        if artifacts.get('generated'):
                            if digest(run/'generated.glb') != artifacts['generated']['sha256']:
                                raise PipelineError('model_changed', '생성된 파츠 파일이 변경되었습니다.')
                            part['model']['status'] = 'ready'
                            continue
                        task = read_json(run/'character.json')
                        if resubmittable(task, job.get('model_retry')) and self._release_model(run, part, task, job):
                            self.publish(owner, job_id, state)
                            task = {}
                        if not task:
                            attempts = sum((directory/'parts'/p['slot']/'character.json').is_file()
                                           for p in modelled if p['slot'] not in state.get('reuse', {}).get('slots', []))
                            if attempts >= job['limits']['meshy_tasks']:
                                raise PipelineError('meshy_budget_exhausted', '허용된 Meshy 생성 횟수를 모두 사용했습니다.')
                            task = self._submit_model(owner, job_id, state, part, run, output, client)
                        if not task.get('task_id'):
                            raise PipelineError('task_recovery_required', uncertain_text(part['slot'], task))
                        part['model'] = {k: task.get(k) for k in ('status', 'task_id', 'progress')}
                        self.publish(owner, job_id, state)
                    deadline = time.monotonic()+deadline_seconds
                    while True:
                        complete = True
                        for part in modelled:
                            run = directory/'parts'/part['slot']
                            artifacts = read_json(run/'generation-artifacts.json')
                            if artifacts.get('generated'):
                                if digest(run/'generated.glb') != artifacts['generated']['sha256']:
                                    raise PipelineError('model_changed', '생성된 파츠 파일이 변경되었습니다.')
                                part['model']['status'] = 'ready'; continue
                            with _polling(state):
                                task = character_jobs.refresh(run, client)
                            part['model'] = {k: task.get(k) for k in ('status', 'task_id', 'progress')}
                            self.publish(owner, job_id, state)
                            if task['status'] in ('FAILED', 'CANCELED'):
                                raise PipelineError('provider_failed', failure_text(part['slot'], task))
                            if task['status'] == 'SUCCEEDED':
                                character_jobs.download(run, 'generation'); part['model']['status'] = 'ready'
                            else:
                                complete = False
                        self.publish(owner, job_id, state)
                        _write_json(output/'progress.json', {'stage': 'models', 'message': f'개별 3D 완료 {sum(p["model"]["status"] == "ready" for p in modelled)}/{len(modelled)}'})
                        if complete: break
                        if time.monotonic() >= deadline:
                            raise PipelineError('poll_paused', '긴 작업의 조회를 일시 중단했습니다. 기존 작업 이어가기로 상태 조회를 재개하세요.')
                        time.sleep(poll_seconds)
            models = []
            for part in modelled:
                from src.services.meshy_outputs import publish_extras
                with _polling(state):
                    publish_extras(directory/'parts'/part['slot'], directory, part['slot'])
                path = directory/'parts'/part['slot']/'generated.glb'
                models.append({'slot': part['slot'], 'path': str(path), 'sha256': digest(path), 'task_id': part['model']['task_id']})
                if state.get('production_mode') == 'character_parts' or part['slot'] == 'body':
                    name = f'generated-{part["slot"]}.glb'
                    copy_file(path, output/name)
                    job = read_json(directory/'job.json')
                    job.setdefault('files', {})[name] = digest(path)
                    _write_json(directory/'job.json', job)
            if state.get('rig_with_meshy'):
                # Preserve Meshy's native skin and clips. Never rebind this path to a local 23-bone rig.
                job = read_json(directory/'job.json')
                job.update(status='review_required', updated_at=now())
                _write_json(directory/'job.json', job)
                _write_json(output/'progress.json', {'stage': 'rig', 'message': '전신 생성 완료 · Meshy 리깅·동작 가져오는 중'})
                if state.get('production_mode') == 'character_parts':
                    from src.services.avatar_character_flow import continue_character
                    continue_character(self.factory, owner, job_id)
                else:
                    from src.services.avatar_meshy import AvatarMeshy
                    provider = AvatarMeshy(self.factory)
                    provider.start(owner, job_id); provider.execute(owner, job_id)
                return
            raise PipelineError('legacy_mode_removed', '단일 이미지 레거시 조립은 종료되었습니다. 캐릭터 파츠 생산을 사용하세요.', 410)
        except Exception as exc:
            failure_id = uuid.uuid4().hex[:12]
            # No credentials, raw response or internal exception text in public errors.
            code = exc.code if isinstance(exc, PipelineError) else None
            state = {}
            try:
                import traceback
                frames = [{'file': Path(f.filename).name, 'line': f.lineno, 'function': f.name}
                          for f in traceback.extract_tb(exc.__traceback__)]
                last = frames[-1] if frames else {}
                LOGGER.error('Avatar production %s failed: job=%s type=%s code=%s at=%s:%s', failure_id, job_id,
                             type(exc).__name__, code, last.get('file'), last.get('line'))
                _write_json(directory/'failure.json', {'id': failure_id, 'type': type(exc).__name__, 'code': code,
                                                       'frames': frames, 'at': now()})
                # A POST may have persisted its intent before the caller received its result.
                state = read_json(directory/'pipeline.json')
                for p in state.get('parts', []):
                    task = read_json(directory/'parts'/p['slot']/'character.json')
                    if task:
                        p['model'] = {k: task.get(k) for k in ('status', 'task_id', 'progress')}
                self.publish(owner, job_id, state)
            except Exception as detail:
                # The details are best effort. A job left running here would answer every resume with invalid_state until a restart.
                LOGGER.error('Avatar production %s: failure details not saved: job=%s type=%s', failure_id, job_id, type(detail).__name__)
            error = _pause_message(exc, failure_id, state.get('model_provider', 'meshy'))

            def pause():
                job = read_json(directory/'job.json')
                job.update(status='pipeline_paused', error=error, updated_at=now())
                if code in CONTINUABLE_STOPS:
                    job['interrupted'] = {'stage': 'models', 'at': now()}
                _write_json(directory/'job.json', job)
            # A storage blip that stopped the run must not also leave it `pipeline_running` until a restart.
            final_write(pause, 'production job')
        finally:
            _RUN_LOCKS.release(str(directory))
