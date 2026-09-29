"""Accept uploaded three-view bodies unchanged."""
from copy import deepcopy
import hashlib
import json
import os
import re

from src.services.asset_editor import _write_json
from src.services.avatar_blueprints import AvatarBlueprints
from src.services.avatar_factory import IMAGE_PROFILE, _LOCK, digest
from src.services.avatar_production_spec import production_spec, seal_production_spec
from src.services.character_parts import blender_executable
from src.services.character_pipeline import PipelineError, now, read_json
from src.services.glb import parse_glb
from src.services.object_storage import copy_file
from src.services.process_identity import identity
from src.services.studio_library import StudioLibrary


VIEWS = ('front', 'side', 'back')


def _submitted_fingerprint(payload):
    value = deepcopy(payload)
    if value.get('rig_source'):
        value['rig_source'].pop('body_sha256', None)
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class AvatarBaseBodies:
    """Create one body-only factory job from immutable, owner-scoped assets."""

    def __init__(self, factory):
        self.factory = factory
        self.blueprints = AvatarBlueprints(factory.data)

    def listing(self, owner):
        return [job for job in self.factory.listing(owner) if job.get('job_kind') == 'base_body']

    def _receipt(self, owner, key):
        request_id = hashlib.sha256(key.encode()).hexdigest()[:24]
        return self.factory.root/str(int(owner))/'base-body-requests'/f'{request_id}.json'

    def _rig_source(self, owner, value):
        if not value:
            return None
        job_id, version = value['job_id'], value['version']
        source_job = self.factory.get(owner, job_id)
        metadata = StudioLibrary(self.factory, owner).metadata()
        library = StudioLibrary(self.factory, owner)
        if (source_job.get('production_mode') != 'character_parts' or source_job.get('base_job_id')
                or library.is_job_deleted(source_job, metadata)
                or metadata.get('parts', {}).get(f'{job_id}:body', {}).get('deleted')):
            raise PipelineError('invalid_rig_source', '기본 몸으로 완료된 캐릭터 작업을 선택하세요.', 422)
        root = self.factory.directory(owner, job_id)/'native-parts'/version
        record = read_json(root/'record.json')
        expected = record.get('files', {}).get('body.glb')
        body = root/'body.glb'
        if record.get('status') != 'review_required' or not expected or not body.is_file() or digest(body) != expected:
            raise PipelineError('invalid_rig_source', '선택한 기본 몸 버전의 몸 파일을 확인할 수 없습니다.', 422)
        try:
            document, _ = parse_glb(body.read_bytes(), strict=True)
        except (KeyError, TypeError, ValueError) as exc:
            raise PipelineError('invalid_rig_source', '선택한 기본 몸의 골격 파일이 올바르지 않습니다.', 422) from exc
        if not document.get('skins'):
            raise PipelineError('invalid_rig_source', '선택한 기본 몸에 저장된 골격이 없습니다.', 422)
        return {'job_id': job_id, 'version': version, 'body_sha256': expected}

    def _character(self, owner, receipt, marker, name, front):
        character_id = receipt.get('character_id')
        if not character_id:
            matches = [item for item in self.factory.pipeline.records()
                       if item.get('owner_id', self.factory.pipeline.owner) == owner and item.get('name') == marker]
            if len(matches) > 1:
                raise PipelineError('character_recovery_conflict', '기본 몸 캐릭터 접수 기록이 중복되었습니다.', 409)
            if matches:
                character_id = matches[0]['id']
            else:
                character_id = self.factory.pipeline.create(marker, 1.2, owner)['id']
            receipt = {**receipt, 'character_id': character_id, 'updated_at': now()}
            _write_json(self._receipt(owner, receipt['request_key']), receipt)

        character = self.factory.pipeline.detail(character_id, owner)
        references = [item for item in character['artifacts'] if item['id'] == 'reference']
        if front is None:
            pass  # GLB imports have no reference image before local assembly.
        elif references:
            saved = self.factory.pipeline.artifact(character_id, owner, 'reference')
            if digest(saved) != front:
                raise PipelineError('source_changed', '접수된 기본 몸 정면 원본이 변경되었습니다.', 409)
        else:
            character = self.factory.pipeline.upload(
                character_id, owner, self.blueprints.asset(owner, front).read_bytes(), 'image', character['revision'])
        if character['name'] != name:
            character = self.factory.pipeline.update(character_id, owner, {'name': name}, character['revision'])
        return character, receipt

    def create(self, owner, key, payload):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}', key):
            raise PipelineError('invalid_key', '생산 요청 식별자는 8~100자의 영문, 숫자, 밑줄, 하이픈이어야 합니다.', 422)
        canonical = json.loads(json.dumps(payload))
        submitted_fingerprint = _submitted_fingerprint(canonical)
        job_id = hashlib.sha256(f'{owner}:base-body:{key}'.encode()).hexdigest()[:24]
        directory = self.factory.directory(owner, job_id)
        receipt_path = self._receipt(owner, key)
        with _LOCK:
            saved_job = read_json(directory/'job.json')
            if saved_job:
                if _submitted_fingerprint(saved_job.get('input', {})) != submitted_fingerprint:
                    raise PipelineError('idempotency_conflict', '같은 요청 식별자에 다른 기본 몸 입력이 사용되었습니다.', 409)
                return self.factory.get(owner, job_id), False

            if not os.getenv('ASSET_S3_BUCKET', '').strip():
                raise PipelineError('storage_unavailable', '기본 몸 원본을 저장할 S3 버킷 설정이 필요합니다.', 422)
            if not os.getenv('MESHY_API_KEY', '').strip():
                raise PipelineError('meshy_unavailable', '기본 몸 3D 생성에 Meshy API 키가 필요합니다.', 422)
            if not blender_executable():
                raise PipelineError('blender_unavailable', '기본 몸 조립에 사용할 Blender 설치를 확인하세요.', 422)

            receipt = read_json(receipt_path)
            if receipt and receipt.get('submitted_fingerprint') != submitted_fingerprint:
                raise PipelineError('idempotency_conflict', '같은 요청 식별자에 다른 기본 몸 입력이 사용되었습니다.', 409)

            assets = {view: self.blueprints.asset(owner, canonical['views'][view]) for view in VIEWS}
            for view, path in assets.items():
                if digest(path) != canonical['views'][view]:
                    raise PipelineError('source_changed', f'{view} 기본 몸 원본이 변경되었습니다.', 409)
            frozen_rig = self._rig_source(owner, canonical.get('rig_source'))
            if frozen_rig:
                canonical['rig_source'] = frozen_rig
            fingerprint = hashlib.sha256(
                json.dumps(canonical, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            if receipt and receipt.get('fingerprint') != fingerprint:
                raise PipelineError('source_changed', '접수 중인 기본 몸 골격 원본이 변경되었습니다.', 409)

            if receipt:
                # Even pre-fix requests keep their originally accepted task budget.
                motion_actions = deepcopy(receipt.get('motion_actions', {}))
            elif frozen_rig:
                motion_actions = {}
            else:
                from src.services.avatar_meshy import AvatarMeshy
                meshy = AvatarMeshy(self.factory)
                motion_actions = meshy.default_actions(owner)
                meshy.validate_actions(owner, motion_actions)
            if receipt:
                meshy_texture_prompts = deepcopy(receipt.get('meshy_texture_prompts', {}))
            else:
                from src.services.studio_prompts import StudioPrompts
                meshy_texture_prompts = StudioPrompts(self.factory, owner).values('meshy_texture')
            # Freeze this before submission; recovery of older accepted requests
            # retains their original remesh setting.
            preserve_geometry = receipt.get('meshy_preserve_geometry', False) if receipt else True
            quality_profile = receipt.get('meshy_quality_profile') if receipt else 'high-v1'
            marker = f'__base_body_request_{job_id}__'
            receipt = receipt or {'revision': 'base-body-request-v1', 'request_key': key,
                                  'submitted_fingerprint': submitted_fingerprint, 'fingerprint': fingerprint,
                                  'job_id': job_id, 'marker': marker,
                                  'input': canonical, 'motion_actions': motion_actions,
                                  'meshy_texture_prompts': meshy_texture_prompts,
                                  'meshy_preserve_geometry': preserve_geometry,
                                  'meshy_quality_profile': quality_profile,
                                  'status': 'staging', 'created_at': now()}
            receipt_path.parent.mkdir(parents=True, exist_ok=True)
            _write_json(receipt_path, receipt)
            character, receipt = self._character(owner, receipt, marker, canonical['name'], canonical['views']['front'])

            directory.mkdir(parents=True, exist_ok=True)
            output = directory/'output'
            output.mkdir(parents=True, exist_ok=True)
            copy_file(assets['front'], directory/'source.png')
            for view in VIEWS:
                copy_file(assets[view], output/f'body-{view}.png')

            spec = production_spec('source', VIEWS)
            spec['base_body']['source_preserved'] = True
            if frozen_rig:
                spec['frozen_body'] = True
            spec = seal_production_spec(spec)
            views = {view: {'status': 'succeeded', 'file': f'body-{view}.png',
                            'sha256': canonical['views'][view], 'asset': canonical['views'][view],
                            'origin': 'uploaded_base_body'} for view in VIEWS}
            front = deepcopy(views['front'])
            setup = {'body_type': canonical['body_type'],
                     'rig_source': deepcopy(frozen_rig) if frozen_rig else None}
            state = {
                'parts': [{'slot': 'body', 'description': '', 'design_prompt': '', 'views': views,
                           'image': front, 'model': {'status': 'pending'},
                           'provenance': {'origin': 'uploaded_base_body', 'review': 'pending'}}],
                'blueprint': None, 'production_spec': spec, 'fit_profiles': {},
                'reference_preparation': None, 'default_expressions': None, 'hair_length': 'source',
                'production_mode': 'character_parts', 'design_prompts': {},
                'meshy_texture_prompts': meshy_texture_prompts,
                'meshy_preserve_geometry': preserve_geometry,
                'meshy_quality_profile': quality_profile,
                'reuse': {'source_job_id': None, 'slots': []}, 'rig_with_meshy': True,
                'motion_actions': motion_actions, 'motion_actions_explicit': False, 'body_purpose': 'wardrobe_base',
                'body_prompt': 'Preserve the supplied base-body views exactly.', 'body_height_m': 1.2,
                'base_body_setup': setup, 'uploaded_views': list(VIEWS),
                'image_provider': 'uploaded', 'image_model': None,
                'image_base': None, 'meshy_base': os.getenv('MESHY_API_BASE_URL', 'https://api.meshy.ai').rstrip('/')}
            _write_json(directory/'pipeline.json', state)
            _write_json(output/'progress.json', {'stage': 'models', 'message': '기본 몸 3D 생성 대기 중',
                                                 'images_received': 3, 'images_total': 3,
                                                 'active_images': 0})

            base_body = {'body_type': canonical['body_type'], 'views': deepcopy(canonical['views'])}
            if frozen_rig:
                base_body['rig_source'] = deepcopy(frozen_rig)
            profile = {**IMAGE_PROFILE, 'name': canonical['name'], 'height': 1.2,
                       'body_purpose': 'wardrobe_base', 'body_origin': 'uploaded_base_body',
                       'rig': 'meshy-native', 'bones': None, 'head_height': None, 'head_ratio': None,
                       'base_outfit': 'opaque_training_bodysuit'}
            job = {'id': job_id, 'job_kind': 'base_body', 'fingerprint': fingerprint,
                   'executor': self.factory.instance, 'executor_process': identity(),
                   'character_id': character['id'], 'character_name': character['name'],
                   'input_kind': 'image', 'input': canonical, 'base_body': base_body,
                   'production_mode': 'character_parts', 'auto_assemble': True,
                   'source_sha256': canonical['views']['front'], 'profile': profile,
                   'image_provider': 'uploaded', 'image_model': None, 'status': 'pipeline_queued',
                   'created_at': now(), 'updated_at': now(), 'error': None,
                   'limits': {'image_tasks': 0, 'reference_tasks': 0, 'expression_tasks': 0,
                              'meshy_tasks': 1, 'meshy_rig_tasks': 0 if frozen_rig else 1,
                              'meshy_animation_tasks': len(set(motion_actions.values()))},
                   'review': {'decision': 'pending'},
                   'parts': [{'slot': 'body', 'image_status': 'succeeded', 'image_asset': canonical['views']['front'],
                              'model_status': 'pending', 'task_id': None, 'progress': 0,
                              'provenance': {'origin': 'uploaded_base_body', 'review': 'pending'},
                              'views': {view: {key: value[key] for key in ('status', 'file', 'sha256')}
                                        for view, value in views.items()}}],
                   'production_spec': {key: deepcopy(spec[key]) for key in
                                       ('id', 'revision', 'sha256', 'body_height_m', 'axes', 'canvas',
                                        'generated_views', 'release_requires')},
                   'files': {f'body-{view}.png': canonical['views'][view] for view in VIEWS}}
            _write_json(directory/'job.json', job)
            _write_json(receipt_path, {**receipt, 'status': 'accepted', 'character_id': character['id'],
                                       'accepted_at': now(), 'updated_at': now()})
            self.factory._listings.pop(int(owner), None)
            return self.factory.get(owner, job_id), True
