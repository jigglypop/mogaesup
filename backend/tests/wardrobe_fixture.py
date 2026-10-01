"""A disposable wardrobe: registered bodies and the part jobs built on them, written as the records the services read."""
import hashlib

from src.services import avatar_wardrobe
from src.services.asset_editor import _write_json
from src.services.avatar_factory import AvatarFactory

OWNER = 1


def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    _write_json(path, value)


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


class Library:
    def __init__(self, root, factory=None):
        self.factory = factory or AvatarFactory(root)
        self.wardrobe = avatar_wardrobe.Wardrobe(self.factory, OWNER)
        # Sealed records are remembered by (owner, job, version) for the whole process; tests reuse those names.
        avatar_wardrobe._records.clear()
        # Object storage has no directories to make; a local disk needs this one for the wardrobe's own files.
        self.wardrobe.library.root.mkdir(parents=True, exist_ok=True)

    def directory(self, job_id):
        return self.factory.directory(OWNER, job_id)

    def job(self, job_id, *, base=None, requested=None, name=None, created_at='2026-09-20T00:00:00+00:00',
            character=None, **extra):
        job = {'id': job_id, 'character_id': character or job_id, 'character_name': name or job_id,
               'created_at': created_at, 'status': 'review_required', 'input_kind': 'image',
               'production_mode': 'character_parts', 'source_sha256': sha(job_id),
               'profile': {'name': 'fixture', 'rig': 'meshy-native'}, 'parts': [], 'files': {}, **extra}
        if base:
            job['base_job_id'], job['base_version'] = base
        if requested is not None:
            job['requested_slots'] = requested
        put(self.directory(job_id)/'job.json', job)

    def assembly(self, job_id, version, *, status='review_required', slots=('hair',), created_at='2026-09-20T00:00:00+00:00',
                 contents=None):
        """One assembly record; only a sealed one carries the part files and their reports. `contents` ({slot: bytes})
        writes real files, which the record then names by their own hash."""
        record = {'status': status, 'created_at': created_at, 'files': {}, 'result': {}}
        if status == 'review_required':
            record['files'] = {f'{slot}.glb': self.file_sha(job_id, version, slot) for slot in ('body', *slots)}
            record['result'] = {'parts': [{'slot': slot} for slot in ('body', *slots)]}
            for slot, content in (contents or {}).items():
                path = self.directory(job_id)/'native-parts'/version/f'{slot}.glb'
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
                record['files'][f'{slot}.glb'] = hashlib.sha256(content).hexdigest()
        put(self.directory(job_id)/'native-parts'/version/'record.json', record)

    @staticmethod
    def file_sha(job_id, version, slot):
        return sha(f'{job_id}:{version}:{slot}')

    def current(self, job_id, version):
        put(self.directory(job_id)/'native-parts/current.json', {'version': version})

    def ready(self, job_id, version):
        put(self.directory(job_id)/'native-parts/ready.json', {'version': version})

    def register(self, *bodies):
        """The wardrobe's registered bodies: (job id, version) pairs."""
        entries = [{'job_id': job, 'version': version, 'profile_id': f'body-{job[:8]}', 'geometry_sha256': sha(job),
                    'body_sha256': self.file_sha(job, version, 'body'), 'name': job, 'body_type': 'female',
                    'registered_at': '2026-09-20T00:00:00+00:00'} for job, version in bodies]
        put(self.wardrobe.path, {'revision': 'rev-1', 'bodies': entries, 'updated_at': '2026-09-20T00:00:00+00:00'})

    def catalog(self, **sections):
        """The operator's library metadata: items, parts (tombstones) and characters."""
        put(self.wardrobe.library.root/'catalog.json', {'revision': '1', 'items': {}, 'parts': {}, 'characters': {}, **sections})

    def refresh(self):
        """Forget the job listing the factory keeps for a few seconds."""
        self.factory._listings.clear()
        self.factory._records.clear()
        self.factory._listing_pending.clear()

    def listed(self, body_job):
        """(job, version, slot, sha256) of every part the wardrobe offers on a body."""
        self.refresh()
        return sorted((part['job_id'], part['version'], part['slot'], part['sha256'])
                      for part in self.wardrobe.parts(body_job)['parts'])


def textured_glb(colors=((200, 30, 30), (30, 30, 200), (240, 240, 240)), size=96):
    """A quad whose UV layout covers a texture of vertical stripes, one per colour."""
    import io
    import struct

    from PIL import Image

    from src.services.glb import build_glb
    image = Image.new('RGB', (size, size))
    for index, color in enumerate(colors):
        image.paste(color, (index*size//len(colors), 0, (index + 1)*size//len(colors), size))
    png = io.BytesIO()
    image.save(png, 'PNG')
    binary = (struct.pack('<12f', 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0) + struct.pack('<8f', 0, 0, 1, 0, 1, 1, 0, 1)
              + struct.pack('<6H', 0, 1, 2, 0, 2, 3) + png.getvalue())
    doc = {'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'name': 'body_0', 'mesh': 0}],
           'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'TEXCOORD_0': 1}, 'indices': 2, 'material': 0}]}],
           'materials': [{'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}}}],
           'textures': [{'source': 0}], 'images': [{'bufferView': 3, 'mimeType': 'image/png'}],
           'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': 4, 'type': 'VEC3', 'min': [0, 0, 0], 'max': [1, 1, 0]},
                         {'bufferView': 1, 'componentType': 5126, 'count': 4, 'type': 'VEC2'},
                         {'bufferView': 2, 'componentType': 5123, 'count': 6, 'type': 'SCALAR'}],
           'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': 48}, {'buffer': 0, 'byteOffset': 48, 'byteLength': 32},
                           {'buffer': 0, 'byteOffset': 80, 'byteLength': 12},
                           {'buffer': 0, 'byteOffset': 92, 'byteLength': len(png.getvalue())}],
           'buffers': [{'byteLength': len(binary)}]}
    return build_glb(doc, binary)


def seed_variant_base(root):
    """A sealed base body job with the saved pipeline, drawings and part models a variant copies from.
    Returns (factory, job directory, JOB, VERSION)."""
    import copy
    import io
    import json

    from PIL import Image

    from native_assembly_fixture import JOB, VERSION, seed_native_assembly
    from src.services.avatar_native_parts import SLOTS
    from src.services.avatar_production_spec import production_spec, seal_production_spec
    factory, version_directory = seed_native_assembly(root, 'fixture')
    directory = version_directory.parent.parent
    record = json.loads((version_directory/'record.json').read_text(encoding='utf-8'))
    record['result'].update(bone_count=1, fitting_targets={})
    put(version_directory/'record.json', record)
    parts = []
    for slot in ('body', *SLOTS):
        views = {}
        for view in ('front', 'side'):
            content = io.BytesIO()
            Image.new('RGBA', (16 + len(slot), 16), (len(slot)*20, 40, 60, 255)).save(content, 'PNG')
            name = f'{slot}-{view}.png'
            (directory/'output'/name).write_bytes(content.getvalue())
            views[view] = {'status': 'succeeded', 'file': name, 'sha256': hashlib.sha256(content.getvalue()).hexdigest()}
        model = f'raw model of {slot}'.encode()
        put(directory/'parts'/slot/'generation-artifacts.json', {'generated': {'sha256': hashlib.sha256(model).hexdigest()}})
        (directory/'parts'/slot/'generated.glb').write_bytes(model)
        parts.append({'slot': slot, 'description': f'{slot} design', 'views': views, 'image': copy.deepcopy(views['front']),
                      'model': {'status': 'ready', 'task_id': 'task'}, 'part_method': 'isolated'})
    (directory/'source.png').write_bytes(b'source drawing')
    put(directory/'pipeline.json', {'production_spec': seal_production_spec(production_spec('source', ('front', 'side'))),
                                    'parts': parts, 'hair_length': 'source', 'design_prompts': {}})
    return factory, directory, JOB, VERSION


class Overlap:
    """How many callers are inside at once. Each one waits, for a few seconds at most, until two have been inside together,
    so that a test of a limit does not depend on how fast the machine starts its threads."""

    def __init__(self, wait=5):
        from threading import Condition
        self.condition, self.wait, self.active, self.peak = Condition(), wait, 0, 0

    def __enter__(self):
        with self.condition:
            self.active += 1
            self.peak = max(self.peak, self.active)
            self.condition.notify_all()
            self.condition.wait_for(lambda: self.peak >= 2, timeout=self.wait)
        return self

    def __exit__(self, *exc):
        with self.condition:
            self.active -= 1
