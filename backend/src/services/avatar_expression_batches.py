"""Five frozen eyes/nose/mouth overlay requests with resumable per-image receipts."""
import hashlib
import json
import re
from threading import Lock

from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK
from src.services.avatar_expression_generation import expression_lease
from src.services.character_pipeline import PipelineError, now, read_json
from src.services.process_identity import identity, state as process_state
from src.services.studio_prompts import StudioPrompts

NAMES = ('neutral', 'smile', 'cry', 'angry', 'surprise')
_WORKERS = {}


class AvatarExpressionBatches:
    def __init__(self, generation):
        self.generation = generation
        self.root = generation.body.parent/'expression-batches'

    def directory(self, batch_id):
        if not re.fullmatch(r'[a-f0-9]{24}', batch_id):
            raise PipelineError('not_found', '표정 일괄 작업을 찾을 수 없습니다.', 404)
        return self.root/batch_id

    def _record(self, batch_id):
        record = read_json(self.directory(batch_id)/'record.json')
        if (not record or record.get('job_id') != self.generation.job
                or record.get('body_version') != self.generation.version):
            raise PipelineError('not_found', '표정 일괄 작업을 찾을 수 없습니다.', 404)
        return record

    def _save(self, record):
        record['updated_at'] = now()
        _write_json(self.directory(record['id'])/'record.json', record)

    def listing(self):
        items = [self.get(path.parent.name) for path in self.root.glob('*/record.json')]
        return sorted(items, key=lambda item: item['created_at'], reverse=True)

    def get(self, batch_id):
        record = self._record(batch_id)
        alive = record['status'] in ('accepted', 'running') and process_state(record.get('process')) != 'exited'
        items, resumable = [], False
        for name in record['names']:
            generation_id = record.get('generations', {}).get(name)
            item = self.generation.get(generation_id) if generation_id else None
            resumable |= item is None or item['can_resume']
            items.append({'name': name, 'generation_id': generation_id,
                          'status': item['status'] if item else 'pending',
                          'error': item.get('error') if item else None})
        complete = all(item['status'] == 'complete' for item in items)
        child_running = any(item['status'] == 'running' for item in items)
        status = ('complete' if complete else record['status'] if alive else 'running' if child_running
                  else 'paused' if resumable else 'blocked')
        return {**{key: record[key] for key in ('id', 'request_key', 'created_at')},
                'status': status, 'items': items, 'error': None if complete else record.get('error'),
                'can_resume': bool(not complete and resumable and not child_running
                                   and (not alive or status == 'accepted'))}

    def create(self, key, payload):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}', key):
            raise PipelineError('invalid_key', '요청 식별자가 필요합니다.', 422)
        generation = self.generation
        assets = payload['reference_assets']
        fingerprint = hashlib.sha256(json.dumps({'reference_assets': assets,
            'body_sha256': generation.body_sha256}, sort_keys=True).encode()).hexdigest()
        batch_id = hashlib.sha256(
            f'{generation.owner}:{generation.job}:{generation.version}:expression-batch:{key}'.encode()).hexdigest()[:24]
        with _LOCK, expression_lease(self.directory(batch_id)):
            previous = read_json(self.directory(batch_id)/'record.json')
            if previous:
                if previous['fingerprint'] != fingerprint:
                    raise PipelineError('idempotency_conflict', '같은 요청 키에 다른 눈·코·입 원본이 있습니다.', 409)
                return self.get(batch_id), previous['status'] == 'accepted'
            if not generation.capabilities()['ready']:
                raise PipelineError('provider_unavailable', 'S3와 OpenAI 이미지 생성 연결을 확인해 주세요.', 503)
            from src.services.avatar_expression_references import AvatarExpressionReferences
            AvatarExpressionReferences(generation.factory, generation.owner, generation.job).sources(assets)
            prompts = StudioPrompts(generation.factory, generation.owner).values('expression')
            record = {'id': batch_id, 'request_key': key, 'fingerprint': fingerprint,
                      'job_id': generation.job, 'body_version': generation.version,
                      'body_sha256': generation.body_sha256, 'reference_assets': list(assets),
                      'names': list(NAMES), 'prompts': {name: prompts[name] for name in NAMES},
                      'generations': {}, 'max_image_tasks': len(NAMES), 'status': 'accepted',
                      'process': identity(), 'created_at': now(), 'error': None}
            self.directory(batch_id).mkdir(parents=True, exist_ok=True)
            self._save(record)
        return self.get(batch_id), True

    def resume(self, batch_id):
        with _LOCK, expression_lease(self.directory(batch_id)):
            public = self.get(batch_id)
            if not public['can_resume']:
                return public, False
            record = self._record(batch_id)
            record.update(status='accepted', process=identity(), error=None)
            self._save(record)
        return self.get(batch_id), True

    def execute(self, batch_id):
        with _LOCK:
            lock = _WORKERS.setdefault(str(self.directory(batch_id)), Lock())
        if not lock.acquire(blocking=False):
            return
        try:
            with expression_lease(self.directory(batch_id)):
                record = self._record(batch_id)
                if record['status'] != 'accepted':
                    return
                record.update(status='running', process=identity(), error=None)
                self._save(record)
            errors = []
            for name in record['names']:
                try:
                    generation_id = record['generations'].get(name)
                    if not generation_id:
                        # A lost batch write recovers the same child, never a new paid request.
                        item, _ = self.generation.create(f'expression-batch-{batch_id}-{name}', {
                            'name': name, 'prompt': record['prompts'][name],
                            'reference_assets': record['reference_assets']})
                        generation_id = item['id']
                        record['generations'][name] = generation_id
                        self._save(record)
                    item = self.generation.get(generation_id)
                    if item['status'] != 'complete' and item['can_resume']:
                        _, dispatch = self.generation.resume(generation_id)
                        if dispatch:
                            self.generation.execute(generation_id)
                        item = self.generation.get(generation_id)
                    if item['status'] != 'complete':
                        errors.append(item.get('error') or f'{name}: 표정 이미지 수신 대기')
                except Exception as exc:
                    errors.append(exc.message if isinstance(exc, PipelineError) else f'{name}: 표정 생성 처리 중단')
            record.update(status='paused' if errors else 'complete', error=' / '.join(errors) or None)
            self._save(record)
        except Exception as exc:
            if isinstance(exc, PipelineError) and exc.code == 'worker_active':
                return
            record = self._record(batch_id)
            record.update(status='paused', error=exc.message if isinstance(exc, PipelineError) else '표정 일괄 처리 중단')
            self._save(record)
        finally:
            lock.release()
