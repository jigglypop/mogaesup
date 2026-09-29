"""Wardrobe bodies: saved base body versions whose parts are swapped among jobs.

A part belongs to a wardrobe body when its job descends from that body version through
base_job_id/base_version. Each job re-exports its own body.glb (coverage cuts), so file
hashes differ between siblings and are not used for membership.
"""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import io
import json
import re
from threading import RLock

from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK
from src.services.character_pipeline import PipelineError, now, read_json
from src.services.studio_library import StudioLibrary

MAX_BODIES = 8
MAX_OUTFITS = 200
_FIELDS = ('job_id', 'version', 'profile_id', 'geometry_sha256', 'body_sha256')
_ID = re.compile(r'[a-f0-9]{24}')
_SLOT = re.compile(r'[A-Za-z]{2,20}')
# A long coat reaches the lower thighs like a dress but is worn over a bottom; its description says which.
_OUTERWEAR = re.compile(r'코트|재킷|자켓|점퍼|가디건|야상|블레이저|파카|패딩|바람막이|\b(coat|jacket|cardigan|parka|blazer|anorak)\b')
_DRESS = re.compile(r'원피스|드레스|\bdress\b')
# Assembly records never change after a version is sealed; keep recent ones in memory.
_records = OrderedDict()
_records_lock = RLock()
_READERS = ThreadPoolExecutor(max_workers=8, thread_name_prefix='wardrobe-records')


def lineage_body(jobs_by_id, job_id, registered):
    """(job_id, version) of the registered body a job builds on, or None."""
    seen = set()
    current = jobs_by_id.get(job_id)
    while current and current['id'] not in seen and len(seen) < 16:
        seen.add(current['id'])
        base = (current.get('base_job_id'), current.get('base_version'))
        if not base[0]:
            return None
        if base in registered:
            return base
        current = jobs_by_id.get(base[0])
    return None


class Wardrobe:
    def __init__(self, factory, owner):
        self.factory, self.owner = factory, owner
        self.library = StudioLibrary(factory, owner)

    @property
    def path(self):
        return self.library.root/'wardrobe-bodies.json'

    def _stored(self):
        return read_json(self.path, {'revision': '0', 'bodies': []})

    def _write(self, bodies):
        value = {'bodies': bodies, 'updated_at': now()}
        value['revision'] = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
        _write_json(self.path, value)

    def bodies(self):
        """Registered bodies with the common body marked and how many part jobs build on each."""
        from src.services.avatar_fitting_management import FittingManagement
        value = self._stored()
        default = FittingManagement(self.factory, self.owner).body_default().get('body') or None
        registered = {(body['job_id'], body['version']) for body in value['bodies']}
        try:
            jobs = self.factory.listing(self.owner)
        except PipelineError:
            jobs = None  # The listing is still loading; counts arrive with the next read.
        counts = {}
        if jobs is not None:
            jobs_by_id = {job['id']: job for job in jobs}
            for job in jobs:
                body = lineage_body(jobs_by_id, job['id'], registered)
                if body:
                    counts[body] = counts.get(body, 0) + 1
        return {'revision': value['revision'],
                'bodies': [{**body, 'is_default': bool(default) and (default['job_id'], default['version']) == (body['job_id'], body['version']),
                            'part_jobs': counts.get((body['job_id'], body['version']), 0) if jobs is not None else None}
                           for body in value['bodies']],
                'default': {'job_id': default['job_id'], 'version': default['version']} if default else None}

    def register(self, job, version, expected_revision):
        from src.services.avatar_fitting_management import FittingManagement
        self.library.require_storage()
        with _LOCK:
            previous = self._stored()
            if not any(b['job_id'] == job and b['version'] == version for b in previous['bodies']):
                if previous['revision'] != expected_revision:
                    raise PipelineError('revision_conflict', '옷장 몸 목록이 변경되었습니다. 다시 불러오세요.', 409)
                body, source_job = FittingManagement(self.factory, self.owner).body_entry(job, version)
                if source_job.get('base_job_id'):
                    raise PipelineError('variant_body', '변형 작업의 몸은 옷장 몸으로 등록할 수 없습니다. 기준 몸을 등록하세요.', 422)
                others = [b for b in previous['bodies'] if b['job_id'] != job]
                if len(others) >= MAX_BODIES:
                    raise PipelineError('too_many_bodies', f'옷장 몸은 {MAX_BODIES}개까지 등록할 수 있습니다.', 422)
                name = self.library.metadata()['items'].get(job, {}).get('name')
                entry = {**{key: body[key] for key in _FIELDS},
                         'name': name or source_job.get('character_name') or job,
                         'body_type': (source_job.get('base_body') or {}).get('body_type'), 'registered_at': now()}
                self._write(others + [entry])
        return self.bodies()

    def unregister(self, job, expected_revision):
        if not _ID.fullmatch(job):
            raise PipelineError('not_found', '옷장 몸을 찾을 수 없습니다.', 404)
        self.library.require_storage()
        with _LOCK:
            previous = self._stored()
            if any(b['job_id'] == job for b in previous['bodies']):
                if previous['revision'] != expected_revision:
                    raise PipelineError('revision_conflict', '옷장 몸 목록이 변경되었습니다. 다시 불러오세요.', 409)
                self._write([b for b in previous['bodies'] if b['job_id'] != job])
        return self.bodies()

    # Parts library -----------------------------------------------------------

    def _body(self, job_id):
        body = next((b for b in self._stored()['bodies'] if b['job_id'] == job_id), None)
        if not body:
            raise PipelineError('not_found', '옷장 몸을 찾을 수 없습니다.', 404)
        return body

    def _record(self, job_id, version):
        from src.services.avatar_native_parts import AvatarNativeParts
        key = (int(self.owner), job_id, version)
        with _records_lock:
            if key in _records:
                _records.move_to_end(key)
                return _records[key]
        record = read_json(AvatarNativeParts(self.factory).root(self.owner, job_id)/version/'record.json')
        if record.get('status') == 'review_required':
            with _records_lock:
                _records[key] = record
                while len(_records) > 512:
                    _records.popitem(last=False)
        return record

    def parts(self, job_id):
        """Every part made on a wardrobe body: the body job's own and its descendants', newest first.

        A slot this job did not request came from another job (a variant copies its base's models or
        fitted files) and is listed only under the job that made it; slots a refit froze were
        requested here and stay listed.
        """
        body = self._body(job_id)
        registered = {(b['job_id'], b['version']) for b in self._stored()['bodies']}
        jobs = self.factory.listing(self.owner)
        jobs_by_id = {job['id']: job for job in jobs}
        metadata = self.library.metadata()
        members = []
        for job in jobs:
            own = job['id'] == body['job_id']
            if not own and lineage_body(jobs_by_id, job['id'], registered) != (body['job_id'], body['version']):
                continue
            if self.library.is_job_deleted(job, metadata) or metadata['items'].get(job['id'], {}).get('archived'):
                continue
            version = body['version'] if own else job.get('assembly_version')
            if version and _ID.fullmatch(version):
                members.append((job, version))
        # Records are read in parallel on the first listing; later ones come from memory.
        records = list(_READERS.map(lambda member: self._record(member[0]['id'], member[1]), members))
        items = []
        for (job, version), record in zip(members, records):
            if record.get('status') != 'review_required':
                continue
            requested = job.get('requested_slots')
            for part in record.get('result', {}).get('parts', []):
                slot, name = part.get('slot'), f"{part.get('slot')}.glb"
                made_elsewhere = (slot not in requested if requested is not None
                                  else part.get('origin') == 'reused_fitted_native')
                if slot == 'body' or part.get('available') is False or name not in record.get('files', {}) or made_elsewhere:
                    continue
                entry = metadata['parts'].get(f"{job['id']}:{slot}", {})
                if entry.get('deleted'):
                    continue
                check = (part.get('limb_fit') or {}).get('check') or {}
                items.append({'job_id': job['id'], 'version': version, 'slot': slot,
                              'name': entry.get('name') or job.get('part_name') or job.get('character_name') or job['id'],
                              'character_name': job.get('character_name'), 'fit_method': part.get('fit_method'),
                              'fit_check': ({'status': check['status'],
                                             'failures': [f['message'] for f in check.get('failures', [])]}
                                            if check.get('status') in ('pass', 'fail') else None),
                              'shape': ({key: value for key, value in (part.get('shape') or {}).items()
                                         if key in ('sleeve', 'hem', 'fit')}
                                        if part.get('fit_method') == 'body-shell-v1' else None),
                              'sha256': record['files'][name], 'created_at': job.get('created_at')})
        items.sort(key=lambda item: item.get('created_at') or '', reverse=True)
        return {'body': deepcopy(body), 'parts': items}

    def preview(self, job_id, slot, version):
        """Front drawing of a part without the key-coloured mannequin, cropped; cached by drawing hash."""
        import numpy as np
        from PIL import Image
        from src.services.avatar_worn_images import _rgba, dilate, erode, key_mask
        if not _ID.fullmatch(job_id) or not _ID.fullmatch(version) or not _SLOT.fullmatch(slot):
            raise PipelineError('not_found', '미리보기를 찾을 수 없습니다.', 404)
        record = self._record(job_id, version)
        if f'{slot}.glb' not in record.get('files', {}):
            raise PipelineError('not_found', '미리보기를 찾을 수 없습니다.', 404)
        directory = self.factory.directory(self.owner, job_id)
        part = next((p for p in read_json(directory/'pipeline.json').get('parts', []) if p.get('slot') == slot), {})
        view = (part.get('views') or {}).get('front') or {}
        name, sha = view.get('file'), view.get('sha256')
        if not name or '/' in name or '\\' in name or not sha:
            raise PipelineError('preview_missing', '이 파츠에는 정면 그림이 없습니다.', 404)
        key = part.get('key_color') if part.get('part_method') in ('worn', 'body_shell') else None
        target = self.library.root/'wardrobe-previews'/f'{sha[:32]}-{key or "plain"}-v2.png'
        if target.is_file():
            return target
        rgba = _rgba((directory/'output'/name).read_bytes())
        if key:
            visible = (rgba[..., 3] > .06) & ~key_mask(rgba, key)
            # The drawn mannequin outline survives the key colour as thin lines; open them away.
            visible = dilate(erode(visible, 2), 2)
            rgba[..., 3] = np.where(visible, rgba[..., 3], 0.)
        ys, xs = np.nonzero(rgba[..., 3] > .06)
        image = Image.fromarray((np.clip(rgba, 0, 1)*255).astype(np.uint8), 'RGBA')
        if len(xs):
            margin = int(.04*max(np.ptp(xs), np.ptp(ys))) + 4
            image = image.crop((max(0, xs.min()-margin), max(0, ys.min()-margin),
                                min(image.width, xs.max()+margin+1), min(image.height, ys.max()+margin+1)))
        image.thumbnail((384, 384), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, format='PNG')
        target.write_bytes(buffer.getvalue())
        return target

    def coverage(self, body_job_id, job_id, slot, version):
        """Body triangles one garment of this wardrobe body covers; computed once per body and part file."""
        from src.services.avatar_native_parts import AvatarNativeParts
        from src.services.avatar_wardrobe_coverage import GARMENT_SLOTS, coverage
        if slot not in GARMENT_SLOTS or not _ID.fullmatch(job_id) or not _ID.fullmatch(version):
            raise PipelineError('not_found', '가림 영역이 없는 파츠입니다.', 404)
        body = self._body(body_job_id)
        registered = {(b['job_id'], b['version']) for b in self._stored()['bodies']}
        jobs_by_id = {job['id']: job for job in self.factory.listing(self.owner)}
        if job_id != body['job_id'] and lineage_body(jobs_by_id, job_id, registered) != (body['job_id'], body['version']):
            raise PipelineError('not_found', '이 옷장 몸의 파츠가 아닙니다.', 404)
        part_sha = self._record(job_id, version).get('files', {}).get(f'{slot}.glb')
        if not part_sha:
            raise PipelineError('not_found', '파츠 파일을 찾을 수 없습니다.', 404)
        target = self.library.root/'wardrobe-coverage'/f"{body['body_sha256'][:20]}-{part_sha[:20]}-v9.json"
        value = read_json(target)
        if not value:
            native = AvatarNativeParts(self.factory)
            value = coverage(self._body_geometry(native, body), native.artifact(self.owner, job_id, version, f'{slot}.glb').read_bytes(), slot)
            _write_json(target, value)
        if value['covers_bottom'] and self._outerwear(job_id, slot):
            value = {**value, 'covers_bottom': False}
        return value

    def _outerwear(self, job_id, slot):
        part = next((p for p in read_json(self.factory.directory(self.owner, job_id)/'pipeline.json').get('parts', [])
                     if p.get('slot') == slot), {})
        text = (part.get('description') or '').lower()
        return bool(_OUTERWEAR.search(text)) and not _DRESS.search(text)

    def colors(self, job_id, slot, version):
        """Colour regions of a part texture ({regions: [...]}) and the path of their mask PNG, cached per part file."""
        from src.services.avatar_native_parts import AvatarNativeParts
        from src.services.avatar_wardrobe_colors import color_regions
        if not _ID.fullmatch(job_id) or not _ID.fullmatch(version) or not _SLOT.fullmatch(slot):
            raise PipelineError('not_found', '색 영역을 찾을 수 없습니다.', 404)
        part_sha = self._record(job_id, version).get('files', {}).get(f'{slot}.glb')
        if not part_sha:
            raise PipelineError('not_found', '파츠 파일을 찾을 수 없습니다.', 404)
        base = self.library.root/'wardrobe-colors'/f'{part_sha[:20]}-v3'
        info, mask = base.with_suffix('.json'), base.with_suffix('.png')
        cached = read_json(info)
        if cached:
            return cached, mask
        result = color_regions(AvatarNativeParts(self.factory).artifact(self.owner, job_id, version, f'{slot}.glb').read_bytes())
        if not result:
            raise PipelineError('no_texture', '색을 바꿀 텍스처가 없는 파츠입니다.', 422)
        png, regions, material = result
        mask.write_bytes(png)
        value = {'slot': slot, 'material': material, 'regions': regions}
        _write_json(info, value)
        return value, mask

    def _body_geometry(self, native, body):
        """Parsed wardrobe body; one download and parse serves every part's coverage."""
        from src.services.avatar_wardrobe_coverage import skinned_primitives
        key = ('body', body['body_sha256'])
        with _records_lock:
            if key in _records:
                _records.move_to_end(key)
                return _records[key]
        parsed = skinned_primitives(native.artifact(self.owner, body['job_id'], body['version'], 'body.glb').read_bytes())
        with _records_lock:
            _records[key] = parsed
            while len(_records) > 512:
                _records.popitem(last=False)
        return parsed

    # Saved outfits -------------------------------------------------------------

    @property
    def outfits_path(self):
        return self.library.root/'wardrobe-outfits.json'

    def outfits(self):
        value = read_json(self.outfits_path, {'revision': '0', 'outfits': {}})
        return {'revision': value['revision'], 'outfits': value.get('outfits', {})}

    def save_outfit(self, outfit_id, payload, expected_revision, key):
        """Create or replace one outfit; parts must still be the listed files of the chosen body."""
        if not re.fullmatch(r'[a-f0-9]{32}', outfit_id):
            raise PipelineError('invalid_outfit', '조합 식별자가 올바르지 않습니다.', 422)
        if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}', key):
            raise PipelineError('invalid_key', '요청 식별자가 필요합니다.', 422)
        self.library.require_storage()
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        receipt_key = hashlib.sha256(key.encode()).hexdigest()

        def replayed(stored):
            receipt = stored.get('receipts', {}).get(receipt_key)
            if receipt and receipt['fingerprint'] != fingerprint:
                raise PipelineError('idempotency_conflict', '같은 요청의 입력이 변경되었습니다.', 409)
            return bool(receipt)
        if replayed(read_json(self.outfits_path, {'revision': '0', 'outfits': {}, 'receipts': {}})):
            return self.outfits()
        if set(payload.get('colors') or {}) - set(payload['parts']):
            raise PipelineError('invalid_colors', '입은 파츠의 색만 저장할 수 있습니다.', 422)
        # The listing read can take seconds; check parts before taking the shared lock.
        body = self._body(payload['body']['job_id'])
        if body['version'] != payload['body']['version']:
            raise PipelineError('body_changed', '옷장 몸 버전이 바뀌었습니다. 다시 불러오세요.', 409)
        listed = {(p['job_id'], p['version'], p['slot']): p['sha256'] for p in self.parts(body['job_id'])['parts']}
        for slot, part in payload['parts'].items():
            if listed.get((part['job_id'], part['version'], slot)) != part['sha256']:
                raise PipelineError('part_changed', f'{slot} 파츠를 옷장에서 찾을 수 없습니다. 다시 불러오세요.', 409)
        with _LOCK:
            stored = read_json(self.outfits_path, {'revision': '0', 'outfits': {}, 'receipts': {}})
            if replayed(stored):
                return self.outfits()
            if stored['revision'] != expected_revision:
                raise PipelineError('revision_conflict', '저장한 조합이 변경되었습니다. 다시 불러오세요.', 409)
            if outfit_id not in stored.get('outfits', {}) and len(stored.get('outfits', {})) >= MAX_OUTFITS:
                raise PipelineError('too_many_outfits', f'조합은 {MAX_OUTFITS}개까지 저장할 수 있습니다.', 422)
            outfits = {**stored.get('outfits', {}), outfit_id: {**deepcopy(payload), 'saved_at': now()}}
            receipts = {**stored.get('receipts', {}), receipt_key: {'fingerprint': fingerprint}}
            self._write_outfits(outfits, receipts)
        return self.outfits()

    def delete_outfit(self, outfit_id, expected_revision):
        self.library.require_storage()
        with _LOCK:
            stored = read_json(self.outfits_path, {'revision': '0', 'outfits': {}, 'receipts': {}})
            if outfit_id in stored.get('outfits', {}):
                if stored['revision'] != expected_revision:
                    raise PipelineError('revision_conflict', '저장한 조합이 변경되었습니다. 다시 불러오세요.', 409)
                outfits = {k: v for k, v in stored['outfits'].items() if k != outfit_id}
                self._write_outfits(outfits, stored.get('receipts', {}))
        return self.outfits()

    def _write_outfits(self, outfits, receipts):
        value = {'outfits': outfits, 'updated_at': now()}
        value['revision'] = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
        # Receipts only answer replays; keep the most recent ones.
        _write_json(self.outfits_path, {**value, 'receipts': dict(list(receipts.items())[-500:])})
