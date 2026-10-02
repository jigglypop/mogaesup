"""Owner-scoped animal library: reference picture, turnaround views, 3D model and standard rig per animal.

A record names each file by its SHA-256. Published bytes live at files/<sha><suffix>, so writing a
new version never touches the one the record vouches for; the record update is the only switch.
Older animals keep their files at <name>, which is read only when its digest still matches.
"""
import hashlib
import io
import json
from pathlib import PurePosixPath
import re

from PIL import Image, ImageOps

from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, digest
from src.services.character_pipeline import PipelineError, now, read_json, request_job_id, require_bucket, valid_request_key
from src.services.object_storage import copy_file
from src.services.process_identity import state as process_state

STAGES = ('views', 'model', 'rig', 'walk', 'standard')
SPECIES = ('dog',)
MAX_REFERENCE_BYTES = 32 * 1024 * 1024
MAX_REFERENCE_PIXELS = 32_000_000
# The reference is an appearance input for 1024px view images; a larger photo adds upload cost only.
REFERENCE_EDGE = 2048
_SHA = re.compile(r'[a-f0-9]{64}')


def normalized_reference(content):
    """A PNG or JPEG picture as upright PNG pixels, without its metadata (EXIF may carry a location)."""
    if not content:
        raise PipelineError('invalid_image', 'PNG 또는 JPEG 그림을 선택하세요.', 422)
    if len(content) > MAX_REFERENCE_BYTES:
        raise PipelineError('image_too_large', '그림은 32MB 이하로 올려 주세요.', 413)
    try:
        with Image.open(io.BytesIO(content)) as source:
            if source.format not in ('PNG', 'JPEG') or source.width * source.height > MAX_REFERENCE_PIXELS:
                raise ValueError('Unsupported picture')
            source.load()
            upright = ImageOps.exif_transpose(source)
            alpha = upright.mode in ('RGBA', 'LA', 'PA') or 'transparency' in upright.info
            image = upright.convert('RGBA' if alpha else 'RGB')
        if max(image.size) > REFERENCE_EDGE:
            image.thumbnail((REFERENCE_EDGE, REFERENCE_EDGE), Image.Resampling.LANCZOS)
        profile = image.info.get('icc_profile')
        image.info = {}
        output = io.BytesIO()
        image.save(output, format='PNG', **({'icc_profile': profile} if profile else {}))
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        raise PipelineError('invalid_image', 'PNG 또는 JPEG 그림을 선택하세요.', 422) from None
    return output.getvalue(), image.size


class AnimalLibrary:
    def __init__(self, factory, owner):
        self.owner = int(owner)
        self.root = factory.root/str(self.owner)/'library/animals'
        self.references = factory.root/str(self.owner)/'library/animal-references'

    def directory(self, animal_id):
        if not isinstance(animal_id, str) or not re.fullmatch(r'[a-f0-9]{24}', animal_id):
            raise PipelineError('not_found', '동물을 찾을 수 없습니다.', 404)
        return self.root/animal_id

    def _record(self, animal_id):
        record = read_json(self.directory(animal_id)/'record.json')
        if not record:
            raise PipelineError('not_found', '동물을 찾을 수 없습니다.', 404)
        return record

    def record(self, animal_id):
        """The saved record with its collections present, for the production steps."""
        record = self._record(animal_id)
        if not isinstance(record.get('files'), dict):
            record['files'] = {}
        if not isinstance(record.get('stages'), dict):
            record['stages'] = {}
        return record

    def blob(self, animal_id, name, sha):
        if not _SHA.fullmatch(sha or ''):
            raise PipelineError('not_found', '동물 파일을 찾을 수 없습니다.', 404)
        return self.directory(animal_id)/'files'/f'{sha}{PurePosixPath(name).suffix}'

    def file(self, animal_id, name, record=None):
        """The stored bytes the record vouches for under `name`."""
        record = self._record(animal_id) if record is None else record
        sha = (record.get('files') or {}).get(name)
        if not isinstance(sha, str) or not _SHA.fullmatch(sha):
            raise PipelineError('not_found', '동물 파일을 찾을 수 없습니다.', 404)
        for path in (self.blob(animal_id, name, sha), self.directory(animal_id)/name):
            try:
                if path.is_file() and digest(path) == sha:
                    return path
            except OSError:
                continue
        raise PipelineError('not_found', '동물 파일을 찾을 수 없습니다.', 404)

    def production(self, animal_id, record):
        """The latest regeneration job; a live-looking job whose process is gone reads as paused."""
        job_id = record.get('production')
        job = read_json(self.directory(animal_id)/'jobs'/job_id/'job.json') if job_id else None
        if not job:
            return None
        status = job['status']
        if status in ('accepted', 'running') and process_state(job.get('process')) == 'exited':
            status = 'paused'
        return {'id': job['id'], 'request_key': job['request_key'], 'status': status, 'step': job.get('step'),
                'steps': job['steps'], 'done': job.get('done', []), 'views': job['request']['views'], 'note': job['request']['note'],
                'error': job.get('error'), 'created_at': job.get('created_at'), 'updated_at': job.get('updated_at'),
                'progress': self._progress(animal_id, job) if status == 'running' else None}

    def _progress(self, animal_id, job):
        """Where the running step is: the view being drawn, or the Meshy task's percentage."""
        work = self.directory(animal_id)/'jobs'/job['id']
        if job.get('step') == 'views':
            views = job['request']['views']
            drawn = [view for view in views if (work/f'{view}-raw.png').is_file()]
            return {'current': next((view for view in views if view not in drawn), None), 'done': len(drawn),
                    'total': len(views)}
        if job.get('step') == 'model':
            meshy = read_json(work/'meshy'/'character.json')
            return {'percent': meshy.get('progress') if meshy.get('task_id') else None}
        return None

    def get(self, animal_id):
        record = self._record(animal_id)
        files = record.get('files') if isinstance(record.get('files'), dict) else {}
        stages = record.get('stages') if isinstance(record.get('stages'), dict) else {}
        return {**{key: record.get(key) for key in ('id', 'name', 'species', 'order', 'created_at')},
                'stages': {stage: stages.get(stage) for stage in STAGES},
                'production': self.production(animal_id, record),
                'artifacts': [{'name': name, 'sha256': sha, 'url': f'/api/studio/animals/{animal_id}/{name}'}
                              for name, sha in files.items()]}

    def listing(self):
        items = [self.get(path.parent.name) for path in self.root.glob('*/record.json')]
        return {'items': sorted(items, key=lambda item: (item.get('order') or 0, item.get('created_at') or ''))}

    def artifact(self, animal_id, name):
        return self.file(animal_id, name)

    @staticmethod
    def require_storage():
        require_bucket()

    def upload_reference(self, content):
        """Keep one content-addressed reference picture; creating an animal refers to it by digest."""
        self.require_storage()
        png, size = normalized_reference(content)
        reference_id = hashlib.sha256(png).hexdigest()
        path = self.references/f'{reference_id}.png'
        if not path.is_file() or digest(path) != reference_id:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(png)
        return {'id': reference_id, 'width': size[0], 'height': size[1]}

    def reference(self, reference_id):
        if not isinstance(reference_id, str) or not _SHA.fullmatch(reference_id):
            raise PipelineError('reference_not_found', '올린 그림을 찾을 수 없습니다. 다시 올려 주세요.', 404)
        path = self.references/f'{reference_id}.png'
        try:
            if path.is_file() and digest(path) == reference_id:
                return path
        except OSError:
            pass
        raise PipelineError('reference_not_found', '올린 그림을 찾을 수 없습니다. 다시 올려 주세요.', 404)

    def create(self, key, payload):
        """A new animal with its reference picture only; paid production starts from a regenerate request."""
        if not isinstance(key, str) or not valid_request_key(key):
            raise PipelineError('invalid_key', '요청 식별자가 필요합니다.', 422)
        name, species, reference = payload.get('name'), payload.get('species'), payload.get('reference')
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
            raise PipelineError('invalid_name', '이름은 1~80자로 입력하세요.', 422)
        if species not in SPECIES:
            raise PipelineError('invalid_species', '지원하지 않는 동물 종류입니다.', 422)
        if not isinstance(reference, str) or not _SHA.fullmatch(reference):
            raise PipelineError('reference_not_found', '올린 그림을 찾을 수 없습니다. 다시 올려 주세요.', 404)
        self.require_storage()
        submitted = {'name': name.strip(), 'species': species, 'reference': reference}
        fingerprint = hashlib.sha256(json.dumps(submitted, sort_keys=True).encode()).hexdigest()
        animal_id = request_job_id(self.owner, 'animal', key)
        directory = self.directory(animal_id)
        with _LOCK:
            previous = read_json(directory/'record.json')
            if previous:
                if previous.get('fingerprint') != fingerprint:
                    raise PipelineError('idempotency_conflict', '같은 요청에 다른 설정이 있습니다.', 409)
                return self.get(animal_id), False
            frozen = self.blob(animal_id, 'reference.png', reference)
            copy_file(self.reference(reference), frozen)
            if digest(frozen) != reference:
                raise PipelineError('reference_changed', '올린 그림이 변경되었습니다. 다시 올려 주세요.', 409)
            orders = [read_json(path).get('order') for path in self.root.glob('*/record.json')]
            order = max((value for value in orders if type(value) in (int, float)), default=0) + 1
            created = now()
            _write_json(directory/'record.json', {
                'id': animal_id, 'name': submitted['name'], 'species': species, 'order': order,
                'created_at': created, 'updated_at': created, 'request_key': key, 'fingerprint': fingerprint,
                'source': {'kind': 'upload', 'reference_sha256': reference},
                # Production reads design notes (worn/held items) when present; an upload has none yet.
                'design': {}, 'files': {'reference.png': reference},
                'stages': {stage: None for stage in STAGES}, 'production': None})
        return self.get(animal_id), True
