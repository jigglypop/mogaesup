"""Versioned local wardrobe candidates; no paid submissions or approval changes."""
import hashlib
import json
from src.services.object_storage import StoredPath as Path
import re
import subprocess
from copy import deepcopy

from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, _QUEUE, digest
from src.services.avatar_meshy import AvatarMeshy
from src.services.character_parts import blender_executable, blender_process, stop_process
from src.services.character_pipeline import PipelineError, now, read_json, require_request_key
from src.services.process_identity import identity, state as process_state
from src.services.object_storage import WorkspaceUploadError, copy_file, local_workspace, publish_checkpoint
from src.services.avatar_production_spec import production_spec, refresh_fitting_spec
from src.services.avatar_equipment import is_native_part_set
from src.services.run_lock import WorkerLocks, final_write, this_process, worker_alive
from src.services.worker_env import worker_environment
from src.services.avatar_pipeline_quality import REVISION as QUALITY_REVISION, verify_quality

SLOTS = ('hair', 'hat', 'top', 'bottom', 'shoes')
RECIPE = 'native-parts-v14-matte-limb-fit'
# The assembly worker of each version directory that runs in this process.
_WORKERS = WorkerLocks()
# Absolute paths in worker text (C:\..., \\host\..., /srv/...); the worker's public_message cuts them the same way.
_ABSOLUTE_PATH = re.compile(r'(?:\b[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/]|(?<![\w.:/~-])/(?=[^\s/]+/))'
                            r'(?:[^\s\'"<>|*?\\/]+[\\/])*([^\s\'"<>|*?\\/]*)')
_WORKER_TEXT = ('message', 'error', 'source')


def public_result(value):
    """A sealed assembly result as the API answers it: worker messages, errors and source files keep only the names of
    the files they mention, never where they lay on the worker. Results sealed before the worker did the same carry
    them in full."""
    if isinstance(value, dict):
        return {key: (_ABSOLUTE_PATH.sub(lambda match: match.group(1) or 'path', item)
                      if key in _WORKER_TEXT and isinstance(item, str) else public_result(item))
                for key, item in value.items()}
    if isinstance(value, list):
        return [public_result(item) for item in value]
    return value


def uploaded_native_hair(factory, owner, part, path, body):
    """Only the owner's immutable uploaded source can opt into native shape reuse."""
    provenance = part.get('provenance') or {}
    if provenance.get('origin') != 'uploaded_glb':
        return {}
    from src.services.avatar_glb_bodies import AvatarGlbBodies
    uploads = AvatarGlbBodies(factory)
    asset_id = provenance.get('asset_id')
    from src.services.native_hair_upload import validate_native_hair
    result = {'uploaded_native_hair': True}
    try:
        info = uploads.asset(owner, asset_id)
        if info.get('rigged') is not True:
            return {}
        source = uploads._asset_root(owner, asset_id)/'source.glb'
        if digest(source) != asset_id or digest(path) != asset_id:
            raise ValueError('Uploaded native source changed')
        result['native_hair_budget'] = validate_native_hair(path.read_bytes(), body_content=body.read_bytes())
    except (PipelineError, ValueError, KeyError, TypeError, IndexError, OSError):
        result['native_upload_error'] = 'Uploaded native hair validation failed'
    return result


def accepted_seal(directory, seal):
    """(files, result) of a worker's complete.json in `directory` when a version can be sealed from it: it answers
    this input.json, every requested slot has a receipt, an unavailable slot is never the body and is reported
    incomplete, and every file the version needs is there unchanged. ValueError otherwise."""
    if seal.get('input_sha256') != digest(directory/'input.json'):
        raise ValueError('Unsealed output')
    payload = read_json(directory/'input.json')
    result = seal.get('result', {})
    reported = {p['slot']: p for p in result.get('parts', [])}
    requested = {'body', *(p['slot'] for p in payload['parts']),
                 *(p['slot'] for p in payload.get('prefit_parts', [])),
                 *(p['slot'] for p in payload.get('unavailable_parts', []))}
    if not requested <= reported.keys():
        raise ValueError('Missing part receipts')
    incomplete = {p['slot'] for p in result.get('incomplete_parts', [])}
    unavailable = {slot for slot in requested if reported[slot].get('available') is False}
    if 'body' in unavailable or not unavailable <= incomplete:
        raise ValueError('Missing incomplete part receipts')
    required = {'model.glb', 'front.png', 'side.png', 'back.png', 'motion.png',
                *(f'{slot}.glb' for slot in requested-unavailable)}
    if payload.get('production_spec'):
        required.add('opposite.png')
    if not required <= seal.get('files', {}).keys():
        raise ValueError('Incomplete parts')
    for name, expected in seal['files'].items():
        if Path(name).name != name or digest(directory/name) != expected:
            raise ValueError('Output changed')
    verify_quality(directory, seal, payload)
    return seal['files'], result


def workspace_inputs(payload):
    """Files the Blender worker reads from outside its output directory: the body, every part model, the drawings it
    fits to or registers against, and a refit's saved fallback. A worn hat has drawings but no image_paths."""
    parts = payload['parts']
    paths = [payload['source'], *(part['path'] for part in parts if part.get('path')),
             *(part['path'] for part in payload.get('prefit_parts', [])),
             *(path for part in parts for path in part.get('image_paths', {}).values()),
             *(path for part in parts for path in part.get('drawings', {}).values()),
             *(part['fallback_path'] for part in parts if part.get('fallback_path'))]
    return list(dict.fromkeys(paths))


def assembly_running(directory):
    """(record.json of the version `directory`, whether its worker still runs). One this process started runs only
    while it holds its worker lock: a worker whose last save failed leaves accepted or running behind, and that must not
    hold the version until a restart."""
    held = _WORKERS.busy(str(directory))
    record = read_json(directory/'record.json')
    return record, worker_alive(record, held or _WORKERS.busy(str(directory)))


def placed_head_bounds(bounds, spec, slot):
    """True when a head part's measured canvas bounds are a placement on the shared canvas: the
    part reaches the crown and is not much wider than the slot's fitting bounds. A provider that
    fills its frame with the part gives bounds spanning the body, which must not place or back it."""
    crown = (spec or {}).get('anchors', {}).get('crown')
    fitted = (spec or {}).get('fitting', {}).get('bounds', {}).get(slot)
    if not crown or not fitted:
        return True
    return bounds[1][1] >= crown[1] - .03 and bounds[1][0] - bounds[0][0] <= 1.35*(fitted[1][0] - fitted[0][0])


class AvatarNativeParts:
    def __init__(self, factory):
        self.factory = factory

    def root(self, owner, job):
        self.factory.get(owner, job)
        return self.factory.directory(owner, job)/'native-parts'

    def get(self, owner, job, version=None):
        root = self.root(owner, job)
        pointer = {'version': version} if version else read_json(root/'current.json')
        if not pointer:
            return {'status': 'not_started', 'parts': [], 'artifacts': []}
        version = pointer['version']; directory = root/version
        record, running = assembly_running(directory)
        if not record:
            raise PipelineError('not_found', '조립 버전을 찾을 수 없습니다.', 404)
        status = record['status']
        if status in ('accepted', 'running') and not running:
            status = 'recovery_required'
        error = '조립 재개 필요' if status == 'qc_failed' else record.get('error')
        saved_contract = read_json(directory/'input.json').get('contract', {})
        job_directory = self.factory.directory(owner, job)
        pipeline = read_json(job_directory/'pipeline.json') or {}
        local_refit = pipeline.get('local_refit') or {}
        expression_contract = pipeline.get('expression_reuse') or {}
        frozen_expressions = expression_contract.get('expressions') or []
        expression_run = read_json(job_directory/'expression-reuse.json') or {}
        expression_version = (local_refit.get('target_version', version) if local_refit
                              else pipeline.get('native_assembly_version'))
        expression_pending = bool(expression_version == version
            and frozen_expressions and not (
            expression_run.get('target_version') == version
            and expression_run.get('status') == 'complete'
            and all(item['source_id'] in (expression_run.get('expressions') or {})
                    for item in frozen_expressions)))
        result = public_result(record.get('result', {}))
        state = {'version': version, 'status': status, 'error': error,
                'error_stage': record.get('error_stage'), 'error_type': record.get('error_type'),
                **result,
                'expression_pending': expression_pending,
                'refit_request_key': (local_refit.get('request_key')
                    if local_refit.get('target_version') == version else None),
                'fit_update_available': (
                    result.get('origin') != 'uploaded_glb' and (
                        result.get('fitting_revision') != production_spec()['fitting']['revision']
                        or saved_contract.get('recipe') != RECIPE)),
                'parts': result.get('parts', []),
                'artifacts': [{'name': name, 'sha256': value,
                    'url': f'/api/avatar-factory/jobs/{job}/native-parts/{version}/{name}'}
                    for name, value in record.get('files', {}).items()]}
        if status != 'review_required' or expression_pending:
            source_version = local_refit.get('source_version')
            if (isinstance(source_version, str) and re.fullmatch(r'[a-f0-9]{24}', source_version)
                    and source_version != version):
                source_record = read_json(root/source_version/'record.json') or {}
                if source_record.get('status') == 'review_required':
                    source_result = public_result(source_record.get('result', {}))
                    state['preview'] = {'version': source_version, 'status': 'review_required',
                        **source_result,
                        'parts': source_result.get('parts', []),
                        'artifacts': [{'name': name, 'sha256': value,
                            'url': f'/api/avatar-factory/jobs/{job}/native-parts/{source_version}/{name}'}
                            for name, value in source_record.get('files', {}).items()]}
        from src.services.avatar_native_reviews import AvatarNativeReviews
        state['assembly_sha256'] = record.get('files', {}).get('model.glb')
        state['review'] = AvatarNativeReviews(self.factory).overlay(owner, job, version, record)
        return state

    def start_refit(self, owner, job, source_version, slot, request_key, *, fit_profile=None, part_method=None, shape=None):
        """Freeze every other fitted slot, then refit only one saved raw part.

        part_method='body_shell' rebuilds a top or bottom from the frozen body and its
        saved views, with no provider request; 'isolated' refits the saved model.
        shape {'sleeve', 'hem', 'fit'} (body-shell top/bottom) replaces the saved shape;
        {} returns to the drawing; None keeps the saved shape.
        """
        with _LOCK:
            return self._start_refit_locked(owner, job, source_version, slot, request_key,
                                            fit_profile=fit_profile, part_method=part_method, shape=shape)

    def _start_refit_locked(self, owner, job, source_version, slot, request_key, *, fit_profile=None, part_method=None, shape=None):
        if not re.fullmatch(r'[a-f0-9]{24}', source_version):
            raise PipelineError('not_found', '기준 조립 버전을 찾을 수 없습니다.', 404)
        require_request_key(request_key)
        directory = self.factory.directory(owner, job)
        pipeline = read_json(directory/'pipeline.json')
        submitted = {'source_version': source_version, 'slot': slot}
        if fit_profile is not None:
            submitted['fit_profile'] = fit_profile
        if part_method is not None:
            if part_method not in ('isolated', 'body_shell') or (part_method == 'body_shell' and slot not in ('top', 'bottom')):
                raise PipelineError('invalid_part_method', '몸 셸 재피팅은 상의와 하의에만 사용할 수 있습니다.', 422)
            submitted['part_method'] = part_method
        if shape is not None:
            if slot not in ('top', 'bottom') or (slot == 'bottom' and shape.get('sleeve') is not None):
                raise PipelineError('invalid_shape', '소매는 상의에만, 밑단과 품은 상의·하의에만 쓸 수 있습니다.', 422)
            submitted['shape'] = shape
        fingerprint = hashlib.sha256(json.dumps(submitted, sort_keys=True).encode()).hexdigest()
        receipt_path = directory/'native-parts'/'refit-requests'/f'{hashlib.sha256(request_key.encode()).hexdigest()}.json'
        receipt = read_json(receipt_path)
        if receipt:
            if receipt.get('fingerprint') != fingerprint:
                raise PipelineError('idempotency_conflict', '같은 요청의 피팅 입력이 변경되었습니다.', 409)
            if receipt.get('version'):
                return self._resume_version(owner, job, receipt['version'],
                    recover_from=source_version, request_key=request_key)
        previous_intent = pipeline.get('local_refit') or {}
        if previous_intent.get('request_key') == request_key:
            if previous_intent.get('fingerprint') != fingerprint:
                raise PipelineError('idempotency_conflict', '같은 요청 식별자에 다른 파츠를 사용할 수 없습니다.', 409)
            if previous_intent.get('target_version'):
                return self._resume_version(owner, job, previous_intent['target_version'],
                    recover_from=source_version, request_key=request_key)
            return self.start(owner, job)
        from src.services.avatar_expression_reuse import reuse_running
        expression_run, running = reuse_running(directory)
        if running and expression_run.get('process'):
            raise PipelineError('expression_running', '기존 표정을 적용 중입니다. 완료 후 파츠를 선택하세요.', 409)
        current = read_json(directory/'native-parts/current.json')
        if current.get('version') != source_version:
            raise PipelineError('base_changed', '현재 조립 버전을 다시 선택하세요.', 409)
        source = directory/'native-parts'/source_version
        record = read_json(source/'record.json')
        if record.get('status') != 'review_required':
            raise PipelineError('base_incomplete', '완료된 기준 조립 버전이 필요합니다.', 409)
        slots = [part['slot'] for part in pipeline.get('parts', []) if part['slot'] != 'body']
        if slot not in slots:
            raise PipelineError('part_not_found', '다시 피팅할 저장 파츠를 찾을 수 없습니다.', 404)
        reports = {part['slot']: part for part in record.get('result', {}).get('parts', [])}
        if fit_profile is not None and slot not in ('top', 'bottom'):
            raise PipelineError('invalid_fit_profile', '상의와 하의에만 의상 피팅을 적용할 수 있습니다.', 422)
        selected_part = next(part for part in pipeline['parts'] if part['slot'] == slot)
        if part_method is not None:
            if part_method == 'isolated' and not self.factory.directory(owner, job).joinpath('output', f'generated-{slot}.glb').is_file():
                raise PipelineError('part_model_missing', '이 파츠에는 저장된 3D 모델이 없어 기존 피팅을 사용할 수 없습니다.', 409)
            if part_method == 'body_shell' and not (selected_part.get('views') or {}).get('front', {}).get('file'):
                raise PipelineError('part_images_missing', '몸 셸 재피팅에는 저장된 정면 이미지가 필요합니다.', 409)
            selected_part['part_method'] = part_method
        if shape is not None:
            if selected_part.get('part_method') != 'body_shell':
                raise PipelineError('shape_requires_body_shell', '모양은 몸에 맞춰 만든 상의·하의만 바꿀 수 있습니다.', 422)
            selected_part['shape'] = shape or None
        selected_profile = None
        if slot in ('top', 'bottom') and selected_part.get('part_method') != 'body_shell':
            from src.services.avatar_fit_profiles import normalize_fit_profile
            saved_profile = (reports.get(slot, {}).get('fit_profile')
                             or reports.get(slot, {}).get('measurement', {}).get('fit_profile')
                             or selected_part.get('fit_profile'))
            selected_profile = normalize_fit_profile(fit_profile if fit_profile is not None else saved_profile,
                slot=slot, description=selected_part.get('description', ''), kind=selected_part.get('garment_kind', 'source'))
            source_hash = digest(self.factory.artifact(owner, job, f'generated-{slot}.glb'))
            if selected_profile.get('source_sha256') not in (None, source_hash):
                raise PipelineError('part_changed', '기준점을 측정한 원본 파츠가 변경되었습니다.', 409)
            selected_profile['source_sha256'] = source_hash
            selected_part['fit_profile'] = selected_profile
            selected_part['garment_kind'] = selected_profile['kind']
        source_input = read_json(source/'input.json')
        fit_spec = refresh_fitting_spec(source_input.get('production_spec') or pipeline.get('production_spec'),
                                       pipeline.get('hair_length') or 'source',
                                       body_profile=record.get('result', {}).get('body_profile'))
        fit_spec['frozen_body'] = True
        if selected_profile:
            from src.services.avatar_production_spec import configure_fit_profiles
            profiles = deepcopy(fit_spec.get('fit_profiles', {}))
            profiles[slot] = selected_profile
            fit_spec = configure_fit_profiles(fit_spec, profiles)
        fit_spec.pop('sha256', None)
        fit_spec['sha256'] = hashlib.sha256(json.dumps(fit_spec, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        frozen = {}
        for existing in slots:
            if existing == slot:
                continue
            if reports.get(existing, {}).get('available') is False:
                frozen[existing] = {'available': False, 'report': reports[existing]}
                continue
            name = f'{existing}.glb'
            expected = record.get('files', {}).get(name)
            path = source/name
            if not expected or not path.is_file() or digest(path) != expected:
                raise PipelineError('fitted_part_changed', f'저장된 {existing} 피팅 파츠를 확인할 수 없습니다.', 409)
            copy_file(path, directory/'prefit-parts'/name)
            frozen[existing] = {'file': name, 'sha256': expected, 'report': reports.get(existing, {})}
        from src.services.avatar_expression_reuse import snapshot_saved_expressions
        pipeline['native_part_reuse'] = {
            'source_job_id': job, 'source_version': source_version, 'parts': frozen}
        pipeline['expression_reuse'] = snapshot_saved_expressions(
            self.factory, owner, job, source_version, directory)
        pipeline['local_refit'] = {'source_version': source_version, 'slot': slot,
                                   'request_key': request_key, 'fingerprint': fingerprint,
                                   'fit_spec': fit_spec}
        _write_json(receipt_path, {'fingerprint': fingerprint, 'input': submitted, 'status': 'accepted'})
        _write_json(directory/'pipeline.json', pipeline)
        return self.start(owner, job)

    def _resume_version(self, owner, job, version, *, recover_from=None, request_key=None):
        """Recover the sealed input, even after source code or defaults change. The pointers, the pipeline and the
        record it moves are written under the process lock, as a new version's are."""
        with _LOCK:
            return self._resume_version_locked(owner, job, version, recover_from=recover_from, request_key=request_key)

    def _resume_version_locked(self, owner, job, version, *, recover_from=None, request_key=None):
        root = self.root(owner, job)
        record, running = assembly_running(root/version)
        if record.get('status') == 'review_required':
            return self.get(owner, job, version), False
        current_version = read_json(root/'current.json').get('version')
        if current_version != version:
            pipeline_path = self.factory.directory(owner, job)/'pipeline.json'
            pipeline = read_json(pipeline_path)
            refit = pipeline.get('local_refit') or {}
            sealed = read_json(root/version/'input.json')
            refit_matches = bool(refit and refit.get('target_version') in (None, version)
                and (not request_key or refit.get('request_key') == request_key)
                and current_version == refit.get('source_version')
                and (recover_from is None or recover_from == current_version))
            assembly_matches = bool(not refit and pipeline.get('native_assembly_version') == version
                and 'base_version' in sealed and sealed['base_version'] == current_version)
            if not sealed or record.get('status') not in ('accepted', 'running', 'failed', 'qc_failed') or not (refit_matches or assembly_matches):
                raise PipelineError('base_changed', '다른 조립 버전이 선택되어 있습니다. 현재 작업을 확인하세요.', 409)
            if refit_matches:
                pipeline['local_refit']['target_version'] = version
                _write_json(pipeline_path, pipeline)
            self._move_current(root, version)
        runner = read_json(root/version/'runner.json')
        if runner.get('process') and process_state(runner['process']) != 'exited':
            return self.get(owner, job, version), False
        if record.get('status') in ('failed', 'qc_failed', 'running', 'accepted'):
            if record.get('status') in ('accepted', 'running') and running:
                return self.get(owner, job, version), False
            record.update(status='accepted', process=identity(), error=None)
            _write_json(root/version/'record.json', record)
            return self.get(owner, job, version), True
        raise PipelineError('assembly_missing', '저장된 피팅 요청을 확인할 수 없습니다.', 409)

    def _move_current(self, root, version):
        """Point current.json at a version that is not sealed yet. The sealed version it leaves is kept in
        ready.json, which the wardrobe goes on offering until this one is sealed. Both are written under the process
        lock, which its callers already hold."""
        with _LOCK:
            previous = read_json(root/'current.json').get('version')
            if previous and previous != version and read_json(root/previous/'record.json').get('status') == 'review_required':
                _write_json(root/'ready.json', {'version': previous})
            _write_json(root/'current.json', {'version': version})

    def ready_version(self, owner, job):
        """The sealed version the wardrobe offers for a job (its current one once sealed, else the one ready.json
        kept while a newer one is assembled or failed), or None. Part requests build on the same version."""
        from src.services.avatar_production_progress import ready_version
        root = self.factory.directory(owner, job)/'native-parts'
        pointer = read_json(root/'current.json')
        record = read_json(root/pointer['version']/'record.json') if pointer.get('version') else {}
        return ready_version(root, pointer, record)

    def execute_refit(self, owner, job):
        self.execute(owner, job)
        state = self.get(owner, job)
        if state.get('status') != 'review_required':
            return state
        from src.services.avatar_expression_reuse import reuse_saved_expressions
        reuse_saved_expressions(self.factory, owner, job, state['version'])
        return self.get(owner, job)

    def start(self, owner, job, *, canonical_pose=False):
        job_state = self.factory.get(owner, job)
        if job_state.get('production_mode') != 'character_parts':
            raise PipelineError('parts_required', '몸과 의상을 개별 생성한 파츠 작업이 필요합니다.', 422)
        job_directory = self.factory.directory(owner, job)
        pipeline = read_json(job_directory/'pipeline.json')
        local_refit = pipeline.get('local_refit') or {}
        accepted_version = local_refit.get('target_version') if local_refit else pipeline.get('native_assembly_version')
        if accepted_version and not canonical_pose:
            return self._resume_version(owner, job, accepted_version)
        if local_refit:
            source_version = local_refit['source_version']
            source_record = read_json(job_directory/'native-parts'/source_version/'record.json')
            body = job_directory/'native-parts'/source_version/'body.glb'
            expected_body = source_record.get('files', {}).get('body.glb')
            if (source_record.get('status') != 'review_required' or not expected_body
                    or not body.is_file() or digest(body) != expected_body):
                raise PipelineError('body_changed', '기준 조립 몸 파일을 확인할 수 없습니다.', 409)
        else:
            provider = AvatarMeshy(self.factory); state = provider.get(owner, job)
            if not state.get('version'):
                raise PipelineError('rig_required', '먼저 몸의 Meshy 리깅과 동작을 가져오세요.', 422)
            body = provider.artifact(owner, job, state['version'], 'model.glb')
        source_slots = tuple(part['slot'] for part in pipeline.get('parts', []) if part['slot'] != 'body')
        if not is_native_part_set(('body', *source_slots)):
            raise PipelineError('parts_required', '저장된 캐릭터 파츠 구성을 확인하세요.', 422)
        parts, prefit_parts, unavailable_parts = [], [], []
        garment_kinds = {part['slot']: part.get('garment_kind', 'source') for part in pipeline['parts']}
        part_inputs = {part['slot']: part for part in pipeline['parts']}
        native_reuse = pipeline.get('native_part_reuse', {}).get('parts', {})
        for slot in source_slots:
            frozen = native_reuse.get(slot)
            if frozen:
                if frozen.get('available') is False:
                    report = deepcopy(frozen['report'])
                    # The seal accepts an unavailable slot only as an incomplete one.
                    if report.get('fit_status') not in ('needs_anchors', 'failed'):
                        report['fit_status'] = 'failed'
                    unavailable_parts.append(report)
                    continue
                path = self.factory.directory(owner, job)/'prefit-parts'/frozen['file']
                if digest(path) != frozen['sha256']:
                    raise PipelineError('fitted_part_changed', f'고정한 {slot} 피팅 파츠가 변경되었습니다.', 409)
                prefit_parts.append({'slot': slot, 'path': str(path), 'sha256': frozen['sha256'],
                                     'report': frozen.get('report', {}),
                                     'fit_profile': part_inputs[slot].get('fit_profile'),
                                     'garment_kind': garment_kinds[slot]})
                continue
            method = part_inputs[slot].get('part_method', 'isolated')
            if method == 'body_shell':
                # No provider model: the frozen body and the registered views are the inputs.
                images, hashes = {}, {}
                for view, image in part_inputs[slot].get('views', {}).items():
                    name = image.get('file')
                    if view in ('front', 'side', 'back', 'opposite') and name and Path(name).name == name:
                        image_path = job_directory/'output'/name
                        if image_path.is_file() and digest(image_path) == image.get('sha256'):
                            images[view] = str(image_path); hashes[view] = image['sha256']
                if 'front' not in images:
                    raise PipelineError('part_images_missing', f'{slot}: 몸 셸 의상에는 저장된 정면 이미지가 필요합니다.', 409)
                shape = part_inputs[slot].get('shape')
                # A drawing made for the worn method stands on the key-coloured mannequin; the shell
                # cuts that colour out so only the garment makes the silhouette.
                key_color = part_inputs[slot].get('key_color')
                shell_inputs = {'views': hashes, 'shape': shape} if shape else hashes
                if key_color:
                    shell_inputs = {'views': hashes, 'shape': shape, 'key': key_color}
                identity_hash = hashlib.sha256(json.dumps(shell_inputs, sort_keys=True).encode()).hexdigest()
                entry = {'slot': slot, 'part_method': 'body_shell', 'path': None, 'sha256': identity_hash,
                         'garment_kind': (part_inputs[slot].get('fit_profile') or {}).get('kind') or garment_kinds[slot],
                         'fit_profile': part_inputs[slot].get('fit_profile'), 'shape': shape,
                         'image_paths': images, 'image_sha256': hashes}
                if key_color:
                    from src.services.avatar_part_methods import KEY_COLORS
                    entry['key_rgb'] = list(KEY_COLORS[key_color])
                parts.append(entry)
                continue
            path = self.factory.artifact(owner, job, f'generated-{slot}.glb')
            entry = {'slot': slot, 'path': str(path), 'sha256': digest(path), 'part_method': method,
                     'garment_kind': garment_kinds[slot], 'fit_profile': part_inputs[slot].get('fit_profile')}
            # Tripo returns models facing glTF +X; Meshy and the fitting code expect +Z.
            if (read_json(job_directory/'parts'/slot/'character.json') or {}).get('provider') == 'tripo':
                entry['front_axis'] = '+x'
            if method == 'worn':
                from src.services.avatar_part_methods import KEY_COLORS
                entry['key_rgb'] = list(KEY_COLORS[part_inputs[slot].get('key_color') or 'magenta'])
                # The drawings show where the mannequin was: surface there is mannequin in any colour.
                drawings = {}
                for view, image in part_inputs[slot].get('views', {}).items():
                    name = image.get('file')
                    drawing = job_directory/'output'/name if name and Path(name).name == name else None
                    if (view in ('front', 'side', 'back') and drawing is not None and drawing.is_file()
                            and digest(drawing) == image.get('sha256')):
                        drawings[view] = (str(drawing), image['sha256'])
                if drawings:
                    entry['drawings'] = {view: path for view, (path, _) in drawings.items()}
                    entry['drawing_sha256'] = {view: sha for view, (_, sha) in drawings.items()}
            if (slot in ('hair', 'hat') and part_inputs[slot].get('target_bounds_m')
                    and placed_head_bounds(part_inputs[slot]['target_bounds_m'], pipeline.get('production_spec'), slot)):
                views = part_inputs[slot].get('views', {})
                measured_views = [views.get(view, {}) for view in ('front', 'side')]
                if all(view.get('origin') != 'uploaded_part'
                       and (view.get('measurement') or {}).get('bounds_px') for view in measured_views):
                    entry['reference_bounds_m'] = deepcopy(part_inputs[slot]['target_bounds_m'])
            if entry['fit_profile'] or slot == 'hair':
                images = {}
                for view, image in part_inputs[slot].get('views', {}).items():
                    name = image.get('file')
                    if view in ('front', 'side', 'back', 'opposite') and name and Path(name).name == name:
                        image_path = job_directory/'output'/name
                        if image_path.is_file() and digest(image_path) == image.get('sha256'):
                            images[view] = str(image_path)
                entry['image_paths'] = images
                entry['image_sha256'] = {view: digest(Path(image_path)) for view, image_path in images.items()}
                if local_refit and entry['fit_profile']:
                    fallback = job_directory/'native-parts'/local_refit['source_version']/f'{slot}.glb'
                    fallback_sha = source_record.get('files', {}).get(f'{slot}.glb')
                    if fallback_sha and digest(fallback) == fallback_sha:
                        entry.update(fallback_path=str(fallback), fallback_sha256=fallback_sha,
                            fallback_report=next((p for p in source_record.get('result', {}).get('parts', []) if p['slot'] == slot), {}))
            entry['preserve_generated_detail'] = bool(
                part_inputs[slot].get('preserve_generated_detail') or part_inputs[slot].get('meshy_options'))
            if slot == 'hair':
                entry.update(uploaded_native_hair(self.factory, owner, part_inputs[slot], path, body))
            parts.append(entry)
        contract = {'recipe': RECIPE, 'worker_sha256': digest(Path(__file__).with_name('avatar_native_parts_blender.py')),
                    'canonical_pose': canonical_pose,
                    'binding_worker_sha256': digest(Path(__file__).with_name('avatar_blender_common.py')),
                    'body_layers_sha256': digest(Path(__file__).with_name('avatar_body_layers.py')),
                    'head_geometry_sha256': digest(Path(__file__).with_name('avatar_head_geometry.py')),
                    'hair_geometry_sha256': digest(Path(__file__).with_name('avatar_hair_geometry.py')),
                    'shoe_geometry_sha256': digest(Path(__file__).with_name('avatar_shoe_geometry.py')),
                    'arm_geometry_sha256': digest(Path(__file__).with_name('avatar_arm_geometry.py')),
                    'render_budget_sha256': digest(Path(__file__).with_name('avatar_render_budget.py')),
                    'equipment_sha256': digest(Path(__file__).with_name('avatar_equipment.py')),
                    'expression_bake_sha256': digest(Path(__file__).with_name('avatar_expression_bake.py')),
                    'expression_uv_sha256': digest(Path(__file__).with_name('avatar_expression_uv_blender.py')),
                    # The rest of what the Blender worker imports: a change to any of them must make a new version.
                    'limb_fit_sha256': digest(Path(__file__).with_name('avatar_limb_fit.py')),
                    'hood_room_sha256': digest(Path(__file__).with_name('avatar_hood_room.py')),
                    'wardrobe_coverage_sha256': digest(Path(__file__).with_name('avatar_wardrobe_coverage.py')),
                    'glb_sha256': digest(Path(__file__).with_name('glb.py')),
                    'native_hair_upload_sha256': digest(Path(__file__).with_name('native_hair_upload.py')),
                    'asset_delivery_sha256': digest(Path(__file__).with_name('asset_delivery.py')),
                    'pipeline_quality_revision': QUALITY_REVISION,
                    'pipeline_quality_sha256': digest(Path(__file__).with_name('avatar_pipeline_quality.py')),
                    'quality_worker_sha256': digest(Path(__file__).with_name('avatar_quality_blender.py')),
                    'shell_garment_sha256': digest(Path(__file__).with_name('avatar_shell_garment.py')),
                    'garment_kinds': garment_kinds,
                    'part_methods': {p['slot']: p.get('part_method', 'isolated') for p in parts},
                    'front_axes': {p['slot']: p['front_axis'] for p in parts if p.get('front_axis')},
                    'worn_drawings': {p['slot']: p['drawing_sha256'] for p in parts if p.get('drawing_sha256')},
                    'shell_worker_sha256': digest(Path(__file__).with_name('avatar_shell_garment.py')),
                    'worn_worker_sha256': digest(Path(__file__).with_name('avatar_worn_part.py')),
                    'fit_profiles': {p['slot']: p.get('fit_profile') for p in parts if p.get('fit_profile')},
                    'preserve_generated_detail': [p['slot'] for p in parts if p.get('preserve_generated_detail')],
                    'uploaded_native_hair': {p['slot']: {k: p[k] for k in
                        ('sha256', 'native_hair_budget', 'native_upload_error') if k in p}
                        for p in parts if p.get('uploaded_native_hair')},
                    'fit_images': {p['slot']: p.get('image_sha256', {}) for p in parts if p.get('image_paths')},
                    'head_part_reference_bounds': {p['slot']: p['reference_bounds_m'] for p in parts if p.get('reference_bounds_m')},
                    'body': digest(body), 'parts': [(p['slot'], p['sha256']) for p in parts],
                    'prefit_parts': [(p['slot'], p['sha256']) for p in prefit_parts],
                    'unavailable_parts': unavailable_parts}
        pipeline = read_json(self.factory.directory(owner, job)/'pipeline.json')
        # Generation keeps its accepted sizing. An explicit refit freezes the
        # current fitting rules separately before dispatching its worker.
        saved_spec = pipeline.get('production_spec')
        hair_length = (pipeline.get('hair_length')
                       or (saved_spec or {}).get('fitting', {}).get('hair_length')
                       or 'source')
        fit_spec = deepcopy(local_refit.get('fit_spec') or saved_spec or production_spec(hair_length))
        if local_refit:
            fit_spec['frozen_body'] = True
            canonical = json.dumps({key: value for key, value in fit_spec.items() if key != 'sha256'},
                                   sort_keys=True, separators=(',', ':')).encode()
            fit_spec['sha256'] = hashlib.sha256(canonical).hexdigest()
        measurements = {p['slot']: p.get('target_bounds_m') for p in pipeline.get('parts', [])}
        # The worker imports the garment fitting whether or not a slot has a fit profile.
        contract.update(production_spec_sha256=fit_spec['sha256'],
                        source_spec_sha256=(pipeline.get('production_spec') or {}).get('sha256'),
                        fit_worker_sha256=digest(Path(__file__).with_name('avatar_fit_geometry.py')),
                        garment_worker_sha256=digest(Path(__file__).with_name('avatar_garment_geometry.py')))
        version = hashlib.sha256(json.dumps(contract, sort_keys=True).encode()).hexdigest()[:24]
        root = self.root(owner, job); directory = root/version
        if not blender_executable():
            raise PipelineError('blender_unavailable', '로컬 Blender 설치가 필요합니다.', 422)
        with _LOCK:
            previous = read_json(root/'current.json')
            if previous:
                current, running = assembly_running(root/previous['version'])
                if current.get('status') in ('accepted', 'running') and running:
                    return self.get(owner, job), False
            record = read_json(directory/'record.json')
            if record.get('status') == 'review_required':
                _write_json(root/'current.json', {'version': version})
                return self.get(owner, job), False
            runner = read_json(directory/'runner.json')
            if runner and process_state(runner.get('process')) != 'exited':
                raise PipelineError('worker_running', '기존 Blender 작업이 아직 실행 중입니다.', 409)
            directory.mkdir(parents=True, exist_ok=True)
            _write_json(directory/'input.json', {'source': str(body), 'source_sha256': digest(body),
                        'parts': parts, 'prefit_parts': prefit_parts, 'unavailable_parts': unavailable_parts,
                        'output': str(directory), 'contract': contract,
                        'production_spec': fit_spec, 'source_measurements': measurements,
                        'base_version': previous.get('version') if previous else None,
                        'canonical_pose': canonical_pose})
            _write_json(directory/'record.json', {'status': 'accepted', 'process': identity(), 'files': {}, 'created_at': now()})
            if local_refit:
                pipeline['local_refit']['target_version'] = version
                receipt_path = job_directory/'native-parts'/'refit-requests'/f'{hashlib.sha256(local_refit["request_key"].encode()).hexdigest()}.json'
                receipt = read_json(receipt_path)
                _write_json(receipt_path, {**receipt, 'fingerprint': local_refit['fingerprint'], 'version': version})
            else:
                pipeline['native_assembly_version'] = version
            _write_json(job_directory/'pipeline.json', pipeline)
            self._move_current(root, version)
        return self.get(owner, job), True

    def execute(self, owner, job):
        root = self.root(owner, job)
        version = read_json(root/'current.json')['version']
        directory = root/version
        if not _WORKERS.acquire(str(directory)):
            return
        try:
            payload = read_json(directory/'input.json')
            # Reassembly needs the saved input GLBs and this output version, not every
            # prior render, provider response, and .blend in the job's history.
            with local_workspace(directory, inputs=workspace_inputs(payload)):
                return self._execute_local(owner, job, version)
        except WorkspaceUploadError:
            self._fail_unstored(directory)
        except Exception as exc:
            # Whatever else stopped this worker (its inputs, a record it could not read or save) fails the run it
            # admitted as well, so a resume assembles again instead of finding it accepted or running.
            self._fail_unstored(directory, error='Blender 조립 중단', error_type=type(exc).__name__, error_stage='blender')
            raise
        finally:
            _WORKERS.release(str(directory))

    def _fail_unstored(self, directory, *, error='조립 산출물 저장 실패', error_type='WorkspaceUploadError',
                       error_stage='upload'):
        """The workspace ended with files the store did not take, so the record there is still the running checkpoint
        with this process's id, which would stand until a restart. It fails instead, and a resume assembles again. A
        run another process admitted is that process's to settle."""
        def fail():
            record = read_json(directory/'record.json')
            if record.get('status') in ('accepted', 'running') and this_process(record.get('process')):
                record.update(status='failed', error=error, error_type=error_type,
                              error_stage=error_stage, files={}, result={})
                _write_json(directory/'record.json', record)
        final_write(fail, 'assembly record')

    def _execute_local(self, owner, job, version):
        root = self.root(owner, job)
        directory = root/version
        with _QUEUE:
            record = read_json(directory/'record.json')
            if record['status'] != 'accepted':
                return
            record.update(status='running', process=identity())
            _write_json(directory/'record.json', record)
            publish_checkpoint(directory/'record.json')
            phase = 'blender'
            try:
                command = [blender_executable(), '--background', '--factory-startup', '--disable-autoexec',
                           '--python-exit-code', '1', '--python', str(Path(__file__).with_name('avatar_native_parts_blender.py')),
                           '--', str(directory/'input.json')]
                environment = worker_environment()
                if read_json(self.factory.directory(owner, job)/'pipeline.json').get('uploaded_glb'):
                    # An imported base body publishes its front/side/back renders as the frozen
                    # body views later part requests draw on (publish_import_views).
                    environment['ASSET_DETAIL_RENDERS'] = '1'
                with blender_process(command, directory/'blender.log', directory/'runner.json', env=environment,
                                     write_json=_write_json) as process:
                    try:
                        code = process.wait(timeout=1800)
                    except subprocess.TimeoutExpired:
                        # Kill a worker that ignores terminate, so no Blender outlives a failed record.
                        stop_process(process)
                        raise
                if code:
                    raise ValueError('Blender fitting failed')
                phase = 'artifacts'
                files, result = accepted_seal(directory, read_json(directory/'complete.json'))
                record.update(status='review_required', files=files, result=result,
                              error=None, error_type=None, error_stage=None)
            except Exception as exc:
                record.update(status='failed', error='Blender 조립 중단' if phase == 'blender' else '조립 산출물 저장 확인 중단',
                    error_type=type(exc).__name__, error_stage=phase,
                    files={name: digest(directory/name) for name in ('front.png', 'side.png', 'back.png', 'opposite.png') if (directory/name).is_file()},
                    result={})
            final_write(lambda: _write_json(directory/'record.json', record), 'assembly record')

    def artifact(self, owner, job, version, name):
        root = self.root(owner, job)
        if not re.fullmatch('[a-f0-9]{24}', version) or Path(name).name != name:
            raise PipelineError('not_found', '산출물을 찾을 수 없습니다.', 404)
        record = read_json(root/version/'record.json')
        expected = record.get('files', {}).get(name)
        path = root/version/name
        if not expected or not path.is_file() or digest(path) != expected:
            raise PipelineError('artifact_changed', '검증된 산출물을 찾을 수 없습니다.', 404)
        return path
