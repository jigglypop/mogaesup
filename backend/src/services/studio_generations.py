"""Owner-scoped prompt assets with one saved attempt per paid provider stage.

A prop's 3D provider (Meshy or Tripo) is frozen on the record when the job is accepted; its receipts live in
`<provider>/character.json`. Only while no 3D task was accepted or left uncertain may a resume send the 3D step
to a provider again, keeping the paid image.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import re
import time

import httpx

from src.services import character_jobs
from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, digest
from src.services.avatar_openai_images import (DEFAULT_BASE, DEFAULT_MODEL, generate_image,
                                              generate_standard_part_image, OpenAIImageHTTPError,
                                              image_error_message)
from src.services.character_pipeline import PipelineError, now, read_json, request_job_id, require_bucket, require_request_key
from src.services.illustration_motion import FORMATS, MOTION_REVISION, encode, render_frames
from src.services.illustration_rig import build_rig
from src.services.illustration_vector import VECTOR_REVISION, trace_illustration
from src.services.model_providers import (LABELS, PROVIDERS, base_url, client as provider_client,
                                          configured as provider_keys, model_problem, resolve_provider)
from src.services.process_identity import identity
from src.services.object_storage import copy_file, provider_image
from src.services.run_lock import WorkerLocks, final_write, worker_alive
from src.services.studio_materials import texture_maps, prop_model

from src.services.studio_prompts import DEFAULTS as PROMPT_DEFAULTS, StudioPrompts

DEFAULTS = {kind: PROMPT_DEFAULTS[kind] for kind in ('prop', 'texture', 'illustration')}
ILLUSTRATION_PROMPT_REVISION = 'illustration-character-v1'
PROP_FACE_LIMIT = 8000  # Tripo face_limit for one island prop.
# The provider answered these with a definite refusal or never received them: nothing was accepted or paid.
UNSENT = ('submission_rejected', 'submission_not_sent')
_WORKERS = WorkerLocks()
# A listing reads every record and its receipts; in S3 mode one at a time it can outlast the proxy timeouts.
_LISTING_READERS = ThreadPoolExecutor(max_workers=8, thread_name_prefix='generation-listing')


class StudioGenerations:
    def __init__(self, factory, owner):
        self.factory, self.owner = factory, owner
        self.root = factory.root/str(int(owner))/'library/generations'

    def directory(self, job_id):
        if not re.fullmatch(r'[a-f0-9]{24}', job_id):
            raise PipelineError('not_found', '기물·재질 작업을 찾을 수 없습니다.', 404)
        return self.root/job_id

    @staticmethod
    def capabilities(kind):
        keys = provider_keys()
        ready = bool(os.getenv('ASSET_S3_BUCKET', '').strip() and os.getenv('OPENAI_API_KEY', '').strip()
                     and (kind in ('texture', 'illustration') or any(keys.values())))
        result = {'ready': ready, 'reason': None if ready else '생성 서비스 연결 대기'}
        if kind == 'prop':
            result.update(providers=[name for name in PROVIDERS if keys[name]], default_provider=resolve_provider())
        return result

    def listing(self, kind):
        def item(path):
            # One read of each record, its receipts read once, all of them in parallel.
            held = _WORKERS.busy(str(path.parent))
            record = read_json(path)
            if record.get('kind') != kind:
                return None
            return self._public(path.parent.name, record, held)
        items = [value for value in _LISTING_READERS.map(item, list(self.root.glob('*/record.json'))) if value]
        return {'items': sorted(items, key=lambda item: item['created_at'], reverse=True),
                'capabilities': self.capabilities(kind), 'defaults': StudioPrompts(self.factory, self.owner).values(kind)}

    def _record(self, job_id):
        record = read_json(self.directory(job_id)/'record.json')
        if not record:
            raise PipelineError('not_found', '기물·재질 작업을 찾을 수 없습니다.', 404)
        return record

    @staticmethod
    def _run(directory, record):
        """The prop's 3D receipts; records from before provider choice are Meshy's."""
        return directory/(record.get('provider') or 'meshy')

    @staticmethod
    def _image_reason(directory, record):
        if 'image.png' not in record['files']:
            if (directory/'image-provider.response.json').is_file():
                return True, None
            error = read_json(directory/'image-provider.error.json')
            if error:
                return False, image_error_message(error.get('category'), error.get('http_status'))
            request = read_json(directory/'image-provider.request.json')
            if request and request.get('submission') != 'not_sent':
                return False, '이미지 응답을 확인하지 못했습니다. 저장된 요청을 유지하며 유료 요청을 반복하지 않습니다.'
        return True, None

    def _resume_reason(self, directory, record, task=None, image=None):
        """`task` (the prop's 3D receipt) and `image` (_image_reason) when the caller has read them already."""
        if record['status'] == 'complete':
            return False, None
        resumable, reason = image or self._image_reason(directory, record)
        if resumable and record['kind'] == 'prop':
            run = self._run(directory, record)
            problem = model_problem(read_json(run/'character.json') if task is None else task, run)
            if problem:
                return False, problem['message']
        return resumable, reason

    @staticmethod
    def _model_unstarted(directory):
        """No provider accepted a 3D task or may have: sending the 3D step again cannot pay twice."""
        tasks = [read_json(directory/name/'character.json') for name in PROVIDERS]
        return all(not task or (task.get('status') in UNSENT and not task.get('task_id')) for task in tasks)

    def get(self, job_id):
        directory = self.directory(job_id)
        held = _WORKERS.busy(str(directory))
        return self._public(job_id, self._record(job_id), held)

    def _public(self, job_id, record, held):
        """`held`: whether this generation's worker held its lock before the record was read."""
        directory = self.directory(job_id)
        alive = worker_alive(record, held or _WORKERS.busy(str(directory)))
        prop = record['kind'] == 'prop'
        task = read_json(self._run(directory, record)/'character.json') if prop else {}
        image = None if record['status'] == 'complete' else self._image_reason(directory, record)
        resumable, reason = self._resume_reason(directory, record, task, image)
        status = record['status']
        if not alive and status in ('accepted', 'running'):
            status = 'paused' if resumable else 'blocked'
        return {**{key: record.get(key) for key in ('id', 'request_key', 'kind', 'category', 'name', 'prompt',
                    'size', 'stage', 'created_at', 'gpu', 'reference_id', 'vector', 'rig', 'motions')}, 'status': status,
                'provider': (record.get('provider') or 'meshy') if prop else None,
                'model_attempts': record.get('model_attempts', []) if prop else None,
                'can_resume': bool(resumable and (not alive or status == 'accepted')),
                'can_change_provider': bool(prop and status in ('paused', 'blocked') and image and image[0]
                                            and self._model_unstarted(directory)),
                'error': record.get('error') or (reason if not alive else None),
                'task_id': task.get('task_id'), 'progress': task.get('progress'),
                'artifacts': [{'name': name, 'sha256': sha, 'url': f'/api/studio/generations/{job_id}/artifacts/{name}'}
                              for name, sha in record['files'].items()]}

    def create(self, key, payload):
        require_request_key(key)
        payload = dict(payload)
        # The 3D provider is how the job runs, not what it makes: it stays out of the fingerprint, so a replay
        # naming another provider gets the saved job with the provider it was accepted with.
        requested = payload.pop('provider', None)
        if payload.get('reference_id') is None:
            payload.pop('reference_id', None)
        if payload['kind'] not in DEFAULTS or payload['category'] not in DEFAULTS[payload['kind']]:
            raise PipelineError('invalid_category', '기물·재질 종류를 다시 선택하세요.', 422)
        if payload['kind'] != 'prop' and requested is not None:
            raise PipelineError('invalid_provider', '3D 생성 제공자는 기물 생성에서만 고릅니다.', 422)
        if payload['kind'] == 'illustration' and payload.get('size') != 1024:
            raise PipelineError('invalid_size', '2D 원화는 1024px로 생성합니다.', 422)
        if payload['kind'] != 'illustration' and 'reference_id' in payload:
            raise PipelineError('invalid_reference', '기준 원화는 2D 원화 생성에서만 사용할 수 있습니다.', 422)
        if not 1 <= len(payload['name'].strip()) <= 80 or not 1 <= len(payload['prompt'].strip()) <= 8000:
            raise PipelineError('invalid_prompt', '이름과 프롬프트를 입력하세요.', 422)
        job_id = request_job_id(self.owner, 'studio', key)
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        directory = self.directory(job_id)
        with _LOCK:
            previous = read_json(directory/'record.json')
            if previous:
                if previous['fingerprint'] != fingerprint:
                    raise PipelineError('idempotency_conflict', '같은 요청의 입력이 변경됐습니다.', 409)
                return self.get(job_id), previous['status'] == 'accepted'
            if not self.capabilities(payload['kind'])['ready']:
                raise PipelineError('provider_unavailable', 'S3·이미지·3D 생성 서비스 연결을 확인하세요.', 503)
            provider = self._provider_ready(requested) if payload['kind'] == 'prop' else None
            directory.mkdir(parents=True, exist_ok=True)
            reference = None
            if payload['kind'] == 'illustration' and payload.get('reference_id'):
                parent = self._record(payload['reference_id'])
                if parent.get('kind') != 'illustration' or parent.get('status') != 'complete':
                    raise PipelineError('invalid_reference', '완료된 2D 원화만 기준으로 선택할 수 있습니다.', 422)
                parent_image = self.artifact(payload['reference_id'], 'image.png')
                parent_sha256 = parent['files']['image.png']
                frozen = directory/'reference.png'
                copy_file(parent_image, frozen)
                if digest(frozen) != parent_sha256:
                    raise PipelineError('reference_changed', '기준 원화 이미지가 변경되었습니다.', 409)
                reference = {'id': payload['reference_id'], 'file': 'reference.png', 'sha256': parent_sha256}
            provider_prompt = (self._illustration_prompt(payload['prompt'], bool(reference))
                               if payload['kind'] == 'illustration' else None)
            record = {**payload, 'id': job_id, 'request_key': key, 'fingerprint': fingerprint,
                      'status': 'accepted', 'stage': 'image',
                      'files': {'reference.png': reference['sha256']} if reference else {},
                      'reference': reference, 'process': identity(),
                      'created_at': now(), 'error': None,
                      'image_model': os.getenv('AVATAR_IMAGE_MODEL', DEFAULT_MODEL),
                      'image_base': os.getenv('OPENAI_API_BASE', DEFAULT_BASE).rstrip('/'),
                      'meshy_base': base_url('meshy')}
            if provider:
                record['provider'] = provider
                if provider == 'tripo':
                    record['tripo_base'] = base_url('tripo')
            if provider_prompt is not None:
                record.update(provider_prompt=provider_prompt,
                              provider_prompt_sha256=hashlib.sha256(provider_prompt.encode()).hexdigest(),
                              prompt_revision=ILLUSTRATION_PROMPT_REVISION)
            _write_json(directory/'record.json', record)
        return self.get(job_id), True

    def resume(self, job_id, provider=None):
        """Continue a paused job. A named provider that differs from the frozen one, or a job blocked by a
        refused 3D request, sends the 3D step (only) to that provider again."""
        with _LOCK:
            public = self.get(job_id)
            if (provider is not None and public['status'] != 'complete'
                    and (provider != public['provider'] or not public['can_resume'])):
                self._change_provider(job_id, public, provider)
                public = self.get(job_id)
            if not public['can_resume']:
                return public, False
            record = self._record(job_id)
            record.update(status='accepted', process=identity(), error=None)
            self._save(self.directory(job_id), record)
        return self.get(job_id), True

    @staticmethod
    def _provider_ready(requested):
        provider = resolve_provider(requested)
        if not provider_keys()[provider]:
            raise PipelineError('provider_unavailable', f'{LABELS[provider]} API 설정이 필요합니다.', 503)
        return provider

    def _change_provider(self, job_id, public, provider):
        """Callers hold _LOCK. Earlier refused attempts stay as receipts; the image is never requested again."""
        if public['kind'] != 'prop':
            raise PipelineError('invalid_provider', '3D 생성 제공자는 기물 생성에서만 고릅니다.', 422)
        directory = self.directory(job_id)
        if not public['can_change_provider']:
            started = not self._model_unstarted(directory)
            raise PipelineError('provider_locked', '3D 작업이 접수됐거나 접수 여부를 확인하지 못해 다시 요청할 수 없습니다.'
                                if started else public['error'] or '진행 중인 작업은 제공자를 바꿀 수 없습니다.', 409)
        provider = self._provider_ready(provider)
        record = self._record(job_id)
        previous = self._run(directory, record); task = read_json(previous/'character.json')
        if task:
            problem = model_problem(task, previous) or {}
            record.setdefault('model_attempts', []).append(
                {'provider': record.get('provider') or 'meshy', 'status': task.get('status'),
                 'http_status': task.get('http_status'), 'provider_code': problem.get('provider_code'), 'at': now()})
        run = directory/provider
        if read_json(run/'character.json'):
            character_jobs.archive_attempt(run, 'provider_retry')
        record['provider'] = provider
        if provider == 'tripo':
            record['tripo_base'] = base_url('tripo')
        self._save(directory, record)

    @staticmethod
    def _save(directory, record):
        record['updated_at'] = now()
        _write_json(directory/'record.json', record)

    @staticmethod
    def _illustration_prompt(editable, has_reference):
        identity = (
            'The reference image is authoritative for character identity. Preserve the original face, eye shape, '
            'eye proportions, iris colors, highlights, line weight, hairstyle, outfit, palette, and silhouette. '
            if has_reference else ''
        )
        return (
            'ILLUSTRATION CONTRACT illustration-character-v1. Create one polished 2D character illustration, not '
            'a 3D render, model sheet, texture atlas, sprite sheet, collage, or photograph. Show exactly one complete '
            'character, full body from head to feet, centered with margin, on a transparent background. The default '
            'facial expression is neutral: eyes open and a small natural mouth. Do not add a smile, crying, anger, '
            'surprise, closed eyes, or any exaggerated expression unless the editable prompt explicitly requests it. '
            + identity +
            'Do not add text, captions, borders, scenery, floor, cast shadows, extra people, duplicate bodies, or '
            'cropped limbs. Do not invent a drawing style or eye design in code; follow only the editable prompt and '
            'the reference when present. Preserve the editable prompt verbatim as the requested art direction.\n'
            f'EDITABLE PROMPT:\n{editable}'
        )

    def execute(self, job_id):
        directory = self.directory(job_id)
        if not _WORKERS.acquire(str(directory)):
            return
        try:
            record = self._record(job_id)
            if record['status'] != 'accepted':
                return
            record.update(status='running', process=identity(), error=None)
            self._save(directory, record)
            try:
                image = directory/'image.png'
                if 'image.png' not in record['files']:
                    if record['kind'] == 'illustration':
                        provider_prompt = record.get('provider_prompt')
                        if (not isinstance(provider_prompt, str) or not provider_prompt
                                or hashlib.sha256(provider_prompt.encode()).hexdigest()
                                != record.get('provider_prompt_sha256')):
                            raise PipelineError('prompt_contract_missing', '저장된 원화 생성 프롬프트를 확인할 수 없습니다.', 409)
                        reference = record.get('reference')
                        if reference:
                            frozen = directory/'reference.png'
                            if digest(frozen) != reference.get('sha256'):
                                raise PipelineError('reference_changed', '기준 원화 이미지가 변경되었습니다.', 409)
                            raw = generate_standard_part_image(
                                [frozen], provider_prompt, record['image_model'], record['image_base'],
                                receipt=directory/'image-provider.json', canvas_size=(1024, 1024))
                        else:
                            raw = generate_image(provider_prompt, record['image_model'], record['image_base'],
                                                 receipt=directory/'image-provider.json', background='transparent')
                    else:
                        raw = generate_image(record['prompt'], record['image_model'], record['image_base'],
                                             receipt=directory/'image-provider.json')
                    image.write_bytes(raw)
                    record['files']['image.png'] = digest(image)
                    self._save(directory, record)
                elif digest(image) != record['files']['image.png']:
                    raise PipelineError('image_changed', '저장된 이미지가 변경되었습니다.', 409)
                if record['kind'] == 'texture':
                    record['stage'] = 'material'; self._save(directory, record)
                    files, gpu = texture_maps(image, directory, record['size'])
                    record['files'].update(files); record['gpu'] = gpu
                elif record['kind'] == 'prop':
                    record['stage'] = 'model'; self._save(directory, record)
                    self._model(directory, record, image)
                record.update(status='complete', stage='complete', error=None)
                self._save(directory, record)
            except Exception as exc:
                resumable, reason = self._resume_reason(directory, record)
                if isinstance(exc, OpenAIImageHTTPError):
                    message = image_error_message(exc.category, exc.response.status_code)
                elif isinstance(exc, PipelineError):
                    message = exc.message
                elif isinstance(exc, httpx.HTTPError):
                    message = '생성 서비스 연결이 중단됐습니다. 저장된 요청과 파일로 이어갈 수 있는지 확인하세요.'
                else:
                    message = '산출물 저장·변환이 중단됐습니다. 수신한 이미지와 모델은 유지됩니다.'
                record.update(status='paused' if resumable else 'blocked', error=reason or message,
                              error_type=type(exc).__name__)
                final_write(lambda: self._save(directory, record), 'generation record')
        finally:
            _WORKERS.release(str(directory))

    def _model(self, directory, record, image):
        provider = record.get('provider') or 'meshy'; run = self._run(directory, record)
        with provider_client(provider, record) as client:
            task = read_json(run/'character.json')
            if not task:
                # The receipt is written before the POST; an existing one is only refreshed, never sent again.
                if provider == 'tripo':
                    link = provider_image(image, image.read_bytes(), 'image/png')
                    if not link:
                        raise PipelineError('storage_required', 'Tripo 3D 생성에는 S3 저장소의 이미지 주소가 필요합니다.', 503)
                    task = character_jobs.generate_tripo_image(run, image, link['url'], client,
                                                               face_limit=PROP_FACE_LIMIT)
                else:
                    task = character_jobs.generate(run, image, 1.2, client, isolated_part=True)
            deadline = time.monotonic()+1200
            while task.get('status') != 'SUCCEEDED':
                problem = model_problem(task, run)
                if problem:
                    raise PipelineError(problem['code'], problem['message'], 409)
                if time.monotonic() >= deadline:
                    raise PipelineError('provider_wait', '3D 작업이 진행 중입니다. 저장된 작업에서 이어서 확인하세요.', 409)
                task = character_jobs.refresh(run, client)
                if task['status'] != 'SUCCEEDED':
                    time.sleep(5)
        saved = read_json(run/'generation-artifacts.json')
        if not saved or not (run/'generated.glb').is_file() or digest(run/'generated.glb') != saved.get('generated', {}).get('sha256'):
            character_jobs.download(run, 'generation')
        copy_file(run/'generated.glb', directory/'source.glb')
        record['files']['source.glb'] = digest(directory/'source.glb')
        self._save(directory, record)
        record['gpu'] = prop_model(run/'generated.glb', directory/'model.glb', record['size'])
        if provider == 'tripo':
            record['gpu']['requested_target_polygons'] = task.get('generation_settings', {}).get('face_limit')
        record['files']['model.glb'] = digest(directory/'model.glb')

    def _local_work(self, job_id):
        """The generation's worker lock, for local steps that must not overlap on one illustration; call the result to
        give it back."""
        key = str(self.directory(job_id))
        if not _WORKERS.acquire(key):
            raise PipelineError('illustration_busy', '이 원화의 다른 작업을 처리하는 중입니다. 잠시 후 다시 불러오세요.', 409)
        return lambda: _WORKERS.release(key)

    def _finished_illustration(self, job_id, action):
        record = self._record(job_id)
        if record.get('kind') != 'illustration' or record.get('status') != 'complete':
            raise PipelineError('invalid_illustration', f'완료된 2D 원화만 {action}할 수 있습니다.', 422)
        return record

    def _publish(self, job_id, files, update):
        """Write files, then record their hashes and `update` in one record save."""
        directory = self.directory(job_id)
        for name, content in files.items():
            (directory/name).write_bytes(content)
        with _LOCK:
            record = self._record(job_id)
            for name in files:
                record['files'][name] = digest(directory/name)
            update(record)
            self._save(directory, record)

    def rig(self, job_id, joints=None, revision=None):
        """Save the 2D rig of a finished illustration: proposed joints when none are given."""
        release = self._local_work(job_id)
        try:
            record = self._finished_illustration(job_id, '리깅')
            saved = record.get('rig') or {}
            if revision is not None and saved.get('sha256') != revision:
                raise PipelineError('rig_changed', '관절이 다른 곳에서 바뀌었습니다. 다시 불러온 뒤 저장하세요.', 409)
            source_sha256 = record['files']['image.png']
            rig, preview = build_rig(self.artifact(job_id, 'image.png').read_bytes(), joints)
            rig['source_sha256'] = source_sha256
            content = json.dumps(rig, sort_keys=True, ensure_ascii=False).encode()
            sha256 = hashlib.sha256(content).hexdigest()
            if saved.get('sha256') == sha256 and 'rig.json' in record['files']:
                return self.get(job_id)
            summary = {key: rig[key] for key in ('revision', 'skeleton', 'joints', 'proposed', 'adjusted',
                                                 'width', 'height', 'vertices', 'triangles', 'source_sha256')}
            self._publish(job_id, {'rig.json': content, 'rig-regions.png': preview},
                          lambda current: current.update(rig={**summary, 'sha256': sha256, 'created_at': now()}))
            return self.get(job_id)
        finally:
            release()

    def motion(self, job_id, template, strength, speed, fps, size):
        """Render one looping motion of a rigged illustration as GIF, animated WebP and APNG."""
        release = self._local_work(job_id)
        try:
            record = self._finished_illustration(job_id, '모션으로')
            rig = record.get('rig')
            if not rig or 'rig.json' not in record['files']:
                raise PipelineError('rig_required', '먼저 관절을 저장하세요.', 409)
            if rig.get('source_sha256') != record['files']['image.png']:
                raise PipelineError('rig_stale', '원화가 바뀌었습니다. 관절을 다시 저장하세요.', 409)
            params = {'template': template, 'strength': round(float(strength), 2), 'speed': round(float(speed), 2),
                      'fps': fps, 'size': size, 'rig_sha256': rig['sha256'], 'revision': MOTION_REVISION}
            names = {fmt: f'motion-{template}.{extension}' for fmt, extension in FORMATS.items()}
            saved = (record.get('motions') or {}).get(template) or {}
            if all(saved.get(key) == value for key, value in params.items()) \
                    and all(name in record['files'] for name in names.values()):
                return self.get(job_id)
            joints = json.loads(self.artifact(job_id, 'rig.json').read_bytes())['joints']
            png = self.artifact(job_id, 'image.png').read_bytes()
            frames = render_frames(png, joints, template, params['strength'], params['speed'], fps, size)
            encoded = encode(frames, fps)
            entry = {**params, 'frames': len(frames), 'duration_ms': int(round(1000 / fps)) * len(frames),
                     'files': names, 'bytes': {fmt: len(content) for fmt, content in encoded.items()}, 'created_at': now()}
            self._publish(job_id, {names[fmt]: content for fmt, content in encoded.items()},
                          lambda current: current.setdefault('motions', {}).update({template: entry}))
            return self.get(job_id)
        finally:
            release()

    def vectorize(self, job_id, colors):
        """Trace a finished illustration into `image.svg`; local, free and deterministic per colour count."""
        release = self._local_work(job_id)
        try:
            record = self._finished_illustration(job_id, 'SVG로 변환')
            source_sha256 = record['files']['image.png']
            saved = record.get('vector') or {}
            if ('image.svg' in record['files'] and saved.get('colors') == colors
                    and saved.get('revision') == VECTOR_REVISION and saved.get('source_sha256') == source_sha256):
                return self.get(job_id)
            svg, stats = trace_illustration(self.artifact(job_id, 'image.png').read_bytes(), colors)
            vector = {**stats, 'revision': VECTOR_REVISION, 'source_sha256': source_sha256, 'created_at': now()}
            self._publish(job_id, {'image.svg': svg.encode()}, lambda current: current.update(vector=vector))
            return self.get(job_id)
        finally:
            release()

    def artifact(self, job_id, name):
        record = self._record(job_id)
        expected = record['files'].get(name)
        path = self.directory(job_id)/name
        if not expected or digest(path) != expected:
            raise PipelineError('not_found', '저장된 산출물을 찾을 수 없습니다.', 404)
        return path

    def illustration_selection(self):
        state = read_json(self.root/'illustration-selection.json') or {'selected': None, 'revision': '0'}
        selected = state.get('selected')
        if selected is not None:
            record = self._record(selected)
            if record.get('kind') != 'illustration' or record.get('status') != 'complete':
                raise PipelineError('selection_changed', '선택한 기준 원화를 확인할 수 없습니다.', 409)
            self.artifact(selected, 'image.png')
        return {'selected': selected, 'revision': state.get('revision', '0')}

    def select_illustration(self, generation_id, revision):
        require_bucket()
        if generation_id is not None:
            record = self._record(generation_id)
            if record.get('kind') != 'illustration' or record.get('status') != 'complete':
                raise PipelineError('invalid_selection', '완료된 2D 원화만 기준으로 선택할 수 있습니다.', 422)
            self.artifact(generation_id, 'image.png')
        path = self.root/'illustration-selection.json'
        with _LOCK:
            current = read_json(path) or {'selected': None, 'revision': '0'}
            if current.get('selected') == generation_id:
                return {'selected': generation_id, 'revision': current.get('revision', '0')}
            if current.get('revision', '0') != revision:
                raise PipelineError('revision_conflict', '기준 원화 선택이 변경되었습니다. 다시 불러오세요.', 409)
            next_revision = hashlib.sha256(
                f'{self.owner}:{current.get("revision", "0")}:{generation_id}'.encode()).hexdigest()
            result = {'selected': generation_id, 'revision': next_revision}
            self.root.mkdir(parents=True, exist_ok=True)
            _write_json(path, result)
            return result
