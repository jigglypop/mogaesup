"""Owner-scoped library for immutable uploaded GLB assets."""
from copy import deepcopy
import hashlib
import json
import re

from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, digest
from src.services.avatar_fitting_management import FittingManagement
from src.services.avatar_glb_bodies import AvatarGlbBodies
from src.services.avatar_variants import AvatarVariants
from src.services.character_pipeline import PipelineError, now, read_json


SLOTS = ('body', 'hair', 'hat', 'top', 'bottom', 'shoes', 'weapon', 'tool', 'glasses', 'prop')
FIT_SLOTS = frozenset(SLOTS) - {'body', 'prop'}


def _fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class StudioGlbAssets:
    def __init__(self, factory, owner):
        self.factory, self.owner = factory, int(owner)
        self.uploads = AvatarGlbBodies(factory)
        self.root = factory.root/str(self.owner)/'glb-assets'

    def _directory(self, asset_id):
        if not re.fullmatch(r'[a-f0-9]{24}', asset_id):
            raise PipelineError('not_found', 'GLB 에셋을 찾을 수 없습니다.', 404)
        return self.root/asset_id

    def upload(self, content):
        return self.uploads.upload(self.owner, content)

    def create(self, key, payload):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}', key):
            raise PipelineError('invalid_key', '요청 식별자는 8~100자의 영문, 숫자, 밑줄, 하이픈이어야 합니다.', 422)
        name = payload.get('name')
        slot = payload.get('slot')
        model_asset = payload.get('model_asset')
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
            raise PipelineError('invalid_name', '이름은 1~100자로 입력해 주세요.', 422)
        if slot not in SLOTS:
            raise PipelineError('invalid_slot', '지원하는 에셋 슬롯을 선택해 주세요.', 422)
        info = self.uploads.asset(self.owner, model_asset)
        source_path = self.uploads._asset_root(self.owner, model_asset)/'source.glb'
        if digest(source_path) != model_asset:
            raise PipelineError('source_changed', '등록한 GLB 원본이 변경되었습니다.', 409)
        submitted = {'name': name.strip(), 'slot': slot, 'model_asset': model_asset}
        fingerprint = _fingerprint(submitted)
        asset_id = hashlib.sha256(f'{self.owner}:studio-glb:{key}'.encode()).hexdigest()[:24]
        directory = self._directory(asset_id)
        with _LOCK:
            previous = read_json(directory/'record.json')
            if previous:
                if previous.get('fingerprint') != fingerprint:
                    raise PipelineError('idempotency_conflict', '같은 요청 식별자에 다른 GLB 에셋 정보가 있습니다.', 409)
                return self.get(asset_id), False
            record = {
                'id': asset_id,
                'name': submitted['name'],
                'slot': slot,
                'model_asset': model_asset,
                'created_at': now(),
                'source': {'url': f'/api/studio/glb-assets/{asset_id}/source.glb', 'sha256': model_asset},
                'info': deepcopy(info),
                'operations': [],
                'fingerprint': fingerprint,
                'deleted': False,
            }
            directory.mkdir(parents=True, exist_ok=True)
            _write_json(directory/'record.json', record)
        return self.get(asset_id), True

    def listing(self):
        items = [self.get(path.parent.name) for path in self.root.glob('*/record.json')]
        return {'items': sorted(items, key=lambda item: item['created_at'], reverse=True)}

    def _saved(self, asset_id, *, verify_content=False):
        record = read_json(self._directory(asset_id)/'record.json')
        if not record or record.get('id') != asset_id or record.get('deleted'):
            raise PipelineError('not_found', 'GLB 에셋을 찾을 수 없습니다.', 404)
        source_record = record.get('source')
        if (record.get('slot') not in SLOTS
                or not re.fullmatch(r'[a-f0-9]{64}', record.get('model_asset', ''))
                or not isinstance(source_record, dict)
                or source_record.get('url') != f'/api/studio/glb-assets/{asset_id}/source.glb'
                or source_record.get('sha256') != record.get('model_asset')):
            raise PipelineError('invalid_record', '저장된 GLB 에셋 기록이 올바르지 않습니다.', 409)
        info = self.uploads.asset(self.owner, record['model_asset'])
        source = self.uploads._asset_root(self.owner, record['model_asset'])/'source.glb'
        if info.get('id') != source_record['sha256'] or record.get('info') != info:
            raise PipelineError('source_changed', '등록한 GLB 원본 영수증이 변경되었습니다.', 409)
        if verify_content and digest(source) != record['model_asset']:
            raise PipelineError('source_changed', '등록한 GLB 원본이 변경되었습니다.', 409)
        return record

    def get(self, asset_id):
        record = deepcopy(self._saved(asset_id))
        record.pop('fingerprint', None)
        record.pop('deleted', None)
        for operation in record.get('operations', []):
            try:
                child = self.factory.get(self.owner, operation['job_id'])
                operation['status'] = child.get('status', operation.get('status'))
                operation['error'] = child.get('error')
            except PipelineError:
                operation['status'] = 'missing'
                operation['error'] = '연결된 공장 작업을 찾을 수 없습니다.'
        return record

    def source(self, asset_id):
        record = self._saved(asset_id, verify_content=True)
        return self.uploads._asset_root(self.owner, record['model_asset'])/'source.glb'

    def _recover_fit(self, job_id):
        """Claim an interrupted imported-model child without creating any provider request."""
        job = self.factory.get(self.owner, job_id)
        status = job.get('status')
        if status == 'pipeline_queued':
            return job, True
        if status == 'pipeline_running':
            return job, False
        if status == 'review_required':
            from src.services.avatar_native_parts import AvatarNativeParts
            native = AvatarNativeParts(self.factory).get(self.owner, job_id)
            if native.get('status') == 'review_required' and not native.get('expression_pending'):
                return job, False
            if native.get('status') in ('accepted', 'running'):
                return job, False
        if status in ('pipeline_paused', 'failed', 'recovery_required', 'review_required'):
            from src.services.avatar_image_pipeline import AvatarImagePipeline
            job = AvatarImagePipeline(self.factory).resume(self.owner, job_id, stage='models')
            return job, True
        return job, False

    def prepare(self, asset_id, key, payload):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}', key):
            raise PipelineError('invalid_key', '요청 식별자는 8~100자의 영문, 숫자, 밑줄, 하이픈이어야 합니다.', 422)
        record = self._saved(asset_id, verify_content=True)
        submitted = deepcopy(payload)
        fingerprint = _fingerprint(submitted)
        request_id = hashlib.sha256(key.encode()).hexdigest()
        receipt_path = self._directory(asset_id)/'prepare-requests'/f'{request_id}.json'
        previous = read_json(receipt_path)
        if previous:
            if previous.get('fingerprint') != fingerprint:
                raise PipelineError('idempotency_conflict', '같은 요청 식별자에 다른 준비 옵션이 있습니다.', 409)
            if previous.get('action') == 'fit':
                return self._recover_fit(previous['job_id'])
            return self.factory.get(self.owner, previous['job_id']), False

        action = submitted.get('action')
        slot = record['slot']
        if action == 'rig':
            if slot != 'body':
                raise PipelineError('invalid_action', '본체 GLB만 리깅할 수 있습니다.', 422)
            child_key = 'glbrig_'+hashlib.sha256(f'{asset_id}:{key}'.encode()).hexdigest()[:40]
            job, created = self.uploads.create(self.owner, child_key, {
                'name': record['name'], 'body_type': submitted.get('body_type') or 'male',
                'model_asset': record['model_asset'], 'import_mode': 'rig',
                'generate_motions': False, 'prepare_expression_uv': False,
            })
        elif action == 'fit':
            if slot not in FIT_SLOTS:
                raise PipelineError('invalid_action', '이 슬롯은 본체 피팅을 지원하지 않습니다.', 422)
            base_job_id = submitted.get('base_job_id')
            base_version = submitted.get('base_version')
            if bool(base_job_id) != bool(base_version):
                raise PipelineError('invalid_base', '기준 본체 작업과 버전을 함께 선택해 주세요.', 422)
            if not base_job_id:
                default = FittingManagement(self.factory, self.owner).body_default().get('body') or {}
                base_job_id, base_version = default.get('job_id'), default.get('version')
            if not base_job_id or not base_version:
                raise PipelineError('base_required', '먼저 공통 기준 본체를 선택해 주세요.', 422)
            child_key = 'glbfit_'+hashlib.sha256(f'{asset_id}:{key}'.encode()).hexdigest()[:40]
            source = self.uploads._asset_root(self.owner, record['model_asset'])/'source.glb'
            job, created = AvatarVariants(self.factory).create_single_part(self.owner, child_key, {
                'base_job_id': base_job_id, 'base_version': base_version, 'slot': slot,
                'hair_length': 'source', 'bottom_kind': 'source', 'part_name': record['name'],
                'uploaded_model': {'asset_id': record['model_asset'], 'path': str(source),
                                   'sha256': record['model_asset']},
            })
        else:
            raise PipelineError('invalid_action', 'fit 또는 rig 작업을 선택해 주세요.', 422)

        operation = {'id': hashlib.sha256(f'{asset_id}:{key}:{action}'.encode()).hexdigest()[:24],
                     'action': action, 'job_id': job['id'], 'status': job.get('status'),
                     'error': job.get('error')}
        with _LOCK:
            current = self._saved(asset_id)
            operations = current.setdefault('operations', [])
            existing = next((item for item in operations if item['id'] == operation['id']), None)
            if existing and (existing.get('action'), existing.get('job_id')) != (action, job['id']):
                raise PipelineError('idempotency_conflict', '저장된 준비 작업 정보가 일치하지 않습니다.', 409)
            if not existing:
                operations.append(operation)
                _write_json(self._directory(asset_id)/'record.json', current)
            receipt_path.parent.mkdir(parents=True, exist_ok=True)
            _write_json(receipt_path, {'fingerprint': fingerprint, 'input': submitted,
                                       'job_id': job['id'], 'action': action, 'created_at': now()})
        if action == 'fit':
            job, recover_dispatch = self._recover_fit(job['id'])
            return job, created or recover_dispatch
        return self.factory.get(self.owner, job['id']), created
