"""Local, topology-preserving head variants derived from sealed expression bodies."""
from copy import deepcopy
import hashlib
import json
import os
import struct

from src.services.asset_delivery import inspect_glb
from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, digest
from src.services.avatar_native_parts import AvatarNativeParts
from src.services.avatar_expression_bake import _accessor
from src.services.character_pipeline import PipelineError, now, read_json
from src.services.character_segmentation import triangle_indices
from src.services.glb import build_glb, parse_glb


RECIPE = 'expression-head-split-v1'


def _rig_signature(doc):
    structural = ('name', 'children', 'translation', 'rotation', 'scale', 'matrix')
    value = {
        'nodes': [{key: node[key] for key in structural if key in node} for node in doc.get('nodes', [])],
        'skins': doc.get('skins', []), 'animations': doc.get('animations', []),
    }
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _head_joint_ids(doc, node):
    if 'skin' not in node:
        return set()
    skin = doc.get('skins', [])[node['skin']]
    return {local for local, joint in enumerate(skin.get('joints', []))
            if doc['nodes'][joint].get('name', '').lower().split(':')[-1] == 'head'}


def _append_indices(doc, binary, values):
    binary.extend(b'\0' * (-len(binary) % 4))
    offset = len(binary)
    binary.extend(struct.pack('<' + 'I' * len(values), *values))
    doc.setdefault('bufferViews', []).append({
        'buffer': 0, 'byteOffset': offset, 'byteLength': len(values) * 4, 'target': 34963})
    doc.setdefault('accessors', []).append({
        'bufferView': len(doc['bufferViews']) - 1, 'componentType': 5125,
        'count': len(values), 'type': 'SCALAR'})
    return len(doc['accessors']) - 1


def _split_plan(doc, binary):
    plan, total, head, mask = {}, 0, 0, []
    for node_index, node in enumerate(doc.get('nodes', [])):
        if 'mesh' not in node:
            continue
        head_ids = _head_joint_ids(doc, node)
        primitives = doc['meshes'][node['mesh']].get('primitives', [])
        for primitive_index, primitive in enumerate(primitives):
            if primitive.get('mode', 4) != 4:
                raise PipelineError('unsupported_head_source', '머리 분리는 삼각형 GLB에서만 가능합니다.', 409)
            triangles = triangle_indices(doc, binary, primitive)
            attrs = primitive.get('attributes', {})
            material = primitive.get('material')
            underlayer = (material is not None and
                          doc.get('materials', [])[material].get('extras', {}).get('base_underlayer'))
            selected = [False] * len(triangles)
            if head_ids and not underlayer and {'JOINTS_0', 'WEIGHTS_0'} <= set(attrs):
                joints = _accessor(doc, binary, attrs['JOINTS_0'])
                weights = _accessor(doc, binary, attrs['WEIGHTS_0'])
                influence = [sum(weight for joint, weight in zip(js, ws) if int(joint) in head_ids)
                             for js, ws in zip(joints, weights)]
                selected = [all(influence[index] > .5 for index in triangle) for triangle in triangles]
            plan[(node_index, primitive_index)] = {
                'triangles': triangles, 'head': selected,
                'indices': [index for triangle in triangles for index in triangle],
                'joints': _accessor(doc, binary, attrs['JOINTS_0']) if 'JOINTS_0' in attrs else None,
                'weights': _accessor(doc, binary, attrs['WEIGHTS_0']) if 'WEIGHTS_0' in attrs else None,
            }
            total += len(triangles)
            head += sum(selected)
            mask.extend('1' if value else '0' for value in selected)
    if not total or not head or head == total:
        raise PipelineError('head_split_empty', 'Head 관절 기반 머리와 몸 삼각형을 모두 찾을 수 없습니다.', 409)
    return plan, {'source_triangles': total, 'head_triangles': head, 'body_triangles': total-head,
                  'mask_sha256': hashlib.sha256(''.join(mask).encode()).hexdigest()}


def _verify_topology(doc, binary, source_doc, source_binary, plan):
    if len(doc.get('nodes', [])) != len(source_doc.get('nodes', [])):
        raise PipelineError('expression_topology_changed', '표정 몸의 노드 구성이 기준 몸과 다릅니다.', 409)
    structural = ('name', 'children', 'translation', 'rotation', 'scale', 'matrix')
    if (doc.get('skins') != source_doc.get('skins')
            or doc.get('animations') != source_doc.get('animations')
            or any(any(node.get(key) != source_doc['nodes'][index].get(key) for key in structural)
                   for index, node in enumerate(doc['nodes']))):
        raise PipelineError('expression_rig_changed', '표정 몸의 골격·동작·월드 프레임이 기준 몸과 다릅니다.', 409)
    for (node_index, primitive_index), expected in plan.items():
        node, source_node = doc['nodes'][node_index], source_doc['nodes'][node_index]
        if (node.get('name'), node.get('mesh'), node.get('skin')) != (source_node.get('name'), source_node.get('mesh'), source_node.get('skin')):
            raise PipelineError('expression_topology_changed', '표정 몸의 스킨 노드가 기준 몸과 다릅니다.', 409)
        try:
            primitive = doc['meshes'][node['mesh']]['primitives'][primitive_index]
        except (KeyError, IndexError, TypeError):
            raise PipelineError('expression_topology_changed', '표정 몸의 메시 구성이 기준 몸과 다릅니다.', 409) from None
        attrs = primitive.get('attributes', {})
        indices = [index for triangle in triangle_indices(doc, binary, primitive) for index in triangle]
        joints = _accessor(doc, binary, attrs['JOINTS_0']) if 'JOINTS_0' in attrs else None
        weights = _accessor(doc, binary, attrs['WEIGHTS_0']) if 'WEIGHTS_0' in attrs else None
        if indices != expected['indices'] or joints != expected['joints'] or weights != expected['weights']:
            raise PipelineError('expression_topology_changed', '표정 몸의 UV·스킨·삼각형 계보가 기준 몸과 다릅니다.', 409)


def _derive(content, plan, *, keep_head, role):
    doc, source_binary = parse_glb(content, strict=True)
    binary = bytearray(source_binary)
    original_meshes = doc['meshes']
    for node_index, node in enumerate(doc.get('nodes', [])):
        if 'mesh' not in node:
            continue
        source_mesh = original_meshes[node['mesh']]
        primitives = []
        for primitive_index, primitive in enumerate(source_mesh.get('primitives', [])):
            item = plan[(node_index, primitive_index)]
            values = [index for triangle, selected in zip(item['triangles'], item['head'])
                      if selected == keep_head for index in triangle]
            if not values:
                continue
            target = deepcopy(primitive)
            target['indices'] = _append_indices(doc, binary, values)
            primitives.append(target)
        if primitives:
            doc['meshes'].append({**deepcopy(source_mesh), 'primitives': primitives})
            node['mesh'] = len(doc['meshes']) - 1
            node.setdefault('extras', {}).update(standard_slot=role, part_role=role)
        else:
            node.pop('mesh', None); node.pop('skin', None); node.pop('weights', None)
    used = sorted({node['mesh'] for node in doc.get('nodes', []) if 'mesh' in node})
    remap = {old: new for new, old in enumerate(used)}
    doc['meshes'] = [doc['meshes'][old] for old in used]
    for node in doc.get('nodes', []):
        if 'mesh' in node:
            node['mesh'] = remap[node['mesh']]
    for animation in doc.get('animations', []):
        for channel in animation.get('channels', []):
            if channel.get('target', {}).get('path') == 'weights' and 'mesh' not in doc['nodes'][channel['target']['node']]:
                raise PipelineError('unsupported_head_animation', '분리 대상 메시의 morph 애니메이션을 보존할 수 없습니다.', 409)
    doc['buffers'][0]['byteLength'] = len(binary)
    doc.setdefault('extras', {})['expression_head_split'] = {'recipe': RECIPE, 'part_role': role}
    result = build_glb(doc, bytes(binary))
    quality = inspect_glb(result, budget_warnings=True)
    if quality['errors']:
        raise PipelineError('invalid_head_split', '머리 분리 GLB 검증 실패: ' + '; '.join(quality['errors']), 409)
    return result, quality['metrics']


class AvatarExpressionHeads:
    def __init__(self, factory, owner, job, version):
        self.factory, self.owner, self.job, self.version = factory, owner, job, version
        self.native = AvatarNativeParts(factory).artifact(owner, job, version, 'body.glb')
        self.expression_root = self.native.parent/'expressions'
        self.root = self.native.parent/'expression-heads'

    def _record(self):
        return read_json(self.root/'record.json')

    def _artifact(self, name, expected):
        path = self.root/name
        return path.is_file() and digest(path) == expected

    def public(self):
        record = self._record()
        if not record:
            return None
        body = record.get('body_without_head', {})
        base = record.get('base_head', {})
        if not self._artifact(body.get('name', ''), body.get('sha256')) or not self._artifact(base.get('name', ''), base.get('sha256')):
            return None
        prefix = f'/api/studio/bodies/{self.job}/{self.version}/expression-heads'
        expressions = {}
        for expression_id, item in record.get('expressions', {}).items():
            if not self._artifact(item.get('name', ''), item.get('sha256')):
                return None
            expressions[expression_id] = {**item, 'url': f'{prefix}/{expression_id}/head.glb'}
        return {
            'body_without_head': {**body, 'url': f'{prefix}/body-without-head.glb'},
            'base_head': {**base, 'url': f'{prefix}/base-head.glb'},
            'expressions': expressions,
            'recipe': record.get('recipe'), 'created_at': record.get('created_at'),
        }

    def decorate(self, listing):
        public = self.public()
        if not public:
            return listing
        listing['body_without_head'] = public['body_without_head']
        listing['base_head'] = public['base_head']
        for item in listing.get('items', []):
            if item['id'] in public['expressions']:
                item['head'] = public['expressions'][item['id']]
        return listing

    def derive(self):
        if not os.getenv('ASSET_S3_BUCKET', '').strip():
            raise PipelineError('storage_required', 'S3 저장소 설정이 필요합니다.', 503)
        body_content = self.native.read_bytes()
        body_sha = hashlib.sha256(body_content).hexdigest()
        expression_sources = {}
        for path in sorted(self.expression_root.glob('*/record.json')):
            record = read_json(path)
            expression_id = path.parent.name
            expected = record.get('files', {}).get('body.glb')
            model = path.parent/'body.glb'
            if not expected or not model.is_file() or digest(model) != expected:
                raise PipelineError('expression_changed', '저장된 표정 몸 파일이 변경되었습니다.', 409)
            expression_sources[expression_id] = {'path': model, 'sha256': expected}
        identity = {'recipe': RECIPE, 'body_sha256': body_sha,
                    'expressions': {key: value['sha256'] for key, value in expression_sources.items()}}
        fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        with _LOCK:
            existing = self._record()
            if existing.get('fingerprint') == fingerprint and self.public():
                return self.public()
            source_doc, source_binary = parse_glb(body_content, strict=True)
            plan, counts = _split_plan(source_doc, source_binary)
            rig_sha = _rig_signature(source_doc)
            source_quality = inspect_glb(body_content, budget_warnings=True)
            if source_quality['errors']:
                raise PipelineError('invalid_body', '기준 몸 GLB가 올바르지 않습니다.', 409)
            source_quality = source_quality['metrics']
            body_without_head, body_quality = _derive(body_content, plan, keep_head=False, role='bodyWithoutHead')
            base_head, base_quality = _derive(body_content, plan, keep_head=True, role='faceHead')
            for quality, triangles in ((body_quality, counts['body_triangles']),
                                       (base_quality, counts['head_triangles'])):
                if (quality['triangles'] != triangles or quality['joints'] != source_quality['joints']
                        or quality['animations'] != source_quality['animations']):
                    raise PipelineError('head_split_rig_changed', '머리 분리 중 골격·동작 또는 삼각형 수가 변경되었습니다.', 409)
            if (_rig_signature(parse_glb(body_without_head, strict=True)[0]) != rig_sha
                    or _rig_signature(parse_glb(base_head, strict=True)[0]) != rig_sha):
                raise PipelineError('head_split_frame_changed', '머리 분리 중 골격 rest frame이 변경되었습니다.', 409)
            heads = {}
            for expression_id, source in expression_sources.items():
                content = source['path'].read_bytes()
                doc, binary = parse_glb(content, strict=True)
                _verify_topology(doc, binary, source_doc, source_binary, plan)
                head, quality = _derive(content, plan, keep_head=True, role='faceHead')
                if (quality['triangles'] != counts['head_triangles']
                        or quality['joints'] != source_quality['joints']
                        or quality['animations'] != source_quality['animations']):
                    raise PipelineError('head_split_rig_changed', '표정 머리 분리 중 골격·동작 또는 삼각형 수가 변경되었습니다.', 409)
                if _rig_signature(parse_glb(head, strict=True)[0]) != rig_sha:
                    raise PipelineError('head_split_frame_changed', '표정 머리 분리 중 골격 rest frame이 변경되었습니다.', 409)
                name = f'{expression_id}-head.glb'
                (self.root/name).parent.mkdir(parents=True, exist_ok=True)
                (self.root/name).write_bytes(head)
                heads[expression_id] = {'name': name, 'sha256': hashlib.sha256(head).hexdigest(),
                                        'source_body_sha256': source['sha256'],
                                        'triangles': quality['triangles'], 'bones': len(quality['joints'])}
            self.root.mkdir(parents=True, exist_ok=True)
            (self.root/'body-without-head.glb').write_bytes(body_without_head)
            (self.root/'base-head.glb').write_bytes(base_head)
            record = {**identity, 'fingerprint': fingerprint, 'created_at': now(), 'counts': counts,
                      'rig_sha256': rig_sha,
                      'body_without_head': {'name': 'body-without-head.glb',
                          'sha256': hashlib.sha256(body_without_head).hexdigest(),
                          'source_body_sha256': body_sha, 'triangles': body_quality['triangles'],
                          'bones': len(body_quality['joints'])},
                      'base_head': {'name': 'base-head.glb', 'sha256': hashlib.sha256(base_head).hexdigest(),
                          'source_body_sha256': body_sha, 'triangles': base_quality['triangles'],
                          'bones': len(base_quality['joints'])},
                      'expressions': heads}
            if counts['head_triangles'] + counts['body_triangles'] != counts['source_triangles']:
                raise PipelineError('head_split_incomplete', '머리와 몸 삼각형 보완집합이 완전하지 않습니다.', 409)
            _write_json(self.root/'record.json', record)
        return self.public()

    def artifact(self, expression_id, name):
        public = self.public()
        if not public:
            raise PipelineError('not_found', '머리 분리 파일을 찾을 수 없습니다.', 404)
        if expression_id is None and name in ('body-without-head.glb', 'base-head.glb'):
            item = public['body_without_head' if name == 'body-without-head.glb' else 'base_head']
        elif expression_id in public['expressions'] and name == 'head.glb':
            item = public['expressions'][expression_id]
        else:
            raise PipelineError('not_found', '머리 분리 파일을 찾을 수 없습니다.', 404)
        return self.root/item['name']
