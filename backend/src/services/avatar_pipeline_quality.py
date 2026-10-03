"""Assembly delivery and inspection receipts. Never simplify or recolour a model."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import struct

from src.services.glb import build_glb, parse_glb

REVISION = 'assembly-quality-v1'


def digest(content):
    return hashlib.sha256(content).hexdigest()


def exported_metrics(content):
    """Export counts using only stdlib, available in Blender's isolated Python."""
    doc, binary = parse_glb(content, strict=True)
    vertices = triangles = pixels = 0
    for mesh in doc.get('meshes', []):
        for primitive in mesh.get('primitives', []):
            vertices += doc['accessors'][primitive['attributes']['POSITION']]['count']
            count = doc['accessors'][primitive.get('indices', primitive['attributes']['POSITION'])]['count']
            mode = primitive.get('mode', 4)
            triangles += count // 3 if mode == 4 else max(0, count - 2) if mode in (5, 6) else 0
    for image in doc.get('images', []):
        if 'bufferView' not in image:
            pixels = None
            break
        view = doc['bufferViews'][image['bufferView']]
        start = view.get('byteOffset', 0)
        raw = binary[start:start + view['byteLength']]
        size = None
        if raw[:8] == b'\x89PNG\r\n\x1a\n' and len(raw) >= 24:
            size = struct.unpack('>II', raw[16:24])
        elif raw[:2] == b'\xff\xd8':
            offset = 2
            while offset + 4 <= len(raw):
                if raw[offset] != 255:
                    break
                marker = raw[offset + 1]
                if marker in (0xd8, 0xd9, 0xda):
                    break
                length = int.from_bytes(raw[offset + 2:offset + 4], 'big')
                if length < 2 or offset + length + 2 > len(raw):
                    break
                if marker in (0xc0, 0xc1, 0xc2) and length >= 7:
                    h, w = struct.unpack('>HH', raw[offset + 5:offset + 9])
                    size = w, h
                    break
                offset += length + 2
        if not size:
            pixels = None
            break
        pixels += size[0] * size[1]
    return {'vertices': vertices, 'triangles': triangles, 'materials': len(doc.get('materials', [])),
            'meshes': len(doc.get('meshes', [])), 'skins': len(doc.get('skins', [])),
            'animations': [a.get('name', '') for a in doc.get('animations', [])],
            'joints': sorted({doc['nodes'][i].get('name', '') for skin in doc.get('skins', []) for i in skin['joints']}),
            'texture_pixels': pixels}


def compact_glb(content):
    """Remove unreachable/duplicate buffers, preserving every referenced accessor/image byte.

    Unknown extension data may refer to an accessor implicitly: preserve those files
    rather than guess at its references. No remeshing, quantization or image resizing.
    """
    doc, binary = parse_glb(content, strict=True)
    def extensions(value):
        if isinstance(value, dict):
            return bool(value.get('extensions')) or any(extensions(v) for v in value.values())
        return isinstance(value, list) and any(extensions(v) for v in value)
    if extensions(doc) or doc.get('extensionsRequired') or len(doc.get('buffers', [])) != 1:
        return content, 'source_preserved_extensions'
    if any('uri' in b for b in doc['buffers']) or any('uri' in i for i in doc.get('images', [])):
        raise ValueError('Assembly delivery requires embedded resources')
    used = set()
    for mesh in doc.get('meshes', []):
        for p in mesh.get('primitives', []):
            used.update(p.get('attributes', {}).values())
            if 'indices' in p:
                used.add(p['indices'])
            for target in p.get('targets', []):
                used.update(target.values())
    for skin in doc.get('skins', []):
        if 'inverseBindMatrices' in skin:
            used.add(skin['inverseBindMatrices'])
    for animation in doc.get('animations', []):
        for sampler in animation.get('samplers', []):
            used.update((sampler['input'], sampler['output']))
    accessors = doc.get('accessors', [])
    if any(type(i) is not int or not 0 <= i < len(accessors) for i in used):
        raise ValueError('Invalid delivery accessor')
    out = deepcopy(doc)
    mapping = {old: new for new, old in enumerate(sorted(used))}
    out['accessors'] = [deepcopy(accessors[i]) for i in sorted(used)]
    for mesh in out.get('meshes', []):
        for p in mesh.get('primitives', []):
            p['attributes'] = {key: mapping[i] for key, i in p.get('attributes', {}).items()}
            if 'indices' in p:
                p['indices'] = mapping[p['indices']]
            p['targets'] = [{key: mapping[i] for key, i in t.items()} for t in p['targets']] if 'targets' in p else []
            if not p['targets']:
                p.pop('targets')
    for skin in out.get('skins', []):
        if 'inverseBindMatrices' in skin:
            skin['inverseBindMatrices'] = mapping[skin['inverseBindMatrices']]
    for animation in out.get('animations', []):
        for sampler in animation.get('samplers', []):
            sampler['input'], sampler['output'] = mapping[sampler['input']], mapping[sampler['output']]
    views, view_map, dedup, packed = [], {}, {}, bytearray()
    def copy_view(index):
        if index in view_map:
            return view_map[index]
        original = doc['bufferViews'][index]
        start, length = original.get('byteOffset', 0), original['byteLength']
        if original.get('buffer', 0) != 0 or min(start, length) < 0 or start + length > len(binary):
            raise ValueError('Invalid delivery buffer view')
        raw = binary[start:start + length]
        metadata = {key: value for key, value in original.items() if key not in ('buffer', 'byteOffset')}
        key = (json.dumps(metadata, sort_keys=True, separators=(',', ':')), raw)
        if key not in dedup:
            packed.extend(b'\0' * (-len(packed) % 4))
            views.append({**deepcopy(original), 'buffer': 0, 'byteOffset': len(packed)})
            packed.extend(raw)
            dedup[key] = len(views) - 1
        view_map[index] = dedup[key]
        return view_map[index]
    for accessor in out['accessors']:
        if 'bufferView' in accessor:
            accessor['bufferView'] = copy_view(accessor['bufferView'])
        for sparse in (accessor.get('sparse') or {}).get('indices', {}), (accessor.get('sparse') or {}).get('values', {}):
            if 'bufferView' in sparse:
                sparse['bufferView'] = copy_view(sparse['bufferView'])
    for image in out.get('images', []):
        if 'bufferView' in image:
            image['bufferView'] = copy_view(image['bufferView'])
    out['bufferViews'] = views
    out['buffers'] = [{'byteLength': len(packed)}]
    result = build_glb(out, bytes(packed))
    # A derivative must not increase the download to claim compaction.
    return (result, 'lossless_buffer_compaction') if len(result) < len(content) else (content, 'source_preserved')


def seal_quality(directory, files, parts, spec, measured):
    """Inspect the actual exported files and bind all measurements to their hashes."""
    directory = Path(directory)
    checks, delivery, runtime = [], {}, {}
    for name in files:
        if not name.endswith('.glb'):
            continue
        content = (directory / name).read_bytes()
        metrics = exported_metrics(content)
        slot = name[:-4]
        raw, method = compact_glb(content)
        runtime_name = f'{slot}.runtime.glb'
        (directory / runtime_name).write_bytes(raw)
        delivery[slot] = {'artifact': runtime_name, 'sha256': digest(raw), 'source_sha256': digest(content),
                         'source_bytes': len(content), 'runtime_bytes': len(raw), 'method': method,
                         'geometry_preserved': True, 'uv_skin_animation_images_preserved': True}
        if slot == 'model':
            runtime = {**metrics, 'file_bytes': len(raw)}
    for part in parts:
        budget = part.get('runtime_budget') or {}
        if part.get('available', True) and budget.get('budget_met') is False:
            checks.append({'code': 'part_budget', 'slot': part['slot'], 'status': 'exceeded',
                           'actual': budget.get('runtime_triangles'), 'target': budget.get('target_triangles')})
    rear = measured.get('rear_coverage')
    checks.append({'code': 'rear_coverage', 'status': 'measured' if rear and rear.get('rays') else 'not_measured'})
    checks.append({'code': 'visual_review', 'status': 'required'})
    receipt = {'revision': REVISION, 'status': 'review_required', 'checks': checks,
               'rear_coverage': rear, 'parts': measured.get('parts', {}), 'runtime': runtime,
               'production_spec_sha256': spec['sha256'],
               'artifacts': {name: digest((directory / name).read_bytes()) for name in files},
               'delivery': delivery, 'visual_review': 'required'}
    (directory / 'quality.json').write_text(json.dumps(receipt, sort_keys=True, indent=2), encoding='utf8')
    return receipt, ['quality.json', *(item['artifact'] for item in delivery.values())]


def verify_quality(directory, seal, payload):
    """A new pipeline version cannot be sealed without its exact inspection/delivery receipt."""
    if payload.get('contract', {}).get('pipeline_quality_revision') != REVISION:
        return
    # The service Python owns schema/image validation; do not install its Pillow
    # or Pydantic dependencies into Blender just to run a worker.
    from src.services.asset_delivery import inspect_glb
    directory = Path(directory)
    receipt = json.loads((directory / 'quality.json').read_text(encoding='utf8'))
    result, files = seal['result'], seal['files']
    if (receipt.get('revision') != REVISION or result.get('quality') != receipt
            or result.get('delivery') != receipt.get('delivery')
            or receipt.get('production_spec_sha256') != payload['production_spec']['sha256']
            or files.get('quality.json') != digest((directory / 'quality.json').read_bytes())):
        raise ValueError('Assembly inspection receipt changed')
    if receipt.get('artifacts') != {name: sha for name, sha in files.items()
                                   if name != 'quality.json' and not name.endswith('.runtime.glb')}:
        raise ValueError('Assembly inspection does not cover these artifacts')
    for slot, item in receipt['delivery'].items():
        name = f'{slot}.runtime.glb'
        original = (directory / f'{slot}.glb').read_bytes()
        delivered = (directory / name).read_bytes()
        expected, method = compact_glb(original)
        if (item['artifact'] != name or item['source_sha256'] != files.get(f'{slot}.glb')
                or item['sha256'] != files.get(name)
                or item['sha256'] != digest(delivered) or delivered != expected
                or item.get('source_bytes') != len(original) or item.get('runtime_bytes') != len(delivered)
                or item.get('method') != method or item.get('geometry_preserved') is not True
                or item.get('uv_skin_animation_images_preserved') is not True):
            raise ValueError('Runtime delivery changed')
        source = inspect_glb(original, budget_warnings=True)
        runtime = inspect_glb(delivered, budget_warnings=True)
        if source['errors'] or runtime['errors'] or source['metrics'] != runtime['metrics']:
            raise ValueError('Runtime delivery inspection failed')
    model = receipt['delivery'].get('model')
    if not model or receipt.get('runtime') != {
            **exported_metrics((directory / 'model.glb').read_bytes()), 'file_bytes': model['runtime_bytes']}:
        raise ValueError('Assembly runtime measurements changed')
