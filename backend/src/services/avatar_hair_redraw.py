"""Frozen high-resolution hair redraw inputs, four cameras and alpha cleanup."""
import hashlib
import io

from PIL import Image

from src.services.avatar_production_spec import project
from src.services.avatar_reference_preparation import _remove_edge_white
from src.services.character_pipeline import PipelineError

REVISION = 'hair-redraw-four-views-v1'
VIEWS = ('front', 'side', 'back', 'opposite')
CAMERAS = {
    'front': 'FRONT: camera on +Z, up +Y.',
    'side': 'LEFT SIDE: camera on +X, up +Y. The face opening points IMAGE-LEFT.',
    'back': 'BACK: camera on -Z, up +Y. Anatomical left (+X) appears IMAGE-LEFT.',
    'opposite': 'RIGHT SIDE: camera on -X, up +Y. The face opening points IMAGE-RIGHT.',
}
PROMPT = (
    'Redraw ONE complete hairstyle at {width}x{height}, high detail RGBA PNG.\n'
    '{references}\n{camera} Orthographic camera, no perspective.\n'
    'Restore clean strand edges and coherent crown, side and rear volume from the original references. '
    'Preserve the style, bangs, length, color, parting and asymmetry. Complete occluded roots in the same style. '
    'Keep a continuous HAIR-COLORED root backing across crown, sides and rear down to the nape; '
    'the rear is covered with hair, not a second face opening. The face and lower neck openings remain open. '
    'Remove skin, face, ears, neck, body, headwear, labels, background and cast shadows. '
    'Keep fine hair strands and hair-colored roots; transparency belongs only outside the hair and in real openings. '
    'Return one view only, without a contact sheet, checkerboard or measurement marks.\n'
    'Use the body guide camera magnification and worn placement. Keep identical canvas coordinates and vertical '
    'placement in all four views. Do not enlarge each view to its own bounding box. '
    'Guide crown and neck pixels from top-left: {anchors}.\n'
    'Rotate the same hairstyle for this camera; do not mirror the other side or copy front bangs onto the rear.'
)


WORN_REVISION = 'hair-redraw-worn-v1'
WORN_VIEWS = ('front', 'side', 'back')
WORN_PROMPT = (
    'Edit input 1, a flat {key} T-pose mannequin, at {width}x{height}.\n'
    '{references}\n'
    'Put the hairstyle from the original drawings on the bald mannequin head, worn at the head size and position. '
    'Preserve its style, bangs, length, colour, parting and asymmetry; complete occluded roots in the same style. '
    'Hair covers the whole scalp including the back of the head; no scalp shows through. '
    'Every uncovered area of the mannequin stays pure flat {key}: no shading, outline, texture, face or skin. '
    'Keep the mannequin pose, size, position and camera exactly.\n'
    '{camera} Orthographic, no perspective. Transparent background. No text, cast shadow or extra objects. One image.'
)


def contract(notes='', source_side_facing='right', worn=False):
    if source_side_facing not in ('left', 'right') or not isinstance(notes, str) or len(notes) > 2000:
        raise PipelineError('invalid_hair_redraw', '헤어 보정 내용과 원본 측면 방향을 확인하세요.', 422)
    if worn:
        from src.services.avatar_worn_images import VIEW_TEXT
        return {'revision': WORN_REVISION, 'views': list(WORN_VIEWS), 'quality': 'high', 'worn': True,
                'background': 'transparent', 'notes': notes.strip(), 'source_side_facing': source_side_facing,
                'prompt_template': WORN_PROMPT, 'cameras': {view: VIEW_TEXT[view] for view in WORN_VIEWS}}
    return {'revision': REVISION, 'views': list(VIEWS), 'quality': 'high',
            'background': 'transparent', 'notes': notes.strip(), 'source_side_facing': source_side_facing,
            'prompt_template': PROMPT, 'cameras': dict(CAMERAS)}


def request_inputs(spec, view, part, body, output, state=None):
    accepted = part['hair_redraw']
    refs, roles = [], []
    if accepted.get('worn'):
        return _worn_inputs(spec, view, part, output, state, accepted)

    def add(image, role):
        name = image['file']
        path = output/name
        if path.name != name or hashlib.sha256(path.read_bytes()).hexdigest() != image['sha256']:
            raise PipelineError('reference_changed', '저장된 헤어 참조 이미지가 변경되었습니다.', 409)
        refs.append(path); roles.append(role)

    add(body['views'][view], 'BODY FIT GUIDE in the requested view. Use only its head size, position and camera; omit the body.')
    for source_view in ('front', 'back', 'side'):
        role = ('ORIGINAL PROFILE, face opening points IMAGE-'+accepted['source_side_facing'].upper()
                if source_view == 'side' else 'ORIGINAL '+source_view.upper())
        add(part['source_views'][source_view], role+'. Preserve this hairstyle, color, parting, length and asymmetry.')
    for previous in VIEWS[:VIEWS.index(view)]:
        add(part['views'][previous], 'SAVED '+previous.upper()+' OF THIS REDRAW. Same object, scale, crown, roots and strand tips.')
    canvas = spec['canvas']
    anchors = {name: [round(n, 1) for n in project(spec['anchors'][name], view, spec)]
               for name in ('crown', 'neck')}
    prompt = accepted.get('prompt_template', PROMPT).format(
        width=canvas['width'], height=canvas['height'], anchors=anchors,
        references='\n'.join(f'Input {i}: {role}' for i, role in enumerate(roles, 1)),
        camera=accepted.get('cameras', CAMERAS)[view])
    if accepted.get('notes'):
        prompt += '\nRequested appearance corrections: '+accepted['notes']
    return refs, roles, prompt


def _worn_inputs(spec, view, part, output, state, accepted):
    from src.services.avatar_worn_images import key_hex
    refs, roles = [], []

    def add(image, role):
        name = image['file']
        path = output/name
        if path.name != name or hashlib.sha256(path.read_bytes()).hexdigest() != image['sha256']:
            raise PipelineError('reference_changed', '저장된 헤어 참조 이미지가 변경되었습니다.', 409)
        refs.append(path); roles.append(role)
    key_name = part['key_color']
    add(state['key_mannequins'][key_name][view], 'MANNEQUIN in this view: exact pose, size, position and camera.')
    for source_view in ('front', 'back', 'side'):
        role = ('ORIGINAL HAIRSTYLE PROFILE, face opening points IMAGE-'+accepted['source_side_facing'].upper()
                if source_view == 'side' else 'ORIGINAL HAIRSTYLE '+source_view.upper())
        add(part['source_views'][source_view], role+'. Preserve this hairstyle.')
    for previous in WORN_VIEWS[:WORN_VIEWS.index(view)]:
        add(part['views'][previous], 'SAVED '+previous.upper()+' OF THIS HAIRSTYLE ON THE MANNEQUIN. Same hair; only the camera moves.')
    canvas = spec['canvas']
    prompt = accepted['prompt_template'].format(
        key=f'{key_name} {key_hex(key_name)}', width=canvas['width'], height=canvas['height'],
        references='\n'.join(f'Input {i}: {role}' for i, role in enumerate(roles, 1)),
        camera=accepted['cameras'][view])
    if accepted.get('notes'):
        prompt += '\nRequested appearance corrections: '+accepted['notes']
    return refs, roles, prompt


def prepare_background(raw):
    """Preserve provider alpha and interior colors; remove only border matte."""
    normalized, report = _remove_edge_white(raw)
    with Image.open(io.BytesIO(normalized)) as image:
        alpha = image.convert('RGBA').getchannel('A')
        histogram = alpha.histogram()
        report.update(alpha_min=alpha.getextrema()[0], alpha_max=alpha.getextrema()[1],
                      transparent_pixels=sum(histogram[:16]),
                      partially_transparent_pixels=sum(histogram[16:240]),
                      source_size=list(image.size))
    return normalized, report
