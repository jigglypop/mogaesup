"""Hash-bound operator reviews kept outside immutable native assembly receipts."""
from copy import deepcopy
import hashlib
import json
import re

from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, digest
from src.services.character_pipeline import PipelineError, now, read_json, require_request_key
from src.services.runtime_activity import running_task
from src.services.run_lock import run_lock


class AvatarNativeReviews:
    def __init__(self, factory):
        self.factory = factory

    def directory(self, owner, job, version):
        self.factory.get(owner, job)
        if not re.fullmatch(r'[a-f0-9]{24}', version):
            raise PipelineError('not_found', '조립 버전을 찾을 수 없습니다.', 404)
        return self.factory.directory(owner, job)/'native-parts'/version

    @staticmethod
    def fingerprint(record):
        value = {'files': record.get('files', {}), 'result': record.get('result', {})}
        return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

    @staticmethod
    def intact(directory, record):
        files = record.get('files', {})
        if not files.get('model.glb'):
            return False
        # Validate every published artifact, including renders and quality.json.
        for name, expected in files.items():
            if not re.fullmatch(r'[a-zA-Z0-9_.-]+', name) or name in ('.', '..'):
                return False
            path = directory/name
            if not path.is_file() or digest(path) != expected:
                return False
        return True

    def overlay(self, owner, job, version, record):
        directory = self.factory.directory(owner, job)/'native-parts'/version
        stored = read_json(directory/'reviews.json')
        review = stored.get('latest')
        if not review:
            return {'status': 'required'}
        valid = (record.get('status') == 'review_required'
                 and review.get('target_fingerprint') == self.fingerprint(record)
                 and self.intact(directory, record))
        return {**deepcopy(review), 'status': review['decision'] if valid else 'stale'}

    @running_task()
    def submit(self, owner, job, version, key, payload, *, reviewer_name=None):
        require_request_key(key)
        directory = self.directory(owner, job, version)
        if payload.get('decision') not in ('approved', 'changes_requested'):
            raise PipelineError('invalid_review', '검수 결정을 확인해 주세요.', 422)
        if not isinstance(payload.get('notes'), str) or not 5 <= len(payload['notes'].strip()) <= 2000:
            raise PipelineError('invalid_review', '검수 내용을 5~2000자로 입력해 주세요.', 422)
        if not re.fullmatch(r'[a-f0-9]{64}', str(payload.get('expected_assembly_sha256', ''))):
            raise PipelineError('invalid_review', '조립 모델 해시를 확인해 주세요.', 422)
        if any(type(payload.get(field)) is not bool for field in ('appearance_checked', 'motion_checked')):
            raise PipelineError('invalid_review', '외형과 동작 확인 여부가 필요합니다.', 422)
        submitted = {**payload, 'notes': payload['notes'].strip()}
        fingerprint = hashlib.sha256(json.dumps(submitted, sort_keys=True).encode()).hexdigest()
        receipt_key = hashlib.sha256(f'{owner}:{key}'.encode()).hexdigest()
        try:
            with _LOCK, run_lock(directory/'review-write', 0, blender=False):
                record = read_json(directory/'record.json')
                current = read_json(directory.parent/'current.json').get('version')
                if current != version or record.get('status') != 'review_required':
                    raise PipelineError('assembly_changed', '현재 완료된 조립 버전을 다시 확인해 주세요.', 409)
                if record.get('files', {}).get('model.glb') != submitted['expected_assembly_sha256']:
                    raise PipelineError('assembly_changed', '검토한 조립 모델이 변경되었습니다.', 409)
                if not self.intact(directory, record):
                    raise PipelineError('artifact_changed', '조립 산출물 검증을 통과하지 못했습니다.', 409)
                stored = read_json(directory/'reviews.json', {'receipts': {}})
                old = stored.get('receipts', {}).get(receipt_key)
                if old:
                    if old['fingerprint'] != fingerprint:
                        raise PipelineError('idempotency_conflict', '같은 요청 식별자의 검수 내용이 변경되었습니다.', 409)
                    return deepcopy(old['review'])
                from src.services.avatar_native_parts import AvatarNativeParts
                state = AvatarNativeParts(self.factory).get(owner, job, version)
                if state.get('expression_pending'):
                    raise PipelineError('expression_pending', '표정 적용이 완료된 뒤 검수해 주세요.', 409)
                if submitted['decision'] == 'approved':
                    if not submitted['appearance_checked'] or not submitted['motion_checked']:
                        raise PipelineError('review_required', '외형과 동작을 확인한 뒤 승인해 주세요.', 409)
                    if state.get('incomplete_parts'):
                        raise PipelineError('assembly_incomplete', '미완성 파츠를 해결한 뒤 승인해 주세요.', 409)
                    from src.services.asset_delivery import inspect_glb
                    if inspect_glb((directory/'model.glb').read_bytes(), budget_warnings=True)['errors']:
                        raise PipelineError('technical_failure', '모델 구조 오류를 해결한 뒤 승인해 주세요.', 409)
                    if not {'front.png', 'side.png', 'back.png', 'opposite.png', 'motion.png'} <= record.get('files', {}).keys():
                        raise PipelineError('review_evidence_missing', '네 방향과 동작 검수 산출물이 필요합니다.', 409)
                review = {'id': receipt_key[:24], 'version': version,
                          'assembly_sha256': submitted['expected_assembly_sha256'],
                          'target_fingerprint': self.fingerprint(record),
                          'decision': submitted['decision'], 'appearance_checked': submitted['appearance_checked'],
                          'motion_checked': submitted['motion_checked'], 'notes': submitted['notes'],
                          'reviewer_id': owner, 'reviewer_name': reviewer_name or str(owner), 'reviewed_at': now()}
                _write_json(directory/'reviews.json', {'latest': review,
                    'receipts': {**stored.get('receipts', {}), receipt_key: {'fingerprint': fingerprint, 'review': review}}})
                return deepcopy(review)
        except ValueError as exc:
            raise PipelineError('review_busy', '다른 검수 작업이 진행 중입니다.', 409) from exc
