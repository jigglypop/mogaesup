"""Local recovery of a rejected rig using an owner-selected saved body skeleton."""
import hashlib
import subprocess

from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, _QUEUE, digest
from src.services.avatar_native_parts import AvatarNativeParts
from src.services.character_parts import blender_executable, blender_process, stop_process
from src.services.character_pipeline import PipelineError, now, read_json, require_request_key
from src.services.glb import parse_glb
from src.services.object_storage import StoredPath as Path, copy_file, local_workspace
from src.services.process_identity import identity, state as process_state
from src.services.run_lock import run_lock
from src.services.studio_library import StudioLibrary


class AvatarRigTransfer:
    def __init__(self, factory):
        self.factory = factory

    def root(self, owner, job_id):
        self.factory.get(owner, job_id)
        return self.factory.directory(owner, job_id)/'meshy/rig-transfer'

    def sources(self, owner):
        # List immutable body deliveries, without opening their GLBs or calling Meshy. A body offers the sealed
        # version the wardrobe offers (ready_version): while a newer one is assembled or failed, the one it replaced.
        from src.services.avatar_production_progress import ready_version
        items = []
        library = StudioLibrary(self.factory, owner)
        catalog = library.metadata()
        for path in (self.factory.root/str(int(owner))).glob('*/native-parts/current.json'):
            pointer = read_json(path)
            if not pointer.get('version'):
                continue
            version = ready_version(path.parent, pointer, read_json(path.parent/pointer['version']/'record.json'))
            native = read_json(path.parent/version/'record.json') if version else {}
            if native.get('status') != 'review_required' or 'body.glb' not in native.get('files', {}):
                continue
            job = read_json(path.parent.parent/'job.json')
            if job.get('production_mode') != 'character_parts' or job.get('base_job_id'):
                continue
            part = catalog['parts'].get(f'{job["id"]}:body', {})
            if part.get('deleted') or library.is_job_deleted(job, catalog):
                continue
            items.append({'job_id': job['id'], 'version': version,
                          'name': part.get('name') or catalog['items'].get(job['id'], {}).get('name') or job['character_name'],
                          'created_at': job['created_at']})
        return {'items': sorted(items, key=lambda item: item['created_at'], reverse=True)}

    def recommended(self, owner, job_id):
        target = read_json(self.factory.directory(owner, job_id)/'job.json')
        candidates = []
        for item in self.sources(owner)['items']:
            if item['job_id'] == job_id:
                continue
            source = read_json(self.factory.directory(owner, item['job_id'])/'job.json')
            if source.get('profile', {}).get('id') != target.get('profile', {}).get('id'):
                continue
            candidates.append((source.get('character_id') == target.get('character_id'), item['created_at'], item))
        return max(candidates, key=lambda item: item[:2])[2] if candidates else None

    def get(self, owner, job_id, *, during_pipeline=False):
        root = self.root(owner, job_id)
        pointer = read_json(root/'current.json')
        record = read_json(root/pointer['id']/'record.json') if pointer else {}
        status = record.get('status', 'not_started')
        runner = read_json(root/record['id']/'runner.json') if record else {}
        worker_alive = process_state(record.get('process')) != 'exited'
        blender_alive = bool(runner) and process_state(runner.get('process')) != 'exited'
        if status in ('accepted', 'running') and not worker_alive and not blender_alive:
            status = 'paused'
        directory = root.parent.parent
        job = self.factory.get(owner, job_id)
        task = read_json(directory/'meshy/character.json')
        delivery = read_json(directory/'meshy/delivery.json')
        planned = (read_json(directory/'pipeline.json').get('base_body_setup') or {}).get('rig_source')
        uploaded_model = read_json(directory/'parts/body/generation-artifacts.json').get('generated')
        eligible = (job.get('production_mode') == 'character_parts' and not delivery
                    and ((planned and uploaded_model and (directory/'output/generated-body.glb').is_file())
                         or (task.get('stage') == 'rigging' and task.get('status') == 'submission_rejected'
                             and task.get('http_status') == 422)))
        recommended = self.recommended(owner, job_id) if eligible and status == 'not_started' else None
        return {**{key: record.get(key) for key in ('id', 'request_key', 'source_job_id', 'source_version', 'error')},
                'recommended_source': recommended,
                'status': status, 'can_start': bool(eligible and status not in ('accepted', 'running')
                    and not blender_alive and (during_pipeline or not job.get('character_flow', {}).get('busy'))
                    and blender_executable()),
                'error': record.get('error') or ('골격 연결이 중단됐습니다. 저장된 입력으로 다시 연결할 수 있습니다.'
                                               if status == 'paused' else None)}

    def start(self, owner, job_id, source_job_id, source_version, key, *, during_pipeline=False):
        require_request_key(key, '복구 요청 식별자가 필요합니다.')
        root = self.root(owner, job_id)
        request_id = hashlib.sha256(key.encode()).hexdigest()[:24]
        directory = root/request_id
        with _LOCK:
            previous = read_json(directory/'record.json')
            if previous:
                if (previous['source_job_id'], previous['source_version']) != (source_job_id, source_version):
                    raise PipelineError('idempotency_conflict', '같은 복구 요청에 다른 골격이 선택됐습니다.', 409)
                if read_json(root/'current.json').get('id') != request_id:
                    return {**{name: previous.get(name) for name in ('id', 'request_key', 'source_job_id', 'source_version')},
                            'status': 'paused', 'can_start': False, 'error': '이후 접수된 골격 복구 작업을 확인해 주세요.'}, None
                state = self.get(owner, job_id, during_pipeline=during_pipeline)
                if state['status'] == 'paused':
                    previous.update(status='accepted', process=identity(), error=None)
                    self._save(root, directory, previous)
                return self.get(owner, job_id, during_pipeline=during_pipeline), request_id if previous['status'] == 'accepted' else None
            if source_job_id == job_id or not self.get(owner, job_id, during_pipeline=during_pipeline)['can_start']:
                raise PipelineError('transfer_unavailable', '현재 골격 복구를 시작할 수 없습니다.', 409)
            source_job = self.factory.get(owner, source_job_id)
            library = StudioLibrary(self.factory, owner)
            metadata = library.metadata()
            if (library.is_job_deleted(source_job, metadata)
                    or metadata['parts'].get(f'{source_job_id}:body', {}).get('deleted')):
                raise PipelineError('body_deleted', '삭제한 기본 몸은 갤러리 휴지통에서 복원한 뒤 선택하세요.', 409)
            if source_job.get('production_mode') != 'character_parts' or source_job.get('base_job_id'):
                raise PipelineError('invalid_rig_source', '완료된 기본 몸의 골격을 선택하세요.', 422)
            donor = AvatarNativeParts(self.factory).artifact(owner, source_job_id, source_version, 'body.glb')
            planned = (read_json(root.parent.parent/'pipeline.json').get('base_body_setup') or {}).get('rig_source')
            if planned and ((planned['job_id'], planned['version']) != (source_job_id, source_version)
                            or planned['body_sha256'] != digest(donor)):
                raise PipelineError('rig_source_changed', '접수한 기본 몸의 골격 원본이 변경되었습니다.', 409)
            body = self.factory.artifact(owner, job_id, 'generated-body.glb')
            doc, _ = parse_glb(donor.read_bytes(), strict=True)
            if not doc.get('skins'):
                raise PipelineError('invalid_rig_source', '선택한 몸에 저장된 골격이 없습니다.', 422)
            record = {'id': request_id, 'request_key': key, 'status': 'accepted', 'source_job_id': source_job_id,
                      'source_version': source_version, 'process': identity(), 'created_at': now(), 'error': None}
            payload = {'body': str(body), 'body_sha256': digest(body), 'donor': str(donor),
                       'donor_sha256': digest(donor), 'output': str(directory),
                       'worker_sha256': digest(Path(__file__).with_name('avatar_rig_transfer_blender.py')),
                       'binding_sha256': digest(Path(__file__).with_name('avatar_blender_common.py'))}
            directory.mkdir(parents=True, exist_ok=True)
            _write_json(directory/'input.json', payload)
            _write_json(directory/'previous-worker.json', read_json(root.parent/'worker.json'))
            _write_json(directory/'record.json', record)
            _write_json(root/'current.json', {'id': request_id})
            _write_json(root.parent/'worker.json', {**record, 'origin': 'rig_transfer'})
        return self.get(owner, job_id), request_id

    def recover_rejected(self, owner, job_id):
        """One local fallback in the accepted character pipeline; never another paid POST."""
        job = self.factory.get(owner, job_id)
        root = self.root(owner, job_id)
        # An existing recovery stays under its own receipt and explicit resume UI.
        # Donor clips cannot silently replace Meshy actions the operator chose; the
        # server-filled default actions may be replaced by the donor's saved clips.
        # Jobs accepted before the flag existed keep the earlier rule.
        pipeline = read_json(root.parent.parent/'pipeline.json')
        explicit_actions = pipeline.get('motion_actions_explicit', bool(pipeline.get('motion_actions')))
        if not job.get('auto_assemble') or read_json(root/'current.json') or explicit_actions:
            return False
        state = self.get(owner, job_id, during_pipeline=True)
        source = state.get('recommended_source')
        if not state['can_start'] or not source:
            return False
        _, request_id = self.start(owner, job_id, source['job_id'], source['version'],
                                   'auto-rig-'+job_id, during_pipeline=True)
        if request_id:
            self.execute(owner, job_id, request_id)
        return True

    def execute(self, owner, job_id, request_id):
        root = self.root(owner, job_id)
        directory = root/request_id
        # Lock order is the same as native assembly: local_workspace (per-directory
        # scratch lock) first, then the shared BLENDER_CONCURRENCY queue, released as
        # soon as Blender exits. Taking the queue before the workspace would invert
        # that order. The queue is also released before assemble_character below,
        # which takes it again for the assembly worker (the semaphore is not reentrant).
        with run_lock(directory, 0, blender=False):
            record = read_json(directory/'record.json')
            if record.get('status') != 'accepted' or read_json(root/'current.json').get('id') != request_id:
                return
            record.update(status='running', process=identity(), error=None)
            self._save(root, directory, record)
            try:
                payload = read_json(directory/'input.json')
                if (payload['worker_sha256'] != digest(Path(__file__).with_name('avatar_rig_transfer_blender.py'))
                        or payload['binding_sha256'] != digest(Path(__file__).with_name('avatar_blender_common.py'))):
                    raise ValueError('Rig transfer worker changed')
                with local_workspace(directory, inputs=[payload['body'], payload['donor']]):
                    command = [blender_executable(), '--background', '--factory-startup', '--disable-autoexec',
                               '--python-exit-code', '1', '--python', str(Path(__file__).with_name('avatar_rig_transfer_blender.py')),
                               '--', str(directory/'input.json')]
                    with _QUEUE, blender_process(command, directory/'blender.log', directory/'runner.json',
                                                 write_json=_write_json) as process:
                        try:
                            code = process.wait(timeout=1200)
                        except subprocess.TimeoutExpired:
                            stop_process(process)
                            raise
                    if code:
                        raise ValueError('Rig transfer failed')
                self._publish(root, directory, record, payload)
                record.update(status='complete', error=None)
                self._save(root, directory, record)
            except Exception as exc:
                record.update(status='paused', error='저장된 골격 연결이 중단됐습니다. 원본 몸과 파츠는 보존했습니다.',
                              error_type=type(exc).__name__)
                self._save(root, directory, record)
                return
        # Release the workspace and run lock before normal parts assembly.
        from src.services.avatar_character_flow import assemble_character
        assemble_character(self.factory, owner, job_id)

    @staticmethod
    def _save(root, directory, record):
        record['updated_at'] = now()
        _write_json(directory/'record.json', record)
        _write_json(root.parent/'worker.json', {**record, 'origin': 'rig_transfer'})

    @staticmethod
    def _publish(root, directory, record, payload):
        seal = read_json(directory/'complete.json')
        if seal.get('input_sha256') != digest(directory/'input.json'):
            raise ValueError('Rig transfer receipt changed')
        for name in ('model.glb', 'master.blend'):
            if digest(directory/name) != seal.get('files', {}).get(name):
                raise ValueError('Rig transfer output changed')
        model_hash = seal['files']['model.glb']
        version = hashlib.sha256((model_hash+payload['body_sha256']+payload['donor_sha256']).encode()).hexdigest()[:24]
        output = root.parent/'versions'/version
        output.mkdir(parents=True, exist_ok=True)
        copy_file(directory/'model.glb', output/'model.glb')
        receipt = {'version': version, 'origin': 'transferred_meshy_rig', 'source_sha256': payload['body_sha256'],
                   'source_job_id': record['source_job_id'], 'source_version': record['source_version'],
                   'source_rig_sha256': payload['donor_sha256'], 'files': {'model.glb': model_hash},
                   'bone_count': seal['result']['bone_count'], 'clips': seal['result']['clips'],
                   'visual_review': 'required'}
        _write_json(output/'receipt.json', receipt)
        _write_json(root.parent/'delivery.json', receipt)
