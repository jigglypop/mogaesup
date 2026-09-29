"""Durable front/side appearance normalization before modular part generation."""
from copy import deepcopy
import hashlib
import io
import uuid

import httpx
from PIL import Image, ImageDraw

from src.services.asset_editor import _write_json
from src.services.avatar_openai_images import (
    OpenAIImageHTTPError, generate_standard_part_image, image_error_message,
)
from src.services.avatar_production_spec import guide, prepare_image, project
from src.services.character_pipeline import PipelineError, now, read_json


LEGACY_REFERENCE_REVISION = 'metric-character-reference-v1'
REFERENCE_REVISION = 'metric-character-reference-v2-front-side'
FROZEN_REFERENCE_REVISION = 'metric-character-reference-v3-saved-body'
MANAGED_REFERENCE_REVISION = 'metric-character-reference-v4-managed-ko'
T_REFERENCE_REVISION = 'metric-character-reference-v5-front-side-t'
T_FROZEN_REFERENCE_REVISION = 'metric-character-reference-v6-saved-body-t'
T_MANAGED_REFERENCE_REVISION = 'metric-character-reference-v7-managed-ko-t'
REFERENCE_PROMPT = (
    'Create ONE canonical full-body appearance reference of the same character shown in the original image. '
    'Preserve the original identity, face, facial features, hairstyle, hair color, skin color, clothing design, '
    'clothing colors, materials and attached character details. Keep the character fully clothed. '
    'Normalize only the geometry and presentation to the supplied common measurement guide: use the SAME fixed '
    '1.2 metre chibi body and oversized-head proportions, the SAME floor position, centerline, joint locations, '
    'horizontal front orthographic camera, framing and exact T-pose with both arms straight at 90 degrees. '
    'Show one complete character from the top of the hair to both separated soles, with both hands visible and '
    'feet parallel. Do not crop, redesign, simplify, remove or add garments, hair, face details or accessories. '
    'Return only the character at the guide scale and position with a transparent alpha background; no scenery, '
    'ground, cast shadow, text, border, measurement marks or extra character.'
)
SIDE_REFERENCE_PROMPT = (
    'Create ONE canonical full-body RIGHT-SIDE appearance reference of the same character shown in the original '
    'image and the supplied canonical front reference. Preserve the original identity, profile of the face, '
    'hairstyle and hair color, skin color, clothing design, clothing colors, materials and attached character '
    'details. Keep the character fully clothed. Normalize only geometry and presentation to the supplied common '
    'measurement guide: use the SAME fixed 1.2 metre chibi body, oversized-head proportions, floor position, '
    'joint heights and horizontal right-side orthographic camera. Use an exact upright I-pose with both arms '
    'straight down at the sides and the feet aligned to the common side-view guide. Show the complete character '
    'from the top of the hair to the soles. Keep the canonical front body, head, shoulder, torso and floor '
    'landmarks and the same skeletal lengths; rotate only the arm joints into the fixed I-pose coordinates shown '
    'by the side guide. Change no proportions. Do not crop, redesign, simplify, '
    'remove or add garments, hair, face details or accessories. Return only the character at the guide scale and '
    'position with a transparent alpha background; no scenery, ground, cast shadow, text, border, measurement '
    'marks or extra character.'
)
T_SIDE_REFERENCE_PROMPT = (
    'Create ONE canonical full-body RIGHT-SIDE appearance reference of the same character shown in the original '
    'image and the supplied canonical front reference. Preserve identity, profile, hairstyle, colors, clothing, '
    'materials and attached details. Keep the character fully clothed. Use the same fixed body, proportions, '
    'floor position, joint locations and right-side orthographic camera as the front reference. Keep the exact '
    'same horizontal T-pose: both arms remain straight and abducted 90 degrees at shoulder height. In profile '
    'the arms overlap along the camera axis; do not lower, bend or move them to reveal the hands. Show the complete '
    'character from hair top to soles. Change no proportions. Do not crop, redesign, remove or add parts. Return '
    'only the character on transparent alpha without scenery, ground, shadow, text or measurement marks.'
)
REFERENCE_VIEWS = {
    'front': {'prompt': REFERENCE_PROMPT, 'file': 'canonical-reference.png',
              'raw_file': 'canonical-raw.png', 'receipt': 'canonical-reference-provider'},
    'side': {'prompt': SIDE_REFERENCE_PROMPT, 'file': 'canonical-reference-side.png',
             'raw_file': 'canonical-side-raw.png', 'receipt': 'canonical-reference-side-provider'},
}
SIDE_I_POSE_LAYOUT = {
    'pose': 'I', 'camera_axis': '+X_to_-X', 'shoulder_y_m': 0.43,
    'elbow_y_m': 0.315, 'wrist_y_m': 0.20, 'arm_length_m': 0.23,
}
FROZEN_SIDE_LAYOUT = {'pose': 'I', 'camera_axis': '+X_to_-X', 'source': 'saved_body_rig'}
SIDE_T_POSE_LAYOUT = {'pose': 'T', 'camera_axis': '+X_to_-X', 'source': 'production_spec'}
FROZEN_SIDE_T_LAYOUT = {'pose': 'T', 'camera_axis': '+X_to_-X', 'source': 'saved_body_rig'}


def reference_prompt(view, frozen_body=False, *, t_pose=False):
    prompt = T_SIDE_REFERENCE_PROMPT if view == 'side' and t_pose else REFERENCE_VIEWS[view]['prompt']
    if frozen_body:
        prompt = prompt.replace('fixed 1.2 metre chibi body', 'saved body dimensions').replace(
            'fixed 1.2 metre', 'saved body dimensions').replace('1.2 metre chibi body', 'saved body dimensions')
        prompt += (' The supplied saved-body render defines the exact head, torso, limb lengths, thickness and joint positions. '
                   'Dress this saved body with the original photo design. Never replace its anatomy with the photo body '
                   + ('or a generic template. The body guide uses the same T-pose in front and right-side views. '
                      if t_pose else 'or a generic template. The body guide uses a front T-pose and a right-side I-pose. ') +
                   'Preserve headbands, bows and hair ornaments as their original accessory type; do not turn them into hats.')
    return prompt


def initial_state(*, frozen_body=False, prompts=None):
    """Create the immutable T-pose request contract used only by new jobs."""
    if prompts is not None:
        fixed = ('\nFIXED FACTORY CONTRACT: preserve the supplied body-guide coordinates, joint locations and orthographic cameras. '
                 'Both front and right-side views use the identical horizontal T-pose with straight arms abducted '
                 '90 degrees at shoulder height. Side-view arm overlap is required; never lower the arms into an I-pose. '
                 'Preserve the same full-body and clothing proportions and return a transparent background. ')
        fixed += ('Use the saved body dimensions exactly.' if frozen_body
                  else 'Use the guide 1.2 metre SD base body and oversized-head proportions exactly.')
        views = {view: {'status': 'pending', 'prompt': prompts[view] + fixed,
                        **({'layout': FROZEN_SIDE_T_LAYOUT if frozen_body else SIDE_T_POSE_LAYOUT}
                           if view == 'side' else {})}
                 for view in REFERENCE_VIEWS}
        for image in views.values():
            image['prompt_sha256'] = hashlib.sha256(image['prompt'].encode()).hexdigest()
        return {'status': 'pending', 'revision': T_MANAGED_REFERENCE_REVISION, 'frozen_body': frozen_body,
                'prompt': views['front']['prompt'], 'views': views}
    return {'status': 'pending',
            'revision': T_FROZEN_REFERENCE_REVISION if frozen_body else T_REFERENCE_REVISION,
            'prompt': reference_prompt('front', frozen_body, t_pose=True),
            'views': {view: {'status': 'pending', 'prompt': reference_prompt(view, frozen_body, t_pose=True),
                             **({'layout': FROZEN_SIDE_T_LAYOUT if frozen_body else SIDE_T_POSE_LAYOUT}
                                if view == 'side' else {})}
                      for view in REFERENCE_VIEWS}}


def uses_legacy_side_pose(reference):
    """Retain the old I-pose render only for already accepted reference contracts."""
    return bool(reference and reference.get('revision') in (
        REFERENCE_REVISION, FROZEN_REFERENCE_REVISION, MANAGED_REFERENCE_REVISION))


def _receipt(output, view='front', *, legacy=False):
    name = 'canonical-reference-provider' if legacy else REFERENCE_VIEWS[view]['receipt']
    return output/name


def view_receipt(output, view, image):
    """An explicit retry sends under its own receipt; the first attempt keeps the fixed name."""
    return output/image['receipt'] if image.get('receipt') else _receipt(output, view)


def _recoverable(image, receipt):
    status = image.get('status')
    if status in ('pending', 'not_sent', 'received'):
        return True
    if status in ('submitting', 'submission_uncertain', 'failed'):
        return receipt.with_suffix('.response.json').is_file()
    return False


def can_resume(directory, state):
    reference = state.get('reference_preparation')
    if not reference or reference.get('status') == 'succeeded':
        return None
    output = directory/'output'
    views = reference.get('views')
    if not isinstance(views, dict):
        return _recoverable(reference, _receipt(output, legacy=True))
    for view in REFERENCE_VIEWS:
        image = views.get(view, {})
        if image.get('status') == 'succeeded':
            continue
        return _recoverable(image, view_receipt(output, view, image))
    return True


def _remove_edge_white(raw):
    """Remove only near-white pixels connected to an opaque image border."""
    with Image.open(io.BytesIO(raw)) as opened:
        image = opened.convert('RGBA')
    alpha = image.getchannel('A')
    if alpha.getextrema()[0] < 255:
        return raw, {'method': 'provider_alpha_preserved', 'removed_pixels': 0}
    rgb = image.convert('RGB')
    mask = Image.new('L', image.size)
    mask.putdata([255 if min(pixel) >= 242 and max(pixel)-min(pixel) <= 18 else 0
                  for pixel in rgb.getdata()])
    width, height = image.size
    seeds = [(x, y) for x in range(width) for y in (0, height-1)]
    seeds += [(x, y) for y in range(1, height-1) for x in (0, width-1)]
    for seed in seeds:
        if mask.getpixel(seed) == 255:
            ImageDraw.floodfill(mask, seed, 128, thresh=0)
    values = list(mask.getdata())
    removed = sum(value == 128 for value in values)
    alpha = Image.new('L', image.size, 255)
    alpha.putdata([0 if value == 128 else 255 for value in values])
    image.putalpha(alpha)
    output = io.BytesIO(); image.save(output, format='PNG', compress_level=2)
    return output.getvalue(), {'method': 'edge_connected_near_white_v1', 'removed_pixels': removed,
                               'interior_white_preserved': True}


def _failure(exc, receipt):
    transport = read_json(receipt.with_suffix('.request.json'))
    saved = receipt.with_suffix('.response.json').is_file()
    if saved:
        status, category, message = 'submitting', 'local_processing', '수신 이미지 로컬 처리 중단'
    elif isinstance(exc, OpenAIImageHTTPError):
        status, category = 'rejected', exc.category
        message = image_error_message(category, exc.response.status_code)
    elif transport.get('submission') == 'not_sent':
        status, category, message = 'not_sent', 'provider_connection', '생성 서버 연결 실패 · 재개 가능'
    elif isinstance(exc, httpx.RequestError):
        status, category, message = 'submission_uncertain', 'provider_connection', '생성 서버 연결 끊김 · 수신된 응답 없음'
    else:
        status, category, message = 'failed', 'local_processing', '공통 규격 원본 이미지 처리 실패'
    failure = {'id': getattr(exc, 'diagnostic_id', uuid.uuid4().hex[:12]), 'type': type(exc).__name__,
               'category': category, 'message': message, 'phase': transport.get('phase'),
               'elapsed_seconds': transport.get('elapsed_seconds'), 'at': now()}
    if isinstance(exc, OpenAIImageHTTPError):
        failure.update(http_status=exc.response.status_code, provider_code=exc.provider_error.get('code'))
    return status, failure


def _reference_guide(view, spec, frozen_render=None, *, t_pose=False):
    if frozen_render is not None:
        return frozen_render.read_bytes()
    if view != 'side' or t_pose:
        return guide(view, spec)
    # The modular part guides remain the authored horizontal T-pose. Only the
    # appearance-normalization profile uses this fixed I-pose arm projection.
    posed = deepcopy(spec)
    for side in ('left', 'right'):
        shoulder = posed['anchors'][f'shoulder_{side}']
        posed['anchors'][f'wrist_{side}'] = [shoulder[0], SIDE_I_POSE_LAYOUT['wrist_y_m'], shoulder[2]]
    with Image.open(io.BytesIO(guide(view, posed))) as opened:
        image = opened.convert('RGBA')
    draw = ImageDraw.Draw(image)
    points = [project((0, SIDE_I_POSE_LAYOUT[key], 0), view, posed)
              for key in ('shoulder_y_m', 'elbow_y_m', 'wrist_y_m')]
    draw.line(points, fill='#7257b5', width=5)
    for x, y in points:
        draw.ellipse((x-7, y-7, x+7, y+7), fill='#7257b5')
    output = io.BytesIO(); image.save(output, format='PNG')
    return output.getvalue()


def _execute_view(service, owner, job_id, state, job, reference, view, image, *, legacy=False):
    directory = service.factory.directory(owner, job_id); output = directory/'output'
    contract = REFERENCE_VIEWS[view]
    revision = reference.get('revision')
    managed = revision in (MANAGED_REFERENCE_REVISION, T_MANAGED_REFERENCE_REVISION)
    t_pose = revision in (T_REFERENCE_REVISION, T_FROZEN_REFERENCE_REVISION, T_MANAGED_REFERENCE_REVISION)
    frozen_body = reference.get('frozen_body') is True if managed else revision in (FROZEN_REFERENCE_REVISION, T_FROZEN_REFERENCE_REVISION)
    prompt = reference['prompt'] if legacy else image['prompt'] if managed else reference_prompt(view, frozen_body, t_pose=t_pose)
    canonical = output/contract['file']; raw_path = output/contract['raw_file']
    if image.get('status') == 'succeeded':
        if (not canonical.is_file() or hashlib.sha256(canonical.read_bytes()).hexdigest() != image.get('sha256')
                or not raw_path.is_file() or hashlib.sha256(raw_path.read_bytes()).hexdigest() != image.get('raw_sha256')):
            raise PipelineError('reference_changed', '저장된 공통 규격 원본 이미지가 변경되었습니다.', 409)
        return
    receipt = _receipt(output, view, legacy=True) if legacy else view_receipt(output, view, image)
    if not _recoverable(image, receipt):
        raise PipelineError('reference_recovery_required', '공통 규격 원본 이미지 응답을 확인해야 합니다.', 409)
    spec = state['production_spec']
    guide_path = output/f'guide-reference-{view}.png'
    frozen_render = output/('body-front.png' if view == 'front' else 'body-side.png' if t_pose else 'body-side-i.png') if frozen_body else None
    guide_bytes = _reference_guide(view, spec, frozen_render, t_pose=t_pose)
    if guide_path.is_file() and guide_path.read_bytes() != guide_bytes:
        raise PipelineError('guide_changed', '생산 기준 이미지가 변경되었습니다.', 409)
    guide_path.write_bytes(guide_bytes)
    references = [guide_path, directory/'source.png']
    if view == 'side' and not legacy:
        front = output/REFERENCE_VIEWS['front']['file']
        if not front.is_file():
            raise PipelineError('reference_front_missing', '정면 공통 규격 원본을 먼저 준비해야 합니다.', 409)
        references.append(front)
    identities = [{'name': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
                  for path in references]
    prompt_receipt = receipt.with_suffix('.prompt.json')
    recorded = read_json(prompt_receipt)
    revision = reference['revision']
    if recorded:
        if (recorded.get('revision') != revision or recorded.get('prompt') != prompt
                or recorded.get('references') != identities):
            raise PipelineError('reference_request_changed', '기록된 공통 규격 원본 요청 입력이 변경되었습니다.', 409)
    else:
        _write_json(prompt_receipt, {'revision': revision, 'prompt': prompt,
                                    'spec_sha256': spec['sha256'], 'references': identities})
    if image.get('status') != 'received':
        attempts = (sum(int('attempted_at' in item) for item in reference.get('views', {}).values())
                    if not legacy else int('attempted_at' in image))
        if image.get('status') == 'pending' and attempts >= job.get('limits', {}).get('reference_tasks', 1):
            raise PipelineError('image_budget_exhausted', '허용된 공통 규격 원본 생성 횟수를 모두 사용했습니다.', 409)
        image.pop('failure', None)
        image.update(status='submitting', attempted_at=image.get('attempted_at', now()))
        service.publish(owner, job_id, state)
        completed = sum(item.get('status') == 'succeeded' for item in reference.get('views', {}).values())
        _write_json(output/'progress.json', {'stage': 'reference',
            'message': f'공통 규격 원본 이미지 생성 {completed}/2 · {"정면" if view == "front" else "오른쪽 측면"}'})
        try:
            raw = generate_standard_part_image(references, prompt, state['image_model'], state['image_base'],
                                               receipt=receipt,
                                               canvas_size=(spec['canvas']['width'], spec['canvas']['height']))
            raw_path.write_bytes(raw)
            image.update(status='received', raw_file=raw_path.name, raw_sha256=hashlib.sha256(raw).hexdigest())
            service.publish(owner, job_id, state)
            _write_json(output/'progress.json', {'stage': 'reference',
                'message': f'공통 규격 원본 {"정면" if view == "front" else "오른쪽 측면"} 배경 제거 중'})
        except Exception as exc:
            status, failure = _failure(exc, receipt)
            image.update(status=status, failure=failure)
            reference.update(status=status, failure=failure)
            service.publish(owner, job_id, state)
            raise PipelineError('reference_response_missing', failure['message'], 409) from None
    received = raw_path.read_bytes()
    if hashlib.sha256(received).hexdigest() != image.get('raw_sha256'):
        raise PipelineError('reference_changed', '수신된 공통 규격 원본 이미지 해시가 일치하지 않습니다.', 409)
    foreground, background = _remove_edge_white(received)
    normalized, measurement = prepare_image(foreground, 'reference', spec)
    canonical.write_bytes(normalized)
    image.update(status='succeeded', file=canonical.name, sha256=hashlib.sha256(normalized).hexdigest(),
                 measurement=measurement, background_removal=background)
    image.pop('failure', None)
    service.publish(owner, job_id, state)


def execute(service, owner, job_id, state, job):
    reference = state.get('reference_preparation')
    if not reference:
        return
    revision = reference.get('revision')
    legacy = revision == LEGACY_REFERENCE_REVISION and not isinstance(reference.get('views'), dict)
    if legacy:
        if reference.get('prompt') != REFERENCE_PROMPT:
            raise PipelineError('reference_request_changed', '공통 규격 원본 생성 계약이 변경되었습니다.', 409)
        _execute_view(service, owner, job_id, state, job, reference, 'front', reference, legacy=True)
        return
    managed = revision in (MANAGED_REFERENCE_REVISION, T_MANAGED_REFERENCE_REVISION)
    t_pose = revision in (T_REFERENCE_REVISION, T_FROZEN_REFERENCE_REVISION, T_MANAGED_REFERENCE_REVISION)
    frozen_body = reference.get('frozen_body') is True if managed else revision in (FROZEN_REFERENCE_REVISION, T_FROZEN_REFERENCE_REVISION)
    views = reference.get('views')
    if managed:
        valid_prompts = (isinstance(views, dict)
                        and all(isinstance(views.get(view, {}).get('prompt'), str)
                                and views[view]['prompt'].strip()
                                and hashlib.sha256(views[view]['prompt'].encode()).hexdigest() == views[view].get('prompt_sha256')
                                for view in REFERENCE_VIEWS)
                        and reference.get('prompt') == views['front']['prompt'])
    else:
        valid_prompts = (isinstance(views, dict) and reference.get('prompt') == reference_prompt('front', frozen_body, t_pose=t_pose)
                          and all(views.get(view, {}).get('prompt') == reference_prompt(view, frozen_body, t_pose=t_pose)
                                  for view in REFERENCE_VIEWS))
    expected_layout = ((FROZEN_SIDE_T_LAYOUT if frozen_body else SIDE_T_POSE_LAYOUT) if t_pose
                       else (FROZEN_SIDE_LAYOUT if frozen_body else SIDE_I_POSE_LAYOUT))
    if (revision not in (REFERENCE_REVISION, FROZEN_REFERENCE_REVISION, MANAGED_REFERENCE_REVISION,
                         T_REFERENCE_REVISION, T_FROZEN_REFERENCE_REVISION, T_MANAGED_REFERENCE_REVISION)
            or not valid_prompts
            or (frozen_body and not state.get('base_body', {}).get('prepared'))
            or reference['views'].get('side', {}).get('layout') != expected_layout):
        raise PipelineError('reference_request_changed', '공통 규격 원본 생성 계약이 변경되었습니다.', 409)
    for view in REFERENCE_VIEWS:
        _execute_view(service, owner, job_id, state, job, reference, view, reference['views'][view])
    front = reference['views']['front']
    reference.update(status='succeeded', file=front['file'], sha256=front['sha256'],
                     raw_file=front['raw_file'], raw_sha256=front['raw_sha256'],
                     measurement=front.get('measurement'), background_removal=front.get('background_removal'))
    reference.pop('failure', None)
    service.publish(owner, job_id, state)
    directory = service.factory.directory(owner, job_id)
    _write_json(directory/'output'/'progress.json', {'stage': 'reference',
        'message': '공통 규격 원본 이미지 2/2 저장 완료'})
