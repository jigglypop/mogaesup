"""Meshy skeleton and library clips for a preserved factory whole character."""
from copy import deepcopy
import hashlib
import json
import logging
import os
import re
from threading import Lock
import time

import httpx

from src.services import character_jobs, character_motion
from src.services.animation_glb import merge_character_clips
from src.services.asset_delivery import inspect_glb
from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, digest
from src.services.character_pipeline import PipelineError, read_json, now
from src.services.glb import parse_glb
from src.services.process_identity import identity, state as process_state
from src.services.wardrobe import download_glb
from src.services.meshy_status import BLOCKED, saved_problem

SLOTS = ('idle', 'walk', 'run', 'jump', 'fall', 'sit', 'armsUp', 'crouch')
_WORKERS = {}
LOGGER = logging.getLogger(__name__)


def client(base):
    key = os.getenv('MESHY_API_KEY', '').strip()
    if not key:
        raise PipelineError('provider_unavailable', 'Meshy API 설정이 필요합니다.', 422)
    return httpx.Client(base_url=base, headers={'Authorization': 'Bearer '+key}, timeout=120)


class AvatarMeshy:
    def __init__(self, factory):
        self.factory = factory

    def directory(self, owner, job_id):
        job = self.factory.get(owner, job_id)
        slots = [p['slot'] for p in job.get('parts', [])]
        valid_parts = job.get('production_mode') == 'character_parts' and 'body' in slots
        if job.get('input_kind') not in ('image', 'glb') or (slots != ['body'] and not valid_parts):
            raise PipelineError('whole_character_required', '생성된 통짜 전신 작업이 필요합니다.', 422)
        return self.factory.directory(owner, job_id)/'meshy'

    def library(self, owner):
        path = self.factory.root/str(int(owner))/'meshy-library.json'
        cached = read_json(path)
        if cached and time.time()-cached['fetched_at'] < 300:
            return cached['items']
        try:
            with client(os.getenv('MESHY_API_BASE_URL', 'https://api.meshy.ai')) as api:
                items = character_motion.library(api)
        except httpx.HTTPError:
            raise PipelineError('library_unavailable', 'Meshy 동작 목록을 불러오지 못했습니다. 다시 연결해 주세요.', 502) from None
        path.parent.mkdir(parents=True, exist_ok=True)
        _write_json(path, {'fetched_at': time.time(), 'items': items})
        return items

    def _saved_defaults(self, owner):
        root = self.factory.root/str(int(owner))
        saved = read_json(root/'motion-defaults.json', {'selections': {}})
        if saved.get('scope') == 'owner':
            return saved
        # Older UI saved the same default-setting control in each job. Recover
        # the newest saved value per slot, without modifying any rig contracts.
        cache = getattr(self.factory, '_legacy_motion_defaults', {})
        cache_key = (int(owner), json.dumps(saved, sort_keys=True))
        if cache_key in cache:
            return deepcopy(cache[cache_key])
        records = [saved]
        for path in root.glob('*/motion-defaults.json'):
            if re.fullmatch(r'[a-f0-9]{24}', path.parent.name):
                records.append(read_json(path))
        resolved = {'selections': {}, 'scope': 'owner'}
        for record in sorted(records, key=lambda item: item.get('updated_at', '')):
            resolved['selections'].update({slot: value for slot, value in record.get('selections', {}).items()
                                           if slot in SLOTS and type(value) is int})
            if record.get('updated_at'):
                resolved['updated_at'] = record['updated_at']
        cache[cache_key] = deepcopy(resolved)
        self.factory._legacy_motion_defaults = cache
        return resolved

    def defaults(self, owner, selections=None, job_id=None):
        if job_id:
            self.factory.get(owner, job_id)
        if selections is not None:
            self.validate_actions(owner, selections)
        with _LOCK:
            saved = self._saved_defaults(owner)
            if selections is not None:
                saved = {'scope': 'owner', 'selections': {**saved['selections'], **selections}, 'updated_at': now()}
                path = self.factory.root/str(int(owner))/'motion-defaults.json'
                path.parent.mkdir(parents=True, exist_ok=True)
                _write_json(path, saved)
            return saved

    def validate_actions(self, owner, selections):
        available = {item['action_id'] for item in self.library(owner)} if selections else set()
        if not set(selections) <= set(SLOTS) or any(type(v) is not int or v not in available for v in selections.values()):
            raise PipelineError('invalid_action', '현재 Meshy 목록에서 기본 동작을 선택하세요.', 422)

    def default_actions(self, owner):
        saved = self.defaults(owner)['selections']
        return {slot: saved.get(slot, action_id) for slot, action_id in character_motion.DEFAULT_ACTIONS.items()}

    def start(self, owner, job_id):
        run = self.directory(owner, job_id)
        with _LOCK:
            job = run.parent
            contract = read_json(run/'input.json')
            pipeline = read_json(job/'pipeline.json')
            uploaded = bool(pipeline.get('uploaded_glb'))
            if uploaded and ((pipeline.get('base_body_setup') or {}).get('import_mode') != 'rig'
                             or read_json(job/'job.json').get('limits', {}).get('meshy_rig_tasks') != 1):
                raise PipelineError('uploaded_body', '바로 등록한 GLB입니다. 새 리깅 후 등록을 선택해 접수하세요.', 409)
            if (read_json(run/'worker.json').get('origin') == 'rig_transfer'
                    or read_json(run/'delivery.json').get('origin') == 'transferred_meshy_rig'):
                raise PipelineError('local_rig_recovery', '저장된 골격 복구 작업에서 이어서 진행하세요.', 409)
            if pipeline.get('base_body'):
                raise PipelineError('frozen_body', '저장된 기본 몸의 리깅은 다시 제출하지 않습니다.', 422)
            if 'motion_actions' in contract:
                accepted_actions = contract['motion_actions']
                max_animation_tasks = contract.get('max_animation_tasks', 0)
            else:
                accepted_actions = pipeline.get('motion_actions', {})
                limits = read_json(job/'job.json').get('limits', {})
                max_animation_tasks = limits.get('meshy_animation_tasks', 0)
            if (not isinstance(accepted_actions, dict) or not set(accepted_actions) <= set(SLOTS)
                    or any(type(value) is not int for value in accepted_actions.values())
                    or len(set(accepted_actions.values())) > max_animation_tasks):
                raise PipelineError('invalid_motion_contract', '수락된 Meshy 동작 범위와 작업 한도를 확인해 주세요.', 422)
            if not (run/'input.json').exists():
                source = self.factory.artifact(owner, job_id, 'generated-body.glb')
                provider = read_json(job/'parts/body/character.json')
                if not uploaded and (provider.get('stage') != 'generation' or provider.get('status') != 'SUCCEEDED'):
                    raise PipelineError('generation_required', '성공한 Meshy 전신 생성 작업이 필요합니다.', 422)
                base = pipeline['meshy_base']
                height = pipeline.get('body_height_m', 1.81)
                # Validate configuration before recording an accepted operation.
                with client(base):
                    pass
                run.mkdir(exist_ok=True)
                _write_json(run/'input.json', {'source_job_id': job_id, 'source_sha256': digest(source),
                    'generation_task_id': provider.get('task_id'), 'input_kind': 'model' if uploaded else 'generation',
                    'height_meters': height, 'meshy_base': base,
                    'max_rig_tasks': 1, 'motion_actions': accepted_actions,
                    'max_animation_tasks': max_animation_tasks})
                if not uploaded:
                    _write_json(run/'character.json', {**provider, 'height_meters': height})
            else:
                # Legacy runs may have accepted actions in their immutable pipeline but
                # predate the self-contained Meshy input contract. Freeze them once.
                if 'motion_actions' not in contract:
                    contract.update(motion_actions=accepted_actions,
                                    max_animation_tasks=max_animation_tasks)
                    _write_json(run/'input.json', contract)
            worker = read_json(run/'worker.json')
            if worker.get('status') not in ('accepted', 'running') or process_state(worker.get('process')) == 'exited':
                _write_json(run/'worker.json', {'status': 'accepted', 'process': identity(), 'error': None})
        return self.get(owner, job_id)

    def reset_failed(self, owner, job_id):
        """Explicit run: allow a new rig or animation request after a failed or unaccepted attempt.

        Only a provider problem that still blocks this job is reset; a job recovered with a
        saved local rig keeps its receipts. start() admits the worker afterwards.
        """
        run = self.directory(owner, job_id)
        with _LOCK:
            if self.get(owner, job_id)['busy'] or not saved_problem(run):
                return False
            if (read_json(run/'worker.json').get('origin') == 'rig_transfer'
                    or read_json(run/'delivery.json').get('origin') in ('transferred_meshy_rig', 'frozen_body', 'uploaded_glb')):
                return False
            contract = read_json(run/'input.json')
            task = read_json(run/'character.json')
            changed = False
            if task.get('stage') == 'rigging' and task.get('status') in character_jobs.RETRYABLE:
                provider = {}
                if contract.get('input_kind') != 'model':
                    provider = read_json(run.parent/'parts/body/character.json')
                    if provider.get('stage') != 'generation' or provider.get('status') != 'SUCCEEDED':
                        raise PipelineError('generation_required', '성공한 Meshy 전신 생성 작업이 필요합니다.', 422)
                character_jobs.archive_attempt(run, 'explicit')
                if provider:
                    _write_json(run/'character.json', {**provider, 'height_meters': contract.get('height_meters', 1.2)})
                changed = True
            elif task.get('stage') == 'rigging' and task.get('status') == 'SUCCEEDED':
                for path in sorted((run/'actions').glob('*/motion-pack.json')):
                    pack = read_json(path)
                    clip = pack.get('tasks', {}).get('clip')
                    if clip and clip.get('status') in character_jobs.RETRYABLE:
                        pack.setdefault('previous_tasks', []).append(clip)
                        pack['tasks'].pop('clip')
                        pack['max_new_tasks'] = pack.get('submitted_tasks', 0) + 1
                        _write_json(path, pack)
                        changed = True
            return changed

    def _verify_source(self, run):
        contract = read_json(run/'input.json')
        if not contract or digest(run.parent/'output/generated-body.glb') != contract['source_sha256']:
            raise ValueError('Preserved source changed')
        return contract

    def get(self, owner, job_id):
        run = self.directory(owner, job_id)
        task = read_json(run/'character.json')
        receipt = read_json(run/'delivery.json')
        worker = read_json(run/'worker.json')
        busy = worker.get('status') in ('accepted', 'running') and process_state(worker.get('process')) != 'exited'
        tasks = []
        for path in sorted((run/'actions').glob('*/motion-pack.json')):
            pack = read_json(path)
            task_value = pack.get('tasks', {}).get('clip', {})
            tasks.append({'action_id': pack['action_id'], **{k: task_value.get(k) for k in ('task_id', 'status', 'progress')}})
        version = receipt.get('version')
        artifacts = [{'name': name, 'url': f'/api/avatar-factory/jobs/{job_id}/meshy/artifacts/{version}/{name}'}
                     for name in receipt.get('files', {})]
        artifacts.extend({'name': name+'.glb', 'url': f'/api/avatar-factory/jobs/{job_id}/meshy/provider/{name}.glb'}
                         for name in read_json(run/'rigging-artifacts.json') if name in ('rigged', 'walking', 'running'))
        frozen = receipt.get('origin') in ('frozen_body', 'transferred_meshy_rig', 'uploaded_glb')
        if (read_json(run.parent/'pipeline.json').get('base_body_setup') or {}).get('import_mode') == 'register':
            frozen = True
        problem = saved_problem(run)
        local_recovery = worker.get('origin') == 'rig_transfer'
        clips = receipt.get('clips', [])
        if frozen and not clips and version:
            document, _ = parse_glb((run/'versions'/version/'model.glb').read_bytes(), strict=True)
            clips = [{'slot': a.get('name', f'clip_{i}'), 'source': receipt['origin'], 'action_id': None}
                     for i, a in enumerate(document.get('animations', []))]
        return {'provider': 'meshy', 'status': 'ready' if version else 'running' if local_recovery and busy else task.get('status', 'not_started'),
                'rig_task_id': task.get('task_id') if task.get('stage') == 'rigging' else None,
                'progress': task.get('progress', 0) if task.get('status') == 'IN_PROGRESS' else 0,
                'busy': busy, 'error': worker.get('error') if local_recovery else problem['message'] if problem else worker.get('error'),
                'failure': None if local_recovery and busy else problem, 'artifacts': artifacts,
                'version': version, 'clips': clips, 'bone_count': receipt.get('bone_count'),
                'can_request_action': not frozen and task.get('stage') == 'rigging' and task.get('status') == 'SUCCEEDED' and not busy,
                'origin': receipt.get('origin', 'meshy'),
                'model_sha256': receipt.get('files', {}).get('model.glb'),
                'source_sha256': receipt.get('source_sha256'), 'actions': tasks,
                'can_resume': not frozen and not busy and problem is None,
                'selected': read_json(run/'selected.json')}

    def _publish(self, run):
        rig = run/'rigged.glb'
        if not rig.is_file():
            return
        receipts = read_json(run/'rigging-artifacts.json')
        if digest(rig) != receipts.get('rigged', {}).get('sha256'):
            raise ValueError('Provider rig changed')
        clips = {}
        for slot, name in (('walk', 'walking'), ('run', 'running')):
            if name in receipts:
                path = run/(name+'.glb')
                if digest(path) != receipts[name]['sha256']:
                    raise ValueError('Provider basic animation changed')
                clips[slot] = {'path': path, 'source': 'rigging_basic', 'action_id': None}
        for slot, action_id in read_json(run/'selected.json').items():
            directory = run/'actions'/str(action_id)
            saved = read_json(directory/'clip.json')
            if saved:
                path = directory/'clip.glb'
                if digest(path) != saved['sha256']:
                    raise ValueError('Provider library animation changed')
                clips[slot] = {'path': path, 'source': 'animation_library', 'action_id': action_id}
        clip_content = {slot: item['path'].read_bytes() for slot, item in clips.items()}
        provider_rig = rig.read_bytes()

        def package(model):
            merged = merge_character_clips(model, clip_content)
            return merged, inspect_glb(merged, budget_warnings=True)

        # Meshy returns the rig with a greyed, re-baked base colour and no normal/ORM maps; the
        # body that was sent keeps its own material on the same UV layout. Restoring it is an
        # improvement only: any failure delivers the provider rig exactly as received.
        rig_content, material = provider_rig, {'restored': False, 'reason': 'source_missing'}
        source = run.parent/'output/generated-body.glb'
        if source.is_file():
            try:
                from src.services.rig_material import restore_source_material
                rig_content, material = restore_source_material(provider_rig, source.read_bytes())
            except Exception as exc:
                LOGGER.warning('Rig material restore skipped job=%s type=%s', run.parent.name, type(exc).__name__)
                rig_content = provider_rig
                material = {'restored': False, 'reason': 'restore_failed', 'error_type': type(exc).__name__}
        content = quality = None
        if material.get('restored'):
            try:
                content, quality = package(rig_content)
            except Exception as exc:
                LOGGER.warning('Restored rig material rejected job=%s type=%s', run.parent.name, type(exc).__name__)
                content = None
            if content is None or quality['errors']:
                content = None
                material = {'restored': False, 'reason': 'restore_invalid'}
        if content is None:
            content, quality = package(provider_rig)
        if quality['errors']:
            raise ValueError('Meshy package failed structural validation')
        lineage = [{'slot': slot, 'source': item['source'], 'action_id': item['action_id']} for slot, item in clips.items()]
        version = hashlib.sha256(content+json.dumps(lineage, sort_keys=True).encode()).hexdigest()[:24]
        output = run/'versions'/version
        output.mkdir(parents=True, exist_ok=True)
        model = output/'model.glb'
        if not model.exists():
            model.write_bytes(content)
        if digest(model) != hashlib.sha256(content).hexdigest():
            raise ValueError('Versioned output changed')
        doc, _ = parse_glb(content, strict=True)
        receipt = {'version': version, 'files': {'model.glb': digest(model)},
                   'bone_count': len({j for skin in doc.get('skins', []) for j in skin['joints']}),
                   'source_sha256': digest(rig), 'rig_task_id': character_jobs.state(run)['task_id'],
                   'clips': lineage, 'material': material}
        _write_json(output/'receipt.json', receipt)
        _write_json(run/'delivery.json', receipt)

    def _ensure_accepted_actions(self, run, rig_task_id):
        contract = read_json(run/'input.json')
        accepted = contract.get('motion_actions', {})
        if not accepted:
            return
        unique_actions = list(dict.fromkeys(accepted.values()))
        if len(unique_actions) > contract.get('max_animation_tasks', 0):
            raise ValueError('Accepted animation task budget exceeded')
        selected = read_json(run/'selected.json')
        rigging_artifacts = read_json(run/'rigging-artifacts.json')
        basic_artifacts = {'walk': 'walking', 'run': 'running'}
        for slot, action_id in accepted.items():
            basic_name = basic_artifacts.get(slot)
            uses_default_basic = (basic_name in rigging_artifacts
                                  and action_id == character_motion.DEFAULT_ACTIONS.get(slot))
            if uses_default_basic:
                if selected.get(slot) == action_id:
                    selected.pop(slot)
                continue
            selected.setdefault(slot, action_id)
        _write_json(run/'selected.json', selected)
        selected_accepted = list(dict.fromkeys(
            action_id for slot, action_id in accepted.items() if selected.get(slot) == action_id))
        for action_id in selected_accepted:
            directory = run/'actions'/str(action_id)
            pack = character_motion.read_pack(directory)
            if pack:
                if pack.get('action_id') != action_id or pack.get('rig_task_id') != rig_task_id:
                    raise ValueError('Existing animation receipt belongs to another action or rig')
                continue
            directory.mkdir(parents=True, exist_ok=True)
            _write_json(directory/'motion-pack.json', {'action_id': action_id,
                'rig_task_id': rig_task_id, 'max_new_tasks': 1,
                'submitted_tasks': 0, 'tasks': {}})

    def request_action(self, owner, job_id, slot, action_id):
        if slot not in SLOTS or action_id not in {i['action_id'] for i in self.library(owner)}:
            raise PipelineError('invalid_action', '현재 Meshy 목록에서 동작을 선택하세요.', 422)
        run = self.directory(owner, job_id)
        with _LOCK:
            task = read_json(run/'character.json')
            if task.get('stage') != 'rigging' or task.get('status') != 'SUCCEEDED' or not (run/'delivery.json').is_file():
                raise PipelineError('rig_not_ready', 'Meshy 리깅 결과를 먼저 가져와 주세요.', 422)
            if self.get(owner, job_id)['busy']:
                raise PipelineError('worker_busy', '기존 Meshy 작업을 마친 뒤 동작을 선택하세요.')
            directory = run/'actions'/str(action_id)
            if not (directory/'motion-pack.json').is_file():
                directory.mkdir(parents=True, exist_ok=True)
                _write_json(directory/'motion-pack.json', {'action_id': action_id, 'rig_task_id': task['task_id'],
                    'max_new_tasks': 1, 'submitted_tasks': 0, 'tasks': {}})
            selected = read_json(run/'selected.json'); selected[slot] = action_id
            _write_json(run/'selected.json', selected)
        return self.get(owner, job_id)

    def execute(self, owner, job_id, *, poll_seconds=5, timeout=1200):
        run = self.directory(owner, job_id)
        with _LOCK:
            lock = _WORKERS.setdefault(str(run), Lock())
        if not lock.acquire(blocking=False):
            return
        try:
            worker = read_json(run/'worker.json')
            if worker.get('status') == 'running' and worker.get('process') != identity() and process_state(worker.get('process')) != 'exited':
                return
            contract = self._verify_source(run)
            _write_json(run/'worker.json', {'status': 'running', 'process': identity(), 'error': None})
            deadline = time.monotonic()+timeout
            with client(contract['meshy_base']) as api:
                if contract.get('input_kind') == 'model' and not (run/'character.json').is_file():
                    task = character_jobs.rig_model(run, run.parent/'output/generated-body.glb', contract['height_meters'], api)
                else:
                    task = character_jobs.state(run)
                if task['stage'] == 'generation':
                    task = character_jobs.rig(run, api)
                while True:
                    if task['status'] in BLOCKED:
                        raise ValueError('Existing rig attempt requires recovery; no automatic resubmission')
                    task = character_jobs.refresh(run, api)
                    if task['status'] == 'SUCCEEDED':
                        if not (run/'rigging-artifacts.json').is_file():
                            character_jobs.download(run, 'rigging')
                        self._ensure_accepted_actions(run, task['task_id'])
                        pending = False
                        for action_id in set(read_json(run/'selected.json').values()):
                            directory = run/'actions'/str(action_id)
                            if (directory/'clip.json').is_file():
                                continue
                            pack = character_motion.read_pack(directory)
                            motion = character_motion._task(directory, pack, 'clip', character_motion.ENDPOINTS['animation'],
                                {'rig_task_id': task['task_id'], 'action_id': action_id}, api)
                            if motion['status'] != 'SUCCEEDED':
                                pending = True; continue
                            with httpx.Client(timeout=120, follow_redirects=True) as downloader:
                                download_glb(downloader, motion['result']['animation_glb_url'], directory/'clip.glb',
                                             preserve_detail=task.get('generation_settings', {}).get('should_remesh') is False)
                            quality = inspect_glb((directory/'clip.glb').read_bytes(), budget_warnings=True)
                            if quality['errors'] or not quality['metrics']['animations']:
                                raise ValueError('Provider animation is invalid')
                            _write_json(directory/'clip.json', {'sha256': digest(directory/'clip.glb'), 'task_id': motion['task_id']})
                        self._publish(run)
                        if not pending:
                            _write_json(run/'worker.json', {'status': 'complete', 'error': None})
                            if self.factory.get(owner, job_id).get('auto_assemble'):
                                from src.services.avatar_character_flow import assemble_character
                                assemble_character(self.factory, owner, job_id)
                            return
                    if time.monotonic() >= deadline:
                        _write_json(run/'worker.json', {'status': 'paused', 'error': 'Meshy 작업을 조회해 이어갈 수 있습니다.'})
                        return
                    time.sleep(poll_seconds)
        except Exception as exc:
            problem = saved_problem(run)
            if problem:
                error = problem['message']
            elif isinstance(exc, httpx.HTTPError):
                error = 'Meshy 응답을 가져오지 못했습니다. 저장된 작업에서 조회를 이어갈 수 있습니다.'
            else:
                error = '리깅·동작 파일 처리 중 중단됐습니다. 저장된 결과에서 이어갈 수 있습니다.'
            # Record the failure location without logging signed URLs or response bodies.
            trace = exc.__traceback__
            while trace and trace.tb_next:
                trace = trace.tb_next
            LOGGER.error('Meshy worker stopped job=%s type=%s function=%s line=%s code=%s',
                         job_id, type(exc).__name__, trace.tb_frame.f_code.co_name if trace else None,
                         trace.tb_lineno if trace else None, problem['code'] if problem else None)
            _write_json(run/'worker.json', {'status': 'paused', 'error': error,
                        'failure': problem, 'exception_type': type(exc).__name__})
            if problem and problem['code'] == 'rig_pose_rejected':
                from src.services.avatar_rig_transfer import AvatarRigTransfer
                try:
                    AvatarRigTransfer(self.factory).recover_rejected(owner, job_id)
                except Exception as recovery_error:
                    LOGGER.error('Local rig recovery stopped job=%s type=%s', job_id, type(recovery_error).__name__)
        finally:
            lock.release()

    def recover(self, owner, job_id, task_id, action_id=None):
        import re
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', task_id):
            raise PipelineError('invalid_task', '올바른 Meshy 작업 ID가 필요합니다.', 422)
        run = self.directory(owner, job_id)
        with _LOCK:
            if self.get(owner, job_id)['busy']:
                raise PipelineError('worker_busy', '기존 Meshy 조회가 실행 중입니다.')
            contract = self._verify_source(run)
            path = run/'actions'/str(action_id)
            pack = character_motion.read_pack(path) if action_id is not None else None
            task = pack.get('tasks', {}).get('clip', {}) if pack is not None else character_jobs.state(run)
            if task.get('status') != 'submission_uncertain':
                raise PipelineError('invalid_state', '응답이 불확실한 기존 작업만 복구할 수 있습니다.')
            with client(contract['meshy_base']) as api:
                if action_id is None:
                    character_jobs.refresh(run, api, task_id)
                else:
                    response = api.get('/openapi/v1/animations/'+task_id); response.raise_for_status()
                    value = response.json()
                    if value.get('rig_task_id', pack['rig_task_id']) != pack['rig_task_id'] or value.get('action_id', action_id) != action_id:
                        raise PipelineError('task_mismatch', '다른 리깅·동작의 작업 ID입니다.', 422)
                    task.update(task_id=task_id, status='PENDING', recovery_method='operator_task_id')
                    _write_json(path/'motion-pack.json', pack)
        return self.get(owner, job_id)

    def provider_artifact(self, owner, job_id, name):
        run = self.directory(owner, job_id)
        if name not in ('rigged.glb', 'walking.glb', 'running.glb'):
            raise PipelineError('not_found', 'Meshy 원본 산출물을 찾을 수 없습니다.', 404)
        path = run/name
        receipt = read_json(run/'rigging-artifacts.json').get(name.removesuffix('.glb'), {})
        if not path.is_file() or digest(path) != receipt.get('sha256'):
            raise PipelineError('not_found', 'Meshy 원본 산출물을 확인할 수 없습니다.', 404)
        return path

    def artifact(self, owner, job_id, version, name):
        import re
        run = self.directory(owner, job_id)
        if not re.fullmatch(r'[a-f0-9]{24}', version) or name != 'model.glb':
            raise PipelineError('not_found', 'Meshy 산출물을 찾을 수 없습니다.', 404)
        path = run/'versions'/version/name
        receipt = read_json(path.parent/'receipt.json')
        if not path.is_file() or digest(path) != receipt.get('files', {}).get(name):
            raise PipelineError('not_found', 'Meshy 산출물을 확인할 수 없습니다.', 404)
        return path
