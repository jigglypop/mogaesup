"""Owner-scoped, resumable local avatar production. No provider submissions."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
import logging
import os
from src.services.object_storage import StoredPath as Path
import re
import time
from threading import RLock, Semaphore
import uuid

from src.services.asset_editor import _write_json
from src.services.character_pipeline import CharacterPipeline, PipelineError, read_json, now
from src.services.process_identity import state as process_state
from src.services.object_storage import changed_since, child_names, sha256

LOGGER = logging.getLogger(__name__)
# Concurrent Blender workers. Each one uses 1-2 CPU threads and about 1-2 GB of RAM.
_QUEUE = Semaphore(max(1, int(os.getenv('BLENDER_CONCURRENCY', '2') or 2)))
_LOCK = RLock()
_LISTING_REFRESH = ThreadPoolExecutor(max_workers=2, thread_name_prefix='avatar-listing')
_LISTING_READERS = ThreadPoolExecutor(max_workers=12, thread_name_prefix='avatar-listing-read')
# A settled job is re-read after this many seconds even without a local write (another process may own it).
SETTLED_RECORD_SECONDS = 60
PROFILE = {'id': 'maple-sd-v2', 'name': '메이플풍 SD 공통 몸 · 기본복', 'rig': 'gaesup-humanoid-v1',
           'bones': 23, 'height': 1.81, 'head_height': .74, 'head_ratio': 2.45,
           'body_origin': 'authored_clothed_template', 'base_outfit': 'bald_face_tshirt_shorts',
           'pose': 'A-pose', 'visual_approval': 'pending'}
IMAGE_PROFILE = {**PROFILE, 'id': 'maple-chibi-v3', 'name': '대두 SD · 짧은 팔다리 · 기본복',
                 'rig': 'gaesup-maple-v1', 'body_archetype': 'MAPLE_CHIBI_V1',
                 'height': 1.81, 'head_height': 1.14, 'head_ratio': 1.59}


def digest(path):
    return sha256(path)


class AvatarFactory:
    def __init__(self, root):
        self.data = Path(root).resolve(); self.root = self.data/'avatar-factory'
        self.pipeline = CharacterPipeline(self.data)
        self.instance = uuid.uuid4().hex
        self._listing_lock = RLock()
        self._listings = {}
        self._listing_pending = {}
        self._records = {}

    def directory(self, owner, job_id):
        if not re.fullmatch(r'[a-f0-9]{24}', job_id):
            raise PipelineError('not_found', '생산 작업을 찾을 수 없습니다.', 404)
        return self.root/str(int(owner))/job_id

    def get(self, owner, job_id):
        directory = self.directory(owner, job_id); job = read_json(directory/'job.json')
        if not job:
            raise PipelineError('not_found', '생산 작업을 찾을 수 없습니다.', 404)
        if job['status'] in ('pipeline_queued', 'pipeline_running') and job['executor'] != self.instance and process_state(job.get('executor_process')) == 'exited':
            # The last recorded activity dates the stop; detecting it late must not make it look recent.
            job.update(status='pipeline_paused', error='서버 재시작으로 중단됨',
                       interrupted={'stage': job.get('resume_stage', 'images'),
                                    'at': job.get('updated_at') or job.get('created_at'), 'detected_at': now()})
            _write_json(directory/'job.json', job)
            from src.services.avatar_auto_resume import schedule
            schedule(self, owner, job_id)
        if job.get('input_kind') == 'image' and job['status'] in ('pipeline_paused', 'failed', 'recovery_required'):
            job = self._settle_interrupted(owner, job_id) or job
        if job['status'] in ('accepted', 'running') and job.get('executor') != self.instance:
            # Only the removed local 23-bone factory wrote these statuses. Its Blender
            # worker and finalizer no longer exist, so a stopped run, finished or not,
            # is kept unchanged for inspection instead of being sealed by other rules.
            worker_state = process_state(read_json(directory/'output/runner.json').get('process'))
            if worker_state == 'exited' or (worker_state != 'running' and process_state(job.get('executor_process')) == 'exited'):
                finished = (directory/'output/worker-complete.json').exists()
                job.update(status='recovery_required', error=(
                    '이전 방식 조립 결과는 더 이상 확정하지 않습니다. 원본과 작업 파일을 보존했습니다. 새 버전으로 다시 생산해 주세요.'
                    if finished else
                    '서버가 중단된 생산 작업입니다. 원본과 중간 파일을 보존했습니다. 새 버전으로 다시 생산해 주세요.'))
                _write_json(directory/'job.json', job)
        public = {k: deepcopy(v) for k, v in job.items() if k not in ('executor', 'executor_process', 'fingerprint', 'files')}
        public['progress'] = read_json(directory/'output/progress.json', {'stage': 'queued', 'message': '로컬 생산 대기 중'})
        public['artifacts'] = [{'name': name, 'sha256': sha256,
                                'url': f'/api/avatar-factory/jobs/{job_id}/artifacts/{name}'}
                               for name, sha256 in job.get('files', {}).items()]
        public['next_actions'] = []
        if job.get('input_kind') == 'image' and job['status'] in ('pipeline_paused', 'failed', 'recovery_required'):
            state = read_json(directory/'pipeline.json')
            blocked = any(p['image']['status'] not in ('pending', 'received', 'succeeded') and
                          not (p['image']['status'] == 'submitting' and (directory/'output'/f'{p["slot"]}-provider.response.json').is_file())
                          for p in state.get('parts', []))
            if state.get('production_spec'):
                from src.services.avatar_multiview_images import can_resume
                blocked = not can_resume(directory, state)
            runner = read_json(directory/'output/runner.json')
            if job['status'] in ('failed', 'recovery_required') and runner and process_state(runner.get('process')) != 'exited':
                blocked = True
            rejected = None
            for p in state.get('parts', []):
                task = read_json(directory/'parts'/p['slot']/'character.json')
                blocked = blocked or bool(task and (not task.get('task_id') or task.get('status') in ('FAILED', 'CANCELED')))
                if task.get('status') == 'submission_rejected' and task.get('http_status'):
                    response = read_json(directory/'parts'/p['slot']/f'{task.get("stage", "generation")}-submission-response.json')
                    rejected = (task['http_status'], task.get('provider', 'meshy'), response.get('body') or '')
            public['next_actions'] = [{'id': 'resume', 'enabled': not blocked,
                                       'reason': '이미 시도한 요청의 결과 확인이 필요합니다. 자동 재제출하지 않습니다.' if blocked else None}]
            if rejected and re.match(r'(Meshy|Tripo) [^(]+\(HTTP \d+\)', str(public.get('error') or '')):
                # Records written before provider- and cause-specific messages still name both.
                from src.services.avatar_image_pipeline import _provider_http_message
                public['error'] = _provider_http_message(*rejected)
        if job.get('production_mode') == 'character_parts':
            from src.services.avatar_expression_pipeline import summary as expression_summary
            public['default_expressions'] = expression_summary(directory)
            from src.services.avatar_character_flow import character_flow
            public['character_flow'] = character_flow(directory, public)
            public['progress'] = {key: public['character_flow'][key] for key in ('stage', 'message')}
            from src.services.avatar_image_recovery import decorate_job
            decorate_job(directory, public)
            from src.services.avatar_production_progress import production_progress
            public['production_progress'] = production_progress(directory, public)
        return public

    def listing(self, owner):
        # A full history read must not hold the lock or tie up every API worker.
        # Keep one refresh per owner and serve the last complete snapshot while
        # it runs. Selected job reads and every mutation still use live records.
        owner = int(owner)
        with self._listing_lock:
            pending = self._listing_pending.get(owner)
            if pending is not None and pending.done():
                self._listing_pending.pop(owner)
                # Surface storage failures rather than silently masking them
                # with cached success. The browser retains its last good value.
                self._listings[owner] = pending.result()
                pending = None
            cached = self._listings.get(owner)
            if cached and time.monotonic() - cached[0] < 10:
                return deepcopy(cached[1])
            if pending is None:
                pending = _LISTING_REFRESH.submit(self._read_listing, owner)
                self._listing_pending[owner] = pending
            if cached:
                return deepcopy(cached[1])
        # Cold start also has a deadline; the in-flight read survives a browser
        # timeout and the next GET joins it instead of starting another scan.
        try:
            snapshot = pending.result(timeout=12)
        except FutureTimeout as exc:
            raise PipelineError('listing_pending', '저장된 생산 목록을 불러오고 있습니다. 잠시 후 다시 동기화합니다.', 503) from exc
        with self._listing_lock:
            if self._listing_pending.get(owner) is pending:
                self._listings[owner] = snapshot
                self._listing_pending.pop(owner)
        return deepcopy(snapshot[1])

    def _settle_interrupted(self, owner, job_id):
        """A request cut off by a stopped server becomes an explicit retry instead of a dead end."""
        from src.services.avatar_image_recovery import settle_interrupted
        directory = self.directory(owner, job_id)
        state = read_json(directory/'pipeline.json')
        views = [image for part in state.get('parts', []) for image in (part.get('views') or {}).values()]
        views += list(((state.get('reference_preparation') or {}).get('views') or {}).values())
        if not any(image.get('status') == 'submitting' and not image.get('failure') for image in views):
            return None
        with _LOCK:
            job = read_json(directory/'job.json')
            if job.get('status') not in ('pipeline_paused', 'failed', 'recovery_required'):
                return None
            state = read_json(directory/'pipeline.json')
            if settle_interrupted(directory, state):
                from src.services.avatar_image_pipeline import AvatarImagePipeline
                AvatarImagePipeline(self).publish(owner, job_id, state)
            return read_json(directory/'job.json')

    def _read_listing(self, owner):
        ids = [name for name in child_names(self.root/str(owner)) if re.fullmatch(r'[a-f0-9]{24}', name)]
        # Bounded reads share the worker pool across all owners. One unreadable
        # job is reported as such instead of failing the whole snapshot.
        records = _LISTING_READERS.map(lambda job_id: self._listing_record(owner, job_id), sorted(ids, reverse=True))
        return time.monotonic(), [record for record in records if record]

    def _listing_record(self, owner, job_id):
        key = (int(owner), job_id)
        directory = self.directory(owner, job_id)
        with self._listing_lock:
            cached = self._records.get(key)
        if (cached and time.monotonic() - cached[0] < cached[2]
                and not changed_since(directory/'job.json', cached[0])):
            return deepcopy(cached[1])
        started = time.monotonic()
        try:
            public = self.get(owner, job_id)
        except PipelineError as exc:
            if exc.code == 'not_found':
                return None
            LOGGER.warning('Listing could not read job %s: %s', job_id, exc.code)
            return self._unreadable(directory)
        except Exception:
            LOGGER.exception('Listing could not read job %s', job_id)
            return self._unreadable(directory)
        flow = public.get('character_flow') or {}
        settled = not flow.get('busy') and public['status'] not in ('pipeline_queued', 'pipeline_running', 'accepted', 'running')
        with self._listing_lock:
            if len(self._records) > 4096:
                self._records.clear()
            self._records[key] = (started, deepcopy(public), SETTLED_RECORD_SECONDS if settled else 0)
        return public

    def _unreadable(self, directory):
        try:
            job = read_json(directory/'job.json')
        except Exception:
            return None
        if not job:
            return None
        public = {k: deepcopy(v) for k, v in job.items() if k not in ('executor', 'executor_process', 'fingerprint', 'files')}
        public.update(status='unreadable', error='작업 기록을 읽지 못했습니다.', artifacts=[], next_actions=[],
                      progress={'stage': 'unreadable', 'message': '작업 기록을 읽지 못했습니다.'})
        return public

    def artifact(self, owner, job_id, filename):
        directory = self.directory(owner, job_id); job = read_json(directory/'job.json')
        if Path(filename).name != filename or filename not in job.get('files', {}):
            raise PipelineError('not_found', '생산 파일을 찾을 수 없습니다.', 404)
        path = directory/'output'/filename
        if not path.is_file() or digest(path) != job['files'][filename]:
            raise PipelineError('artifact_changed', '검증한 생산 파일과 현재 파일이 다릅니다.')
        return path


def factory_records(root, owner):
    if owner is None:
        return []
    records = []
    for path in (Path(root)/'avatar-factory'/str(int(owner))).glob('*/job.json'):
        job = read_json(path)
        if job.get('status') in ('review_required', 'approved'):
            # Native Meshy characters keep their arbitrary rig outside the 23-bone wardrobe catalog.
            if 'catalog.json' not in job.get('files', {}):
                continue
            catalog = path.parent/'output/catalog.json'
            if digest(catalog) != job.get('files', {}).get('catalog.json'):
                raise PipelineError('catalog_changed', '생산 카탈로그가 변경되었습니다.')
            records.extend(read_json(catalog).get('assets', []))
    return records
