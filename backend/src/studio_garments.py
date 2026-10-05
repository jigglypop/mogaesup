"""Wardrobe garments made the studio's way, one at a time or from a local queue: the paid tools of the local studio MCP
(studio_mcp.py) and `asset-studio-mcp garments`.

A garment is the request the studio's SinglePart screen (frontend/src/character/studio/SinglePart.tsx) sends for its
slot with every other choice left as the screen opens: POST /api/avatar-factory/variants/single-part with an
Idempotency-Key, on a body registered in the wardrobe at the version its sealed assembly offers. It passes the Rust gateway
as the browser's request does (paid_operator, FACTORY_ACCESS=paid, FACTORY_PAID_MONTHLY; a replayed key is counted once).
The job assembles itself and the wardrobe lists the part once that assembly is sealed, so there is no publish step.
Designed garments come from the studio's own garment-styles.json in this checkout, read and validated, never written.

The queue is one JSON file per API origin under .data/studio-mcp/ at the repository root, changed under an OS file lock.
An item's request and key are written (fsynced) before its POST. A POST without a definite answer leaves the item
`uncertain`, and only resolve_garment_item sends it again, under the same key. The first refusal stops an advance.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from src.paths import BACKEND_ROOT
from src.studio_mcp import FactoryId, RequestKey, StudioClient


REPO_ROOT = BACKEND_ROOT.parent
CATALOG_PATH = REPO_ROOT/'frontend'/'src'/'character'/'studio'/'garment-styles.json'
STATE_DIR = REPO_ROOT/'.data'/'studio-mcp'
SINGLE_PART = '/api/avatar-factory/variants/single-part'
SLOTS = ('top', 'bottom', 'shoes', 'hat', 'hair', 'glasses')
MAX_NEW = 3          # paid submissions one advance may send
MAX_IN_FLIGHT = 3    # accepted garments still being made; the queue sends no more until one is done
MAX_ENQUEUE = 30
MAX_OPEN_ITEMS = 300
MAX_CLOSED_ITEMS = 300
MAX_RECEIPTS = 200
STALLED_CHECKS = 6   # stalled garments looked at again per advance, least recently checked first
UNLISTED_CHECKS = 3  # polls a sealed garment may stay off the wardrobe listing before it is reported
MAX_STATE_BYTES = 4*1024*1024
STATES = ('pending', 'submitting', 'running', 'done', 'stalled', 'uncertain', 'failed', 'dropped')

# SinglePart.tsx as it opens: the first method of methodOptions (sent only for these slots), fitProfileFor() with sleeve
# and ease untouched, and meshyDefaultsFor(slot) from meshy-options.ts. The tests compare these with those files.
_METHODS = {'top': 'worn', 'bottom': 'worn', 'hair': 'worn'}
_MESHY_DEFAULTS = {
    'ai_model': 'meshy-7.1', 'geometry_resolution': 'standard', 'should_texture': True, 'enable_pbr': True,
    'texture_resolution': '2k', 'texture_mode': 'source', 'texture_image_assets': [], 'should_remesh': True,
    'topology': 'triangle', 'target_polycount': 50000, 'decimation_mode': None, 'save_pre_remeshed_model': False,
    'pose_mode': '', 'image_enhancement': False, 'remove_lighting': True, 'moderation': False,
    'target_formats': ['glb'], 'auto_size': False, 'origin_at': 'bottom', 'alpha_thumbnail': False,
    'multi_view_thumbnails': False,
}
_POLYCOUNT = {'hair': 30000, 'hat': 8000, 'top': 18000, 'bottom': 12000, 'shoes': 8000, 'glasses': 3000}

GarmentSlot = Literal['top', 'bottom', 'shoes', 'hat', 'hair', 'glasses']
DesignId = Annotated[str, Field(pattern=r'^(?:top|bottom|shoes|hat|hair|glasses)-[a-f0-9]{8}$')]
ItemId = Annotated[str, Field(pattern=r'^q-[a-f0-9]{12}$')]
MaxNew = Annotated[int, Field(ge=0, le=MAX_NEW)]

_ID = re.compile(r'[a-f0-9]{24}')
_ITEM = re.compile(r'q-[a-f0-9]{12}')
_KEY = re.compile(r'[a-zA-Z0-9_-]{8,100}')
_CODE = re.compile(r'[a-z][a-z0-9_]{0,63}')
_TEXT = re.compile(r"[\w .,'!?()&+%-]+")
_ADDRESS = re.compile(r'(?i)www\.|\.(?:com|net|org|io|ai|kr|co|dev|app|me|xyz|html?|php|png|jpe?g|webp|gif|glb|gltf'
                      r'|json|py|js|ts|sh|ps1|exe|env)\b')
_BUSY = ('pipeline_queued', 'pipeline_running', 'accepted', 'running')
# Answers after which nothing was accepted although the request is not wrong: the item waits for a later advance.
_REFUSALS = frozenset({'insufficient_credits', 'conflict', 'busy', 'draining', 'provider_unavailable',
                       'storage_required', 'worker_running', 'listing_pending'})
# Answers that do not say whether the POST was taken; the gateway may have sent it on.
_UNSURE = frozenset({'api_unavailable', 'response_too_large', 'invalid_response', 'studio_waking', 'studio_stopping',
                     'factory_unavailable', 'factory_timeout', 'internal'})


def plain_text(value: str, field: str) -> str:
    """A brief or name as words: no web address, file name, path, markup, code punctuation or key-like token."""
    text = ' '.join(value.split())
    if not text or not _TEXT.fullmatch(text):
        raise ValueError(f"{field} takes letters, digits, spaces and . , ' ! ? ( ) & + % - only")
    if _ADDRESS.search(text):
        raise ValueError(f'{field} must not name a web address or a file')
    if any(len(word) > 32 for word in text.split()):
        raise ValueError(f'{field} must not carry tokens or keys')
    return text


class GarmentRequest(BaseModel):
    """One garment for a wardrobe body: a designed garment (`design_id` from list_garment_options; it brings its own
    bottom_kind or hair_length), or a short `brief` with its `slot` and wardrobe `name`."""
    model_config = ConfigDict(extra='forbid', strict=True)
    body_job_id: FactoryId
    design_id: DesignId | None = None
    slot: GarmentSlot | None = None
    brief: str | None = Field(default=None, min_length=8, max_length=600)
    name: str | None = Field(default=None, min_length=1, max_length=60)
    bottom_kind: Literal['pants', 'skirt'] | None = None
    hair_length: Literal['short', 'long'] | None = None

    @field_validator('brief', 'name')
    @classmethod
    def _plain(cls, value, info):
        return None if value is None else plain_text(value, info.field_name)

    @model_validator(mode='after')
    def _one_source(self):
        if self.design_id is not None:
            if self.brief is not None or self.name is not None or self.bottom_kind or self.hair_length:
                raise ValueError('a designed garment takes only body_job_id, design_id and its slot')
            if self.slot is not None and not self.design_id.startswith(self.slot+'-'):
                raise ValueError('slot does not match the designed garment')
            return self
        if self.brief is None or self.slot is None or self.name is None:
            raise ValueError('give design_id, or brief with slot and name')
        if self.bottom_kind and self.slot != 'bottom':
            raise ValueError('bottom_kind is for a bottom')
        if self.hair_length and self.slot != 'hair':
            raise ValueError('hair_length is for hair')
        return self


GarmentList = Annotated[list[GarmentRequest], Field(min_length=1, max_length=MAX_ENQUEUE)]


class _Design(BaseModel):
    model_config = ConfigDict(extra='ignore', strict=True)
    slot: GarmentSlot
    name: str = Field(min_length=1, max_length=100)
    brief: str = Field(min_length=10, max_length=1500)
    bottom_kind: Literal['pants', 'skirt'] | None = None
    hair_length: Literal['short', 'long'] | None = None


class _Catalog(BaseModel):
    model_config = ConfigDict(extra='ignore', strict=True)
    style: str = Field(min_length=10, max_length=400)
    garments: list[_Design] = Field(min_length=1, max_length=200)


class GarmentError(Exception):
    def __init__(self, code, message=None):
        super().__init__(code)
        self.code, self.message = code, message

    def answer(self):
        return {'ok': False, 'error': {'code': self.code, **({'message': self.message} if self.message else {})}}


def design_id(slot: str, name: str) -> str:
    """A designed garment's ID: its slot and a hash of its name, so reordering the catalog keeps every ID."""
    return f"{slot}-{hashlib.sha256(name.strip().encode('utf-8')).hexdigest()[:8]}"


def load_catalog(path: Path = CATALOG_PATH) -> tuple[str, dict[str, _Design]]:
    """(style sentence, {design ID: design}) from the studio's garment-styles.json."""
    try:
        with open(path, 'rb') as stream:
            raw = stream.read(256*1024+1)
        if len(raw) > 256*1024:
            raise ValueError('too large')
        catalog = _Catalog.model_validate_json(raw)
    except (OSError, ValueError):
        raise GarmentError('catalog_unavailable', 'The studio garment catalog could not be read') from None
    designs = {}
    for design in catalog.garments:
        identifier = design_id(design.slot, design.name)
        if (identifier in designs or (design.bottom_kind and design.slot != 'bottom')
                or (design.hair_length and design.slot != 'hair')):
            raise GarmentError('catalog_unavailable', 'The studio garment catalog has a duplicate or invalid garment')
        designs[identifier] = design
    return catalog.style.strip(), designs


def garment_spec(garment: GarmentRequest, style: str, designs: dict[str, _Design]) -> dict:
    """What a garment asks for. A designed garment is sent as SinglePart sends a chosen style (its name, its brief
    followed by the catalog's style sentence, and its bottom kind or hair length); a brief gets the same style sentence."""
    if garment.design_id is not None:
        design = designs.get(garment.design_id)
        if design is None:
            raise GarmentError('unknown_design', 'No designed garment has this ID; list_garment_options lists them')
        spec = {'slot': design.slot, 'name': design.name.strip(), 'description': f'{design.brief} {style}'.strip(),
                'design_id': garment.design_id}
        if design.bottom_kind:
            spec['bottom_kind'] = design.bottom_kind
        if design.hair_length:
            spec['hair_length'] = design.hair_length
        return spec
    spec = {'slot': garment.slot, 'name': garment.name, 'description': f'{garment.brief} {style}'.strip()}
    if garment.bottom_kind:
        spec['bottom_kind'] = garment.bottom_kind
    if garment.hair_length:
        spec['hair_length'] = garment.hair_length
    return spec


def meshy_defaults(slot: str) -> dict:
    return {**_MESHY_DEFAULTS, 'texture_image_assets': [], 'target_formats': ['glb'],
            'target_polycount': _POLYCOUNT.get(slot, _MESHY_DEFAULTS['target_polycount'])}


def single_part_request(spec: dict, body_job_id: str, body_version: str) -> dict:
    """The body of SinglePart's POST /api/avatar-factory/variants/single-part for this garment."""
    slot = spec['slot']
    bottom_kind = spec.get('bottom_kind', 'source')
    request = {'base_job_id': body_job_id, 'base_version': body_version, 'slot': slot,
               'hair_length': spec.get('hair_length', 'source'), 'bottom_kind': bottom_kind}
    if slot == 'top':
        request['fit_profile'] = {'revision': 'garment-fit-v1', 'sleeve': 'source', 'ease': 'source'}
    elif slot == 'bottom':
        request['fit_profile'] = {'revision': 'garment-fit-v1', 'kind': bottom_kind, 'ease': 'source'}
    request['view_mode'] = 'front_side_back'
    request['meshy_options'] = meshy_defaults(slot)
    if slot in _METHODS:
        request['part_method'] = _METHODS[slot]
    request['part_name'] = spec['name']
    request['description'] = spec['description']
    return request


def post_outcome(response: dict) -> tuple[str, str | None]:
    """('accepted', job ID) or ('refused' | 'rejected' | 'uncertain', None) for the answer to a single-part POST.

    refused: nothing was accepted and the request itself is fine (login, permission, FACTORY_ACCESS, budget, credits,
    drain); rejected: this request was refused for good; uncertain: no definite answer, so it may have been accepted."""
    if response.get('ok'):
        job = response.get('data')
        job_id = job.get('id') if isinstance(job, dict) else None
        return ('accepted', job_id) if isinstance(job_id, str) and _ID.fullmatch(job_id) else ('uncertain', None)
    status = response.get('status')
    code = (response.get('error') or {}).get('code')
    if not isinstance(status, int) or code in _UNSURE:
        return 'uncertain', None
    if status >= 500 and code not in _REFUSALS:
        return 'uncertain', None
    if status in (401, 402, 403, 429) or code in _REFUSALS:
        return 'refused', None
    return 'rejected', None


def _sealed(job: dict) -> bool:
    version = job.get('ready_version')
    return isinstance(version, str) and bool(_ID.fullmatch(version))


def _code(value, fallback):
    text = re.sub(r'[^a-z0-9_]+', '_', str(value or '').lower()).strip('_')
    return text if _CODE.fullmatch(text) else fallback


def garment_state(job: dict, slot: str, listing: dict | None) -> tuple[str, Any]:
    """('running' | 'done' | 'stalled', detail) for an accepted garment job. Done once the wardrobe of its body lists
    the part; stalled while the job waits for someone in the studio (its own receipts decide; nothing is resumed here)."""
    flow = job.get('character_flow') if isinstance(job.get('character_flow'), dict) else {}
    if job.get('status') in _BUSY or flow.get('busy'):
        return 'running', None
    if not _sealed(job):
        return 'stalled', _code(f"{flow.get('status') or job.get('status')}_{flow.get('stage')}", 'stopped')
    if listing is None:
        return 'running', 'wardrobe'
    if listing.get('missing'):
        return 'stalled', 'wardrobe_body_not_found'
    for part in listing.get('parts') or []:
        if isinstance(part, dict) and part.get('job_id') == job.get('id') and part.get('slot') == slot:
            return 'done', {key: part.get(key) for key in ('version', 'sha256', 'name')}
    for part in listing.get('unavailable') or []:
        if isinstance(part, dict) and part.get('job_id') == job.get('id') and part.get('slot') == slot:
            return 'stalled', _code(part.get('reason'), 'fit_incomplete')
    return 'running', 'wardrobe'


def job_summary(job: dict) -> dict:
    flow = job.get('character_flow') if isinstance(job.get('character_flow'), dict) else {}
    slots = job.get('requested_slots') if isinstance(job.get('requested_slots'), list) else []
    return {'job_id': job.get('id'), 'status': job.get('status'), 'slot': slots[0] if len(slots) == 1 else None,
            'name': job.get('part_name'), 'body_job_id': job.get('base_job_id'), 'base_version': job.get('base_version'),
            'ready_version': job.get('ready_version'),
            'flow': {key: flow.get(key) for key in ('status', 'stage', 'busy', 'message')},
            'error': job.get('error'), 'created_at': job.get('created_at'), 'updated_at': job.get('updated_at')}


def _now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()


def _require_key(key):
    if not isinstance(key, str) or not _KEY.fullmatch(key):
        raise ValueError('Invalid idempotency key')


def _move(item, state, **fields):
    item['state'] = state
    item['updated_at'] = _now()
    for field in ('code', 'status'):
        item.pop(field, None)
    item.update({key: value for key, value in fields.items() if value is not None})


def _view(item):
    view = {'item': item['id'], 'state': item['state'], 'slot': item['slot'], 'name': item['name'],
            'body_job_id': item['body_job_id']}
    for field in ('job_id', 'code', 'status', 'wardrobe'):
        if item.get(field) is not None:
            view[field] = item[field]
    if item['spec'].get('design_id'):
        view['design_id'] = item['spec']['design_id']
    return view


def _counts(items):
    return {state: sum(item['state'] == state for item in items) for state in STATES if state != 'submitting'}


def _identity(body, spec):
    return body, spec.get('design_id') or f"{spec['slot']}:{spec['name']}"


def _read_stop(response):
    """Why an advance stops after a GET failed: a refused login or permission, or a studio that cannot answer now."""
    status = response.get('status')
    stop = {'kind': 'refusal' if status in (401, 403) else 'transient',
            'code': (response.get('error') or {}).get('code', 'api_refused')}
    if status:
        stop['status'] = status
    return stop


def _valid_item(item):
    def text(value, pattern=None):
        return isinstance(value, str) and (pattern is None or pattern.fullmatch(value) is not None)
    spec = item.get('spec') if isinstance(item, dict) else None
    return (isinstance(spec, dict) and item.get('state') in STATES and text(item.get('id'), _ITEM)
            and text(item.get('key'), _KEY) and text(item.get('body_job_id'), _ID) and item.get('slot') in SLOTS
            and text(item.get('name')) and spec.get('slot') == item['slot'] and text(spec.get('name'))
            and text(spec.get('description')) and (item.get('job_id') is None or text(item['job_id'], _ID))
            and (item['state'] not in ('running', 'done', 'stalled') or text(item.get('job_id'), _ID))
            and (item.get('request') is None or isinstance(item['request'], dict)))


def _valid_receipt(receipt):
    return (isinstance(receipt, dict) and receipt.get('kind') in ('enqueue', 'advance', 'resolve')
            and isinstance(receipt.get('fingerprint'), str) and isinstance(receipt.get('result'), dict))


class GarmentStudio:
    """The paid garment operations over one StudioClient, and the local queue for its API origin."""

    def __init__(self, client: StudioClient, *, catalog_path: Path = CATALOG_PATH, state_dir: Path = STATE_DIR):
        self.client = client
        self.catalog_path = Path(catalog_path)
        origin = hashlib.sha256(client.origin.encode('utf-8')).hexdigest()[:16]
        self.queue_path = Path(state_dir)/f'garments-{origin}.json'

    def _paid_off(self):
        if not (self.client.writable and getattr(self.client, 'paid', False)):
            return {'ok': False, 'error': {'code': 'mcp_paid_off'}}
        return None

    def _get(self, path):
        return self.client._request('GET', path)

    def _post(self, request, key):
        return self.client._request('POST', SINGLE_PART, body=request, headers={'Idempotency-Key': key})

    def _bodies(self):
        """({body job ID: registered version}, None), or (None, the failed answer)."""
        response = self._get('/api/avatar-factory/wardrobe/bodies')
        if not response['ok']:
            return None, response
        data = response['data'] if isinstance(response['data'], dict) else {}
        bodies = data.get('bodies') if isinstance(data.get('bodies'), list) else []
        return {body['job_id']: body['version'] for body in bodies
                if isinstance(body, dict) and isinstance(body.get('job_id'), str) and _ID.fullmatch(body['job_id'])
                and isinstance(body.get('version'), str) and _ID.fullmatch(body['version'])}, None

    def _body_ready(self, body_job_id, version):
        """None when the body's sealed assembly is its registered version, the one a part request must build on."""
        response = self._get(f'/api/avatar-factory/jobs/{body_job_id}')
        if not response['ok']:
            return response
        data = response['data'] if isinstance(response['data'], dict) else {}
        if data.get('ready_version') != version:
            return {'ok': False, 'error': {'code': 'wardrobe_body_not_ready', 'message':
                    'The body is being assembled again or is registered at an older version; register it again in the studio'}}
        return None

    # Local queue ------------------------------------------------------------

    def _load(self):
        try:
            with open(self.queue_path, 'rb') as stream:
                raw = stream.read(MAX_STATE_BYTES+1)
        except FileNotFoundError:
            return {'version': 1, 'origin': self.client.origin, 'items': [], 'receipts': {}}
        except OSError:
            raise GarmentError('queue_unreadable') from None
        try:
            state = json.loads(raw) if len(raw) <= MAX_STATE_BYTES else None
        except ValueError:
            state = None
        if (not isinstance(state, dict) or state.get('version') != 1 or not isinstance(state.get('items'), list)
                or not isinstance(state.get('receipts'), dict) or not all(_valid_item(item) for item in state['items'])
                or not all(_valid_receipt(receipt) for receipt in state['receipts'].values())):
            # Never replaced by an empty queue: it holds the keys of requests that may have been paid for.
            raise GarmentError('queue_unreadable', 'The local garment queue file is not readable; it is left as it is')
        return state

    def _save(self, state):
        items = state['items']
        closed = [item for item in items if item['state'] in ('done', 'failed', 'dropped')]
        if len(closed) > MAX_CLOSED_ITEMS:
            forget = {id(item) for item in closed[:len(closed)-MAX_CLOSED_ITEMS]}
            state['items'] = [item for item in items if id(item) not in forget]
        receipts = state['receipts']
        while len(receipts) > MAX_RECEIPTS:
            receipts.pop(next(iter(receipts)))
        self.queue_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.queue_path.with_name(f'{self.queue_path.name}.{os.getpid()}.tmp')
        with open(temporary, 'w', encoding='utf-8') as stream:
            json.dump(state, stream, ensure_ascii=False, indent=1)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.queue_path)

    @contextmanager
    def _queue(self):
        """The queue file's state, held under its lock for one change; `queue_busy` while another process changes it."""
        from src.services.process_identity import lease_guard
        guard = lease_guard(self.queue_path)
        try:
            guard.__enter__()
        except ValueError:
            raise GarmentError('queue_busy', 'Another run is changing the garment queue; try again shortly') from None
        try:
            yield self._load()
        finally:
            guard.__exit__(None, None, None)

    @staticmethod
    def _receipt(state, key, kind, request):
        saved = state['receipts'].get(key)
        if saved is None:
            return None
        if saved.get('kind') != kind or saved.get('fingerprint') != _digest(request):
            raise GarmentError('idempotency_conflict', 'This idempotency_key was used for a different call')
        return saved['result']

    @staticmethod
    def _remember(state, key, kind, request, result):
        state['receipts'][key] = {'kind': kind, 'fingerprint': _digest(request), 'at': _now(), 'result': result}

    # Tools ------------------------------------------------------------------

    def options(self) -> dict:
        try:
            style, designs = load_catalog(self.catalog_path)
        except GarmentError as exc:
            return exc.answer()
        data = {'slots': list(SLOTS), 'style': style,
                'garments': [{'id': identifier, 'slot': design.slot, 'name': design.name.strip(), 'brief': design.brief,
                              **({'bottom_kind': design.bottom_kind} if design.bottom_kind else {}),
                              **({'hair_length': design.hair_length} if design.hair_length else {})}
                             for identifier, design in designs.items()]}
        response = self._get('/api/avatar-factory/wardrobe/bodies')
        if response['ok'] and isinstance(response['data'], dict):
            data['bodies'] = [{key: body.get(key) for key in ('job_id', 'version', 'name', 'body_type', 'is_default')}
                              for body in response['data'].get('bodies') or [] if isinstance(body, dict)]
        else:
            data['bodies'] = None
            data['bodies_error'] = {'code': response.get('error', {}).get('code', 'invalid_response'),
                                    **({'status': response['status']} if response.get('status') else {})}
        return {'ok': True, 'data': data}

    def start(self, garment, key: str) -> dict:
        refused = self._paid_off()
        if refused:
            return refused
        _require_key(key)
        garment = garment if isinstance(garment, GarmentRequest) else GarmentRequest.model_validate(garment)
        try:
            spec = garment_spec(garment, *load_catalog(self.catalog_path))
        except GarmentError as exc:
            return exc.answer()
        registered, failure = self._bodies()
        if failure:
            return failure
        version = registered.get(garment.body_job_id)
        if version is None:
            return GarmentError('wardrobe_body_not_found', 'Register the body in the studio wardrobe first').answer()
        failure = self._body_ready(garment.body_job_id, version)
        if failure:
            return failure
        response = self._post(single_part_request(spec, garment.body_job_id, version), key)
        outcome, job_id = post_outcome(response)
        if outcome == 'accepted':
            return {'ok': True, 'data': {'job_id': job_id, 'status': response['data'].get('status'),
                                         'slot': spec['slot'], 'name': spec['name'], 'body_job_id': garment.body_job_id,
                                         'base_version': version}}
        answer = {'ok': False, 'outcome': outcome, 'error': dict(response['error'])}
        if response.get('status'):
            answer['status'] = response['status']
        if outcome == 'uncertain':
            answer['error']['message'] = ('No definite answer; call start_garment again with the same idempotency_key '
                                          'to get the job. A new key starts another paid garment.')
        return answer

    def status(self, job_id: str) -> dict:
        if not isinstance(job_id, str) or not _ID.fullmatch(job_id):
            raise ValueError('Invalid factory job ID')
        response = self._get(f'/api/avatar-factory/jobs/{job_id}')
        if not response['ok']:
            return response
        job = response['data'] if isinstance(response['data'], dict) else {}
        summary = job_summary(job)
        listing = None
        body = job.get('base_job_id')
        if _sealed(job) and isinstance(body, str) and _ID.fullmatch(body):
            answer = self._get(f'/api/avatar-factory/wardrobe/bodies/{body}/parts')
            if answer['ok'] and isinstance(answer['data'], dict):
                listing = answer['data']
            elif answer.get('status') == 404:
                listing = {'missing': True}
            else:
                summary['wardrobe_error'] = {'code': answer['error']['code'],
                                             **({'status': answer['status']} if answer.get('status') else {})}
        state, detail = garment_state(job, summary['slot'], listing)
        summary['state'] = state
        if state == 'done':
            summary['wardrobe'] = detail
        elif detail is not None:
            summary['reason'] = detail
        return {'ok': True, 'data': summary}

    def enqueue(self, garments, key: str) -> dict:
        refused = self._paid_off()
        if refused:
            return refused
        _require_key(key)
        garments = [garment if isinstance(garment, GarmentRequest) else GarmentRequest.model_validate(garment)
                    for garment in garments]
        if not 1 <= len(garments) <= MAX_ENQUEUE:
            raise ValueError(f'Enqueue 1 to {MAX_ENQUEUE} garments at a time')
        request = [garment.model_dump() for garment in garments]
        try:
            style, designs = load_catalog(self.catalog_path)
            specs = [garment_spec(garment, style, designs) for garment in garments]
            with self._queue() as state:
                replay = self._receipt(state, key, 'enqueue', request)
                if replay is not None:
                    return {**replay, 'replayed': True}
                items = state['items']
                known = {_identity(item['body_job_id'], item['spec']): item for item in items
                         if item['state'] not in ('failed', 'dropped')}
                fresh = {_identity(garment.body_job_id, spec) for garment, spec in zip(garments, specs)} - set(known)
                if sum(item['state'] not in ('done', 'failed', 'dropped') for item in items) + len(fresh) > MAX_OPEN_ITEMS:
                    raise GarmentError('queue_full', f'The queue holds at most {MAX_OPEN_ITEMS} unfinished garments')
                queued, skipped = [], []
                for garment, spec in zip(garments, specs):
                    identity = _identity(garment.body_job_id, spec)
                    if identity in known:
                        skipped.append({**_view(known[identity]), 'reason': 'already_queued'})
                        continue
                    now = _now()
                    item = {'id': 'q-'+uuid.uuid4().hex[:12], 'key': 'mcp-garment-'+uuid.uuid4().hex,
                            'state': 'pending', 'body_job_id': garment.body_job_id, 'slot': spec['slot'],
                            'name': spec['name'], 'spec': spec, 'request': None, 'attempts': 0,
                            'created_at': now, 'updated_at': now}
                    items.append(item)
                    known[identity] = item
                    queued.append(_view(item))
                result = {'ok': True, 'queued': queued, 'skipped': skipped, 'counts': _counts(items)}
                self._remember(state, key, 'enqueue', request, result)
                self._save(state)
                return result
        except GarmentError as exc:
            return exc.answer()

    def queue(self) -> dict:
        try:
            state = self._load()
        except GarmentError as exc:
            return exc.answer()
        return {'ok': True, 'data': {'items': [_view(item) for item in state['items'][-200:]],
                                     'counts': _counts(state['items'])}}

    def advance(self, max_new: int, key: str) -> dict:
        refused = self._paid_off()
        if refused:
            return refused
        _require_key(key)
        if isinstance(max_new, bool) or not isinstance(max_new, int) or not 0 <= max_new <= MAX_NEW:
            raise ValueError(f'max_new must be 0 to {MAX_NEW}')
        try:
            with self._queue() as state:
                replay = self._receipt(state, key, 'advance', {'max_new': max_new})
                if replay is not None:
                    return {**replay, 'replayed': True}
                result = self._advance(state, max_new)
                self._remember(state, key, 'advance', {'max_new': max_new}, result)
                self._save(state)
                return result
        except GarmentError as exc:
            return exc.answer()

    def _advance(self, state, max_new):
        result = {'ok': True, 'started': [], 'finished': [], 'failed': [], 'attention': [], 'waiting': [],
                  'paid_submissions': 0, 'stopped': None}
        for item in state['items']:
            if item['state'] == 'submitting':
                # Its request was written and the run ended before the answer: the POST may have been accepted.
                _move(item, 'uncertain', code='interrupted')
                item['was_uncertain'] = True
                result['attention'].append(_view(item))
        self._save(state)
        stop = self._poll(state, result)
        if stop is None and max_new:
            running = sum(item['state'] == 'running' for item in state['items'])
            stop = self._submit(state, result, min(max_new, MAX_IN_FLIGHT-running))
        result['stopped'] = stop
        result['counts'] = _counts(state['items'])
        return result

    def _poll(self, state, result):
        """Reads every running garment's job, and a few stalled ones: done once the wardrobe lists its part."""
        items = state['items']
        stalled = sorted((item for item in items if item['state'] == 'stalled'), key=lambda item: item.get('checked_at', ''))
        listings = {}
        try:
            for item in [item for item in items if item['state'] == 'running'] + stalled[:STALLED_CHECKS]:
                response = self._get(f"/api/avatar-factory/jobs/{item['job_id']}")
                if not response['ok']:
                    if response.get('status') == 404:
                        _move(item, 'failed', code='job_not_found')
                        result['failed'].append(_view(item))
                        continue
                    return _read_stop(response)
                job = response['data'] if isinstance(response['data'], dict) else {}
                item['checked_at'] = _now()
                listing = None
                if _sealed(job):
                    body = item['body_job_id']
                    if body not in listings:
                        answer = self._get(f'/api/avatar-factory/wardrobe/bodies/{body}/parts')
                        if answer['ok'] and isinstance(answer['data'], dict):
                            listings[body] = answer['data']
                        elif answer.get('status') == 404:
                            listings[body] = {'missing': True}
                        else:
                            return _read_stop(answer)
                    listing = listings[body]
                found, detail = garment_state(job, item['slot'], listing)
                if found == 'running' and detail == 'wardrobe':
                    # Sealed, not listed yet: the wardrobe's job listing is refreshed every few seconds.
                    item['unlisted'] = item.get('unlisted', 0)+1
                    if item['unlisted'] > UNLISTED_CHECKS:
                        found, detail = 'stalled', 'not_in_wardrobe'
                elif found == 'running':
                    item['unlisted'] = 0
                if found == 'done':
                    _move(item, 'done', wardrobe=detail)
                    result['finished'].append(_view(item))
                elif found == 'running':
                    if item['state'] != 'running':
                        _move(item, 'running')
                elif item['state'] != 'stalled' or item.get('code') != detail:
                    _move(item, 'stalled', code=detail)
                    result['attention'].append(_view(item))
            return None
        finally:
            self._save(state)

    def _submit(self, state, result, capacity):
        """Sends up to `capacity` pending garments, each request and key saved first; stops at the first answer that is
        not an acceptance."""
        pending = [item for item in state['items'] if item['state'] == 'pending']
        if capacity <= 0 or not pending:
            return None
        registered, failure = self._bodies()
        if failure:
            return _read_stop(failure)
        ready, sent = {}, 0
        for item in pending:
            if sent >= capacity:
                break
            body = item['body_job_id']
            version = registered.get(body)
            if version is None:
                _move(item, 'failed', code='wardrobe_body_not_found')
                result['failed'].append(_view(item))
                self._save(state)
                continue
            if body not in ready:
                failure = self._body_ready(body, version)
                if failure and failure['error']['code'] != 'wardrobe_body_not_ready' and failure.get('status') != 404:
                    return _read_stop(failure)
                ready[body] = failure is None
                if failure:
                    result['waiting'].append({'body_job_id': body, 'code': 'wardrobe_body_not_ready'})
            if not ready[body]:
                continue
            request = item.get('request')
            if request is not None and request.get('base_version') != version and not item.get('was_uncertain'):
                request = None  # Never accepted under its key: it is made for the body's current version instead.
            item['request'] = request or single_part_request(item['spec'], body, version)
            item['attempts'] = item.get('attempts', 0)+1
            _move(item, 'submitting')
            self._save(state)  # The request and its key are on disk before the paid POST.
            response = self._post(item['request'], item['key'])
            result['paid_submissions'] += 1
            outcome, job_id = post_outcome(response)
            if outcome == 'accepted':
                _move(item, 'running', job_id=job_id)
                item['unlisted'] = 0
                result['started'].append(_view(item))
                sent += 1
                self._save(state)
                continue
            code, status = (response.get('error') or {}).get('code', 'api_refused'), response.get('status')
            if outcome == 'refused':
                _move(item, 'pending', code=code, status=status)
            elif outcome == 'rejected':
                _move(item, 'failed', code=code, status=status)
                result['failed'].append(_view(item))
            else:
                _move(item, 'uncertain', code=code, status=status)
                item['was_uncertain'] = True
                result['attention'].append(_view(item))
            self._save(state)
            stop = {'kind': 'uncertain' if outcome == 'uncertain' else 'refusal', 'code': code, 'item': item['id']}
            if status:
                stop['status'] = status
            return stop
        self._save(state)
        return None

    def resolve(self, item_id: str, action: str, key: str) -> dict:
        refused = self._paid_off()
        if refused:
            return refused
        _require_key(key)
        if not isinstance(item_id, str) or not _ITEM.fullmatch(item_id) or action not in ('replay', 'drop'):
            raise ValueError('Invalid queue item or action')
        try:
            with self._queue() as state:
                replay = self._receipt(state, key, 'resolve', {'item': item_id, 'action': action})
                if replay is not None:
                    return {**replay, 'replayed': True}
                item = next((item for item in state['items'] if item['id'] == item_id), None)
                if item is None:
                    raise GarmentError('not_found', 'No such queue item')
                if action == 'drop':
                    if item['state'] not in ('pending', 'stalled', 'uncertain', 'failed'):
                        raise GarmentError('action_unavailable', 'Only a pending, stalled, uncertain or failed item is dropped')
                    _move(item, 'dropped')
                    result = {'ok': True, 'item': _view(item), 'paid_submissions': 0}
                else:
                    if item['state'] != 'uncertain' or not item.get('request'):
                        raise GarmentError('action_unavailable', 'Only an uncertain item is sent again')
                    item['attempts'] = item.get('attempts', 0)+1
                    _move(item, 'submitting')
                    self._save(state)
                    # The same request under the same key: the studio answers with the job it took, or takes it now.
                    response = self._post(item['request'], item['key'])
                    outcome, job_id = post_outcome(response)
                    code, status = (response.get('error') or {}).get('code'), response.get('status')
                    if outcome == 'accepted':
                        _move(item, 'running', job_id=job_id)
                        item['unlisted'] = 0
                    elif outcome == 'rejected':
                        _move(item, 'failed', code=code, status=status)
                    else:
                        _move(item, 'uncertain', code=code, status=status)
                    result = {'ok': True, 'outcome': outcome, 'item': _view(item), 'paid_submissions': 1}
                self._remember(state, key, 'resolve', {'item': item_id, 'action': action}, result)
                self._save(state)
                return result
        except GarmentError as exc:
            return exc.answer()


def register_tools(server, studio: GarmentStudio):
    """The paid garment tools; build_server() adds them only with MOGA_STUDIO_MCP_WRITE=1 and MOGA_STUDIO_MCP_PAID=1."""
    from mcp.types import ToolAnnotations
    read_only = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)
    paid = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=True)
    local = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False)

    @server.tool(annotations=read_only)
    def list_garment_options() -> dict[str, Any]:
        """Designed garments (the studio's garment-styles.json), the wardrobe bodies and the slots a garment is made for."""
        return studio.options()

    @server.tool(annotations=paid)
    def start_garment(garment: GarmentRequest, idempotency_key: RequestKey) -> dict[str, Any]:
        """Paid: one garment on a wardrobe body, as the studio's single-part screen makes it (3 images and 1 3D model).
        After a lost answer call again with the same idempotency_key; a new key starts another paid garment."""
        return studio.start(garment, idempotency_key)

    @server.tool(annotations=read_only)
    def get_garment_job(job_id: FactoryId) -> dict[str, Any]:
        """A garment job's progress, and its wardrobe entry once the wardrobe lists it."""
        return studio.status(job_id)

    @server.tool(annotations=local)
    def enqueue_garments(garments: GarmentList, idempotency_key: RequestKey) -> dict[str, Any]:
        """Adds garments to the local queue; nothing is sent. A garment the queue already holds for that body (not failed
        or dropped) is skipped."""
        return studio.enqueue(garments, idempotency_key)

    @server.tool(annotations=read_only)
    def get_garment_queue() -> dict[str, Any]:
        """The local garment queue: every item's state, job and wardrobe entry."""
        return studio.queue()

    @server.tool(annotations=paid)
    def advance_garment_queue(idempotency_key: RequestKey, max_new: MaxNew = MAX_NEW) -> dict[str, Any]:
        """Paid: reads the queue's running garments, then sends at most max_new pending ones (3 in flight at most).
        Stops at the first refusal. A garment without a definite answer stays uncertain and is not sent again."""
        return studio.advance(max_new, idempotency_key)

    @server.tool(annotations=paid)
    def resolve_garment_item(item_id: ItemId, action: Literal['replay', 'drop'], idempotency_key: RequestKey) -> dict[str, Any]:
        """replay: sends an uncertain item again with its own saved request and key (paid at most once).
        drop: removes a pending, stalled, uncertain or failed item from the queue."""
        return studio.resolve(item_id, action, idempotency_key)


def _bounded(kind, low, high):
    def parse(text):
        try:
            value = kind(text)
        except ValueError:
            raise argparse.ArgumentTypeError(f'expected a number from {low} to {high}') from None
        if not low <= value <= high:
            raise argparse.ArgumentTypeError(f'expected a number from {low} to {high}')
        return value
    return parse


def cli(argv=None, *, studio: GarmentStudio | None = None, sleep=time.sleep, clock=time.monotonic, write=None) -> int:
    """`asset-studio-mcp garments`: advances the local queue from the operator's terminal, one JSON line per step.

    Exit 0 when done, 1 on a setup error, 2 after a refusal or an uncertain submission, 3 when it cannot go on
    (the studio stays unreachable, pending garments cannot start, or --max-hours passed)."""
    parser = argparse.ArgumentParser(prog='asset-studio-mcp garments',
                                     description='Advance the local garment queue through the studio gateway.')
    parser.add_argument('--max-new', type=_bounded(int, 0, MAX_NEW), default=MAX_NEW,
                        help='paid submissions per step (0-3)')
    parser.add_argument('--until-empty', action='store_true',
                        help='repeat until no garment is pending or running')
    parser.add_argument('--max-paid', type=_bounded(int, 1, 50), default=3,
                        help='paid submissions in this run, at most (1-50)')
    parser.add_argument('--poll-seconds', type=_bounded(int, 10, 3600), default=60,
                        help='seconds between steps (10-3600)')
    parser.add_argument('--max-hours', type=_bounded(float, 0.1, 48), default=12,
                        help='stop after this many hours (0.1-48)')
    args = parser.parse_args(argv)
    emit = write or (lambda line: print(line, flush=True))
    client = None
    if studio is None:
        if os.environ.get('MOGA_STUDIO_MCP_WRITE') != '1' or os.environ.get('MOGA_STUDIO_MCP_PAID') != '1':
            print('asset-studio-mcp garments needs MOGA_STUDIO_MCP_WRITE=1 and MOGA_STUDIO_MCP_PAID=1', file=sys.stderr)
            return 1
        try:
            client = StudioClient(os.environ.get('MOGA_STUDIO_API_URL', ''), os.environ.get('MOGA_STUDIO_SESSION', ''),
                                  app_origin=os.environ.get('MOGA_STUDIO_APP_ORIGIN'), writable=True, paid=True)
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            return 1
        studio = GarmentStudio(client)
    run, began, paid, waits, step, code = uuid.uuid4().hex[:12], clock(), 0, 0, 0, None
    try:
        while code is None:
            step += 1
            result = studio.advance(min(args.max_new, args.max_paid-paid), f'cli-{run}-{step}')
            paid += result.get('paid_submissions', 0)
            emit(json.dumps({'step': step, 'paid_this_run': paid, **result}, ensure_ascii=False, sort_keys=True))
            ok, stopped, counts = result.get('ok'), result.get('stopped'), result.get('counts') or {}
            if not ok and result['error']['code'] != 'queue_busy':
                code = 1
            elif stopped and stopped['kind'] in ('refusal', 'uncertain'):
                code = 2
            elif not args.until_empty:
                code = 0 if ok and not stopped else 3
            else:
                # A studio that is waking up, or another run holding the queue, is waited for a few steps.
                waits = waits+1 if stopped or not ok else 0
                if waits > 5:
                    code = 3
                elif ok and not stopped and not counts.get('running'):
                    # Nothing in flight: done, unless pending garments could have started and did not (body not ready).
                    code = 0 if not counts.get('pending') or paid >= args.max_paid or args.max_new == 0 else 3
                if code is None and clock()-began >= args.max_hours*3600:
                    code = 3
                if code is None:
                    sleep(args.poll_seconds)
        emit(json.dumps({'exit': code, 'paid_this_run': paid}, sort_keys=True))
        return code
    finally:
        if client is not None:
            client.close()


if __name__ == '__main__':
    raise SystemExit(cli())
