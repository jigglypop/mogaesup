"""Owner-scoped, resumable local avatar production. No provider submissions."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
import json
import logging
import os
from src.services.object_storage import StoredPath as Path
import re
import time
from threading import RLock, Semaphore
import uuid

from src.services.asset_editor import _write_json, update_json
from src.services.character_pipeline import CharacterPipeline, PipelineError, read_json, now
from src.services.process_identity import state as process_state
from src.services.object_storage import changed_since, child_names, sha256
from src.services.run_lock import WorkerLocks, worker_alive

LOGGER = logging.getLogger(__name__)
# Concurrent Blender workers. Each one uses 1-2 CPU threads and about 1-2 GB of RAM.
_QUEUE = Semaphore(max(1, int(os.getenv('BLENDER_CONCURRENCY', '2') or 2)))
_LOCK = RLock()
# The production worker of each job directory (AvatarImagePipeline.execute) while it runs in this process.
_RUN_LOCKS = WorkerLocks()
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


def _json_default(value):
    """A value json cannot encode becomes what FastAPI's response encoder makes of it (a set, a date, a path), so the
    encoded listing stays the JSON a returned dict would have been."""
    from fastapi.encoders import jsonable_encoder
    return jsonable_encoder(value)


# The settings of the JSON FastAPI renders a returned dict to (starlette's JSONResponse).
_LISTING_ENCODER = json.JSONEncoder(ensure_ascii=False, allow_nan=False, indent=None, separators=(',', ':'),
                                    default=_json_default)


class AvatarFactory:
    def __init__(self, root):
        self.data = Path(root).resolve(); self.root = self.data/'avatar-factory'
        self.pipeline = CharacterPipeline(self.data)
        self.instance = uuid.uuid4().hex
        self._listing_lock = RLock()
        self._listings = {}
        self._listing_pending = {}
        self._listing_json = {}  # owner -> (the snapshot in _listings it encodes, its JSON bytes)
        self._records = {}

    def directory(self, owner, job_id):
        if not re.fullmatch(r'[a-f0-9]{24}', job_id):
            raise PipelineError('not_found', '생산 작업을 찾을 수 없습니다.', 404)
        return self.root/str(int(owner))/job_id

    def _executor_gone(self, job, held):
        """Queued or running for another server instance whose process has exited; or running in a live process with no
        worker any more. A run of this process runs only while its worker holds the job's lock (`held`, observed
        before and after reading `job`): one whose last save failed leaves `pipeline_running` behind and nothing runs
        it, so it reads as stopped instead of refusing every resume until a restart."""
        status = job.get('status')
        if status not in ('pipeline_queued', 'pipeline_running'):
            return False
        if job.get('executor') != self.instance and process_state(job.get('executor_process')) == 'exited':
            return True
        return status == 'pipeline_running' and not worker_alive(
            {'status': 'running', 'process': job.get('executor_process')}, held)

    def _worker_held(self, directory):
        return _RUN_LOCKS.busy(str(directory))

    def get(self, owner, job_id):
        directory = self.directory(owner, job_id)
        held = self._worker_held(directory)
        job = read_json(directory/'job.json')
        if not job:
            raise PipelineError('not_found', '생산 작업을 찾을 수 없습니다.', 404)
        if self._executor_gone(job, held or self._worker_held(directory)):
            def pause(current):
                # A resume or a finished run may have landed since the read; only a record still stopped is paused.
                if not self._executor_gone(current, held or self._worker_held(directory)):
                    return None
                if process_state(current.get('executor_process')) != 'exited':
                    # This live process's worker ended without saving its pause; the stage it stopped in is unknown.
                    return {**current, 'status': 'pipeline_paused', 'updated_at': now(),
                            'error': '생산 실행이 중단 상태를 저장하지 못한 채 끝났습니다. 저장된 단계에서 이어서 실행할 수 있습니다.'}
                # The last recorded activity dates the stop; detecting it late must not make it look recent.
                return {**current, 'status': 'pipeline_paused', 'error': '서버 재시작으로 중단됨',
                        'interrupted': {'stage': current.get('resume_stage', 'images'),
                                        'at': current.get('updated_at') or current.get('created_at'), 'detected_at': now()}}
            # A GET only records the stop. Continuing the job sends paid requests, so only the operator or the startup scan does.
            with _LOCK:
                job = update_json(directory/'job.json', pause)
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
            if state.get('production_spec'):
                from src.services.avatar_multiview_images import can_resume
                blocked = not can_resume(directory, state)
            else:
                # What resume() takes: a request that never left, or an attempted one whose answer is kept.
                from src.services.avatar_image_pipeline import unresolved_image_attempt
                blocked = any(unresolved_image_attempt(directory, p) for p in state.get('parts', []))
            runner = read_json(directory/'output/runner.json')
            if job['status'] in ('failed', 'recovery_required') and runner and process_state(runner.get('process')) != 'exited':
                blocked = True
            rejected = None
            from src.services.character_jobs import submitted_task_id
            for p in state.get('parts', []):
                run = directory/'parts'/p['slot']
                task = read_json(run/'character.json')
                # A submission whose saved answer names the accepted task is that task: resume polls it, never resends.
                known = bool(task.get('task_id') or (task and submitted_task_id(run, task)))
                blocked = blocked or bool(task and (not known or task.get('status') in ('FAILED', 'CANCELED')))
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
        """Every job of the owner, newest first. The list and its jobs are the snapshot every caller shares until the
        next refresh, not copies: read them, and copy a job before changing it."""
        return self._listing_snapshot(owner)[1]

    def listing_json(self, owner):
        """listing() as the UTF-8 JSON of {"jobs": [...]}, the bytes a returned dict would have been rendered to.
        The studio polls it every 10 s per tab and it runs to megabytes, so a snapshot is encoded once, by the
        thread that asks first, and later requests get the same bytes until the snapshot is refreshed."""
        snapshot = self._listing_snapshot(owner)
        owner = int(owner)
        with self._listing_lock:
            encoded = self._listing_json.get(owner)
        if encoded and encoded[0] is snapshot:
            return encoded[1]
        # One job at a time: the C encoder holds the GIL for a whole call, and one call for every job would stall the
        # event loop for as long. The joined pieces are the bytes of encoding {"jobs": [...]} at once.
        content = b'{"jobs":[' + b','.join(_LISTING_ENCODER.encode(job).encode('utf-8') for job in snapshot[1]) + b']}'
        with self._listing_lock:
            # Bytes are kept only for the current snapshot; one that was replaced or dropped meanwhile is not kept.
            if self._listings.get(owner) is snapshot:
                self._listing_json[owner] = snapshot, content
        return content

    def _listing_snapshot(self, owner):
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
                return cached
            if pending is None:
                pending = _LISTING_REFRESH.submit(self._read_listing, owner)
                self._listing_pending[owner] = pending
            if cached:
                return cached
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
        return snapshot

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
        # The record kept here is the job listed in the snapshots: listing() callers never change it, so it is shared.
        key = (int(owner), job_id)
        directory = self.directory(owner, job_id)
        with self._listing_lock:
            cached = self._records.get(key)
        if (cached and time.monotonic() - cached[0] < cached[2]
                and not changed_since(directory/'job.json', cached[0])):
            return cached[1]
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
            self._records[key] = (started, public, SETTLED_RECORD_SECONDS if settled else 0)
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
