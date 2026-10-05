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
import logging
import math
import re
from threading import RLock, Semaphore
import uuid

from src.services.asset_editor import _retry_file_io, _write_json
from src.services.avatar_factory import _LOCK
from src.services.avatar_equipment import conflicting_head_parts
from src.services.character_pipeline import PipelineError, now, read_json, require_request_key
from src.services.keyed_lock import keyed_lock
from src.services.object_storage import is_remote, mark_changed
from src.services.studio_library import StudioLibrary

LOGGER = logging.getLogger(__name__)
MAX_BODIES = 8
MAX_OUTFITS = 200
_FIELDS = ('job_id', 'version', 'profile_id', 'geometry_sha256', 'body_sha256')
_ID = re.compile(r'[a-f0-9]{24}')
_SLOT = re.compile(r'[A-Za-z]{2,20}')
_SHA = re.compile(r'[a-f0-9]{64}')
_CODE = re.compile(r'[a-z][a-z0-9_]{0,39}')
# A long coat or hooded zip-up reaches the lower thighs like a dress but is worn over a bottom; its description says
# which. A jumper skirt is a dress: 점퍼 in it is the pinafore, not a jacket.
_OUTERWEAR = re.compile(r'코트|재킷|자켓|점퍼|가디건|야상|블레이저|파카|패딩|바람막이|후드|후디|집업|지퍼\s*업|'
                        r'\b(coat|jacket|cardigan|parka|blazer|anorak|hood(?:ed|ie|y)?|hoodies|zip[\s-]*up)\b')
_DRESS = re.compile(r'원피스|드레스|점퍼\s*스커트|점퍼\s*치마|\b(dress|jumper[\s-]*(?:skirt|dress)|pinafore)\b')
# Assembly records never change after a version is sealed; keep recent ones in memory.
_records = OrderedDict()
_records_lock = RLock()
_RECORDS = 512
# A parsed wardrobe body holds tens of MB of arrays: only the last few are kept, apart from the small records.
_geometries = OrderedDict()
_GEOMETRIES = 4
_READERS = ThreadPoolExecutor(max_workers=8, thread_name_prefix='wardrobe-records')
# Colour and coverage work holds hundreds of MB of arrays: only a few run at once, however many members open the wardrobe.
_COMPUTING = Semaphore(2)
# (body job, version, registered geometry) already compared by _adopt_versions: each body version is parsed once.
_COMPARED = set()


def _write_file(path, content):
    """A cached file written whole: one PUT where it is stored remotely, a temporary file renamed over it on a local
    disk, so a reader never finds half a PNG."""
    if is_remote(path):
        path.write_bytes(content)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f'{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        temporary.write_bytes(content)
        _retry_file_io(lambda: temporary.replace(path))
    finally:
        _retry_file_io(lambda: temporary.unlink(missing_ok=True))
    mark_changed(path)


def legacy_render_frame(height):
    """How the product camera (avatar_blender_common.camera_setup) framed a body `height` metres tall in versions sealed
    before the worker recorded it: 2048/1500 of the height across, centred 26/1500 of it above the body's middle."""
    return {'ortho_scale_m': 2048*height/1500, 'center_gltf_m': [0., height*(.5 + 26/1500), 0.]}


def _front_crop(frame, box, size):
    """Pixel box (left, top, right, bottom) of a glTF-space box in a front render of `size` framed by `frame`, with a
    margin. The front camera looks along glTF -Z: image right is +X, image up is +Y."""
    width, height = size
    scale = max(width, height)/frame['ortho_scale_m']
    cx, cy = frame['center_gltf_m'][0], frame['center_gltf_m'][1]
    (x0, y0, _), (x1, y1, _) = box
    left, right = width/2 + (x0 - cx)*scale, width/2 + (x1 - cx)*scale
    top, bottom = height/2 - (y1 - cy)*scale, height/2 - (y0 - cy)*scale
    margin = .15*max(right - left, bottom - top)
    return (max(0, math.floor(left - margin)), max(0, math.floor(top - margin)),
            min(width, math.ceil(right + margin)), min(height, math.ceil(bottom + margin)))


def _box(value):
    """A [[x, y, z], [x, y, z]] glTF box with finite numbers and some width and height, low corner first."""
    try:
        low, high = value
        numbers = [float(v) for v in (*low, *high)]
    except (TypeError, ValueError):
        return False
    return (len(numbers) == 6 and all(math.isfinite(v) for v in numbers)
            and numbers[0] < numbers[3] and numbers[1] < numbers[4])


def registered_bodies(bodies):
    """Every (job_id, version) a registered body answers to, mapped to its current (job_id, version). A body registered
    again at a version with the same geometry keeps the version it replaced as an alias, so the parts built on that
    version stay with it. Only aliases whose geometry was compared when they were written count (`aliases_verified`):
    a list written before that check may carry a version of another shape, and registering the same version again
    compares them (register)."""
    pairs = {}
    for body in bodies:
        current = (body['job_id'], body['version'])
        pairs[current] = current
        if body.get('aliases_verified') is not True:
            continue
        for version in body.get('aliases', []):
            pairs[(body['job_id'], version)] = current
    return pairs


def lineage_body(jobs_by_id, job_id, registered):
    """(job_id, version) of the registered body a job builds on, or None. `registered` is registered_bodies()."""
    seen = set()
    current = jobs_by_id.get(job_id)
    while current and current['id'] not in seen and len(seen) < 16:
        seen.add(current['id'])
        base = (current.get('base_job_id'), current.get('base_version'))
        if not base[0]:
            return None
        if base in registered:
            return registered[base]
        current = jobs_by_id.get(base[0])
    return None


def _reason(part):
    """Short code for why a part report is not offered: the report's reason, else its fit status. Only a code is
    taken from the report; its error messages can carry worker text and are never passed on."""
    for key in ('unavailable_reason', 'fit_status'):
        value = part.get(key)
        if isinstance(value, str) and _CODE.fullmatch(value):
            return value
    return 'fit_incomplete'


def _runtime_delivery(record, slot):
    """A sealed derivative bound to this slot's original file, or None for legacy/invalid receipts."""
    if record.get('status') != 'review_required' or not isinstance(slot, str) or not _SLOT.fullmatch(slot):
        return None
    files = record.get('files')
    result = record.get('result')
    delivery = result.get('delivery') if isinstance(result, dict) else None
    if not isinstance(files, dict) or not isinstance(delivery, dict):
        return None
    item = delivery.get(slot)
    name, source = f'{slot}.runtime.glb', f'{slot}.glb'
    if not isinstance(item, dict):
        return None
    source_sha, runtime_sha = files.get(source), files.get(name)
    if (not isinstance(source_sha, str) or not _SHA.fullmatch(source_sha)
            or not isinstance(runtime_sha, str) or not _SHA.fullmatch(runtime_sha)
            or item.get('artifact') != name or item.get('source_sha256') != source_sha
            or item.get('sha256') != runtime_sha or item.get('geometry_preserved') is not True):
        return None
    return item


class _JobRecords:
    """job.json records read when asked, which is all lineage_body needs: a member's request must not list every job."""

    def __init__(self, factory, owner):
        self.factory, self.owner = factory, owner

    def get(self, job_id):
        if not isinstance(job_id, str) or not _ID.fullmatch(job_id):
            return None
        return read_json(self.factory.directory(self.owner, job_id)/'job.json') or None


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
        try:
            jobs = self.factory.listing(self.owner)
        except PipelineError:
            jobs = None  # The listing is still loading; counts arrive with the next read.
        if jobs is not None:
            self._adopt_versions(jobs)
        value = self._stored()
        default = FittingManagement(self.factory, self.owner).body_default().get('body') or None
        registered = registered_bodies(value['bodies'])
        counts = {}
        if jobs is not None:
            jobs_by_id = {job['id']: job for job in jobs}
            metadata = self.library.metadata()
            for job in jobs:
                body = lineage_body(jobs_by_id, job['id'], registered)
                # The count is of jobs parts() lists parts of, not of every job that was ever built on the body.
                if body and self._offered(job, metadata):
                    counts[body] = counts.get(body, 0) + 1
        return {'revision': value['revision'],
                'bodies': [{**body, 'is_default': bool(default) and (default['job_id'], default['version']) == (body['job_id'], body['version']),
                            'part_jobs': counts.get((body['job_id'], body['version']), 0) if jobs is not None else None}
                           for body in value['bodies']],
                'default': {'job_id': default['job_id'], 'version': default['version']} if default else None}

    def register(self, job, version, expected_revision):
        from src.services.avatar_fitting_management import FittingManagement

        def pending():
            """The stored list while this body still has to be added to it; None when it is there already. A body listed
            with aliases nobody compared (written before that check) is registered again, which compares them."""
            previous = self._stored()
            if any(b['job_id'] == job and b['version'] == version
                   and (not b.get('aliases') or b.get('aliases_verified') is True) for b in previous['bodies']):
                return None
            if previous['revision'] != expected_revision:
                raise PipelineError('revision_conflict', '옷장 몸 목록이 변경되었습니다. 다시 불러오세요.', 409)
            return previous
        self.library.require_storage()
        with _LOCK:
            previous = pending()
        if previous is not None:
            # Reading and parsing the body GLB takes seconds: the lock is only for comparing and writing the list.
            management = FittingManagement(self.factory, self.owner)
            body, source_job = management.body_entry(job, version)
            if source_job.get('base_job_id'):
                raise PipelineError('variant_body', '변형 작업의 몸은 옷장 몸으로 등록할 수 없습니다. 기준 몸을 등록하세요.', 422)
            shapes = self._alias_geometries(management, job, previous, body['version'])
            with _LOCK:
                previous = pending()
                if previous is not None:
                    others = [b for b in previous['bodies'] if b['job_id'] != job]
                    if len(others) >= MAX_BODIES:
                        raise PipelineError('too_many_bodies', f'옷장 몸은 {MAX_BODIES}개까지 등록할 수 있습니다.', 422)
                    name = self.library.metadata()['items'].get(job, {}).get('name')
                    replaced = next((b for b in previous['bodies'] if b['job_id'] == job), None)
                    # The versions it replaces keep their parts only where their body has this geometry: the
                    # replaced version (its geometry is stored) and its aliases (each parsed above).
                    if replaced:
                        shapes[replaced['version']] = replaced.get('geometry_sha256')
                    candidates = [*(replaced or {}).get('aliases', []), *([replaced['version']] if replaced else [])]
                    aliases = [alias for alias in dict.fromkeys(candidates)
                               if alias != body['version'] and shapes.get(alias) == body['geometry_sha256']]
                    # Compared here already: _adopt_versions does not parse them again.
                    _COMPARED.update((job, version, body['geometry_sha256']) for version in shapes)
                    entry = {**{key: body[key] for key in _FIELDS},
                             'name': name or source_job.get('character_name') or job,
                             'body_type': (source_job.get('base_body') or {}).get('body_type'), 'registered_at': now(),
                             **({'aliases': aliases, 'aliases_verified': True} if aliases else {})}
                    self._write(others + [entry])
        return self.bodies()

    def _alias_geometries(self, management, job, stored, new_version):
        """{version: geometry} of the aliases the registered entry of `job` carries, each read from its own body: an
        alias kept across a geometry change before this check existed is found out here. A version whose body cannot
        be read is left out, and its parts go with it. Parsed before the lock, like the body being registered."""
        replaced = next((b for b in stored['bodies'] if b['job_id'] == job), None)
        shapes = {}
        for alias in (replaced or {}).get('aliases', []):
            if alias == new_version or not isinstance(alias, str) or not _ID.fullmatch(alias):
                continue
            try:
                shapes[alias] = management.body_entry(job, alias)[0]['geometry_sha256']
            except (PipelineError, OSError, ValueError, KeyError) as exc:
                LOGGER.info('Wardrobe body %s drops alias %s: its body cannot be read (%s)', job, alias, type(exc).__name__)
        return shapes

    def _adopt_versions(self, jobs):
        """Adds to a registered body, as verified aliases, the other versions of its job that part jobs were made on and
        whose body has the registered geometry, so their parts stay in the wardrobe. register() keeps such a version
        only when it is the one being replaced; a body registered afresh at a later version of the same shape left the
        parts made on the earlier one out. Each version is parsed once per process; a version that cannot be read or
        has another shape is left out."""
        stored = self._stored()
        entries = {b['job_id']: b for b in stored['bodies'] if not b.get('aliases') or b.get('aliases_verified') is True}
        registered = registered_bodies(stored['bodies'])
        wanted = sorted({(job.get('base_job_id'), job.get('base_version')) for job in jobs
                         if job.get('base_job_id') in entries and isinstance(job.get('base_version'), str)
                         and _ID.fullmatch(job['base_version'])} - set(registered))
        wanted = [(job, version) for job, version in wanted
                  if (job, version, entries[job]['geometry_sha256']) not in _COMPARED]
        if not wanted:
            return
        try:
            self.library.require_storage()
        except PipelineError:
            return
        from src.services.avatar_fitting_management import FittingManagement
        management = FittingManagement(self.factory, self.owner)
        found = {}
        for job, version in wanted:
            geometry = entries[job]['geometry_sha256']
            _COMPARED.add((job, version, geometry))
            try:
                shape = management.body_entry(job, version)[0]['geometry_sha256']
            except (PipelineError, OSError, ValueError, KeyError) as exc:
                LOGGER.info('Wardrobe body %s leaves version %s out: its body cannot be read (%s)', job, version,
                            type(exc).__name__)
                continue
            if shape == geometry:
                found.setdefault((job, geometry), []).append(version)
        if not found:
            return
        with _LOCK:
            current = self._stored()
            bodies, changed = [], False
            for body in current['bodies']:
                extra = [version for version in found.get((body['job_id'], body['geometry_sha256']), [])
                         if version != body['version'] and version not in body.get('aliases', [])]
                if extra and (not body.get('aliases') or body.get('aliases_verified') is True):
                    body = {**body, 'aliases': [*body.get('aliases', []), *extra], 'aliases_verified': True}
                    changed = True
                bodies.append(body)
            if changed:
                self._write(bodies)

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
        """A version's assembly record, sealed ones kept in memory. {} for one that cannot be read (logged): a damaged
        record hides its own job's parts, not every part of the wardrobe."""
        key = (int(self.owner), job_id, version)
        with _records_lock:
            if key in _records:
                _records.move_to_end(key)
                return _records[key]
        if not _ID.fullmatch(version):
            return {}
        try:
            record = read_json(self.factory.directory(self.owner, job_id)/'native-parts'/version/'record.json')
            if not isinstance(record, dict):
                raise ValueError('An assembly record is a JSON object')
        except ValueError as exc:
            LOGGER.warning('Wardrobe skips job %s version %s: unreadable assembly record (%s)', job_id, version, type(exc).__name__)
            return {}
        if record.get('status') == 'review_required':
            with _records_lock:
                _records[key] = record
                while len(_records) > _RECORDS:
                    _records.popitem(last=False)
        return record

    def _offered(self, job, metadata, pinned=None):
        """The version parts() reads a job's parts from, or None when it offers none: a deleted or archived job, one
        whose slots are all tombstoned, or one with no sealed assembly. A job being re-assembled, or whose
        re-assembly failed, still offers the sealed version it had (ready_version); the body job is pinned."""
        if self.library.is_job_deleted(job, metadata):
            return None
        slots = job.get('requested_slots')
        if slots and all(metadata['parts'].get(f"{job['id']}:{slot}", {}).get('deleted') for slot in slots):
            return None
        version = pinned or job.get('ready_version') or job.get('assembly_version')
        return version if version and _ID.fullmatch(version) else None

    def _require_member(self, job_id, slot, message, body=None):
        """404 unless parts() could list this job's part: the job is a registered body's own or built on one (on
        `body` when given), is not deleted or archived, and the slot is not tombstoned. It reads the few records
        that takes, not the listing of every job."""
        registered = registered_bodies(self._stored()['bodies'])
        jobs = _JobRecords(self.factory, self.owner)
        job = jobs.get(job_id)
        if body:
            member = job_id == body['job_id'] or lineage_body(jobs, job_id, registered) == (body['job_id'], body['version'])
        else:
            member = any(job_id == registered_job for registered_job, _ in registered) or lineage_body(jobs, job_id, registered) is not None
        metadata = self.library.metadata()
        if (not job or not member or self.library.is_job_deleted(job, metadata)
                or metadata['parts'].get(f'{job_id}:{slot}', {}).get('deleted')):
            raise PipelineError('not_found', message, 404)

    def _member_record(self, job_id, version, slot, message):
        """The assembly record a wardrobe member may use `slot` of at `version`, else 404 (`not_found`): the body of a
        registered body at its registered version, or a part parts() lists: a job on a registered body's lineage (or the
        body's own), the version that job offers, a slot it made, fitted and not tombstoned. Reads the few records that
        takes, not the listing of every job, and no part file."""
        from src.services.avatar_native_parts import AvatarNativeParts
        if not _ID.fullmatch(job_id) or not _ID.fullmatch(version) or not _SLOT.fullmatch(slot):
            raise PipelineError('not_found', message, 404)
        bodies = self._stored()['bodies']
        own = next((b for b in bodies if b['job_id'] == job_id), None)
        if slot == 'body':
            if not own or own['version'] != version:
                raise PipelineError('not_found', message, 404)
            return self._record(job_id, version)
        jobs = _JobRecords(self.factory, self.owner)
        job = jobs.get(job_id)
        metadata = self.library.metadata()
        if (not job or (not own and lineage_body(jobs, job_id, registered_bodies(bodies)) is None)
                or self.library.is_job_deleted(job, metadata)
                or metadata['parts'].get(f'{job_id}:{slot}', {}).get('deleted')):
            raise PipelineError('not_found', message, 404)
        offered = own['version'] if own else AvatarNativeParts(self.factory).ready_version(self.owner, job_id)
        record = self._record(job_id, version) if offered == version else {}
        part = next((p for p in record.get('result', {}).get('parts', [])
                     if isinstance(p, dict) and p.get('slot') == slot), None)
        requested = job.get('requested_slots')
        made_elsewhere = (slot not in requested if isinstance(requested, list)
                          else (part or {}).get('origin') == 'reused_fitted_native')
        if (record.get('status') != 'review_required' or not part or part.get('available') is False
                or made_elsewhere or f'{slot}.glb' not in record.get('files', {})):
            raise PipelineError('not_found', message, 404)
        return record

    def member_file(self, job_id, version, name):
        """The path of a GLB a wardrobe member may load (see _member_record), else 404 (`not_found`). A *.runtime.glb
        derivative additionally needs its sealed delivery receipt bound to the original slot. Operators read every
        assembly file through AvatarNativeParts.artifact."""
        from src.services.avatar_native_parts import AvatarNativeParts
        message = '산출물을 찾을 수 없습니다.'
        runtime = isinstance(name, str) and name.endswith('.runtime.glb')
        suffix = '.runtime.glb' if runtime else '.glb'
        slot = name[:-len(suffix)] if isinstance(name, str) and name.endswith(suffix) else ''
        record = self._member_record(job_id, version, slot, message)
        if slot != 'body' and name not in record.get('files', {}):
            raise PipelineError('not_found', message, 404)
        native = AvatarNativeParts(self.factory)
        if runtime:
            if not _runtime_delivery(record, slot):
                raise PipelineError('not_found', message, 404)
            native.artifact(self.owner, job_id, version, f'{slot}.glb')
        return native.artifact(self.owner, job_id, version, name)

    def parts(self, job_id, *, operator=True):
        """Every part made on a wardrobe body: the body job's own and its descendants', newest first.

        A slot this job did not request came from another job (a variant copies its base's models or
        fitted files) and is listed only under the job that made it; slots a refit froze were
        requested here and stay listed. A job offers the last sealed version of its assembly, so its
        parts stay listed while a refit is running or after one failed, and switch when the new
        version is sealed. A job whose record cannot be read is left out (logged); the others are listed.

        operator=False is a member's listing: the parts to wear, without the parts that could not be
        fitted (`unavailable` is empty) or the messages of failed fit checks (`fit_check` is None).
        """
        self._body(job_id)
        jobs = self.factory.listing(self.owner)
        self._adopt_versions(jobs)
        body = self._body(job_id)
        registered = registered_bodies(self._stored()['bodies'])
        jobs_by_id = {job['id']: job for job in jobs}
        metadata = self.library.metadata()
        members = []
        for job in jobs:
            own = job['id'] == body['job_id']
            if not own and lineage_body(jobs_by_id, job['id'], registered) != (body['job_id'], body['version']):
                continue
            version = self._offered(job, metadata, body['version'] if own else None)
            if version:
                members.append((job, version))
        # Records are read in parallel on the first listing; later ones come from memory.
        records = list(_READERS.map(lambda member: self._record(member[0]['id'], member[1]), members))
        items, missing = [], []
        for (job, version), record in zip(members, records):
            if record.get('status') != 'review_required':
                continue
            try:
                listed, unfitted = self._job_parts(job, version, record, metadata)
            except (AttributeError, KeyError, TypeError, ValueError) as exc:
                LOGGER.warning('Wardrobe skips job %s version %s: malformed assembly record (%s)',
                               job['id'], version, type(exc).__name__)
                continue
            items += listed
            missing += unfitted
        items.sort(key=lambda item: item.get('created_at') or '', reverse=True)
        missing.sort(key=lambda row: row[0], reverse=True)
        if not operator:
            for item in items:
                item['fit_check'] = None
            missing = []
        return {'body': deepcopy(body), 'parts': items, 'unavailable': [row[1] for row in missing]}

    def _job_parts(self, job, version, record, metadata):
        """(listed parts, (created_at, unavailable entry) rows) of one job's sealed record."""
        items, missing = [], []
        requested = job.get('requested_slots')
        for part in record.get('result', {}).get('parts', []):
            slot, name = part.get('slot'), f"{part.get('slot')}.glb"
            made_elsewhere = (slot not in requested if requested is not None
                              else part.get('origin') == 'reused_fitted_native')
            if slot == 'body' or made_elsewhere:
                continue
            entry = metadata['parts'].get(f"{job['id']}:{slot}", {})
            if entry.get('deleted'):
                continue
            label = entry.get('name') or job.get('part_name') or job.get('character_name') or job['id']
            if part.get('available') is False:
                # Why a part is missing from the list: its code only, never the worker's messages or paths.
                missing.append((job.get('created_at') or '', {'job_id': job['id'], 'version': version, 'slot': slot,
                                                              'name': label, 'reason': _reason(part)}))
                continue
            if name not in record.get('files', {}):
                continue
            check = (part.get('limb_fit') or {}).get('check') or {}
            delivery = _runtime_delivery(record, slot)
            items.append({'job_id': job['id'], 'version': version, 'slot': slot, 'name': label,
                          'character_name': job.get('character_name'), 'fit_method': part.get('fit_method'),
                          'fit_check': ({'status': check['status'],
                                         'failures': [f['message'] for f in check.get('failures', [])]}
                                        if check.get('status') in ('pass', 'fail') else None),
                          'shape': ({key: value for key, value in (part.get('shape') or {}).items()
                                     if key in ('sleeve', 'hem', 'fit')}
                                    if part.get('fit_method') == 'body-shell-v1' else None),
                          'sha256': record['files'][name], 'created_at': job.get('created_at'),
                          **({'runtime_name': delivery['artifact'], 'runtime_sha256': delivery['sha256']}
                             if delivery else {})})
        return items, missing

    def preview(self, job_id, slot, version, *, member=False):
        """Front drawing of a part without the key-coloured mannequin, cropped; cached by drawing hash. A part with no
        drawing (one made from an uploaded GLB) is shown as it is worn: its region of the assembly's front render.
        A member (member=True) sees only the version a job offers of a slot it made, as with its files."""
        import numpy as np
        from PIL import Image
        from src.services.avatar_worn_images import _rgba, dilate, erode, key_mask
        if not _ID.fullmatch(job_id) or not _ID.fullmatch(version) or not _SLOT.fullmatch(slot):
            raise PipelineError('not_found', '미리보기를 찾을 수 없습니다.', 404)
        self._require_member(job_id, slot, '미리보기를 찾을 수 없습니다.')
        if member:
            self._member_record(job_id, version, slot, '미리보기를 찾을 수 없습니다.')
        record = self._record(job_id, version)
        if f'{slot}.glb' not in record.get('files', {}):
            raise PipelineError('not_found', '미리보기를 찾을 수 없습니다.', 404)
        directory = self.factory.directory(self.owner, job_id)
        part = next((p for p in read_json(directory/'pipeline.json').get('parts', []) if p.get('slot') == slot), {})
        view = (part.get('views') or {}).get('front') or {}
        report = next((p for p in record.get('result', {}).get('parts', [])
                       if isinstance(p, dict) and p.get('slot') == slot), {})
        if not view and slot == 'hair' and report.get('fit_method') == 'uploaded-native-hair-v1':
            return self._uploaded_native_preview(job_id, version, record, report)
        name, sha = view.get('file'), view.get('sha256')
        if not name or '/' in name or '\\' in name or not sha:
            return self._worn_preview(job_id, slot, version, record)
        key = part.get('key_color') if part.get('part_method') in ('worn', 'body_shell') else None
        target = self.library.root/'wardrobe-previews'/f'{sha[:32]}-{key or "plain"}-v2.png'
        if target.is_file():
            return target
        if not (directory/'output'/name).is_file():
            return self._worn_preview(job_id, slot, version, record)
        # Members open the wardrobe together: the first to ask draws the preview, the others wait and read it.
        with keyed_lock(('preview', str(target))):
            if target.is_file():
                return target
            with _COMPUTING:
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
                _write_file(target, buffer.getvalue())
        return target

    def _uploaded_native_preview(self, job_id, version, record, report):
        """An uploaded hair's sealed own render, or the actual whole assembly front; no guessed crop or new render."""
        from PIL import Image, UnidentifiedImageError
        from src.services.avatar_native_parts import AvatarNativeParts
        missing = PipelineError('preview_missing', '이 파츠에는 미리보기 그림이 없습니다.', 404)
        if record.get('status') != 'review_required' or report.get('available') is not True:
            raise missing
        # Check the exact offered version and slot ownership, and that its sealed files are still there as sealed, even
        # when a thumbnail is already cached. Each file is checked once against its stored hash; the render is read
        # only to draw a thumbnail.
        self._member_record(job_id, version, 'hair', '산출물을 찾을 수 없습니다.')
        files = record.get('files', {})
        render = 'hair-front.png' if 'hair-front.png' in files else 'front.png'
        expected = files.get(render)
        if not isinstance(expected, str) or not _SHA.fullmatch(expected):
            raise missing
        native = AvatarNativeParts(self.factory)
        try:
            native.artifact(self.owner, job_id, version, 'hair.glb')
            source_path = native.artifact(self.owner, job_id, version, render)
        except OSError as exc:
            raise PipelineError('artifact_changed', '검증된 미리보기를 찾을 수 없습니다.', 404) from exc
        target = self.library.root/'wardrobe-previews'/f'{version}-{expected}-native-v1.png'
        if target.is_file():
            return target
        with keyed_lock(('preview', str(target))):
            if target.is_file():
                return target
            try:
                content = source_path.read_bytes()
            except OSError as exc:
                raise PipelineError('artifact_changed', '검증된 미리보기를 찾을 수 없습니다.', 404) from exc
            if hashlib.sha256(content).hexdigest() != expected:
                raise PipelineError('artifact_changed', '검증된 미리보기를 찾을 수 없습니다.', 404)
            with _COMPUTING:
                try:
                    with Image.open(io.BytesIO(content)) as source:
                        image = source.convert('RGBA')
                except (OSError, UnidentifiedImageError) as exc:
                    raise missing from exc
                visible = image.getchannel('A').point(lambda value: 255 if value > 15 else 0).getbbox()
                if not visible:
                    raise missing
                image = image.crop(visible)
                image.thumbnail((384, 384), Image.Resampling.LANCZOS)
                buffer = io.BytesIO()
                image.save(buffer, format='PNG')
                _write_file(target, buffer.getvalue())
        return target

    def _worn_preview(self, job_id, slot, version, record):
        """The part's region of the version's front render (the character wearing it), for a part with no drawing; a
        head part's own render when the version has one. Cropped by the part's fitted bounds, else by its slot's
        fitting target, through the camera frame the version was rendered with. `preview_missing` (404) when the
        version has no front render or nothing says where the part sits."""
        from PIL import Image
        from src.services.avatar_native_parts import AvatarNativeParts
        missing = PipelineError('preview_missing', '이 파츠에는 미리보기 그림이 없습니다.', 404)
        files, result = record.get('files', {}), record.get('result', {})
        own_render = f'{slot}-front.png' if f'{slot}-front.png' in files else None
        report = next((p for p in result.get('parts', []) if isinstance(p, dict) and p.get('slot') == slot), {})
        box = report.get('fitted_bounds_gltf')
        box = box if _box(box) else (result.get('fitting_targets') or {}).get(slot)
        render = own_render or 'front.png'
        if render not in files or not (own_render or _box(box)):
            raise missing
        target = self.library.root/'wardrobe-previews'/f'{files[render][:32]}-{slot}-worn-v1.png'
        if target.is_file():
            return target
        frame = None
        if not own_render:
            frame = result.get('render_frame')
            if not (isinstance(frame, dict) and isinstance(frame.get('ortho_scale_m'), (int, float))
                    and frame['ortho_scale_m'] > 0 and len(frame.get('center_gltf_m') or ()) == 3):
                height = (read_json(self.factory.directory(self.owner, job_id)/'native-parts'/version/'input.json')
                          .get('production_spec') or {}).get('body_height_m')
                if not isinstance(height, (int, float)) or not height > 0:
                    raise missing
                frame = legacy_render_frame(height)
        native = AvatarNativeParts(self.factory)
        with keyed_lock(('preview', str(target))):
            if target.is_file():
                return target
            with _COMPUTING:
                with Image.open(io.BytesIO(native.artifact(self.owner, job_id, version, render).read_bytes())) as source:
                    image = source.convert('RGBA')
                if frame is not None:
                    left, top, right, bottom = _front_crop(frame, box, image.size)
                    if right - left < 2 or bottom - top < 2:
                        raise missing
                    image = image.crop((left, top, right, bottom))
                # Only where the character is: the render's background is transparent.
                visible = image.getchannel('A').point(lambda value: 255 if value > 15 else 0).getbbox()
                if not visible:
                    raise missing
                image = image.crop(visible)
                image.thumbnail((384, 384), Image.Resampling.LANCZOS)
                buffer = io.BytesIO()
                image.save(buffer, format='PNG')
                _write_file(target, buffer.getvalue())
        return target

    def coverage(self, body_job_id, job_id, slot, version, *, member=False):
        """Body triangles one garment of this wardrobe body covers; computed once per body and part file. A member
        (member=True) asks only for the version a job offers of a slot it made."""
        from src.services.avatar_native_parts import AvatarNativeParts
        from src.services.avatar_wardrobe_coverage import GARMENT_SLOTS, coverage
        if slot not in GARMENT_SLOTS or not _ID.fullmatch(job_id) or not _ID.fullmatch(version):
            raise PipelineError('not_found', '가림 영역이 없는 파츠입니다.', 404)
        body = self._body(body_job_id)
        self._require_member(job_id, slot, '이 옷장 몸의 파츠가 아닙니다.', body)
        if member:
            self._member_record(job_id, version, slot, '이 옷장 몸의 파츠가 아닙니다.')
        part_sha = self._record(job_id, version).get('files', {}).get(f'{slot}.glb')
        if not part_sha:
            raise PipelineError('not_found', '파츠 파일을 찾을 수 없습니다.', 404)
        # v12: shins and thighs of a prefixed skeleton ('mixamorig:LeftLeg', 'mixamorig_LeftLeg') are found too.
        target = self.library.root/'wardrobe-coverage'/f"{body['body_sha256'][:20]}-{part_sha[:20]}-v12.json"
        value = read_json(target)
        if not value:
            with keyed_lock(('coverage', str(target))):
                value = read_json(target)
                if not value:
                    native = AvatarNativeParts(self.factory)
                    with _COMPUTING:
                        value = coverage(self._body_geometry(native, body),
                                         native.artifact(self.owner, job_id, version, f'{slot}.glb').read_bytes(), slot)
                    _write_json(target, value)
        if value['covers_bottom'] and self._outerwear(job_id, slot):
            value = {**value, 'covers_bottom': False}
        return value

    def _outerwear(self, job_id, slot):
        part = next((p for p in read_json(self.factory.directory(self.owner, job_id)/'pipeline.json').get('parts', [])
                     if p.get('slot') == slot), {})
        text = (part.get('description') or '').lower()
        return bool(_OUTERWEAR.search(text)) and not _DRESS.search(text)

    def colors(self, job_id, slot, version, *, member=False):
        """Colour regions of a part texture ({regions: [...]}) and the path of their mask PNG, cached per part file. A
        member (member=True) asks only for the version a job offers of a slot it made."""
        from src.services.avatar_native_parts import AvatarNativeParts
        from src.services.avatar_wardrobe_colors import TextureTooLarge, color_regions
        if not _ID.fullmatch(job_id) or not _ID.fullmatch(version) or not _SLOT.fullmatch(slot):
            raise PipelineError('not_found', '색 영역을 찾을 수 없습니다.', 404)
        self._require_member(job_id, slot, '색 영역을 찾을 수 없습니다.')
        if member:
            self._member_record(job_id, version, slot, '색 영역을 찾을 수 없습니다.')
        part_sha = self._record(job_id, version).get('files', {}).get(f'{slot}.glb')
        if not part_sha:
            raise PipelineError('not_found', '파츠 파일을 찾을 수 없습니다.', 404)
        base = self.library.root/'wardrobe-colors'/f'{part_sha[:20]}-v3'
        info, mask = base.with_suffix('.json'), base.with_suffix('.png')
        cached = read_json(info)
        if cached:
            return cached, mask
        # The json and the mask are fetched together, and the clustering takes seconds and hundreds of MB: one
        # request computes, the others wait for it and read what it saved.
        with keyed_lock(('colors', part_sha[:20])):
            cached = read_json(info)
            if cached:
                return cached, mask
            with _COMPUTING:
                try:
                    result = color_regions(AvatarNativeParts(self.factory).artifact(self.owner, job_id, version, f'{slot}.glb').read_bytes())
                except TextureTooLarge:
                    raise PipelineError('texture_too_large', '텍스처가 너무 커서 색 영역을 나눌 수 없습니다.', 422) from None
            if not result:
                raise PipelineError('no_texture', '색을 바꿀 텍스처가 없는 파츠입니다.', 422)
            png, regions, material = result
            # The mask first: a reader that finds the json must find the mask it describes, and finds it whole.
            _write_file(mask, png)
            value = {'slot': slot, 'material': material, 'regions': regions}
            _write_json(info, value)
        return value, mask

    def _body_geometry(self, native, body):
        """Parsed wardrobe body; one download and parse serves every part's coverage. Kept in its own small cache:
        each one holds tens of MB."""
        from src.services.avatar_wardrobe_coverage import skinned_primitives
        key = ('body', body['body_sha256'])
        with _records_lock:
            if key in _geometries:
                _geometries.move_to_end(key)
                return _geometries[key]
        # Several parts of one body are asked for together: parse its GLB once.
        with keyed_lock(key):
            with _records_lock:
                if key in _geometries:
                    _geometries.move_to_end(key)
                    return _geometries[key]
            parsed = skinned_primitives(native.artifact(self.owner, body['job_id'], body['version'], 'body.glb').read_bytes())
            with _records_lock:
                _geometries[key] = parsed
                while len(_geometries) > _GEOMETRIES:
                    _geometries.popitem(last=False)
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
        require_request_key(key)
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
        if conflicting_head_parts(payload['parts']):
            raise PipelineError('invalid_parts', '전체 머리와 분리 머리는 함께 입을 수 없습니다.', 422)
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
