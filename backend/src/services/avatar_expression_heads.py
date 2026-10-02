"""Local, topology-preserving head variants derived from sealed expression bodies."""
from src.services.avatar_factory import digest
from src.services.avatar_native_parts import AvatarNativeParts
from src.services.character_pipeline import PipelineError, read_json


class AvatarExpressionHeads:
    def __init__(self, factory, owner, job, version):
        self.factory, self.owner, self.job, self.version = factory, owner, job, version
        self.native = AvatarNativeParts(factory).artifact(owner, job, version, 'body.glb')
        self.root = self.native.parent/'expression-heads'

    def _record(self):
        return read_json(self.root/'record.json')

    def _artifact(self, name, expected):
        path = self.root/name
        return path.is_file() and digest(path) == expected

    def public(self):
        record = self._record()
        if not record:
            return None
        body = record.get('body_without_head', {})
        base = record.get('base_head', {})
        if not self._artifact(body.get('name', ''), body.get('sha256')) or not self._artifact(base.get('name', ''), base.get('sha256')):
            return None
        prefix = f'/api/studio/bodies/{self.job}/{self.version}/expression-heads'
        expressions = {}
        for expression_id, item in record.get('expressions', {}).items():
            if not self._artifact(item.get('name', ''), item.get('sha256')):
                return None
            expressions[expression_id] = {**item, 'url': f'{prefix}/{expression_id}/head.glb'}
        return {
            'body_without_head': {**body, 'url': f'{prefix}/body-without-head.glb'},
            'base_head': {**base, 'url': f'{prefix}/base-head.glb'},
            'expressions': expressions,
            'recipe': record.get('recipe'), 'created_at': record.get('created_at'),
        }

    def artifact(self, expression_id, name):
        public = self.public()
        if not public:
            raise PipelineError('not_found', '머리 분리 파일을 찾을 수 없습니다.', 404)
        if expression_id is None and name in ('body-without-head.glb', 'base-head.glb'):
            item = public['body_without_head' if name == 'body-without-head.glb' else 'base_head']
        elif expression_id in public['expressions'] and name == 'head.glb':
            item = public['expressions'][expression_id]
        else:
            raise PipelineError('not_found', '머리 분리 파일을 찾을 수 없습니다.', 404)
        return self.root/item['name']
