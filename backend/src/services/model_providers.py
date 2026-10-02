"""3D provider selection and the Tripo multiview and single-image contracts beside Meshy.

The provider is frozen per accepted request. Both providers receive the same
ordered views as short-lived URLs of the stored inputs (a studio prop sends its
one image the same way); task receipts record the provider so refresh, download
and recovery never mix endpoints.
"""
import json
import os

import httpx

from src.services.character_pipeline import PipelineError, read_json

PROVIDERS = ('meshy', 'tripo')
LABELS = {'meshy': 'Meshy', 'tripo': 'Tripo'}
MESHY_BASE = 'https://api.meshy.ai'
TRIPO_BASE = 'https://api.tripo3d.ai/v2/openapi'
TRIPO_MODEL = 'v3.1-20260211'
# Tripo task states -> the Meshy-style states the pipeline already understands.
TRIPO_STATUS = {'queued': 'PENDING', 'running': 'IN_PROGRESS', 'success': 'SUCCEEDED', 'failed': 'FAILED',
                'cancelled': 'CANCELED', 'banned': 'FAILED', 'expired': 'FAILED', 'unknown': 'IN_PROGRESS'}
TRIPO_ORDER = ('front', 'side', 'back', 'opposite')  # Tripo: [front, left, back, right]


def configured():
    return {'meshy': bool(os.getenv('MESHY_API_KEY', '').strip()),
            'tripo': bool(os.getenv('TRIPO_API_KEY', '').strip())}


def resolve_provider(requested=None):
    name = requested or os.getenv('AVATAR_3D_PROVIDER', 'meshy').strip().lower() or 'meshy'
    if name not in PROVIDERS:
        raise PipelineError('invalid_provider', '3D 생성 제공자를 다시 선택하세요.', 422)
    return name


def base_url(provider, state=None):
    if provider == 'tripo':
        return ((state or {}).get('tripo_base') or os.getenv('TRIPO_API_BASE_URL', TRIPO_BASE)).rstrip('/')
    return ((state or {}).get('meshy_base') or os.getenv('MESHY_API_BASE_URL', MESHY_BASE)).rstrip('/')


def client(provider, state=None, *, timeout=120):
    key = os.getenv('TRIPO_API_KEY' if provider == 'tripo' else 'MESHY_API_KEY', '').strip()
    if not key:
        raise PipelineError('provider_unavailable', f'{LABELS.get(provider, provider)} API 설정이 필요합니다.', 422)
    return httpx.Client(base_url=base_url(provider, state), headers={'Authorization': 'Bearer '+key}, timeout=timeout)


def tripo_payload(urls_by_view, *, face_limit=None, texture=True, pbr=True):
    """multiview_to_model body: four file slots [front, left, back, right]; front is required."""
    if 'front' not in urls_by_view:
        raise ValueError('Tripo multiview requires a front view')
    files = [({'type': 'png', 'url': urls_by_view[view]} if view in urls_by_view else {}) for view in TRIPO_ORDER]
    return _tripo_task('multiview_to_model', {'files': files}, face_limit, texture, pbr)


def tripo_image_payload(url, *, face_limit=None, texture=True, pbr=True):
    """image_to_model body: one stored PNG by its short-lived URL, with the multiview quality settings."""
    if not isinstance(url, str) or not url.startswith('https://'):
        raise ValueError('Tripo image_to_model requires an https URL of the stored image')
    return _tripo_task('image_to_model', {'file': {'type': 'png', 'url': url}}, face_limit, texture, pbr)


def _tripo_task(kind, inputs, face_limit, texture, pbr):
    payload = {'type': kind, 'model_version': os.getenv('TRIPO_MODEL_VERSION', TRIPO_MODEL), **inputs,
               'texture': bool(texture), 'pbr': bool(pbr), 'texture_quality': 'standard',
               'geometry_quality': 'standard', 'orientation': 'default', 'auto_size': False}
    if face_limit:
        payload['face_limit'] = int(face_limit)
    return payload


def tripo_task_id(response_json):
    data = response_json.get('data') or {}
    if response_json.get('code') not in (0, None):
        return None
    return data.get('task_id')


def failure_text(slot, task):
    """Why a part's 3D task failed, naming the provider that ran it. A Tripo content-policy refusal
    (task error 2008) is refused again for the same drawing, so it does not suggest a plain retry."""
    provider = 'Tripo' if task.get('provider') == 'tripo' else 'Meshy'
    code = task.get('provider_error')
    if provider == 'Tripo' and code == 2008:
        return f'{slot}: Tripo 콘텐츠 정책 검사에서 거절됨 (2008) · 같은 그림은 다시 거절되므로 방식이나 설명을 바꿔 새로 요청하세요.'
    detail = f' (오류 {code})' if isinstance(code, int) and not isinstance(code, bool) else ''
    return f'{slot}: {provider} {task.get("status")}{detail} · 성공한 파츠 보존 · 3D 파츠부터 실행으로 다시 요청할 수 있습니다.'


def uncertain_text(slot, task):
    provider = 'Tripo' if task.get('provider') == 'tripo' else 'Meshy'
    return f'{slot}: {provider} 요청 접수 여부 확인 필요 · 3D 파츠부터 실행으로 다시 요청할 수 있습니다.'


# Tripo reports an empty balance with code 2010 (also as HTTP 403).
TRIPO_CREDIT_CODES = (2010,)


def tripo_refusal(response_json):
    """A definite refusal inside a successful HTTP response, or None.

    Tripo answers every request with {"code": ..., "data": ...}; a non-zero code means no
    task was created. The public message names only the numeric code, never provider text.
    """
    if not isinstance(response_json, dict):
        return None
    code = response_json.get('code')
    if code in (0, None):
        return None
    number = code if isinstance(code, int) and not isinstance(code, bool) else None
    if number in TRIPO_CREDIT_CODES:
        message = 'Tripo 크레딧 부족 · 충전 후 3D 파츠부터 실행하세요 · 받은 이미지와 파일은 보존했습니다.'
    else:
        label = f' (코드 {number})' if number is not None else ''
        message = f'Tripo 요청 거절{label} · 입력을 확인한 뒤 3D 파츠부터 실행으로 다시 요청할 수 있습니다 · 받은 이미지와 파일은 보존했습니다.'
    return {'code': number, 'message': message}


def tripo_state(response_json):
    data = response_json.get('data') or {}
    return TRIPO_STATUS.get(str(data.get('status', 'unknown')).lower(), 'IN_PROGRESS'), data.get('progress')


def tripo_model_url(result_json):
    output = (result_json.get('data') or {}).get('output') or {}
    return output.get('pbr_model') or output.get('model') or output.get('base_model')


def _receipt_code(run):
    """Tripo's numeric code in the private receipt of an HTTP-refused submission (403 carries 2010)."""
    try:
        code = json.loads(read_json(run/'generation-submission-response.json').get('body') or '{}').get('code')
    except (ValueError, AttributeError):
        return None
    return code if isinstance(code, int) and not isinstance(code, bool) else None


def model_problem(task, run=None):
    """Why a saved single-model 3D run cannot continue, naming its provider; None while it can.

    Tripo refusals name only the numeric code and HTTP status, never provider text.
    """
    from src.services.meshy_status import task_problem
    problem = task_problem(task, 'generation')
    if not problem or task.get('provider') != 'tripo':
        return problem
    status, http = task.get('status'), task.get('http_status')
    code = task.get('provider_error') if status in ('FAILED', 'CANCELED') else task.get('provider_code')
    if code is None and status == 'submission_rejected' and run is not None:
        code = _receipt_code(run)
    label = f' (코드 {code})' if code is not None else f' (HTTP {http})' if http else ''
    kept = ' 저장된 이미지와 3D 파일은 유지됩니다.'
    if code == 2008:
        key, message = 'content_refused', ('Tripo 콘텐츠 정책 검사에서 3D 생성이 거절됐습니다 (코드 2008). '
                                           '같은 그림은 다시 거절되므로 설명을 바꿔 새로 요청하세요.' + kept)
    elif status == 'submission_rejected':
        if code in TRIPO_CREDIT_CODES or http == 402:
            key, reason = 'insufficient_credits', 'Tripo 크레딧 부족으로 3D 생성 요청이 거절됐습니다'
        elif http in (401, 403):
            key, reason = 'provider_authentication', 'Tripo 인증·권한 문제로 3D 생성 요청이 거절됐습니다'
        elif http == 429:
            key, reason = 'provider_rate_limit', 'Tripo 요청 한도 초과로 3D 생성 요청이 거절됐습니다'
        else:
            key, reason = status, 'Tripo가 3D 생성 요청을 거절했습니다'
        message = f'{reason}{label}.{kept}'
    elif status == 'submission_not_sent':
        key, message = status, 'Tripo 연결 실패로 3D 생성 요청이 전송되지 않았습니다.'
    elif status == 'submission_uncertain':
        key, message = status, 'Tripo 3D 생성 요청의 접수 여부를 확인하지 못했습니다.'
    elif status == 'FAILED':
        key, message = status, f'Tripo 3D 생성 작업이 실패했습니다{label}.{kept}'
    else:
        key, message = status, f'Tripo 3D 생성 작업이 취소됐습니다.{kept}'
    return {**problem, 'code': key, 'provider_code': code, 'message': message}
