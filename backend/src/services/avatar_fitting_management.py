"""Saved common body and garment fitting controls on existing factory artifacts."""
from collections import OrderedDict
from copy import deepcopy
import hashlib
import json
import re
from threading import Lock

from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, digest
from src.services.character_pipeline import PipelineError, now, read_json, require_request_key
from src.services.glb import parse_glb
from src.services.keyed_lock import keyed_lock
from src.services.studio_library import StudioLibrary

_facts = OrderedDict()
_facts_lock = Lock()


def body_facts(path, sha256):
    """{'identity': geometry_identity, 'clips': animation names} of a body GLB whose content hashes to `sha256`.
    Parsing takes seconds and the file is immutable, so it is parsed once per hash: callers can do it before taking
    the process lock, and the checks under the lock then read it from memory."""
    with _facts_lock:
        if sha256 in _facts:
            _facts.move_to_end(sha256)
            return _facts[sha256]
    with keyed_lock(('body-facts', sha256)):
        with _facts_lock:
            if sha256 in _facts:
                return _facts[sha256]
        content = path.read_bytes()
        doc, _ = parse_glb(content, strict=True)
        facts = {'identity': geometry_identity(content),
                 'clips': [clip.get('name', f'clip_{index}') for index, clip in enumerate(doc.get('animations', []))]}
        with _facts_lock:
            _facts[sha256] = facts
            while len(_facts) > 32:
                _facts.popitem(last=False)
        return facts


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


# The fits that prove how a sealed slot was built when its assembly input does not say.
_FIT_METHODS = {'body-shell-v1': 'body_shell', 'worn-extract-v1': 'worn'}


def saved_build(entry):
    """(part_method, shape) one slot of a sealed assembly was built with; (None, None) when its input does not say.

    A slot built in that assembly names both. A slot it only carried over has the fit report it was sealed with: the
    body-shell and worn fits identify themselves, any other fit is the saved model's. The shape is the requested one:
    sleeve and hem when set, fit when it is not the default.
    """
    method = entry.get('part_method')
    if method in ('isolated', 'body_shell', 'worn'):
        return method, (entry.get('shape') or None) if method == 'body_shell' else None
    report = entry.get('report') or {}
    if not report.get('fit_method'):
        return None, None
    method = _FIT_METHODS.get(report['fit_method'], 'isolated')
    if method != 'body_shell':
        return method, None
    resolved = report.get('shape') or {}
    shape = {key: resolved[key] for key in ('sleeve', 'hem') if resolved.get(key) is not None}
    if resolved.get('fit') not in (None, 'normal'):
        shape['fit'] = resolved['fit']
    return method, shape or None


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
        identity = body_facts(path, record['files']['body.glb'])['identity']
        body = {'job_id': job, 'version': version, 'profile_id': f'body-{identity[:24]}',
                'geometry_sha256': identity, 'body_sha256': record['files']['body.glb'],
                'measurements': record.get('result', {}).get('body_profile')}
        return body, source_job

    def save_body_default(self, job, version, expected_revision):
        def pending():
            """The stored default while it still has to change; the same default is answered as it is."""
            previous = self.body_default()
            if previous.get('body', {}) and all(previous['body'].get(k) == v
                                               for k, v in (('job_id', job), ('version', version))):
                return previous, False
            if previous['revision'] != expected_revision:
                raise PipelineError('revision_conflict', '공통 몸이 변경되었습니다. 다시 불러오세요.', 409)
            return previous, True
        self.library.require_storage()
        with _LOCK:
            previous, changes = pending()
        if not changes:
            return previous
        # Reading and parsing the body GLB takes seconds: the lock is only for comparing and writing the default.
        body, _ = self.body_entry(job, version)
        with _LOCK:
            previous, changes = pending()
            if not changes:
                return previous
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
        # A profile keeps the hash of the mesh its anchors were measured on, so that a refit refuses anchors of an
        # older mesh; only a profile that never recorded one is taken to belong to the file as it is now.
        profile['source_sha256'] = profile.get('source_sha256') or raw_sha
        return {'slot': slot, 'source_version': version, 'source_sha256': raw_sha,
                'fit_profile': profile, 'measurement': measurement,
                'body_profile': record.get('result', {}).get('body_profile')}

    def versions(self, job):
        from src.services.runtime_activity import ContextThreadPoolExecutor as ThreadPoolExecutor
        from src.services.avatar_native_parts import AvatarNativeParts
        root = AvatarNativeParts(self.factory).root(self.owner, job)
        paths = list(root.glob('*/record.json'))
        def item(path):
            record = read_json(path)
            if record.get('status') != 'review_required':
                return None
            result = record.get('result', {})
            from src.services.avatar_native_reviews import AvatarNativeReviews
            return {'version': path.parent.name, 'created_at': record.get('created_at'),
                    'assembly_sha256': record.get('files', {}).get('model.glb'),
                    'review': AvatarNativeReviews(self.factory).overlay(self.owner, job, path.parent.name, record),
                    'fitting_revision': result.get('fitting_revision'),
                    'incomplete_parts': result.get('incomplete_parts', []),
                    'url': f'/api/avatar-factory/jobs/{job}/native-parts/{path.parent.name}/front.png'}
        with ThreadPoolExecutor(max_workers=6) as pool:
            items = [row for row in pool.map(item, paths) if row]
        return {'current': read_json(root/'current.json').get('version'),
                'items': sorted(items, key=lambda row: row.get('created_at') or '', reverse=True)}

    def select(self, job, version, expected_version, key):
        from src.services.avatar_native_parts import AvatarNativeParts, admission
        require_request_key(key)
        if not re.fullmatch(r'[a-f0-9]{24}', version):
            raise PipelineError('not_found', '조립 버전을 찾을 수 없습니다.', 404)
        self.library.require_storage()
        native = AvatarNativeParts(self.factory)
        root = native.root(self.owner, job)
        intent = {'version': version, 'expected_version': expected_version}
        receipt = root/'selections'/f'{hashlib.sha256(key.encode()).hexdigest()}.json'
        with admission(self.owner, job):
            record = self._selectable(root, job, version, expected_version, receipt, intent)
            if record is not None:
                # The models are hashed before the process lock is taken; under it the checks are made again on the
                # same sealed record before anything is written.
                for name in {name for name in record.get('files', {}) if name.endswith('.glb')} | {'model.glb', 'body.glb'}:
                    native.artifact(self.owner, job, version, name, record=record)
                with _LOCK:
                    self._select_locked(root, job, version, expected_version, receipt, intent, record)
        return native.get(self.owner, job)

    def _selectable(self, root, job, version, expected_version, receipt, intent):
        """The sealed record of the version to select, or None when this request selected it already; a refusal while
        the job runs, its current version moved elsewhere or the version is not sealed."""
        from src.services.avatar_native_parts import assembly_running
        from src.services.avatar_expression_reuse import expression_reuse_state
        from src.services.avatar_stage_resume import ensure_stage_idle
        previous = read_json(receipt)
        if previous:
            if previous['input'] != intent:
                raise PipelineError('idempotency_conflict', '같은 요청의 선택 버전이 바뀌었습니다.', 409)
            if previous.get('status') == 'complete':
                return None
        ensure_stage_idle(self.factory, self.owner, job)
        pointer = read_json(root/'current.json')
        assembling = assembly_running(root/pointer['version'])[1] if pointer else False
        expressions = expression_reuse_state(self.factory.directory(self.owner, job))
        if assembling or (expressions and expressions.get('busy')):
            raise PipelineError('assembly_running', '현재 조립이나 표정 저장이 끝난 뒤 버전을 선택하세요.', 409)
        if pointer.get('version') not in (expected_version, version):
            raise PipelineError('revision_conflict', '현재 조립 버전이 변경되었습니다.', 409)
        record = read_json(root/version/'record.json')
        if record.get('status') != 'review_required':
            raise PipelineError('version_incomplete', '저장 완료된 조립 버전을 선택하세요.', 409)
        return record

    def _select_locked(self, root, job, version, expected_version, receipt, intent, checked):
        """Point the job at `version` once the checks of _selectable still hold for the record whose files were
        hashed (`checked`)."""
        record = self._selectable(root, job, version, expected_version, receipt, intent)
        if record is None:
            return
        if record != checked:
            raise PipelineError('revision_conflict', '선택한 조립 버전이 변경되었습니다. 다시 선택하세요.', 409)
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
        selected_builds = {p['slot']: saved_build(p) for p in [*selected.get('parts', []), *selected.get('prefit_parts', [])]}
        for part in pipeline.get('parts', []):
            if part['slot'] in selected_profiles:
                profile = selected_profiles[part['slot']]
                if profile:
                    part['fit_profile'] = deepcopy(profile)
                else:
                    part.pop('fit_profile', None)
                part['garment_kind'] = (selected_kinds.get(part['slot'])
                                        or (profile or {}).get('kind') or 'source')
                # How the slot was built goes back with its fit: a refit that follows starts from this
                # version's method and shape, not from a later version's.
                method, shape = selected_builds[part['slot']]
                if method:
                    if method != part.get('part_method', 'isolated'):
                        part['part_method'] = method
                    if shape:
                        part['shape'] = deepcopy(shape)
                    else:
                        part.pop('shape', None)
        _write_json(directory/'pipeline.json', pipeline)
        _write_json(root/'current.json', {'version': version})
        _write_json(receipt, {'input': intent, 'status': 'complete'})
        self.factory._listings.pop(int(self.owner), None)
