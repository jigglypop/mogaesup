"""Regenerate an animal: redraw chosen turnaround views, rebuild the 3D model, refit the standard rig.

Steps run in order and each keeps its own receipts: a view image is never re-requested once saved or
while its acceptance is uncertain, and a Meshy task is recovered by its task ID, never resubmitted.
Every step publishes its files content-addressed and then switches the record in one update, so a
step stopped anywhere leaves the record vouching only for complete files and can simply run again.
"""
import hashlib
import io
import json
import logging
import os
import subprocess
import time
import uuid

from PIL import Image

from src.services import character_jobs
from src.services.animal_library import AnimalLibrary
from src.services.asset_delivery import inspect_glb
from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, _QUEUE, digest
from src.services.avatar_openai_images import DEFAULT_BASE, DEFAULT_MODEL, generate_standard_part_image, saved_response
from src.services.character_parts import blender_executable, blender_process, stop_process
from src.services.character_pipeline import PipelineError, now, read_json, request_job_id, require_bucket, valid_request_key
from src.services.model_providers import client as provider_client
from src.services.object_storage import StoredPath as Path, local_workspace, provider_image
from src.services.process_identity import identity, state as process_state
from src.services.run_lock import WorkerLocks, final_write, worker_alive

LOGGER = logging.getLogger(__name__)
VIEWS = ('front', 'left', 'back', 'right')
CANVAS = 1024
PAWS_Y = round(CANVAS * .93)
MAX_HEIGHT, MAX_WIDTH = round(CANVAS * .84), round(CANVAS * .92)
# Figure heights within this many pixels already share one scale (alpha edges move by a pixel on resize).
SCALE_TOLERANCE = 2
# The face is painted on the front of the head only. A side view that turns it toward the camera puts a
# second face on the side of the head, and the 3D model fuses the views into extra eyes and mouths.
PROFILE = ('The camera is exactly perpendicular to the spine: a true 90-degree profile, not a three-quarter view. '
           'The head points straight along the body, not turned toward the camera. The face is on the front of the '
           'head, so it is seen edge-on: the nose and mouth appear only once, on the front silhouette edge, the near '
           'eye is small and right behind that edge, and the far eye is hidden. The side of the head shows only '
           'cheek, fur, ear or hood; never paint a whole face (eyes, mouth, blush) on the side of the head. The '
           'far-side legs are mostly hidden behind the near-side legs.')
CAMERA = {
    'front': 'Exact orthographic FRONT view: camera straight in front of the animal, at body height. It faces the '
             'viewer squarely, head and body not turned, left and right symmetric. Its own left side appears on '
             'IMAGE-RIGHT. Both eyes, the nose and the mouth appear once, centred on the front of the head.',
    'left': "Exact orthographic LEFT side profile: camera at the animal's own LEFT side, at body height. The nose "
            f'points IMAGE-LEFT, the tail points IMAGE-RIGHT. Only its left eye is visible. {PROFILE}',
    'back': "Exact orthographic BACK view: camera straight behind the animal, at body height. Its own left side "
            'appears on IMAGE-LEFT. Show the back of the head or hood, the back, the rear legs and the tail; no eye, '
            'nose, mouth or other face detail is visible.',
    'right': "Exact orthographic RIGHT side profile: camera at the animal's own RIGHT side, at body height. The nose "
             f'points IMAGE-RIGHT, the tail points IMAGE-LEFT. Only its right eye is visible. {PROFILE} Rotate the '
             'same model; never mirror the left view: one-sided details (bags, bows, flowers, markings) stay on '
             'their true side and are hidden when on the far side.',
}
# No pose_mode: a quadruped is generated in its four-legged stance, never a humanoid T/A-pose.
MESHY_OPTIONS = {'ai_model': 'meshy-7', 'should_texture': True, 'enable_pbr': True, 'should_remesh': True,
                 'topology': 'triangle', 'target_polycount': 30000, 'texture_resolution': '2k',
                 'image_enhancement': False, 'remove_lighting': True, 'target_formats': ['glb']}
MESHY_TIMEOUT = 1800
MESHY_UNCHECKED = 'Meshy 작업 상태를 확인하지 못했습니다. 같은 요청으로 이어서 확인할 수 있습니다.'
RIG_TIMEOUT = 1200
# Every rig and motion file made from a model; a new model makes all of them stale.
RIG_FILES = ('rigged.glb', 'walk.glb', 'motions-standard.glb', 'standard.json')
CLIPS = ('walk', 'run', 'idle', 'bark', 'sit', 'lie', 'jump')
RIG_FAILED = '표준 골격을 씌우지 못했습니다.'
RIG_ERRORS = {'mesh_missing': '3D 모델에서 메시를 찾지 못했습니다.', 'mesh_degenerate': '3D 모델의 크기를 읽지 못했습니다.',
              'paws_not_found': '네 발의 위치를 찾지 못했습니다.', 'head_not_found': '머리 위치를 찾지 못했습니다.'}
LEGS = {'fore_L': '왼쪽 앞다리', 'fore_R': '오른쪽 앞다리', 'hind_L': '왼쪽 뒷다리', 'hind_R': '오른쪽 뒷다리'}
# Jobs whose worker runs in this process, by job directory.
_JOBS = WorkerLocks()


class StepPaused(Exception):
    """The step can continue later from its saved receipts."""


class StepBlocked(Exception):
    """A paid request's acceptance is uncertain; nothing is sent again automatically."""


def view_prompt(design, view, earlier, note):
    roles = ['Image 1: original character art (appearance reference only; ignore its pose, held items, name label '
             'and background).']
    roles += [f'Image {index + 2}: ACCEPTED {name.upper()} VIEW of the same model. Match its design exactly, but '
              'not its camera angle.' for index, name in enumerate(earlier)]
    worn, held = design.get('worn'), design.get('held')
    parts = [
        'Turnaround view for 3D modeling of ONE cute chibi animal character.', *roles,
        'Keep the identity exactly: the same face, fur colours, markings, ear shape, costume and worn accessories'
        + (f': {worn}.' if worn else '.') + ' Eyes open with the same happy expression.',
        'Pose: standing on all four legs in a neutral stance: body horizontal, four short legs straight down and '
        'slightly apart, all four paws flat on the ground, clearly visible and separated, head level and pointing '
        'the same way as the body, tail visible. Keep the chibi proportions: large head, small round body, short '
        'legs.',
        (f'Remove the {held} it holds; nothing' if held else 'Nothing') + ' is held in the paws or mouth.',
        CAMERA[view],
        'Full body centred with margin, nothing cropped. The paws rest on the same horizontal line and the model has '
        'the same size in every view. Transparent background, soft even lighting, no cast shadow, no ground, no added '
        'text, no name label, no background decorations. Same soft plush illustration style as the original, with a '
        'clean, readable silhouette.',
    ]
    if note:
        parts.append(f'Correction requested for this view: {note}')
    return ' '.join(parts)


def _figure(content):
    image = Image.open(io.BytesIO(content)).convert('RGBA')
    box = image.getchannel('A').point(lambda v: 255 if v > 64 else 0).getbbox()
    if not box:
        raise PipelineError('image_empty', '빈 면 이미지가 반환됐습니다. 이 면을 다시 그려 주세요.', 422)
    return image.crop(box)


def fit_height(figure):
    """The largest figure height that keeps this view inside the canvas margins."""
    return min(MAX_HEIGHT, MAX_WIDTH * figure.height / figure.width)


def common_height(figures, kept=(), anchor=None):
    """One figure height for every view: an animal has the same height seen from any side.

    It never exceeds what the widest view allows, and never enlarges a kept view: kept views stay at
    their saved height (`anchor`) while they all still match it, else at the smallest of them.
    """
    limit = min(fit_height(figure) for figure in figures.values())
    heights = [figures[view].height for view in kept]
    if heights:
        same = type(anchor) is int and all(abs(height - anchor) <= SCALE_TOLERANCE for height in heights)
        limit = min(limit, anchor if same else min(heights))
    return max(1, int(limit))


def align_view(content, height):
    """The figure at `height` (the common height of every view), paws on one line, centred on a square canvas."""
    figure = _figure(content)
    height = min(height, fit_height(figure))
    resized = figure.resize((max(1, round(figure.width * height / figure.height)), max(1, round(height))),
                            Image.Resampling.LANCZOS)
    canvas = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(resized, ((CANVAS - resized.width) // 2, PAWS_Y - resized.height))
    output = io.BytesIO()
    canvas.save(output, format='PNG')
    return output.getvalue()


def _sha(content):
    return hashlib.sha256(content).hexdigest()


class AnimalProduction:
    def __init__(self, factory, owner):
        self.factory, self.owner = factory, owner
        self.library = AnimalLibrary(factory, owner)

    def _jobs(self, animal_id):
        return self.library.directory(animal_id)/'jobs'

    def start(self, animal_id, key, payload):
        if not isinstance(key, str) or not valid_request_key(key):
            raise PipelineError('invalid_key', '요청 식별자가 필요합니다.', 422)
        views = [view for view in VIEWS if view in payload.get('views', [])]
        # Redrawn views make the model stale, and a new model makes the rig stale.
        model = bool(views) or bool(payload.get('model'))
        rig = model or bool(payload.get('rig'))
        steps = (['views'] if views else []) + (['model'] if model else []) + (['rig'] if rig else [])
        if not steps:
            raise PipelineError('nothing_requested', '다시 만들 단계를 고르세요.', 422)
        note = (payload.get('note') or '').strip()
        if len(note) > 400:
            raise PipelineError('invalid_note', '수정 요청은 400자 이내로 입력하세요.', 422)
        require_bucket()
        if views and not os.getenv('OPENAI_API_KEY', '').strip():
            raise PipelineError('image_provider_unavailable', 'OpenAI 이미지 생성 키가 필요합니다.', 422)
        if model and not os.getenv('MESHY_API_KEY', '').strip():
            raise PipelineError('provider_unavailable', 'Meshy API 설정이 필요합니다.', 422)
        if not blender_executable():
            raise PipelineError('blender_unavailable', 'Blender 연결이 필요합니다.', 503)
        request = {'views': views, 'note': note, 'steps': steps}
        job_id = request_job_id(self.owner, f'animal-job:{animal_id}', key)
        directory = self.library.directory(animal_id)
        with _LOCK:
            record = read_json(directory/'record.json')
            if not record:
                raise PipelineError('not_found', '동물을 찾을 수 없습니다.', 404)
            job_path = self._jobs(animal_id)/job_id/'job.json'
            held = _JOBS.busy(str(job_path.parent))
            job = read_json(job_path)
            if job:
                if job['request'] != request:
                    raise PipelineError('idempotency_conflict', '같은 요청에 다른 설정이 있습니다.', 409)
                paused = job['status'] == 'paused' or (job['status'] in ('accepted', 'running')
                                                       and not worker_alive(job, held or _JOBS.busy(str(job_path.parent))))
                if paused and record.get('production') != job_id:
                    raise PipelineError('job_replaced', '이 작업은 새 요청으로 대체됐습니다.', 409)
                if paused:
                    job.update(status='accepted', process=identity(), updated_at=now())
                    _write_json(job_path, job)
                return self.library.get(animal_id), paused
            current = record.get('production')
            if current:
                work = self._jobs(animal_id)/current
                held = _JOBS.busy(str(work))
                active = read_json(work/'job.json')
                # Only a job whose worker still runs blocks a new request; a stopped one is replaced.
                if worker_alive(active, held or _JOBS.busy(str(work))):
                    raise PipelineError('animal_busy', '진행 중인 작업이 끝난 뒤 요청하세요.', 409)
            self._require_inputs(record, views, model, rig)
            _write_json(job_path, {'id': job_id, 'request_key': key, 'request': request, 'steps': steps, 'done': [],
                                   'status': 'accepted', 'step': None, 'process': identity(), 'error': None,
                                   'created_at': now(), 'updated_at': now()})
            record.update(production=job_id, updated_at=now())
            _write_json(directory/'record.json', record)
        return self.library.get(animal_id), True

    @staticmethod
    def _require_inputs(record, views, model, rig):
        """Refuse a request whose paid steps could not finish with the files the animal has."""
        files = record.get('files') if isinstance(record.get('files'), dict) else {}
        if views and 'reference.png' not in files:
            raise PipelineError('reference_required', '원본 그림이 필요합니다.', 422)
        if model and any(view not in views and f'{view}.png' not in files for view in VIEWS):
            raise PipelineError('views_required', '네 면 이미지가 모두 필요합니다. 없는 면을 함께 다시 그려 주세요.', 422)
        if rig and not model and 'model.glb' not in files:
            raise PipelineError('model_required', '3D 모델이 필요합니다.', 422)

    def execute(self, animal_id, job_id):
        job_path = self._jobs(animal_id)/job_id/'job.json'
        if not _JOBS.acquire(str(job_path.parent)):
            return
        try:
            self._execute(job_id, animal_id, job_path)
        finally:
            _JOBS.release(str(job_path.parent))

    def _execute(self, job_id, animal_id, job_path):
        job = read_json(job_path)
        if job.get('status') != 'accepted':
            return
        job.update(status='running', process=identity(), error=None, updated_at=now())
        _write_json(job_path, job)
        try:
            for step in job['steps']:
                if step in job['done']:
                    continue
                job.update(step=step, updated_at=now())
                _write_json(job_path, job)
                getattr(self, f'_{step}')(animal_id, job_path.parent, job)
                job['done'].append(step)
                _write_json(job_path, job)
            job.update(status='complete', step=None, error=None)
        except StepPaused as reason:
            job.update(status='paused', error=str(reason))
        except StepBlocked as reason:
            job.update(status='blocked', error=str(reason))
        except PipelineError as reason:
            job.update(status='failed', error=reason.message)
        except Exception:
            # Paid requests are guarded by their own receipts, so running the same job again is safe.
            LOGGER.exception('Animal job %s stopped at %s', job_id, job.get('step'))
            job.update(status='paused', error='처리 중 중단됐습니다. 같은 요청으로 이어서 실행할 수 있습니다.')
        job['updated_at'] = now()
        final_write(lambda: _write_json(job_path, job), 'animal job')

    def _update_record(self, animal_id, change):
        directory = self.library.directory(animal_id)
        with _LOCK:
            record = read_json(directory/'record.json')
            if not record:
                raise PipelineError('not_found', '동물을 찾을 수 없습니다.', 404)
            for field in ('files', 'stages'):
                if not isinstance(record.get(field), dict):
                    record[field] = {}
            change(record)
            record['updated_at'] = now()
            _write_json(directory/'record.json', record)

    def _publish(self, animal_id, work, contents, change=None):
        """Store each file under its digest, then switch the record to all of them (and `change`) at once.

        Nothing the record vouches for is overwritten, so a stop before the switch leaves the previous
        version current and complete; running the step again stores the same bytes and switches.
        """
        digests = {}
        for name, content in contents.items():
            sha = digests[name] = _sha(content)
            blob = self.library.blob(animal_id, name, sha)
            if not (blob.is_file() and digest(blob) == sha):
                blob.parent.mkdir(parents=True, exist_ok=True)
                blob.write_bytes(content)
                if digest(blob) != sha:
                    raise StepPaused('파일 저장을 확인하지 못했습니다. 같은 요청으로 이어서 실행할 수 있습니다.')
        files = self.library.record(animal_id)['files']
        replaced = {name: files[name] for name, sha in digests.items() if files.get(name) not in (None, sha)}
        if replaced:
            # Keep what this job replaced first: the version to restore if its result is rejected.
            saved = read_json(work/'replaced.json')
            _write_json(work/'replaced.json', {**replaced, **saved})

        def switch(record):
            record['files'].update(digests)
            if change:
                change(record)
        self._update_record(animal_id, switch)

    # Views -----------------------------------------------------------------------------------------

    def _views(self, animal_id, work, job):
        record = self.library.record(animal_id)
        requested = job['request']['views']
        design = record.get('design') if isinstance(record.get('design'), dict) else {}
        # 1. One paid image per requested view. Each keeps its receipts, so a stop costs nothing extra.
        for view in VIEWS:
            if view in requested and not (work/f'{view}-raw.png').is_file():
                self._draw_view(animal_id, work, job, view, design, record)
        # 2. One scale for all views, fixed in a plan with the exact bytes to publish.
        plan = self._view_plan(animal_id, work, requested)
        contents = {}
        for view, sha in plan['views'].items():
            content = (work/f'{view}-aligned.png').read_bytes()
            if _sha(content) != sha:
                raise PipelineError('views_changed', '준비한 면 이미지가 변경되었습니다. 면을 다시 그려 주세요.', 409)
            contents[f'{view}.png'] = content

        # 3. All views switch together, so the model step never sees a mix of old and new views.
        def stage(record):
            record['stages']['views'] = {
                **(record['stages'].get('views') or {}), 'status': 'complete', 'provider': 'GPT Image',
                'images': sum(1 for view in VIEWS if f'{view}.png' in record['files']), 'redrawn': requested,
                'rescaled': plan['rescaled'], 'height': plan['height'], 'updated_at': now()}
        self._publish(animal_id, work, contents, stage)

    def _view_source(self, animal_id, work, requested, name, record):
        """This job's new image of an earlier view, or the saved one the record vouches for."""
        if name in requested:
            return work/f'{name}-raw.png'
        return self.library.file(animal_id, f'{name}.png', record)

    def _draw_view(self, animal_id, work, job, view, design, record):
        requested = job['request']['views']
        earlier = list(VIEWS[:VIEWS.index(view)])
        references = [self.library.file(animal_id, 'reference.png', record),
                      *(self._view_source(animal_id, work, requested, name, record) for name in earlier)]
        receipt = work/f'{view}-provider'
        prompt_path = work/f'{view}-prompt.json'
        saved = read_json(prompt_path)
        if saved:
            # A saved response is returned as it is (also one kept on this host when the store refused it); only a
            # new request must match the saved inputs.
            answered = saved_response(receipt)
            if not answered and saved.get('references') != [digest(path) for path in references]:
                raise StepBlocked('참조 이미지가 바뀌어 저장된 요청을 다시 보내지 않습니다.')
            text, model = saved['prompt'], saved.get('model') or DEFAULT_MODEL
        else:
            text = view_prompt(design, view, earlier, job['request']['note'])
            model = os.getenv('AVATAR_IMAGE_MODEL', DEFAULT_MODEL)
            _write_json(prompt_path, {'prompt': text, 'references': [digest(path) for path in references],
                                      'model': model})
        try:
            raw = generate_standard_part_image(references, text, model, os.getenv('OPENAI_API_BASE', DEFAULT_BASE).rstrip('/'),
                                               receipt=receipt, canvas_size=(CANVAS, CANVAS))
        except Exception as reason:
            raise self._image_failure(receipt, reason) from None
        _figure(raw)
        (work/f'{view}-raw.png').write_bytes(raw)

    @staticmethod
    def _image_failure(receipt, reason):
        """What a failed image call means for this job, judged by its receipts, never by guesswork."""
        if isinstance(reason, PipelineError) and reason.code == 'image_request_changed':
            return StepBlocked('저장된 이미지 요청과 입력이 달라 다시 보내지 않습니다.')
        if saved_response(receipt):
            # The paid answer is saved; a rejection of its content stays, a read failure can be retried.
            return reason if isinstance(reason, PipelineError) else StepPaused(
                '저장된 이미지 응답을 읽지 못했습니다. 같은 요청으로 이어서 실행할 수 있습니다.')
        if receipt.with_suffix('.error.json').is_file():
            return PipelineError('image_rejected', '이미지 요청이 거절됐습니다.', 422)
        request = read_json(receipt.with_suffix('.request.json'))
        if not request:
            # Nothing was sent: a configuration error stays as it is, anything else can be retried.
            return reason if isinstance(reason, PipelineError) else StepPaused(
                '이미지 요청을 보내기 전에 중단됐습니다. 같은 요청으로 이어서 실행할 수 있습니다.')
        if request.get('submission') == 'not_sent':
            return StepPaused('이미지 서버 연결 실패 · 같은 요청으로 이어서 실행할 수 있습니다.')
        return StepBlocked('이미지 요청의 접수 여부를 확인하지 못했습니다. 유료 요청을 다시 보내지 않습니다.')

    def _view_plan(self, animal_id, work, requested):
        """Fix the common scale and the aligned bytes once, so a resumed step publishes the same files."""
        plan_path = work/'views-plan.json'
        plan = read_json(plan_path)
        if plan:
            return plan
        record = self.library.record(animal_id)
        sources = {}
        for view in VIEWS:
            if view in requested:
                sources[view] = (work/f'{view}-raw.png').read_bytes()
            elif f'{view}.png' in record['files']:
                sources[view] = self.library.file(animal_id, f'{view}.png', record).read_bytes()
        figures = {view: _figure(content) for view, content in sources.items()}
        kept = [view for view in sources if view not in requested]
        anchor = (record['stages'].get('views') or {}).get('height')
        height = common_height(figures, kept, anchor)
        staged = {}
        for view, content in sources.items():
            if view in kept and abs(figures[view].height - height) <= SCALE_TOLERANCE:
                continue
            aligned = align_view(content, height)
            (work/f'{view}-aligned.png').write_bytes(aligned)
            staged[view] = _sha(aligned)
        plan = {'height': height, 'views': staged, 'rescaled': [view for view in staged if view in kept]}
        _write_json(plan_path, plan)
        return plan

    # Model -----------------------------------------------------------------------------------------

    def _model(self, animal_id, work, job):
        run = work/'meshy'
        refreshed = False
        with provider_client('meshy') as api:
            state = character_jobs.state(run) if (run/'character.json').is_file() else {}
            if state.get('status') in ('submission_not_sent', 'submission_rejected'):
                # Meshy never accepted this attempt, so a new submission cannot duplicate a task.
                character_jobs.archive_attempt(run, state['status'])
                state = {}
            if not state:
                state = self._submit_model(animal_id, run, api)
            if not state.get('task_id'):
                raise StepBlocked('Meshy 작업 번호가 없어 다시 제출하지 않습니다.')
            deadline = time.monotonic() + MESHY_TIMEOUT
            while state.get('status') != 'SUCCEEDED':
                status = state.get('status')
                if status in ('FAILED', 'CANCELED'):
                    character_jobs.archive_attempt(run, f'Meshy {status}')
                    raise PipelineError('model_failed', 'Meshy 3D 생성이 실패했습니다. 사용한 크레딧은 환불됩니다.', 422)
                if refreshed and status not in ('PENDING', 'IN_PROGRESS'):
                    raise StepPaused(MESHY_UNCHECKED)
                if time.monotonic() > deadline:
                    raise StepPaused('Meshy 작업이 아직 진행 중입니다. 같은 요청으로 이어서 확인할 수 있습니다.')
                if refreshed:
                    time.sleep(10)
                state = self._refresh(run, api)
                refreshed = True
            if not self._downloaded(run):
                if not refreshed:
                    # Saved download links may have expired while the job waited; a status read renews them.
                    state = self._refresh(run, api)
                    if state.get('status') != 'SUCCEEDED':
                        raise StepPaused(MESHY_UNCHECKED)
                try:
                    character_jobs.download(run, 'generation')
                except Exception:
                    raise StepPaused('3D 모델을 내려받지 못했습니다. 같은 요청으로 이어서 받을 수 있습니다.') from None
        content = (run/'generated.glb').read_bytes()
        if _sha(content) != (read_json(run/'generation-artifacts.json').get('generated') or {}).get('sha256'):
            raise StepPaused('3D 모델을 내려받지 못했습니다. 같은 요청으로 이어서 받을 수 있습니다.')
        result = read_json(run/'generation-result.json')
        quality = read_json(run/'generated-quality.json').get('metrics', {})

        def stage(record):
            # Rigs and motions made from the previous model leave with it, in the same record update.
            for name in RIG_FILES:
                record['files'].pop(name, None)
            record['stages'].update(rig=None, walk=None, standard=None, model={
                'status': 'complete', 'provider': 'Meshy', 'task_id': result.get('id'),
                'credits': result.get('consumed_credits'), 'triangles': quality.get('triangles'), 'updated_at': now()})
        self._publish(animal_id, work, {'model.glb': content}, stage)

    def _submit_model(self, animal_id, run, api):
        record = self.library.record(animal_id)
        try:
            images = [self.library.file(animal_id, f'{view}.png', record) for view in VIEWS]
        except PipelineError:
            raise PipelineError('views_required', '네 면 이미지가 모두 필요합니다.', 422) from None
        try:
            urls = []
            for path in images:
                remote = provider_image(path, path.read_bytes(), 'image/png')
                if not remote:
                    raise PipelineError('storage_required', 'S3 저장소 설정이 필요합니다.', 503)
                urls.append(remote['url'])
            return character_jobs.generate_multiview_part(run, images, api, isolated_part=False, height=.45,
                                                          expected_views=['front', 'side', 'back', 'opposite'],
                                                          generation_options=MESHY_OPTIONS, image_urls=urls)
        except PipelineError:
            raise
        except Exception:
            if not (run/'character.json').is_file():
                raise StepPaused('Meshy 요청을 보내기 전에 중단됐습니다. 같은 요청으로 이어서 실행할 수 있습니다.') from None
            state = character_jobs.state(run)
            if state.get('status') in ('submission_not_sent', 'submission_rejected'):
                character_jobs.archive_attempt(run, state['status'])
                raise StepPaused('Meshy 요청이 접수되지 않았습니다. 같은 요청으로 이어서 실행할 수 있습니다.') from None
            raise StepBlocked('Meshy 요청의 접수 여부를 확인하지 못했습니다. 다시 제출하지 않습니다.') from None

    @staticmethod
    def _refresh(run, api):
        """Read the saved task's status: a free GET that never submits anything."""
        try:
            return character_jobs.refresh(run, api)
        except Exception:
            raise StepPaused(MESHY_UNCHECKED) from None

    @staticmethod
    def _downloaded(run):
        saved = read_json(run/'generation-artifacts.json').get('generated') or {}
        glb = run/'generated.glb'
        return bool(saved.get('sha256')) and glb.is_file() and digest(glb) == saved['sha256']

    # Rig -------------------------------------------------------------------------------------------

    def _rig(self, animal_id, work, job):
        record = self.library.record(animal_id)
        try:
            model = self.library.file(animal_id, 'model.glb', record)
        except PipelineError:
            raise PipelineError('model_required', '3D 모델이 필요합니다.', 422) from None
        model_sha = record['files']['model.glb']
        run = work/'rig'
        # A new nonce per attempt: files left by an earlier attempt can never pass as this one's result.
        attempt = uuid.uuid4().hex
        with local_workspace(run, inputs=[model]), _QUEUE:
            runner = read_json(run/'runner.json')
            if runner and process_state(runner.get('process')) != 'exited':
                raise StepPaused('이전 Blender 작업이 아직 실행 중입니다. 끝난 뒤 같은 요청으로 이어서 실행할 수 있습니다.')
            _write_json(run/'input.json', {'source': str(model), 'output': str(run), 'attempt': attempt})
            command = [blender_executable(), '--background', '--factory-startup', '--disable-autoexec',
                       '--python-exit-code', '1', '--threads', '2', '--python',
                       str(Path(__file__).with_name('animal_standard_rig_blender.py')), '--', str(run/'input.json')]
            with blender_process(command, run/'blender.log', run/'runner.json', write_json=_write_json) as process:
                try:
                    code = process.wait(timeout=RIG_TIMEOUT)
                except subprocess.TimeoutExpired:
                    stop_process(process)
                    raise StepPaused('표준 골격 작업 시간이 초과됐습니다. 같은 요청으로 이어서 실행할 수 있습니다.') from None
        if code:
            raise PipelineError('rig_failed', self._rig_error(read_json(run/'error.json'), attempt), 422)
        report_bytes = (run/'standard.json').read_bytes() if (run/'standard.json').is_file() else b''
        try:
            report = json.loads(report_bytes) if report_bytes else {}
        except ValueError:
            report = {}
        if not isinstance(report, dict):
            report = {}
        sealed = report.get('files') if isinstance(report.get('files'), dict) else {}
        expected = sealed.get('motions-standard.glb')
        glb = run/'motions-standard.glb'
        if (report.get('attempt') != attempt or report.get('source_sha256') != model_sha or not expected
                or not glb.is_file()):
            raise PipelineError('rig_failed', '표준 골격 결과를 확인하지 못했습니다.', 422)
        content = glb.read_bytes()
        if _sha(content) != expected or inspect_glb(content, budget_warnings=True)['errors']:
            raise PipelineError('rig_failed', '표준 골격 결과를 확인하지 못했습니다.', 422)
        paws = report.get('paw_height_pct') if isinstance(report.get('paw_height_pct'), dict) else {}
        clips = [clip for clip in report.get('clips') or [] if isinstance(clip, str) and clip in CLIPS]

        def stage(record):
            if record['files'].get('model.glb') != model_sha:
                raise PipelineError('model_changed', '3D 모델이 바뀌어 표준 골격을 저장하지 않았습니다.', 409)
            record['stages']['standard'] = {
                'status': 'complete', 'provider': 'Blender', 'bones': report.get('bones'), 'clips': clips,
                'fps': report.get('fps'), 'paws': len(paws), 'model_sha256': model_sha,
                'grounded_paws': sum(1 for value in paws.values()
                                     if isinstance(value, dict) and (value.get('frames_on_ground(<2%)') or 0) >= 12),
                'updated_at': now()}
        self._publish(animal_id, work, {'motions-standard.glb': content, 'standard.json': report_bytes}, stage)

    @staticmethod
    def _rig_error(error, attempt):
        """A fixed message for a known Blender failure code; anything else stays generic."""
        if not isinstance(error, dict) or error.get('attempt') != attempt:
            return RIG_FAILED
        code = error.get('code')
        if code == 'leg_not_found' and error.get('leg') in LEGS:
            return f"{RIG_FAILED[:-1]} · {LEGS[error['leg']]}를 찾지 못했습니다."
        if code in RIG_ERRORS:
            return f'{RIG_FAILED[:-1]} · {RIG_ERRORS[code]}'
        return RIG_FAILED
