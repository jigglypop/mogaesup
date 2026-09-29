"""Explicit per-view replacement attempts; never replay an uncertain POST."""
from copy import deepcopy
import hashlib
import json

from src.services.asset_editor import _write_json
from src.services.character_pipeline import PipelineError, now, read_json
from src.services.process_identity import identity
from src.services.avatar_openai_images import image_error_message, _error_category

RETRYABLE = {'submission_uncertain', 'rejected', 'failed', 'qc_failed'}
REFERENCE = 'reference'
REFERENCE_KEPT_FIELDS = ('prompt', 'prompt_sha256', 'layout')
LABELS = {'body': '몸', 'hair': '머리카락', 'head': '기존 머리 파츠', 'hairBack': '뒷머리', 'hairFront': '앞머리',
          'hat': '머리 장식', 'top': '상의', 'bottom': '하의', 'shoes': '신발', REFERENCE: '공통 규격 원본'}
VIEW_LABELS = {'front': '정면', 'side': '좌측면', 'back': '후면', 'opposite': '우측면'}
REFERENCE_VIEW_LABELS = {'front': '정면', 'side': '오른쪽 측면'}


def image_failure(image):
    if image.get('failure'):
        return deepcopy(image['failure'])
    if image.get('status') == 'qc_failed':
        # Earlier servers saved QC without a failure ID. Derive a stable retry token.
        evidence = json.dumps({'sha256': image.get('sha256'), 'qc': image.get('qc')}, sort_keys=True)
        return {'id': hashlib.sha256(evidence.encode()).hexdigest()[:12], 'category': 'local_processing',
                'message': '저장 이미지 처리 대기'}
    return None


def receipt_path(directory, slot, view, image):
    return directory/'output'/image.get('receipt', f'{slot}-{view}-provider')


def reference_receipt(directory, view, image):
    from src.services.avatar_reference_preparation import view_receipt
    return view_receipt(directory/'output', view, image)


def _reference_views(state):
    reference = state.get('reference_preparation') or {}
    views = reference.get('views')
    return reference, views if isinstance(views, dict) else {}


def settle_interrupted(directory, state):
    """Record requests cut off by a stopped server as unconfirmed so an explicit retry is possible."""
    changed = False

    def settle(image, receipt):
        nonlocal changed
        if image.get('status') != 'submitting' or image.get('failure'):
            return
        saved = receipt.with_suffix('.response.json').is_file()
        request_path = receipt.with_suffix('.request.json')
        request = read_json(request_path)
        # Earlier automatic attempts in this receipt were all provably unprocessed, so only the
        # stopped attempt decides: no request, or an incomplete upload, was never processed.
        unsent = not saved and (not request or request.get('submission') == 'not_sent' or (
            'submission' not in request and not (request.get('request_started') and request.get('request_body_complete'))))
        token = hashlib.sha256(f'{receipt.name}:{image.get("attempted_at")}'.encode()).hexdigest()[:12]
        if unsent:
            if request and request.get('submission') != 'not_sent':
                request.update(submission='not_sent', settled_after_stop=now())
                _write_json(request_path, request)
            image['status'] = 'not_sent'
            image['failure'] = {'id': token, 'type': 'ProcessStopped', 'at': now(),
                                'category': 'provider_connection', 'message': '서버 재시작 · 전송 전 중단'}
        else:
            image['failure'] = {'id': token, 'type': 'ProcessStopped', 'at': now(),
                                'category': 'local_processing' if saved else 'provider_connection',
                                'message': '수신 이미지 처리 중단' if saved else '서버 재시작 · 응답 확인 불가'}
            if not saved:
                image['status'] = 'submission_uncertain'
        changed = True

    for part in state.get('parts', []):
        for view, image in (part.get('views') or {}).items():
            settle(image, receipt_path(directory, part['slot'], view, image))
    reference, views = _reference_views(state)
    for view, image in views.items():
        was_submitting = image.get('status') == 'submitting'
        settle(image, reference_receipt(directory, view, image))
        if was_submitting and image.get('status') in ('submission_uncertain', 'not_sent') and reference.get('status') != 'succeeded':
            reference.update(status=image['status'], failure=deepcopy(image['failure']))
    return changed


def has_dependents(state, part, view):
    if not part.get('views'):
        return True
    model = part.get('model', {})
    if model.get('task_id') or model.get('status', 'pending') != 'pending':
        return True
    generated = state.get('production_spec', {}).get('generated_views', list(part['views']))
    if view in generated:
        later = generated[generated.index(view)+1:]
        if any(part['views'].get(next_view, {}).get('status', 'pending') != 'pending' for next_view in later):
            return True
    # All parts reference the common body. Other parts do not reference each other.
    return part['slot'] == 'body' and any(
        image['status'] != 'pending' for other in state['parts'] if other['slot'] != 'body'
        for image in other.get('views', {}).values())


def reference_has_dependents(state, view):
    """Part images use the saved appearance reference; the side reference uses the front."""
    _, views = _reference_views(state)
    if view == 'front' and views.get('side', {}).get('status', 'pending') != 'pending':
        return True
    reused = set(state.get('reuse', {}).get('slots', []))
    return any(image.get('status', 'pending') != 'pending'
               and image.get('origin') not in ('frozen_body_render', 'uploaded_part', 'uploaded_base_body')
               for part in state.get('parts', []) if part['slot'] not in reused
               for image in (part.get('views') or {}).values())


def _describe(failure, receipt, status):
    transport = read_json(receipt.with_suffix('.request.json'))
    if status == 'rejected':
        rejection = read_json(receipt.with_suffix('.error.json'))
        http_status = rejection.get('http_status') or transport.get('http_status')
        provider_error = rejection.get('provider_error', transport.get('provider_error', {}))
        category = _error_category(http_status, provider_error) if isinstance(http_status, int) else failure.get('category', 'unknown')
        failure.update(category=category, message=image_error_message(category, http_status),
                       http_status=http_status, provider_code=provider_error.get('code'))
    failure.setdefault('elapsed_seconds', transport.get('elapsed_seconds'))
    failure.setdefault('phase', transport.get('phase'))
    if failure.get('type') in ('ReadError', 'ReadTimeout', 'RemoteProtocolError'):
        failure.setdefault('message', '생성 서버 연결 끊김 · 수신된 응답 없음')


def decorate_job(directory, public):
    """Expose actionable failures, including receipts written by earlier servers."""
    paused = public['status'] in ('pipeline_paused', 'failed', 'recovery_required')
    state = read_json(directory/'pipeline.json') if paused else {}
    failure_message = None
    failure_count = 0
    for part in public.get('parts', []):
        for view, image in part.get('views', {}).items():
            failure = image_failure(image)
            if not failure or image['status'] not in RETRYABLE:
                continue
            image['failure'] = failure
            if image['status'] == 'qc_failed':
                failure.update(category='local_processing', message='저장 이미지 처리 대기')
            saved = next((p for p in state.get('parts', []) if p['slot'] == part['slot']), {})
            receipt = receipt_path(directory, part['slot'], view, saved.get('views', {}).get(view, {}))
            _describe(failure, receipt, image['status'])
            part['image_status'] = image['status']
            part['image_failure'] = deepcopy(failure)
            if failure.get('message'):
                failure_message = f'{LABELS.get(part["slot"], part["slot"])} {VIEW_LABELS.get(view, view)}: {failure["message"]}'
                failure_count += 1
            if paused and failure.get('id') and (image['status'] == 'qc_failed' or not receipt.with_suffix('.response.json').is_file()):
                from src.services.avatar_production_spec import can_reuse_image
                if image['status'] == 'qc_failed' and can_reuse_image(image):
                    continue
                blocked = has_dependents(state, saved, view)
                public['next_actions'].append({'id': 'retry_image', 'enabled': not blocked,
                    'reason': '이 이미지를 사용하는 후속 작업이 있습니다.' if blocked else None,
                    'slot': part['slot'], 'view': view, 'failure_id': failure['id'], 'additional_image_tasks': 1})
    _, reference_views = _reference_views(state)
    public_reference = public.get('reference_preparation') or {}
    for view, image in reference_views.items():
        failure = image_failure(image)
        if not failure or image.get('status') not in RETRYABLE:
            continue
        receipt = reference_receipt(directory, view, image)
        _describe(failure, receipt, image['status'])
        public_view = (public_reference.get('views') or {}).get(view)
        if public_view is not None:
            public_view['failure'] = deepcopy(failure)
        if failure.get('message'):
            failure_message = f'{LABELS[REFERENCE]} {REFERENCE_VIEW_LABELS.get(view, view)}: {failure["message"]}'
            failure_count += 1
        if failure.get('id') and not receipt.with_suffix('.response.json').is_file():
            blocked = reference_has_dependents(state, view)
            public['next_actions'].append({'id': 'retry_image', 'enabled': not blocked,
                'reason': '이 이미지를 사용하는 후속 작업이 있습니다.' if blocked else None,
                'slot': REFERENCE, 'view': view, 'failure_id': failure['id'], 'additional_image_tasks': 1})
    retryable = [{k: action[k] for k in ('slot', 'view', 'failure_id')}
                 for action in public['next_actions'] if action['id'] == 'retry_image' and action['enabled']]
    if retryable:
        public['next_actions'].append({'id': 'retry_images', 'enabled': True,
            'images': retryable, 'additional_image_tasks': len(retryable)})
    if failure_message and paused:
        if failure_count > 1:
            failure_message = f'미완료 이미지 {failure_count}장 · {failure_message}'
        public['error'] = failure_message
        public['progress']['message'] = failure_message
        if public.get('character_flow'):
            public['character_flow']['message'] = failure_message


def retry_view(service, owner, job_id, slot, view, failure_id):
    return retry_views(service, owner, job_id, [{'slot': slot, 'view': view, 'failure_id': failure_id}])


def retry_views(service, owner, job_id, images):
    """Accept an explicit set atomically; a replay never creates more attempts."""
    from src.services.avatar_image_pipeline import _LOCK, _RUN_LOCKS
    service.factory.get(owner, job_id)
    directory = service.factory.directory(owner, job_id)
    with _LOCK:
        job = read_json(directory/'job.json')
        state = read_json(directory/'pipeline.json')
        settle_interrupted(directory, state)
        if not images or len(images) != len({(i['slot'], i['view']) for i in images}):
            raise PipelineError('invalid_views', '중복되지 않은 이미지 요청을 선택하세요.', 422)
        selected = []
        reused = []
        reference, reference_views = _reference_views(state)
        for request in images:
            slot, view, failure_id = (request[k] for k in ('slot', 'view', 'failure_id'))
            if slot == REFERENCE:
                part, image = None, reference_views.get(view)
            else:
                part = next((p for p in state.get('parts', []) if p['slot'] == slot), None)
                image = part.get('views', {}).get(view) if part else None
            if not state.get('production_spec') or not image:
                raise PipelineError('view_not_found', '이미지 작업을 찾을 수 없습니다.', 404)
            reused.append(any(a.get('failure', {}).get('id') == failure_id for a in image.get('previous_attempts', [])))
            selected.append((part, view, image, failure_id))
        if all(reused):
            return service.factory.get(owner, job_id), False
        if any(reused):
            raise PipelineError('failure_changed', '이미 접수한 이미지가 포함되어 있습니다.', 409)
        lock = _RUN_LOCKS.get(str(directory))
        if job['status'] not in ('pipeline_paused', 'failed', 'recovery_required') or (lock and lock.locked()):
            raise PipelineError('worker_running', '진행 중인 작업입니다.', 409)
        for part, view, image, failure_id in selected:
            failure = image_failure(image)
            if image['status'] not in RETRYABLE or not failure or failure['id'] != failure_id:
                raise PipelineError('failure_changed', '이미지 상태가 변경되었습니다.', 409)
            receipt = (reference_receipt(directory, view, image) if part is None
                       else receipt_path(directory, part['slot'], view, image))
            if image['status'] != 'qc_failed' and receipt.with_suffix('.response.json').is_file():
                raise PipelineError('response_saved', '저장된 응답에서 재개할 수 있습니다.', 409)
            if reference_has_dependents(state, view) if part is None else has_dependents(state, part, view):
                raise PipelineError('dependent_views_exist', '후속 이미지가 있는 작업은 새 버전이 필요합니다.', 409)
        for part, view, image, failure_id in selected:
            image['failure'] = image_failure(image)
            previous = image.get('previous_attempts', []) + [{k: deepcopy(v) for k, v in image.items() if k != 'previous_attempts'}]
            if part is None:
                reset = {key: deepcopy(image[key]) for key in REFERENCE_KEPT_FIELDS if key in image}
                reference_views[view] = {**reset, 'status': 'pending', 'previous_attempts': previous,
                                         'receipt': f'canonical-reference-{view}-retry-{failure_id}-provider'}
                reference.update(status='pending')
                reference.pop('failure', None)
                continue
            part['views'][view] = {'status': 'pending', 'receipt': f'{part["slot"]}-{view}-retry-{failure_id}-provider', 'previous_attempts': previous}
            part['image'] = {'status': 'pending'}
        service.publish(owner, job_id, state)
        job = read_json(directory/'job.json')
        job.update(status='pipeline_queued', resume_stage='images', model_retry=False, error=None,
                   executor=service.factory.instance, executor_process=identity(), updated_at=now())
        job.pop('interrupted', None)
        _write_json(directory/'job.json', job)
        _write_json(directory/'output/progress.json', {'stage': 'images', 'message': '이미지 다시 요청 중'})
    return service.factory.get(owner, job_id), True
