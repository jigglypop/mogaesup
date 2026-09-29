"""Saved common body and garment fitting controls on existing factory artifacts."""
from copy import deepcopy
import hashlib
import json
import re

from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, digest
from src.services.character_pipeline import PipelineError, now, read_json
from src.services.glb import parse_glb
from src.services.studio_library import StudioLibrary


def geometry_identity(content):
    """Texture-independent identity; changing geometry or bind transforms changes it."""
    from src.services.avatar_expression_bake import _accessor as accessor
    doc, binary = parse_glb(content, strict=True)
    signature = hashlib.sha256()
    structure = {'nodes': [{k: n[k] for k in ('name', 'children', 'matrix', 'translation', 'rotation', 'scale', 'skin')
                            if k in n} for n in doc.get('nodes', [])],
                 'joints': [s['joints'] for s in doc.get('skins', [])]}
    signature.update(json.dumps(structure, sort_keys=True, separators=(',', ':')).encode())
    for skin in doc.get('skins', []):
        if 'inverseBindMatrices' in skin:
            signature.update(json.dumps(accessor(doc, binary, skin['inverseBindMatrices']), separators=(',', ':')).encode())
    for mesh in doc.get('meshes', []):
        for primitive in mesh.get('primitives', []):
            for key in ('POSITION', 'JOINTS_0', 'WEIGHTS_0'):
                index = primitive.get('attributes', {}).get(key)
                if index is not None:
                    values = accessor(doc, binary, index)
                    signature.update(key.encode()); signature.update(str(len(values)).encode())
                    signature.update(json.dumps(values, separators=(',', ':')).encode())
            if 'indices' in primitive:
                signature.update(json.dumps(accessor(doc, binary, primitive['indices']), separators=(',', ':')).encode())
    return signature.hexdigest()


class FittingManagement:
    def __init__(self, factory, owner):
        self.factory, self.owner = factory, owner
        self.library = StudioLibrary(factory, owner)

    def body_default(self):
        return read_json(self.library.root/'body-profile.json', {'revision': '0', 'body': None})

    def body_entry(self, job, version):
        """(identity of a saved, prepared body version, its job) or a refusal; part jobs can build on it."""
        from src.services.avatar_native_parts import AvatarNativeParts
        metadata = self.library.metadata()
        source_job = self.factory.get(self.owner, job)
        if (self.library.is_job_deleted(source_job, metadata)
                or metadata['parts'].get(f'{job}:body', {}).get('deleted')):
            raise PipelineError('body_deleted', '보관 중인 몸을 선택하세요.', 409)
        native = AvatarNativeParts(self.factory)
        root = native.root(self.owner, job)
        if not re.fullmatch(r'[a-f0-9]{24}', version):
            raise PipelineError('not_found', '몸 버전을 찾을 수 없습니다.', 404)
        record = read_json(root/version/'record.json')
        if record.get('status') != 'review_required':
            raise PipelineError('body_incomplete', '저장된 조립 몸을 선택하세요.', 409)
        if record.get('result', {}).get('origin') == 'uploaded_glb':
            # Part generation rejects an unprepared GLB body, so it cannot be a shared body either.
            raise PipelineError('body_preparation_required', '바로 등록한 GLB는 피팅·조립부터 실행한 뒤 지정하세요.', 422)
        path = native.artifact(self.owner, job, version, 'body.glb')
        identity = geometry_identity(path.read_bytes())
        body = {'job_id': job, 'version': version, 'profile_id': f'body-{identity[:24]}',
                'geometry_sha256': identity, 'body_sha256': record['files']['body.glb'],
                'measurements': record.get('result', {}).get('body_profile')}
        return body, source_job

    def save_body_default(self, job, version, expected_revision):
        self.library.require_storage()
        with _LOCK:
            previous = self.body_default()
            if previous.get('body', {}) and all(previous['body'].get(k) == v
                                               for k, v in (('job_id', job), ('version', version))):
                return previous
            if previous['revision'] != expected_revision:
                raise PipelineError('revision_conflict', '공통 몸이 변경되었습니다. 다시 불러오세요.', 409)
            body, _ = self.body_entry(job, version)
            value = {'body': body, 'updated_at': now()}
            value['revision'] = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
            _write_json(self.library.root/'body-profile.json', value)
            return value

    def part_profile(self, job, slot, version=None):
        from src.services.avatar_fit_profiles import normalize_fit_profile
        from src.services.avatar_native_parts import AvatarNativeParts
        if slot not in ('top', 'bottom'):
            raise PipelineError('invalid_slot', '상의 또는 하의를 선택하세요.', 422)
        root = AvatarNativeParts(self.factory).root(self.owner, job)
        version = version or read_json(root/'current.json').get('version')
        if not version or not re.fullmatch(r'[a-f0-9]{24}', version):
            raise PipelineError('not_found', '조립 버전을 찾을 수 없습니다.', 404)
        record = read_json(root/version/'record.json')
        if not record:
            raise PipelineError('not_found', '조립 버전을 찾을 수 없습니다.', 404)
        pipeline = read_json(self.factory.directory(self.owner, job)/'pipeline.json')
        part = next((p for p in pipeline.get('parts', []) if p['slot'] == slot), None)
        if not part:
            raise PipelineError('part_not_found', '저장된 의상을 찾을 수 없습니다.', 404)
        payload = read_json(root/version/'input.json')
        saved = next((p for p in [*payload.get('parts', []), *payload.get('prefit_parts', [])]
                      if p['slot'] == slot), {})
        report = next((p for p in record.get('result', {}).get('parts', []) if p['slot'] == slot), {})
        measurement = report.get('attempted_fit') or report.get('measurement', {})
        fit = saved.get('fit_profile') or report.get('fit_profile') or measurement.get('fit_profile')
        # Old versions are read from their own saved contract, never a newer edit.
        profile = normalize_fit_profile(fit, slot=slot, description=part.get('description', ''),
                                        kind=saved.get('garment_kind', 'source'))
        raw = self.factory.artifact(self.owner, job, f'generated-{slot}.glb')
        raw_sha = digest(raw)
        landmarks = measurement.get('source_landmarks') or report.get('source_landmarks') or {}
        if not profile['anchors'] and isinstance(landmarks, dict):
            # These are source measurements, not user target overrides. Keeping
            # derived cuff/hem targets here would override later length edits.
            profile['anchors'] = [{'name': name, 'source': point}
                                  for name, point in landmarks.items() if isinstance(point, list) and len(point) == 3]
        profile['source_sha256'] = raw_sha
        return {'slot': slot, 'source_version': version, 'source_sha256': raw_sha,
                'fit_profile': profile, 'measurement': measurement,
                'body_profile': record.get('result', {}).get('body_profile')}

    def versions(self, job):
        from concurrent.futures import ThreadPoolExecutor
        from src.services.avatar_native_parts import AvatarNativeParts
        root = AvatarNativeParts(self.factory).root(self.owner, job)
        paths = list(root.glob('*/record.json'))
        def item(path):
            record = read_json(path)
            if record.get('status') != 'review_required':
                return None
            result = record.get('result', {})
            return {'version': path.parent.name, 'created_at': record.get('created_at'),
                    'fitting_revision': result.get('fitting_revision'),
                    'incomplete_parts': result.get('incomplete_parts', []),
                    'url': f'/api/avatar-factory/jobs/{job}/native-parts/{path.parent.name}/front.png'}
        with ThreadPoolExecutor(max_workers=6) as pool:
            items = [row for row in pool.map(item, paths) if row]
        return {'current': read_json(root/'current.json').get('version'),
                'items': sorted(items, key=lambda row: row.get('created_at') or '', reverse=True)}

    def select(self, job, version, expected_version, key):
        from src.services.avatar_native_parts import AvatarNativeParts
        from src.services.avatar_stage_resume import ensure_stage_idle
        if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}', key):
            raise PipelineError('invalid_key', '요청 식별자가 필요합니다.', 422)
        if not re.fullmatch(r'[a-f0-9]{24}', version):
            raise PipelineError('not_found', '조립 버전을 찾을 수 없습니다.', 404)
        self.library.require_storage()
        native = AvatarNativeParts(self.factory)
        with _LOCK:
            root = native.root(self.owner, job)
            intent = {'version': version, 'expected_version': expected_version}
            receipt = root/'selections'/f'{hashlib.sha256(key.encode()).hexdigest()}.json'
            previous = read_json(receipt)
            if previous:
                if previous['input'] != intent:
                    raise PipelineError('idempotency_conflict', '같은 요청의 선택 버전이 바뀌었습니다.', 409)
                if previous.get('status') == 'complete':
                    return native.get(self.owner, job)
            ensure_stage_idle(self.factory, self.owner, job)
            pointer = read_json(root/'current.json')
            from src.services.avatar_stage_resume import active_run
            from src.services.avatar_expression_reuse import expression_reuse_state
            current_record = read_json(root/pointer['version']/'record.json') if pointer else {}
            expressions = expression_reuse_state(self.factory.directory(self.owner, job))
            if active_run(current_record) or (expressions and expressions.get('busy')):
                raise PipelineError('assembly_running', '현재 조립이나 표정 저장이 끝난 뒤 버전을 선택하세요.', 409)
            if pointer.get('version') not in (expected_version, version):
                raise PipelineError('revision_conflict', '현재 조립 버전이 변경되었습니다.', 409)
            record = read_json(root/version/'record.json')
            if record.get('status') != 'review_required':
                raise PipelineError('version_incomplete', '저장 완료된 조립 버전을 선택하세요.', 409)
            for name in {name for name in record.get('files', {}) if name.endswith('.glb')} | {'model.glb', 'body.glb'}:
                native.artifact(self.owner, job, version, name)
            _write_json(receipt, {'input': intent, 'status': 'accepted'})
            directory = self.factory.directory(self.owner, job)
            pipeline = read_json(directory/'pipeline.json')
            for name in ('local_refit', 'native_part_reuse', 'expression_reuse'):
                pipeline.pop(name, None)
            selected = read_json(root/version/'input.json')
            pipeline['native_assembly_version'] = version
            selected_profiles = {p['slot']: p.get('fit_profile') or p.get('report', {}).get('fit_profile')
                                 for p in [*selected.get('parts', []), *selected.get('prefit_parts', [])]}
            selected_kinds = {p['slot']: p.get('garment_kind') or p.get('report', {}).get('garment_kind')
                              for p in [*selected.get('parts', []), *selected.get('prefit_parts', [])]}
            for part in pipeline.get('parts', []):
                if part['slot'] in selected_profiles:
                    profile = selected_profiles[part['slot']]
                    if profile:
                        part['fit_profile'] = deepcopy(profile)
                    else:
                        part.pop('fit_profile', None)
                    part['garment_kind'] = (selected_kinds.get(part['slot'])
                                            or (profile or {}).get('kind') or 'source')
            _write_json(directory/'pipeline.json', pipeline)
            _write_json(root/'current.json', {'version': version})
            _write_json(receipt, {'input': intent, 'status': 'complete'})
            self.factory._listings.pop(int(self.owner), None)
            return native.get(self.owner, job)
