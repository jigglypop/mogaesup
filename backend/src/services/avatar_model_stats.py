"""Read-only GLB statistics from the JSON chunk, without loading binary geometry."""
from collections import Counter, OrderedDict
from copy import deepcopy
import json
import re
import struct
from threading import RLock

from src.services.character_pipeline import PipelineError, read_json
from src.services.object_storage import read_byte_range

_cache = OrderedDict()
_lock = RLock()


def _geometry(doc):
    accessors, meshes, nodes = (doc.get(key, []) for key in ('accessors', 'meshes', 'nodes'))

    def item(values, index):
        if type(index) is not int or not 0 <= index < len(values):
            raise ValueError('Invalid GLB index')
        return values[index]

    def count(index):
        value = item(accessors, index)['count']
        if type(value) is not int or value < 0:
            raise ValueError('Invalid accessor count')
        return value

    scenes = doc.get('scenes', [])
    children = {child for node in nodes for child in node.get('children', [])}
    roots = item(scenes, doc.get('scene', 0)).get('nodes', []) if scenes else [i for i in range(len(nodes)) if i not in children]
    pending = list(roots)
    seen = set()
    instances = Counter()
    joints = set()
    while pending:
        index = pending.pop()
        if index in seen:
            raise ValueError('Repeated scene node')
        seen.add(index)
        node = item(nodes, index)
        pending.extend(node.get('children', []))
        if 'mesh' in node:
            attributes = node.get('extensions', {}).get('EXT_mesh_gpu_instancing', {}).get('attributes', {})
            copies = count(next(iter(attributes.values()))) if attributes else 1
            instances[node['mesh']] += copies
            if 'skin' in node:
                joints.update(item(doc.get('skins', []), node['skin']).get('joints', []))
    triangles = vertices = primitives = other_primitives = 0
    materials = set()
    for index, copies in instances.items():
        positions = set()
        for primitive in item(meshes, index).get('primitives', []):
            position = primitive['attributes']['POSITION']
            positions.add(position)
            elements = count(primitive['indices']) if 'indices' in primitive else count(position)
            mode = primitive.get('mode', 4)
            if mode == 4:
                if elements % 3:
                    raise ValueError('Invalid triangle indices')
                triangles += elements // 3 * copies
            elif mode in (5, 6):
                triangles += max(0, elements - 2) * copies
            elif mode in (0, 1, 2, 3):
                other_primitives += copies
            else:
                raise ValueError('Unsupported primitive mode')
            primitives += copies
            materials.add(primitive.get('material'))
        vertices += sum(count(position) for position in positions) * copies
    return {'triangles': triangles, 'vertices': vertices, 'meshes': sum(instances.values()),
            'primitives': primitives, 'materials': len(materials), 'bones': len(joints),
            'texture_images': len(doc.get('images', [])), 'animations': len(doc.get('animations', [])),
            'non_triangle_primitives': other_primitives}


def model_stats(factory, owner, job_id, name, version=None):
    directory = factory.directory(owner, job_id)
    if not re.fullmatch(r'[a-zA-Z0-9_-]+\.glb', name):
        raise PipelineError('not_found', 'GLB 파일을 찾을 수 없습니다.', 404)
    if version:
        if not re.fullmatch(r'[a-f0-9]{24}', version):
            raise PipelineError('not_found', '조립 버전을 찾을 수 없습니다.', 404)
        record = read_json(directory/'native-parts'/version/'record.json')
        path = directory/'native-parts'/version/name
    else:
        record = read_json(directory/'job.json')
        path = directory/'output'/name
    expected = record.get('files', {}).get(name)
    if not expected:
        raise PipelineError('not_found', '저장된 GLB 기록을 찾을 수 없습니다.', 404)
    try:
        header, size, etag, checksum = read_byte_range(path, 0, 20)
        if checksum and checksum != expected:
            raise ValueError('Stored model differs from its receipt')
        key = (str(path), expected, etag)
        with _lock:
            if key in _cache:
                _cache.move_to_end(key)
                return deepcopy(_cache[key])
        magic, version_number, declared_size, json_size, chunk_type = struct.unpack('<4sIIII', header)
        if magic != b'glTF' or version_number != 2 or declared_size != size or chunk_type != 0x4e4f534a or not 0 < json_size <= min(size - 20, 4 * 1024 * 1024):
            raise ValueError('Invalid GLB JSON header')
        payload, _, _, _ = read_byte_range(path, 20, json_size, etag=etag)
        result = {**_geometry(json.loads(payload)), 'file_bytes': size, 'name': name, 'source': 'glb_json',
                  'expected_sha256': expected, 'version': version}
        with _lock:
            _cache[key] = result
            if len(_cache) > 256:
                _cache.popitem(last=False)
        return deepcopy(result)
    except (ValueError, TypeError, KeyError, IndexError, struct.error, RecursionError) as exc:
        raise PipelineError('model_stats_unavailable', 'GLB 구조 정보를 읽을 수 없습니다.', 422) from exc
