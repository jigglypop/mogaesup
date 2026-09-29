"""Owner-scoped facial-feature artwork, separate from the body reference."""
import hashlib
import json
import os
import re

from src.services.asset_editor import _write_json
from src.services.avatar_blueprints import AvatarBlueprints
from src.services.avatar_factory import _LOCK
from src.services.character_pipeline import PipelineError, now, read_json


class AvatarExpressionReferences:
    def __init__(self, factory, owner, job):
        factory.get(owner, job)
        self.factory, self.owner = factory, owner
        self.path = factory.directory(owner, job)/'expression-reference.json'

    def sources(self, assets):
        if (not isinstance(assets, list) or not 1 <= len(assets) <= 3
                or len(set(assets)) != len(assets)
                or any(not isinstance(item, str) or not re.fullmatch(r'[a-f0-9]{64}', item) for item in assets)):
            raise PipelineError('invalid_expression_reference', '눈·코·입 원본 PNG를 1~3장 등록해 주세요.', 422)
        blueprints = AvatarBlueprints(self.factory.data)
        roles = ({1: ['face-features.png'],
                  2: ['eyes.png', 'mouth.png'],
                  3: ['eyes.png', 'nose.png', 'mouth.png']}[len(assets)])
        return [(blueprints.asset(self.owner, asset), role, asset) for asset, role in zip(assets, roles)]

    def get(self):
        record = read_json(self.path)
        assets = record.get('assets', [])
        roles = ({1: ['face-features.png'], 2: ['eyes.png', 'mouth.png'],
                  3: ['eyes.png', 'nose.png', 'mouth.png']}.get(len(assets), []))
        return {'revision': record.get('revision', '0'), 'updated_at': record.get('updated_at'),
                'assets': [{'id': asset, 'role': roles[index],
                            'url': f'/api/avatar-blueprints/assets/{asset}'}
                           for index, asset in enumerate(assets)]}

    def save(self, assets, revision):
        if not os.getenv('ASSET_S3_BUCKET', '').strip():
            raise PipelineError('storage_required', 'S3 저장소 설정이 필요합니다.', 503)
        if assets:
            self.sources(assets)
        with _LOCK:
            previous = read_json(self.path)
            if previous.get('assets', []) == assets:
                return self.get()
            if previous.get('revision', '0') != revision:
                raise PipelineError('revision_conflict', '다른 화면에서 눈·코·입 원본이 변경되었습니다. 다시 불러와 주세요.', 409)
            record = {'assets': assets, 'updated_at': now()}
            record['revision'] = hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
            _write_json(self.path, record)
        return self.get()
