"""Saved combinations of sealed native parts, scoped to owner/job/version."""
import hashlib
import json
import re

from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK
from src.services.character_pipeline import PipelineError, now, read_json


class AvatarNativeOutfits:
    def __init__(self, native):
        self.native = native

    def _context(self, owner, job, version):
        if not re.fullmatch(r'[a-f0-9]{24}', version):
            raise PipelineError('not_found', '조립 버전을 찾을 수 없습니다.', 404)
        root = self.native.root(owner, job) / version
        record = read_json(root / 'record.json')
        if record.get('status') != 'review_required':
            raise PipelineError('assembly_not_ready', '저장된 조립 파츠가 필요합니다.', 409)
        slots = [p['slot'] for p in record['result']['parts']
                 if p['slot'] != 'body' and p.get('available', True)
                 and f'{p["slot"]}.glb' in record['files']]
        return root, record['files']['body.glb'], slots

    def get(self, owner, job, version):
        with _LOCK:
            root, body_hash, slots = self._context(owner, job, version)
            current = read_json(root / 'selection.json').get('current')
            if current:
                if current['body_sha256'] != body_hash:
                    raise PipelineError('assembly_changed', '조립 몸의 파일 버전이 변경되었습니다.', 409)
                return current
            return {'version': version, 'body_sha256': body_hash, 'revision': '0', 'slots': slots}

    def put(self, owner, job, version, payload, expected_revision, key):
        payload = dict(payload)
        if payload.get('hair_color') is None:
            payload.pop('hair_color', None)
        elif not re.fullmatch('#[0-9a-fA-F]{6}', payload['hair_color']):
            raise PipelineError('invalid_color', '헤어 색상을 선택하세요.', 422)
        if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}', key):
            raise PipelineError('invalid_key', '저장 요청 식별자가 필요합니다.', 422)
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        key_hash = hashlib.sha256(key.encode()).hexdigest()
        with _LOCK:
            root, body_hash, allowed = self._context(owner, job, version)
            path = root / 'selection.json'
            state = read_json(path) or {'receipts': {}}
            receipt = state['receipts'].get(key_hash)
            if receipt:
                if receipt['fingerprint'] != fingerprint:
                    raise PipelineError('idempotency_conflict', '같은 저장 요청의 조합이 변경되었습니다.', 409)
                return receipt['result']
            if payload['body_sha256'] != body_hash:
                raise PipelineError('assembly_changed', '고정한 조립 몸 버전이 다릅니다.', 409)
            current = self.get(owner, job, version)
            if expected_revision != current['revision']:
                raise PipelineError('revision_conflict', '저장된 조합이 변경되었습니다. 다시 불러오세요.', 409)
            slots = payload['slots']
            if len(slots) != len(set(slots)) or any(slot not in allowed for slot in slots):
                raise PipelineError('invalid_parts', '이 조립 버전의 파츠만 한 번씩 선택할 수 있습니다.', 422)
            for name in ['body.glb', *(f'{slot}.glb' for slot in slots)]:
                self.native.artifact(owner, job, version, name)
            saved_at = now()
            revision = hashlib.sha256(f'{current["revision"]}:{fingerprint}:{key_hash}:{saved_at}'.encode()).hexdigest()
            result = {'version': version, 'body_sha256': body_hash, 'revision': revision,
                      'slots': list(slots), 'hair_color': payload.get('hair_color'), 'saved_at': saved_at}
            state['current'] = result
            state['receipts'][key_hash] = {'fingerprint': fingerprint, 'result': result}
            _write_json(path, state)
            return result
