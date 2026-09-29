"""Register owner-scoped GLB bodies without image or model generation."""
from copy import deepcopy
import hashlib
import json
import os
import re

from src.services.asset_delivery import DeliveryPolicy, inspect_glb
from src.services.asset_editor import _write_json
from src.services.avatar_base_bodies import AvatarBaseBodies, _submitted_fingerprint
from src.services.avatar_factory import IMAGE_PROFILE, _LOCK, digest
from src.services.avatar_production_spec import production_spec, seal_production_spec
from src.services.character_parts import blender_executable
from src.services.character_pipeline import PipelineError, now, read_json
from src.services.glb import parse_glb
from src.services.object_storage import copy_file
from src.services.process_identity import identity

MAX_GLB_BYTES = 256 * 1024 * 1024


class AvatarGlbBodies(AvatarBaseBodies):
    def _asset_root(self, owner, asset_id):
        if not re.fullmatch(r'[a-f0-9]{64}', asset_id):
            raise PipelineError('not_found', 'GLB 원본을 찾을 수 없습니다.', 404)
        return self.factory.root/str(int(owner))/'base-body-glb-assets'/asset_id

    def upload(self, owner, content):
        if not os.getenv('ASSET_S3_BUCKET', '').strip():
            raise PipelineError('storage_unavailable', 'GLB 원본을 저장할 S3 설정이 필요합니다.', 422)
        if not content or len(content) > MAX_GLB_BYTES:
            raise PipelineError('invalid_glb_size', 'GLB는 0바이트 초과, 256MB 이하로 올려 주세요.', 422)
        quality = inspect_glb(content, DeliveryPolicy(max_file_bytes=MAX_GLB_BYTES), budget_warnings=True)
        if quality['errors']:
            raise PipelineError('invalid_glb', 'GLB 구조를 확인하세요. 메시와 텍스처를 파일 안에 포함해야 합니다.', 422)
        doc, _ = parse_glb(content, strict=True)
        if not doc.get('meshes') or any(item.get('uri') and not item['uri'].startswith('data:')
                                      for item in doc.get('buffers', []) + doc.get('images', [])):
            raise PipelineError('invalid_glb', '메시와 텍스처가 모두 내장된 GLB를 선택하세요.', 422)
        skins = doc.get('skins', [])
        joints = {joint for skin in skins for joint in skin['joints']}
        rigged = bool(joints and any('skin' in node and 'mesh' in node for node in doc.get('nodes', [])))
        if skins and not rigged:
            raise PipelineError('invalid_skin', '메시에 연결되지 않은 골격입니다. 스킨 바인딩을 확인하세요.', 422)
        asset_id = hashlib.sha256(content).hexdigest()
        root = self._asset_root(owner, asset_id)
        receipt = {'id': asset_id, 'bytes': len(content), 'rigged': rigged, 'bone_count': len(joints),
                   'triangles': quality['metrics'].get('triangles', 0),
                   'animations': [clip.get('name', f'clip_{index}') for index, clip in enumerate(doc.get('animations', []))]}
        with _LOCK:
            root.mkdir(parents=True, exist_ok=True)
            path = root/'source.glb'
            if not path.is_file():
                path.write_bytes(content)
            if digest(path) != asset_id:
                raise PipelineError('source_changed', '저장한 GLB 원본을 확인할 수 없습니다.', 409)
            _write_json(root/'receipt.json', receipt)
        return receipt

    def asset(self, owner, asset_id):
        root = self._asset_root(owner, asset_id)
        receipt = read_json(root/'receipt.json')
        if receipt.get('id') != asset_id or not (root/'source.glb').is_file():
            raise PipelineError('not_found', '등록한 GLB 원본을 찾을 수 없습니다.', 404)
        return receipt

    def create(self, owner, key, payload):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}', key):
            raise PipelineError('invalid_key', '등록 요청 식별자가 필요합니다.', 422)
        canonical = deepcopy(payload)
        submitted = _submitted_fingerprint(canonical)
        job_id = hashlib.sha256(f'{owner}:base-body-glb:{key}'.encode()).hexdigest()[:24]
        directory = self.factory.directory(owner, job_id)
        receipt_path = self._receipt(owner, key)
        with _LOCK:
            existing = read_json(directory/'job.json')
            if existing:
                if _submitted_fingerprint(existing['input']) != submitted:
                    raise PipelineError('idempotency_conflict', '같은 요청에 다른 GLB 또는 설정이 있습니다.', 409)
                return self.factory.get(owner, job_id), False
            rerig = canonical['import_mode'] == 'rig'
            if not os.getenv('ASSET_S3_BUCKET', '').strip() or (rerig and not blender_executable()):
                raise PipelineError('import_unavailable', 'GLB 저장소 또는 리깅 처리 설정을 확인하세요.', 422)
            if not rerig and canonical['prepare_expression_uv']:
                raise PipelineError('invalid_import_options', '바로 등록은 원본 텍스처와 UV를 유지합니다.', 422)
            asset = self.asset(owner, canonical['model_asset'])
            source = self._asset_root(owner, asset['id'])/'source.glb'
            if digest(source) != asset['id']:
                raise PipelineError('source_changed', '등록한 GLB 원본이 변경되었습니다.', 409)
            fingerprint = hashlib.sha256(json.dumps(canonical, sort_keys=True).encode()).hexdigest()
            receipt = read_json(receipt_path)
            if receipt and (receipt.get('fingerprint') != fingerprint or receipt.get('submitted_fingerprint') != submitted):
                raise PipelineError('idempotency_conflict', '기존 GLB 등록 요청의 입력이 다릅니다.', 409)
            motion_actions = deepcopy(receipt.get('motion_actions', {})) if receipt else {}
            if rerig:
                from src.services.avatar_meshy import AvatarMeshy, client
                with client(os.getenv('MESHY_API_BASE_URL', 'https://api.meshy.ai')):
                    pass
                document, _ = parse_glb(source.read_bytes(), strict=True)
                if not document.get('textures') or not document.get('images'):
                    raise PipelineError('texture_required', '새 리깅에는 텍스처가 포함된 전신 GLB가 필요합니다.', 422)
                if not receipt and canonical['generate_motions']:
                    meshy = AvatarMeshy(self.factory)
                    motion_actions = meshy.default_actions(owner)
                    meshy.validate_actions(owner, motion_actions)
            marker = f'__base_glb_request_{job_id}__'
            receipt = receipt or {'request_key': key, 'job_id': job_id, 'input': canonical,
                                  'fingerprint': fingerprint, 'submitted_fingerprint': submitted,
                                  'motion_actions': motion_actions, 'status': 'staging', 'created_at': now()}
            receipt_path.parent.mkdir(parents=True, exist_ok=True)
            _write_json(receipt_path, receipt)
            character, receipt = self._character(owner, receipt, marker, canonical['name'], None)
            output = directory/'output'
            output.mkdir(parents=True, exist_ok=True)
            copy_file(source, output/'generated-body.glb')
            copy_file(source, directory/'source.glb')
            run = directory/'parts/body'
            run.mkdir(parents=True, exist_ok=True)
            copy_file(source, run/'generated.glb')
            _write_json(run/'generation-artifacts.json', {'generated': {'sha256': asset['id'], 'origin': 'uploaded_glb'}})
            spec = production_spec('source', ('front', 'side', 'back'))
            spec['base_body'].update(source_preserved=True, preserve_face_texture=not canonical['prepare_expression_uv'])
            spec = seal_production_spec(spec)
            body = {'slot': 'body', 'views': {}, 'image': {'status': 'not_required'},
                    'model': {'status': 'ready', 'task_id': None, 'origin': 'uploaded_glb'},
                    'description': '', 'design_prompt': '', 'provenance': {'origin': 'uploaded_glb', 'review': 'pending'}}
            setup = {'body_type': canonical['body_type'], 'model_asset': asset['id'], 'import_mode': canonical['import_mode']}
            pipeline = {'parts': [body], 'production_spec': spec, 'production_mode': 'character_parts',
                        'base_body_setup': setup, 'uploaded_glb': asset, 'fit_profiles': {}, 'blueprint': None,
                        'reference_preparation': None, 'default_expressions': None, 'hair_length': 'source',
                        'design_prompts': {}, 'image_provider': 'uploaded', 'image_model': None,
                        'image_base': None, 'meshy_base': os.getenv('MESHY_API_BASE_URL', 'https://api.meshy.ai').rstrip('/'),
                        'motion_actions': motion_actions, 'motion_actions_explicit': False, 'rig_with_meshy': rerig, 'meshy_preserve_geometry': True,
                        'reuse': {'source_job_id': None, 'slots': []}, 'body_purpose': 'wardrobe_base', 'body_height_m': 1.2}
            _write_json(directory/'pipeline.json', pipeline)
            if not rerig and asset['rigged']:
                version = hashlib.sha256(('uploaded-glb:'+asset['id']).encode()).hexdigest()[:24]
                destination = directory/'meshy/versions'/version
                destination.mkdir(parents=True, exist_ok=True)
                copy_file(source, destination/'model.glb')
                delivery = {'version': version, 'origin': 'uploaded_glb', 'source_sha256': asset['id'],
                            'files': {'model.glb': asset['id']}, 'bone_count': asset['bone_count'],
                            'clips': [{'slot': name, 'source': 'uploaded_glb', 'action_id': None} for name in asset['animations']]}
                _write_json(destination/'receipt.json', delivery)
                _write_json(directory/'meshy/delivery.json', delivery)
                _write_json(directory/'meshy/worker.json', {'status': 'complete', 'origin': 'uploaded_glb', 'error': None})
            if not rerig:
                version = hashlib.sha256(('registered-glb:'+asset['id']).encode()).hexdigest()[:24]
                native = directory/'native-parts'/version
                native.mkdir(parents=True, exist_ok=True)
                for name in ('body.glb', 'model.glb'):
                    copy_file(source, native/name)
                _write_json(native/'record.json', {'status': 'review_required', 'created_at': now(), 'error': None,
                    'files': {'body.glb': asset['id'], 'model.glb': asset['id']},
                    'result': {'origin': 'uploaded_glb', 'rigged': asset['rigged'], 'bone_count': asset['bone_count'],
                               'clips': asset['animations'], 'parts': [], 'expression_uv': {'available': False}}})
                _write_json(directory/'native-parts/current.json', {'version': version})
            _write_json(output/'progress.json', {'stage': 'rig' if rerig else 'complete',
                                                'message': '새 리깅 대기' if rerig else 'GLB 등록 완료'})
            job = {'id': job_id, 'job_kind': 'base_body', 'fingerprint': fingerprint,
                   'executor': self.factory.instance, 'executor_process': identity(),
                   'character_id': character['id'], 'character_name': character['name'],
                   'input_kind': 'glb', 'input': canonical, 'base_body': setup,
                   'source_sha256': asset['id'], 'production_mode': 'character_parts', 'auto_assemble': rerig,
                   'profile': {**IMAGE_PROFILE, 'name': canonical['name'], 'height': 1.2, 'body_origin': 'uploaded_glb',
                               'rig': 'meshy-native' if rerig else 'uploaded' if asset['rigged'] else 'none',
                               'bones': asset['bone_count'] or None},
                   'status': 'review_required', 'created_at': now(), 'updated_at': now(), 'error': None,
                   'review': {'decision': 'pending'}, 'image_provider': 'uploaded', 'image_model': None,
                   'limits': {'image_tasks': 0, 'reference_tasks': 0, 'expression_tasks': 0, 'meshy_tasks': 0,
                              'meshy_rig_tasks': int(rerig), 'meshy_animation_tasks': len(set(motion_actions.values()))},
                   'parts': [{'slot': 'body', 'image_status': 'not_required', 'model_status': 'ready', 'task_id': None,
                              'progress': 100, 'views': {}, 'provenance': deepcopy(body['provenance'])}],
                   'production_spec': {name: deepcopy(spec[name]) for name in ('id', 'revision', 'sha256', 'body_height_m', 'axes', 'canvas', 'generated_views', 'release_requires')},
                   'files': {'generated-body.glb': asset['id']}}
            _write_json(directory/'job.json', job)
            _write_json(receipt_path, {**receipt, 'status': 'accepted', 'accepted_at': now()})
            self.factory._listings.pop(int(owner), None)
            return self.factory.get(owner, job_id), True


def publish_import_views(factory, owner, job_id, version):
    """Persist local GLB renders as inputs for later individual-part requests."""
    directory = factory.directory(owner, job_id)
    pipeline = read_json(directory/'pipeline.json')
    if not pipeline.get('uploaded_glb'):
        return
    native = directory/'native-parts'/version
    record = read_json(native/'record.json')
    views = {}
    job = read_json(directory/'job.json')
    for view in ('front', 'side', 'back'):
        name = f'body-{view}.png'
        expected = record['files'][name]
        if digest(native/name) != expected:
            raise ValueError('Imported body render changed')
        copy_file(native/name, directory/'output'/name)
        job['files'][name] = expected
        views[view] = {'status': 'succeeded', 'file': name, 'sha256': expected, 'origin': 'local_glb_render'}
    copy_file(native/'body-front.png', directory/'source.png')
    pipeline['parts'][0].update(views=views, image=deepcopy(views['front']))
    job['parts'][0].update(views=deepcopy(views), image_status='succeeded')
    _write_json(directory/'pipeline.json', pipeline)
    _write_json(directory/'job.json', job)
