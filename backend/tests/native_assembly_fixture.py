"""Disposable assembly fixture; optional copies of real artifacts stay read-only."""
import copy
import json
from pathlib import Path
import shutil

from services.test_character_preparation import animated_fixture
from src.services.asset_editor import _write_json
from src.services.avatar_factory import AvatarFactory, digest
from src.services.avatar_native_parts import SLOTS
from src.services.glb import build_glb, parse_glb

JOB = 'e' * 24
VERSION = 'f' * 24


def seed_native_assembly(root, character_id, source_dir=None):
    factory = AvatarFactory(root)
    job = factory.directory(1, JOB)
    directory = job / 'native-parts' / VERSION
    directory.mkdir(parents=True)
    if source_dir:
        source = Path(source_dir)
        record = json.loads((source / 'record.json').read_text(encoding='utf-8'))
        for name in record['files']:
            if Path(name).name != name:
                raise ValueError('Unexpected artifact path')
            shutil.copyfile(source / name, directory / name)
            assert digest(directory / name) == record['files'][name]
    else:
        doc, binary = parse_glb(animated_fixture(), strict=True)
        animation = doc['animations'][0]
        doc['animations'] = [{**copy.deepcopy(animation), 'name': name} for name in ('idle', 'walk', 'run', 'jump', 'sit', 'fall')]
        parts = []
        for slot in ('body', *SLOTS):
            part = copy.deepcopy(doc)
            objects = []
            for i, node in enumerate(part['nodes']):
                if 'mesh' in node:
                    node['name'] = f'{slot}_{i}'
                    node['extras'] = {'standard_slot': slot, 'part_role': slot}
                    objects.append(node['name'])
            (directory / f'{slot}.glb').write_bytes(build_glb(part, binary))
            parts.append({'slot': slot, 'objects': objects})
        (directory / 'model.glb').write_bytes((directory / 'body.glb').read_bytes())
        record = {'status': 'review_required', 'result': {'parts': parts, 'bone_count': 1, 'visual_review': 'required'},
                  'files': {p.name: digest(p) for p in directory.glob('*.glb')}}
    _write_json(directory / 'record.json', record)
    _write_json(job / 'native-parts/current.json', {'version': VERSION})
    (job / 'output').mkdir()
    shutil.copyfile(directory / 'body.glb', job / 'output/generated-body.glb')
    _write_json(job / 'job.json', {
        'id': JOB, 'character_id': character_id, 'character_name': '조립 캐릭터 검증',
        'created_at': '2026-09-18T00:00:00+00:00', 'status': 'review_required', 'input_kind': 'image',
        'production_mode': 'character_parts', 'source_sha256': record['files']['body.glb'],
        'profile': {'name': 'Native assembly', 'rig': 'meshy-native'},
        'parts': [{'slot': slot, 'image_status': 'succeeded', 'model_status': 'ready'} for slot in ('body', *SLOTS)],
        'files': {'generated-body.glb': record['files']['body.glb']},
    })
    return factory, directory
