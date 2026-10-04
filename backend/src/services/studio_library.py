"""Owner-scoped S3 library metadata and reproducible tile maps."""
from contextlib import contextmanager
import hashlib
import io
import json
import math
import random
import re
from threading import Lock

import numpy as np
from PIL import Image
from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, digest
from src.services.character_pipeline import PipelineError, read_json, now, require_bucket

SURFACES = {'snow': (224, 234, 244), 'sand': (202, 174, 119),
            'grass': (79, 112, 54), 'soil': (104, 76, 52), 'stone': (123, 128, 133),
            'wood': (142, 92, 48), 'bark': (92, 61, 39), 'brick': (151, 70, 51)}


def _columns(values):
    return np.array(values, dtype=np.float64)[None, :]


def _rows(values):
    return np.array(values, dtype=np.float64)[:, None]


def _pattern_maps(surface, n, seed):
    """Return periodic height and colour modifiers (float32, n×n) for authored surface families.

    The sines are taken per row and per column with `math`, and the per-texel arithmetic runs in numpy in the order the
    original per-texel loop used, so the maps stay identical to the bytes that loop produced."""
    rng = random.Random(seed)
    tau = math.tau
    phase = rng.random()*tau
    if surface == 'wood':
        grain_count = rng.randint(8, 13)
        grain_s = _columns([math.sin(tau*grain_count*x/n) for x in range(n)])
        grain_c = _columns([math.cos(tau*grain_count*x/n) for x in range(n)])
        pore_s = _columns([math.sin(tau*grain_count*3*x/n) for x in range(n)])
        pore_c = _columns([math.cos(tau*grain_count*3*x/n) for x in range(n)])
        warp_s, warp_c, pore_phase_s, pore_phase_c = [], [], [], []
        for y in range(n):
            v = y/n
            warp = .38*math.sin(tau*2*v+phase)+.14*math.sin(tau*5*v-phase*.7)
            warp_s.append(math.sin(warp)); warp_c.append(math.cos(warp))
            pore_phase = tau*2*v+phase
            pore_phase_s.append(math.sin(pore_phase)); pore_phase_c.append(math.cos(pore_phase))
        grain = grain_s*_rows(warp_c)+grain_c*_rows(warp_s)
        pore = (pore_s*_rows(pore_phase_c)+pore_c*_rows(pore_phase_s))*.18
        value = grain*.72+pore
        heights, colours = value*.58, value
    elif surface == 'bark':
        ridge_count = rng.randint(7, 11)
        ridge_s = _columns([math.sin(tau*ridge_count*x/n) for x in range(n)])
        ridge_c = _columns([math.cos(tau*ridge_count*x/n) for x in range(n)])
        split_s = _columns([math.sin(tau*ridge_count*2*x/n) for x in range(n)])
        split_c = _columns([math.cos(tau*ridge_count*2*x/n) for x in range(n)])
        knot_s = _columns([math.sin(tau*2*x/n) for x in range(n)])
        knot_c = _columns([math.cos(tau*2*x/n) for x in range(n)])
        rows = {name: [] for name in ('twist_s', 'twist_c', 'split_s', 'split_c', 'knot_s', 'knot_c')}
        for y in range(n):
            v = y/n
            twist = .45*math.sin(tau*2*v+phase)+.2*math.sin(tau*5*v)
            split_phase = tau*3*v+phase
            knot_phase = phase-tau*3*v
            for name, angle in (('twist', twist), ('split', split_phase), ('knot', knot_phase)):
                rows[name+'_s'].append(math.sin(angle)); rows[name+'_c'].append(math.cos(angle))
        ridge = ridge_s*_rows(rows['twist_c'])+ridge_c*_rows(rows['twist_s'])
        split = (split_s*_rows(rows['split_c'])+split_c*_rows(rows['split_s']))*.28
        knots = (knot_s*_rows(rows['knot_c'])+knot_c*_rows(rows['knot_s']))*.14
        value = ridge*.68+split+knots
        heights, colours = value*.82, value
    else:
        rows, columns = 8, 6
        mortar = .075
        joint_s = _columns([math.sin(math.pi*columns*x/n) for x in range(n)])
        joint_c = _columns([math.cos(math.pi*columns*x/n) for x in range(n)])
        pit_s = _columns([math.sin(tau*11*x/n) for x in range(n)])
        pit_c = _columns([math.cos(tau*11*x/n) for x in range(n)])
        row_wave, joint_phase_s, joint_phase_c, pit_phase_s, pit_phase_c = [], [], [], [], []
        for y in range(n):
            v = y/n
            row_wave.append(abs(math.sin(math.pi*rows*v)))
            row_phase = .5*(1-math.cos(tau*rows*v))
            joint_phase = math.pi*row_phase
            joint_phase_s.append(math.sin(joint_phase)); joint_phase_c.append(math.cos(joint_phase))
            pit_phase = tau*7*v+phase
            pit_phase_s.append(math.sin(pit_phase)); pit_phase_c.append(math.cos(pit_phase))
        joint_wave = np.abs(joint_s*_rows(joint_phase_c)+joint_c*_rows(joint_phase_s))
        row_wave = _rows(row_wave)
        joint_mask = np.minimum(1., row_wave/(mortar*math.pi))
        brick_face = np.minimum(np.minimum(1., row_wave/(mortar*math.pi)), joint_wave/(mortar*math.pi))
        pitting = .08*(pit_s*_rows(pit_phase_c)+pit_c*_rows(pit_phase_s))
        heights = (brick_face-.5)*.7+pitting*joint_mask
        colours = (brick_face-.5)*.8+pitting
    return heights.astype(np.float32), np.broadcast_to(colours, (n, n)).astype(np.float32)


def _channel(values):
    """Bytes of one 8-bit channel: rounded half to even like round(), then clamped."""
    return np.clip(np.rint(values), 0, 255).astype(np.uint8)


def _tile_maps(surface, n, seed):
    """Lossless albedo, normal and ORM WebP bytes for one reproducible tile identity."""
    rng = random.Random(seed)
    # Preserve the original five surfaces byte-for-byte. New authored families
    # use their own periodic functions while sharing the same wrapped derivatives.
    if surface in {'wood', 'bark', 'brick'}:
        heights, colour_modifiers = _pattern_maps(surface, n, seed)
    else:
        # Integer frequencies produce a continuous periodic surface, including
        # normal derivatives. Each tile samples [0, 1), so texels aren't duplicated.
        waves = [(rng.randint(1, 24), rng.randint(-24, 24), rng.random()*math.tau,
                  .6**octave) for octave in range(7)]
        weight = sum(w[3] for w in waves)
        total = np.zeros((n, n))
        for fx, fy, phase, amplitude in waves:
            xs = _columns([math.sin(math.tau*fx*x/n+phase) for x in range(n)])
            xc = _columns([math.cos(math.tau*fx*x/n+phase) for x in range(n)])
            ys = _rows([math.sin(math.tau*fy*y/n) for y in range(n)])
            yc = _rows([math.cos(math.tau*fy*y/n) for y in range(n)])
            total = total+amplitude*(xs*yc+xc*ys)
        heights = (total/weight).astype(np.float32)
        colour_modifiers = heights
    # The float32 maps are read back as doubles, as the original per-texel loop read them from array('f').
    h, colour = heights.astype(np.float64), colour_modifiers.astype(np.float64)
    base = SURFACES[surface]
    albedo = np.stack([_channel(c+(10 if surface == 'snow' else 24)*colour) for c in base], axis=-1)
    dx = (np.roll(h, -1, axis=1)-np.roll(h, 1, axis=1))*n*.025
    dy = (np.roll(h, -1, axis=0)-np.roll(h, 1, axis=0))*n*.025
    length = np.sqrt(dx*dx+dy*dy+1)
    normals = np.stack([_channel(127.5-dx/length*127.5), _channel(127.5+dy/length*127.5),
                        _channel(127.5+127.5/length)], axis=-1)
    orm = np.stack([np.full((n, n), 255, np.uint8), _channel(220+15*h), np.zeros((n, n), np.uint8)], axis=-1)
    maps = {}
    for name, raw in (('albedo', albedo), ('normal', normals), ('orm', orm)):
        output = io.BytesIO()
        Image.frombytes('RGB', (n, n), raw.tobytes()).save(output, format='WEBP', lossless=True, method=4)
        maps[name+'.webp'] = output.getvalue()
    return maps


TEXTURE_RUNS_PER_OWNER = 2
_texture_runs = {}   # owner -> texture maps being computed now
_texture_guard = Lock()


@contextmanager
def _texture_slot(owner):
    """A few texture computations per owner at a time; each holds a CPU core while it runs."""
    with _texture_guard:
        if _texture_runs.get(owner, 0) >= TEXTURE_RUNS_PER_OWNER:
            raise PipelineError('texture_busy', '다른 텍스쳐를 만드는 중입니다. 끝난 뒤 다시 요청하세요.', 429)
        _texture_runs[owner] = _texture_runs.get(owner, 0) + 1
    try:
        yield
    finally:
        with _texture_guard:
            _texture_runs[owner] -= 1
            if not _texture_runs[owner]:
                del _texture_runs[owner]


class StudioLibrary:
    def __init__(self, factory, owner):
        self.factory, self.owner = factory, owner
        self.root = factory.root/str(int(owner))/'library'

    def require_storage(self):
        require_bucket()

    def metadata(self):
        catalog = read_json(self.root/'catalog.json', {'revision': '0', 'items': {}})
        catalog.setdefault('items', {})
        catalog.setdefault('parts', {})
        catalog.setdefault('characters', {})
        return catalog

    def save(self, job_id, name, archived, revision):
        self.require_storage()
        self.factory.get(self.owner, job_id)
        return self._save_metadata('items', job_id, {'name': self._name(name), 'archived': archived}, revision)

    def save_part(self, job_id, slot, changes, revision):
        self.require_storage()
        job = self.factory.get(self.owner, job_id)
        names = {f'{slot}-front.png', f'{slot}-image.png', f'generated-{slot}.glb', f'{slot}.glb'}
        artifacts = [*job.get('artifacts', []), *job.get('assembly_artifacts', [])]
        has_part = any(part.get('slot') == slot for part in job.get('parts', []))
        if (job.get('production_mode') != 'character_parts'
                or (job.get('base_job_id') and slot not in job.get('requested_slots', []))
                or not (has_part or any(item.get('name') in names for item in artifacts))):
            raise PipelineError('part_not_found', '저장된 파츠를 찾을 수 없습니다.', 404)
        if not changes or set(changes)-{'name', 'deleted'}:
            raise PipelineError('invalid_metadata', '변경할 이름이나 삭제 상태가 필요합니다.', 422)
        changes = dict(changes)
        if 'name' in changes:
            changes['name'] = self._name(changes['name'])
        if 'deleted' in changes and type(changes['deleted']) is not bool:
            raise PipelineError('invalid_metadata', '삭제 상태를 확인하세요.', 422)
        # A tombstone removes only this library entry. Immutable generation and
        # assembly artifacts remain valid for existing outfits and restoration.
        return self._save_metadata('parts', f'{job_id}:{slot}', changes, revision)

    def save_visibility(self, job_id, scope, deleted, revision):
        self.require_storage()
        job = self.factory.get(self.owner, job_id)
        if scope == 'character':
            return self._save_metadata(
                'characters', job.get('character_id') or job['id'], {'deleted': deleted}, revision)
        if scope == 'version':
            return self._save_metadata('items', job['id'], {'deleted': deleted}, revision)
        raise PipelineError('invalid_visibility_scope', '삭제 범위를 확인하세요.', 422)

    def is_job_deleted(self, job, catalog=None):
        catalog = catalog or self.metadata()
        item = catalog['items'].get(job['id'], {})
        character = catalog['characters'].get(job.get('character_id') or job['id'], {})
        return bool(item.get('archived') or item.get('deleted') or character.get('deleted'))

    @staticmethod
    def _name(value):
        if not isinstance(value, str) or not 1 <= len(value.strip()) <= 80:
            raise PipelineError('invalid_name', '이름은 1~80자로 입력하세요.', 422)
        return value.strip()

    def _save_metadata(self, section, key, changes, revision):
        with _LOCK:
            catalog = self.metadata()
            current = catalog[section].get(key, {})
            # A lost response can safely replay the same field changes.
            if all(current.get(field) == value for field, value in changes.items()):
                return catalog
            if catalog['revision'] != revision:
                raise PipelineError('revision_conflict', '관리 목록이 변경되었습니다. 다시 불러오세요.', 409)
            catalog[section][key] = {**current, **changes, 'updated_at': now()}
            catalog['revision'] = hashlib.sha256(json.dumps(catalog, sort_keys=True).encode()).hexdigest()
            self.root.mkdir(parents=True, exist_ok=True)
            _write_json(self.root/'catalog.json', catalog)
            return catalog

    def textures(self):
        return {'items': [self.texture(path.parent.name) for path in sorted(
            (self.root/'textures').glob('*/record.json'), reverse=True)]}

    def texture(self, texture_id):
        if not re.fullmatch(r'[a-f0-9]{24}', texture_id):
            raise PipelineError('not_found', '텍스쳐를 찾을 수 없습니다.', 404)
        record = read_json(self.root/'textures'/texture_id/'record.json')
        if not record:
            raise PipelineError('not_found', '텍스쳐를 찾을 수 없습니다.', 404)
        files = record.get('files')
        if (not isinstance(files, dict) or set(files) not in (
                {'albedo.webp', 'normal.webp', 'orm.webp'},
                {'albedo.webp', 'normal.webp', 'orm.webp', 'manifest.json'}) or
                any(not re.fullmatch(r'[a-f0-9]{64}', sha) for sha in files.values())):
            raise PipelineError('invalid_record', '텍스쳐 저장 기록이 올바르지 않습니다.', 409)
        return {**record, 'artifacts': [{'name': name, 'sha256': sha,
                'url': f'/api/studio/textures/{texture_id}/{name}'} for name, sha in files.items()]}

    def generate_texture(self, payload):
        self.require_storage()
        if payload.get('surface') not in SURFACES or payload.get('size') not in (256, 512, 1024):
            raise PipelineError('invalid_texture', '지원하지 않는 반복 텍스쳐 설정입니다.', 422)
        if type(payload.get('seed')) is not int or not 0 <= payload['seed'] <= 2147483647:
            raise PipelineError('invalid_texture', '텍스쳐 시드가 올바르지 않습니다.', 422)
        identity = {key: payload[key] for key in ('surface', 'size', 'seed')}
        identity['algorithm'] = 'periodic-fourier-pbr-v3'
        texture_id = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:24]
        directory = self.root/'textures'/texture_id
        if (directory/'record.json').is_file():
            return self.texture(texture_id)
        # The maps depend only on the identity, so concurrent requests compute and store identical bytes.
        # The shared factory lock guards only the record commit, never this CPU-bound work.
        with _texture_slot(int(self.owner)):
            maps = _tile_maps(payload['surface'], payload['size'], payload['seed'])
        directory.mkdir(parents=True, exist_ok=True)
        files = {}
        for filename, data in maps.items():
            (directory/filename).write_bytes(data)
            files[filename] = hashlib.sha256(data).hexdigest()
        n = payload['size']
        with _LOCK:
            if (directory/'record.json').is_file():
                return self.texture(texture_id)
            record = {'id': texture_id, **identity, 'created_at': now(), 'files': files,
                'tileable': True, 'channels': {'orm': {'r': 'occlusion', 'g': 'roughness', 'b': 'metalness'}},
                'material': {'baseColor': 'albedo.webp', 'normal': 'normal.webp', 'orm': 'orm.webp',
                             'baseColorSpace': 'srgb', 'dataColorSpace': 'linear', 'wrap': 'repeat',
                             'mipmaps': True, 'metalness': 0, 'normalConvention': 'OpenGL'},
                'gpu': {'compression': 'rgba8-uncompressed', 'estimated_bytes_with_mips': n*n*4*3*4//3,
                        'texture_count': 3, 'sampler': 'repeat-trilinear', 'anisotropy': 4}}
            manifest = {k: v for k, v in record.items() if k != 'files'}
            manifest['files'] = dict(files)
            manifest['schema'] = 'gaesup-webgpu-tile-v1'
            _write_json(directory/'manifest.json', manifest)
            files['manifest.json'] = hashlib.sha256((directory/'manifest.json').read_bytes()).hexdigest()
            _write_json(directory/'record.json', record)
            return self.texture(texture_id)

    def artifact(self, texture_id, name):
        record = self.texture(texture_id)
        if name not in record['files']:
            raise PipelineError('not_found', '텍스쳐 파일을 찾을 수 없습니다.', 404)
        path = self.root/'textures'/texture_id/name
        # The stored object's own SHA-256 (its HEAD checksum, or the record's hash): the route streams the file next,
        # so it is not downloaded once more just to be hashed.
        if digest(path) != record['files'][name]:
            raise PipelineError('artifact_changed', '저장된 텍스쳐가 변경되었습니다.', 409)
        return path
