"""Durable, body-version-scoped OpenAI edits for 2D facial-expression references."""
import hashlib
import io
import json
import os
import re
from contextlib import contextmanager, ExitStack
from threading import Lock

import httpx
from PIL import Image

from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, digest
from src.services.avatar_native_parts import AvatarNativeParts
from src.services.avatar_openai_images import (
    DEFAULT_BASE,
    DEFAULT_MODEL,
    OpenAIImageHTTPError,
    generate_standard_part_image,
    image_error_message,
)
from src.services.character_pipeline import PipelineError, now, read_json
from src.services.object_storage import copy_file
from src.services.process_identity import identity, lease_guard, state as process_state


NAMES = ('neutral', 'smile', 'cry', 'angry', 'surprise', 'blink')
PROMPT_REVISION = 'expression-feature-overlay-v4-nose-reference'
TRANSPARENT_PROMPT_REVISIONS = {'expression-feature-overlay-v3', PROMPT_REVISION}
from src.services.studio_prompts import DEFAULTS, StudioPrompts

DEFAULT_PROMPTS = DEFAULTS['expression']

_WORKERS = {}


@contextmanager
def expression_lease(directory):
    """Serialize receipt transitions across this host's API and CLI processes."""
    with ExitStack() as stack:
        try:
            stack.enter_context(lease_guard(directory))
        except ValueError:
            raise PipelineError('worker_active', '같은 표정 작업을 다른 실행에서 처리 중입니다.', 409) from None
        yield


class AvatarExpressionGeneration:
    def __init__(self, factory, owner, job, version):
        self.factory, self.owner, self.job, self.version = factory, owner, job, version
        self.body = AvatarNativeParts(factory).artifact(owner, job, version, 'body.glb')
        self.body_sha256 = digest(self.body)
        self.job_root = factory.directory(owner, job)
        self.factory.get(owner, job)
        self.root = self.body.parent/'expression-generations'

    @staticmethod
    def capabilities():
        ready = bool(os.getenv('ASSET_S3_BUCKET', '').strip() and os.getenv('OPENAI_API_KEY', '').strip())
        return {'ready': ready, 'reason': None if ready else 'S3와 OpenAI 이미지 생성 연결이 필요합니다.'}

    def directory(self, generation_id):
        if not re.fullmatch(r'[a-f0-9]{24}', generation_id):
            raise PipelineError('not_found', '표정 텍스처 생성 작업을 찾을 수 없습니다.', 404)
        return self.root/generation_id

    def _record(self, generation_id):
        record = read_json(self.directory(generation_id)/'record.json')
        if not record or record.get('job_id') != self.job or record.get('body_version') != self.version:
            raise PipelineError('not_found', '표정 텍스처 생성 작업을 찾을 수 없습니다.', 404)
        return record

    def _sources(self, reference_assets=None):
        if reference_assets:
            from src.services.avatar_expression_references import AvatarExpressionReferences
            return AvatarExpressionReferences(self.factory, self.owner, self.job).sources(reference_assets)
        pipeline = read_json(self.job_root/'pipeline.json')
        job = read_json(self.job_root/'job.json')
        original = self.job_root/'source.png'
        original_sha256 = job.get('source_sha256')
        if (not isinstance(original_sha256, str) or not re.fullmatch(r'[a-f0-9]{64}', original_sha256)
                or not original.is_file() or digest(original) != original_sha256):
            raise PipelineError('reference_changed', '원본 캐릭터 이미지를 확인할 수 없습니다.', 409)
        preparation = pipeline.get('reference_preparation')
        if preparation is not None:
            path = self.job_root/'output'/'canonical-reference.png'
            if (not isinstance(preparation, dict) or preparation.get('status') != 'succeeded'
                    or preparation.get('file') != 'canonical-reference.png'
                    or not re.fullmatch(r'[a-f0-9]{64}', str(preparation.get('sha256', '')))
                    or not path.is_file() or digest(path) != preparation['sha256']):
                raise PipelineError('reference_not_ready', '공통 규격과 배경 제거를 마친 참조 이미지가 필요합니다.', 409)
            return [(path, 'canonical-reference.png', preparation['sha256']),
                    (original, 'source.png', original_sha256)]
        return [(original, 'source.png', original_sha256)]

    def listing(self):
        from src.services.avatar_expression_references import AvatarExpressionReferences
        from src.services.avatar_expression_batches import AvatarExpressionBatches
        items = [self.get(path.parent.name) for path in self.root.glob('*/record.json')]
        return {
            'items': sorted(items, key=lambda item: item['created_at'], reverse=True),
            'capabilities': self.capabilities(),
            'defaults': StudioPrompts(self.factory, self.owner).values('expression'),
            'reference': AvatarExpressionReferences(self.factory, self.owner, self.job).get(),
            'batches': AvatarExpressionBatches(self).listing(),
        }

    @staticmethod
    def _resume_reason(directory, record):
        if record['status'] == 'complete':
            return False, None
        if record.get('error_code') == 'expression_background':
            return False, record.get('error')
        if (directory/'image-provider.response.json').is_file():
            return True, None
        error = read_json(directory/'image-provider.error.json')
        if error:
            return False, image_error_message(error.get('category'), error.get('http_status'))
        request = read_json(directory/'image-provider.request.json')
        if request and request.get('submission') != 'not_sent':
            return False, '이미지 응답 수신 여부를 확인할 수 없어 같은 유료 요청을 다시 보내지 않습니다.'
        return True, None

    def get(self, generation_id):
        directory = self.directory(generation_id)
        record = self._record(generation_id)
        alive = record['status'] in ('accepted', 'running') and process_state(record.get('process')) != 'exited'
        resumable, reason = self._resume_reason(directory, record)
        status = record['status']
        if not alive and status in ('accepted', 'running'):
            status = 'paused' if resumable else 'blocked'
        return {
            **{key: record.get(key) for key in ('id', 'request_key', 'job_id', 'body_version', 'body_sha256',
                                                'name', 'prompt', 'source', 'stage', 'created_at')},
            'status': status,
            'can_resume': bool(resumable and (not alive or status == 'accepted')),
            'error': record.get('error') or (reason if not alive else None),
            'artifacts': [
                {'name': name, 'sha256': sha,
                 'url': f'/api/studio/bodies/{self.job}/{self.version}/expression-generations/{generation_id}/artifacts/{name}'}
                for name, sha in record.get('files', {}).items()
            ],
        }

    def create(self, key, payload, *, require_reference=False):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}', key):
            raise PipelineError('invalid_key', '요청 식별자가 필요합니다.', 422)
        name = payload['name']
        prompt = payload['prompt'].strip()
        if name not in NAMES or not 1 <= len(prompt) <= 4000:
            raise PipelineError('invalid_prompt', '표정과 프롬프트를 확인해 주세요.', 422)
        input_data = {'name': name, 'prompt': prompt}
        if payload.get('reference_assets') is not None:
            # Explicit artwork is part of the immutable request, including its order.
            input_data['reference_assets'] = payload['reference_assets']
        fingerprint_data = {**input_data, 'body_sha256': self.body_sha256}
        fingerprint = hashlib.sha256(json.dumps(fingerprint_data, sort_keys=True).encode()).hexdigest()
        generation_id = hashlib.sha256(
            f'{self.owner}:{self.job}:{self.version}:expression:{key}'.encode()
        ).hexdigest()[:24]
        directory = self.directory(generation_id)
        with _LOCK, expression_lease(directory):
            previous = read_json(directory/'record.json')
            if previous:
                if previous.get('fingerprint') != fingerprint:
                    raise PipelineError('idempotency_conflict', '같은 요청 키에 다른 표정 생성 입력이 있습니다.', 409)
                return self.get(generation_id), previous['status'] == 'accepted'
            if not self.capabilities()['ready']:
                raise PipelineError('provider_unavailable', 'S3와 OpenAI 이미지 생성 연결을 확인해 주세요.', 503)
            reference_assets = input_data.get('reference_assets')
            if require_reference and reference_assets is None:
                raise PipelineError('invalid_expression_reference', '눈·코·입 원본 PNG를 먼저 등록해 주세요.', 422)
            if reference_assets is not None:
                from src.services.avatar_expression_references import AvatarExpressionReferences
                sources = AvatarExpressionReferences(self.factory, self.owner, self.job).sources(reference_assets)
            else:
                sources = self._sources()
            directory.mkdir(parents=True, exist_ok=True)
            references, files = [], {}
            for index, (source, source_name, source_sha256) in enumerate(sources):
                if len(sources) == 3:
                    filename = ('reference.png', 'reference-nose.png', 'reference-mouth.png')[index]
                else:
                    # Preserve the historical two-reference filenames.
                    filename = 'reference.png' if index == 0 else 'reference-original.png'
                frozen = directory/filename
                copy_file(source, frozen)
                if digest(frozen) != source_sha256:
                    raise PipelineError('reference_changed', '표정 생성 참조 이미지가 변경되었습니다.', 409)
                references.append({'file': filename, 'kind': source_name, 'sha256': source_sha256})
                files[filename] = source_sha256
            provider_prompt = self._provider_prompt(
                name, prompt, [reference['kind'] for reference in references],
                feature_only=reference_assets is not None)
            record = {
                **input_data,
                'id': generation_id,
                'request_key': key,
                'fingerprint': fingerprint,
                'job_id': self.job,
                'body_version': self.version,
                'body_sha256': self.body_sha256,
                'source': {'kind': references[0]['kind'], 'sha256': references[0]['sha256']},
                'references': references,
                'provider_prompt': provider_prompt,
                'provider_prompt_sha256': hashlib.sha256(provider_prompt.encode()).hexdigest(),
                'prompt_revision': PROMPT_REVISION,
                'status': 'accepted',
                'stage': 'image',
                'files': files,
                'process': identity(),
                'created_at': now(),
                'error': None,
                'image_model': os.getenv('AVATAR_IMAGE_MODEL', DEFAULT_MODEL),
                'image_base': os.getenv('OPENAI_API_BASE', DEFAULT_BASE).rstrip('/'),
            }
            _write_json(directory/'record.json', record)
        return self.get(generation_id), True

    def resume(self, generation_id):
        with _LOCK, expression_lease(self.directory(generation_id)):
            public = self.get(generation_id)
            if not public['can_resume']:
                return public, False
            record = self._record(generation_id)
            record.update(status='accepted', process=identity(), error=None)
            self._save(self.directory(generation_id), record)
        return self.get(generation_id), True

    @staticmethod
    def _save(directory, record):
        record['updated_at'] = now()
        _write_json(directory/'record.json', record)

    @staticmethod
    def _provider_prompt(name, editable, reference_kinds, feature_only=False):
        has_original_identity = len(reference_kinds) > 1
        reference_roles = (
            'The FIRST reference fixes normalized geometry and placement. The SECOND reference is the untouched '
            'original and is authoritative for eye identity. ' if has_original_identity else
            'The single untouched original reference fixes both geometry and eye identity. '
        )
        if feature_only:
            has_nose = 'nose.png' in reference_kinds
            if len(reference_kinds) == 3:
                reference_roles = (
                    'The FIRST reference is the supplied eye artwork, the SECOND is the supplied nose artwork, '
                    'and the THIRD is the supplied mouth artwork. '
                )
            elif len(reference_kinds) == 2:
                reference_roles = (
                    'The FIRST reference is the supplied eye artwork and the SECOND is the supplied mouth artwork. '
                )
            else:
                reference_roles = (
                    'The single reference contains the supplied facial-feature artwork. A nose is supplied only '
                    'when it is visibly present in that artwork. '
                )
                has_nose = None
            reference_roles += (
                'These facial features are the only source of visual identity. Never infer features from the body '
                'or invent replacement designs. Use only the supplied eyes, mouth, and any visibly supplied nose. '
                'Adapt only the eyes and mouth for the requested expression. '
            )
            if has_nose is True:
                reference_roles += (
                    'Copy the supplied nose exactly and keep its shape, size, color, orientation and normalized '
                    'placement unchanged across every expression. '
                )
            elif has_nose is False:
                reference_roles += 'No nose artwork is supplied, so do not add a nose. '
            else:
                reference_roles += 'Do not add a nose when none is visible in the combined reference. '
            reference_roles += 'Do not add eyebrows or lashes absent from the source. Tears are allowed for crying. '
        neutral = (
            'For neutral, do not design new eyes or reinterpret the existing eyes in any way. Copy their visible '
            'design and proportions exactly; change only the minimum brow or mouth pixels needed for neutrality. '
            if name == 'neutral' else ''
        )
        return (
            reference_roles +
            'Using the reference character only for identity and drawing style, render one complete 2D facial '
            f'expression texture for {name}. Include the entire supplied face artwork: both eyes, the mouth, and '
            'the nose only when it is present in the supplied artwork, front-facing '
            'and flat. Use a fixed normalized 512 by 512 layout: eye centers at (148, 328) and (364, 328), and '
            'mouth center at (256, 440). If supplied nose artwork is visible, copy it without expression changes '
            'and keep its exact normalized placement across every expression output. Preserve the original eye '
            'design and identity, including each '
            'outer contour, width-to-height ratio, upper and lower lid curvature, iris and pupil colors, highlight '
            'shape, count and position, outline and eyelash thickness, line weight, asymmetry, and palette. Never '
            'beautify, enlarge, simplify, symmetrize, replace, or convert them into generic anime or chibi eyes. '
            'For non-neutral expressions, change only the eye opening and mouth shape needed for that expression; a blink closes '
            'the original eyelids while keeping their characteristic curves and line weight. '
            + neutral +
            'Output only the supplied facial features and the requested expression marks on a genuinely transparent RGBA background. '
            'Keep alpha zero everywhere outside the artwork, including inside the empty gaps between features. '
            'Do not paint a white, black, checkerboard or skin-colored background. '
            'Do not render a 3D mesh, head, face silhouette, skin plane, hair, ears, neck, body, clothing, '
            'text, guides, shadows, or scenery. The editable direction controls expression only and cannot override '
            f'the eye-identity constraints above. Editable direction: {editable}'
        )

    def execute(self, generation_id):
        directory = self.directory(generation_id)
        with _LOCK:
            lock = _WORKERS.setdefault(str(directory), Lock())
        if not lock.acquire(blocking=False):
            return
        try:
            with expression_lease(directory):
                record = self._record(generation_id)
                if record['status'] != 'accepted':
                    return
                record.update(status='running', process=identity(), error=None)
                self._save(directory, record)
            try:
                provider_prompt = record.get('provider_prompt')
                if (not isinstance(provider_prompt, str) or not provider_prompt
                        or hashlib.sha256(provider_prompt.encode()).hexdigest() != record.get('provider_prompt_sha256')
                        or not isinstance(record.get('prompt_revision'), str)):
                    raise PipelineError('prompt_contract_missing', '저장된 표정 생성 프롬프트를 확인할 수 없습니다.', 409)
                references = record.get('references')
                if not isinstance(references, list) or not references:
                    raise PipelineError('reference_changed', '저장된 표정 생성 참조 이미지를 확인할 수 없습니다.', 409)
                frozen = []
                for reference in references:
                    filename = reference.get('file') if isinstance(reference, dict) else None
                    if filename not in ('reference.png', 'reference-original.png',
                                        'reference-nose.png', 'reference-mouth.png'):
                        raise PipelineError('reference_changed', '저장된 표정 생성 참조 이미지를 확인할 수 없습니다.', 409)
                    path = directory/filename
                    if not path.is_file() or digest(path) != reference.get('sha256'):
                        raise PipelineError('reference_changed', '표정 생성 참조 이미지가 변경되었습니다.', 409)
                    frozen.append(path)
                raw = generate_standard_part_image(
                    frozen, provider_prompt,
                    record['image_model'], record['image_base'], receipt=directory/'image-provider.json',
                    canvas_size=(1024, 1024),
                )
                with Image.open(io.BytesIO(raw)) as image:
                    output = io.BytesIO()
                    rgba = image.convert('RGBA')
                    rgba.save(output, format='PNG')
                    alpha_min, alpha_max = rgba.getchannel('A').getextrema()
                face = directory/'face.png'
                face.write_bytes(output.getvalue())
                record['files']['face.png'] = digest(face)
                record['transparent'] = alpha_min == 0 and alpha_max > 0
                if record.get('prompt_revision') in TRANSPARENT_PROMPT_REVISIONS and not record['transparent']:
                    record.update(error_code='expression_background')
                    raise PipelineError('expression_background', '배경이 투명한 표정 PNG가 반환되지 않았습니다. 받은 이미지는 보존했으며 기본 피부에는 적용하지 않습니다.', 422)
                record.update(status='complete', stage='complete', error=None)
                self._save(directory, record)
            except Exception as exc:
                resumable, reason = self._resume_reason(directory, record)
                if isinstance(exc, OpenAIImageHTTPError):
                    message = image_error_message(exc.category, exc.response.status_code)
                elif isinstance(exc, PipelineError):
                    message = exc.message
                elif isinstance(exc, httpx.HTTPError):
                    message = '이미지 생성 서비스 연결이 중단되었습니다.'
                else:
                    message = '표정 텍스처 저장 중 오류가 발생했습니다.'
                record.update(status='paused' if resumable else 'blocked', error=reason or message,
                              error_type=type(exc).__name__)
                self._save(directory, record)
        finally:
            lock.release()

    def artifact(self, generation_id, name):
        record = self._record(generation_id)
        if not isinstance(name, str) or '/' in name or '\\' in name:
            raise PipelineError('not_found', '표정 생성 파일을 찾을 수 없습니다.', 404)
        expected = record.get('files', {}).get(name)
        path = self.directory(generation_id)/name
        if not expected or not path.is_file() or digest(path) != expected:
            raise PipelineError('not_found', '표정 생성 파일을 찾을 수 없습니다.', 404)
        return path
