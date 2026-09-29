"""Serializable garment fitting contracts for generated avatar parts."""
from copy import deepcopy
import hashlib
import json
import math
import re

from src.services.character_pipeline import PipelineError


FIT_PROFILE_REVISION = 'garment-fit-v1'
GARMENT_SLOTS = ('top', 'bottom')
SLEEVES = ('source', 'none', 'short', 'long')
KINDS = ('source', 'pants', 'skirt')
EASES = ('source', 'regular', 'loose')
_FIELDS = {'revision', 'sleeve', 'kind', 'ease', 'length_ratio', 'sleeve_ratio',
           'region_ease', 'anchors', 'source_sha256'}
REGION_EASE_KEYS = ('torso', 'sleeve', 'hip')
_SHA256 = re.compile(r'[0-9a-f]{64}')


def _error(message):
    raise PipelineError('invalid_fit_profile', message, 422)


def _choice(value, allowed, field):
    if value not in allowed:
        _error(f'{field} 값이 올바르지 않습니다. 사용 가능: {", ".join(allowed)}')
    return value


def _ratio(value, field, upper):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _error(f'{field} 값은 유한한 숫자 또는 null이어야 합니다.')
    value = float(value)
    if not ((0.0 <= value if field == 'sleeve_ratio' else 0.0 < value) and value <= upper):
        _error(f'{field} 값의 범위가 올바르지 않습니다. 최대 {upper:g}입니다.')
    return value


def _point(value, field, limit):
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        _error(f'{field}에는 좌표 3개가 필요합니다.')
    point = []
    for coordinate in value:
        if (isinstance(coordinate, bool) or not isinstance(coordinate, (int, float))
                or not math.isfinite(coordinate) or abs(coordinate) > limit):
            _error(f'{field} 좌표는 유한한 미터 값이어야 하며 ±{limit:g} 범위여야 합니다.')
        point.append(float(coordinate))
    return point


def _description_defaults(slot, description, kind):
    text = description.lower()
    sleeve = 'source'
    if slot == 'top':
        none = bool(re.search(r'\b(sleeveless|tank(?:\s+top)?|no\s+sleeves?)\b|민소매|나시', text))
        short = bool(re.search(r'\b(short[- ]sleeved?|tee|t-shirt)\b|반팔', text))
        long = bool(re.search(r'\b(long[- ]sleeved?)\b|긴팔', text))
        selected = [name for name, matched in (('none', none), ('short', short), ('long', long)) if matched]
        if len(selected) == 1:
            sleeve = selected[0]
    resolved_kind = kind if kind in KINDS else 'source'
    if slot == 'bottom' and resolved_kind == 'source':
        skirt = bool(re.search(r'\bskirt\b|치마', text))
        pants = bool(re.search(r'\b(pants|trousers|shorts|jeans)\b|바지|반바지', text))
        if skirt != pants:
            resolved_kind = 'skirt' if skirt else 'pants'
    loose = bool(re.search(r'\b(loose|oversized|baggy|relaxed)\b|루즈|오버사이즈|헐렁', text))
    regular = bool(re.search(r'\b(regular(?:\s+fit)?|fitted|slim)\b|레귤러|정핏', text))
    ease = ('loose' if loose else 'regular') if loose != regular else 'source'
    return sleeve, resolved_kind, ease


def normalize_fit_profile(value=None, *, slot, description='', kind='source'):
    """Validate and complete one pure-data garment profile.

    Missing dimensions remain ``None`` so ``source`` means preserve the source
    garment proportions instead of substituting a factory length.
    """
    if slot not in GARMENT_SLOTS:
        _error('상의와 하의에만 의상 피팅을 적용할 수 있습니다.')
    if value is None:
        value = {}
    if not isinstance(value, dict):
        _error(f'{slot} fit_profile은 객체여야 합니다.')
    unknown = set(value) - _FIELDS
    if unknown:
        _error(f'{slot} fit_profile에 지원하지 않는 항목이 있습니다: {", ".join(sorted(unknown))}')
    revision = value.get('revision', FIT_PROFILE_REVISION)
    if revision != FIT_PROFILE_REVISION:
        _error(f'{slot} fit_profile revision은 {FIT_PROFILE_REVISION}이어야 합니다.')
    if not isinstance(description, str):
        _error(f'{slot} 설명은 문자열이어야 합니다.')
    if kind not in KINDS:
        _error(f'{slot} kind 값이 올바르지 않습니다.')
    default_sleeve, default_kind, default_ease = _description_defaults(slot, description, kind)
    sleeve = _choice(value.get('sleeve', default_sleeve), SLEEVES, 'sleeve')
    garment_kind = _choice(value.get('kind', default_kind), KINDS, 'kind')
    ease = _choice(value.get('ease', default_ease), EASES, 'ease')
    region_ease = value.get('region_ease', {})
    if not isinstance(region_ease, dict) or not set(region_ease) <= set(REGION_EASE_KEYS):
        _error('region_ease에는 torso, sleeve, hip만 입력할 수 있습니다.')
    normalized_region_ease = {
        region: _choice(region_ease[region], EASES, f'region_ease.{region}')
        for region in REGION_EASE_KEYS if region in region_ease
    }
    anchors = value.get('anchors', [])
    if not isinstance(anchors, list) or len(anchors) > 48:
        _error('anchors는 최대 48개까지 입력할 수 있습니다.')
    normalized_anchors = []
    names = set()
    for index, anchor in enumerate(anchors):
        if not isinstance(anchor, dict) or set(anchor) - {'name', 'source', 'target'}:
            _error(f'anchors[{index}]에는 name, source와 선택적 target만 입력할 수 있습니다.')
        name = anchor.get('name')
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,64}', name):
            _error(f'anchors[{index}].name이 올바르지 않습니다.')
        if name in names:
            _error(f'중복된 앵커 이름입니다: {name}')
        names.add(name)
        normalized = {'name': name, 'source': _point(anchor.get('source'), f'anchors[{index}].source', 1000.0)}
        if 'target' in anchor:
            normalized['target'] = _point(anchor['target'], f'anchors[{index}].target', 10.0)
        normalized_anchors.append(normalized)
    result = {
        'revision': FIT_PROFILE_REVISION,
        'sleeve': sleeve,
        'kind': garment_kind,
        'ease': ease,
        'region_ease': normalized_region_ease,
        'length_ratio': _ratio(value.get('length_ratio'), 'length_ratio', 3.0),
        'sleeve_ratio': _ratio(value.get('sleeve_ratio'), 'sleeve_ratio', 1.5),
        'anchors': normalized_anchors,
    }
    source_sha256 = value.get('source_sha256')
    if source_sha256 is not None:
        if not isinstance(source_sha256, str) or not _SHA256.fullmatch(source_sha256):
            _error('source_sha256는 소문자 SHA-256 값이어야 합니다.')
        result['source_sha256'] = source_sha256
    return result


def normalize_fit_profiles(value=None, *, descriptions=None, kinds=None, slots=GARMENT_SLOTS):
    if value is None:
        value = {}
    if not isinstance(value, dict) or not set(value) <= set(GARMENT_SLOTS):
        _error('fit_profiles에는 top과 bottom만 입력할 수 있습니다.')
    descriptions = descriptions or {}
    kinds = kinds or {}
    return {slot: normalize_fit_profile(value.get(slot), slot=slot,
                                        description=descriptions.get(slot, ''),
                                        kind=kinds.get(slot, 'source'))
            for slot in slots if slot in GARMENT_SLOTS}


def reject_generation_fit_profile(profile, *, slot):
    """Prevent anchors measured from an older mesh entering a new image job."""
    if profile.get('anchors') or profile.get('source_sha256'):
        _error(f'{slot}의 anchors와 source_sha256는 로컬 재피팅에서만 사용할 수 있습니다.')


def fit_profiles_sha256(profiles):
    canonical = json.dumps(profiles, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(canonical).hexdigest()


def copy_fit_profile(profile):
    return deepcopy(profile)
