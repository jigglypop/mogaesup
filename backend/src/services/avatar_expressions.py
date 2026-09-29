"""UV expression textures and GLB derivatives bound to an exact saved body."""
import base64
from copy import deepcopy
import hashlib
import io
import json
import os
import re

from PIL import Image
from src.services.asset_delivery import inspect_glb
from src.services.asset_editor import _write_json
from src.services.avatar_factory import _LOCK, digest
from src.services.avatar_native_parts import AvatarNativeParts
from src.services.character_pipeline import PipelineError, read_json, now
from src.services.glb import parse_glb, build_glb
from src.services.avatar_expression_bake import bake_expression, _texture_image, MAX_EXPRESSION_TEXTURE_EDGE


COMPOSITION = 'body-albedo-face-overlay-v1'


def _skin_material(material):
    """An old emissive face must not wash out the composited base color."""
    material.pop('emissiveTexture', None)
    material['emissiveFactor'] = [0, 0, 0]
    pbr = material.setdefault('pbrMetallicRoughness', {})
    pbr['metallicFactor'] = 0
    pbr['roughnessFactor'] = .85
    return pbr


def _albedo_sha256(doc, binary, material_index):
    info = doc['materials'][material_index].get('pbrMetallicRoughness', {}).get('baseColorTexture')
    if info is None:
        return None
    texture = doc['textures'][info['index']]
    source = texture.get('source')
    if source is None:
        source = texture.get('extensions', {}).get('KHR_texture_basisu', {}).get('source')
    if source is None:
        return None
    image = doc['images'][source]
    if 'bufferView' in image:
        view = doc['bufferViews'][image['bufferView']]
        start = view.get('byteOffset', 0)
        raw = binary[start:start+view['byteLength']]
    elif image.get('uri', '').startswith('data:'):
        raw = base64.b64decode(image['uri'].split(',', 1)[1])
    else:
        return None
    return hashlib.sha256(raw).hexdigest()


def expression_material_targets(body_doc, body_binary, full_doc, full_binary, indices):
    """Map surviving body materials; covered primitives exist only in body.glb."""
    body_nodes = {node.get('name'): node for node in body_doc.get('nodes', [])
                  if node.get('name', '').startswith('body_') and 'mesh' in node}
    full_nodes = {node.get('name'): node for node in full_doc.get('nodes', [])
                  if node.get('name', '').startswith('body_') and 'mesh' in node}
    candidates = {}
    for name, node in body_nodes.items():
        primitives = body_doc['meshes'][node['mesh']]['primitives']
        full_node = full_nodes.get(name)
        full_materials = ({p['material'] for p in full_doc['meshes'][full_node['mesh']]['primitives'] if 'material' in p}
                          if full_node else set())
        for primitive in primitives:
            if 'material' in primitive:
                candidates.setdefault(primitive['material'], set()).update(full_materials)
    mapping, omitted = {}, []
    full_hashes = {}
    for index in indices:
        material = body_doc['materials'][index]
        named = {target for target in candidates.get(index, set())
                 if full_doc['materials'][target].get('name') == material.get('name')}
        source_hash = _albedo_sha256(body_doc, body_binary, index)
        targets = set()
        for target in named:
            if target not in full_hashes:
                full_hashes[target] = _albedo_sha256(full_doc, full_binary, target)
            if source_hash and source_hash == full_hashes[target]:
                targets.add(target)
        if targets:
            mapping[index] = targets
        elif index in candidates and not named and material.get('extras', {}).get('hidden_by_slots'):
            # Unequipping still uses this atlas on body.glb. The fully dressed
            # model intentionally has no primitive on which to apply it.
            omitted.append(index)
        else:
            raise PipelineError('body_mapping_changed', '전체 캐릭터의 얼굴 재질을 찾을 수 없습니다.', 409)
    return mapping, omitted


class AvatarExpressions:
    def __init__(self, factory, owner, job, version):
        self.factory, self.owner, self.job, self.version = factory, owner, job, version
        self.body = AvatarNativeParts(factory).artifact(owner, job, version, 'body.glb')
        self.root = self.body.parent/'expressions'

    def listing(self):
        selection = read_json(self.root/'selection.json')
        selected = selection.get('expression_id')
        if selected is not None:
            # Do not expose a stale pointer if a record was removed outside this service.
            self.get(selected)
        result = {
            'items': [self.get(path.parent.name) for path in sorted(self.root.glob('*/record.json'))],
            'selected': selected,
            'revision': selection.get('revision', '0'),
        }
        return result

    def select(self, expression_id, revision=None):
        if not os.getenv('ASSET_S3_BUCKET', '').strip():
            raise PipelineError('storage_required', 'S3 저장소 설정이 필요합니다.', 503)
        if expression_id is not None:
            self.get(expression_id)
        path = self.root/'selection.json'
        with _LOCK:
            current = read_json(path)
            current_id = current.get('expression_id')
            current_revision = current.get('revision', '0')
            if expression_id == current_id:
                return {'selected': current_id, 'revision': current_revision}
            if revision is not None and revision != current_revision:
                raise PipelineError('revision_conflict', '저장된 표정 선택이 변경되었습니다. 다시 불러와 주세요.', 409)
            next_revision = hashlib.sha256(
                f'{self.owner}:{self.job}:{self.version}:{current_revision}:{expression_id}'.encode()
            ).hexdigest()
            self.root.mkdir(parents=True, exist_ok=True)
            _write_json(path, {
                'expression_id': expression_id,
                'revision': next_revision,
                'updated_at': now(),
            })
            return {'selected': expression_id, 'revision': next_revision}

    def get(self, expression_id):
        if not re.fullmatch('[a-f0-9]{24}', expression_id):
            raise PipelineError('not_found', '표정을 찾을 수 없습니다.', 404)
        record = read_json(self.root/expression_id/'record.json')
        if not record:
            raise PipelineError('not_found', '표정을 찾을 수 없습니다.', 404)
        prefix = f'/api/studio/bodies/{self.job}/{self.version}/expressions/{expression_id}'
        result = {k: v for k, v in record.items() if k != 'files'} | {
            'artifacts': [{'name': name, 'sha256': sha, 'url': f'{prefix}/{name}'} for name, sha in record['files'].items()]}
        return result

    def save(self, payload, *, face_content=None):
        if not os.getenv('ASSET_S3_BUCKET', '').strip():
            raise PipelineError('storage_required', 'S3 저장소 설정이 필요합니다.', 503)
        body_sha = digest(self.body)
        if payload['body_sha256'] != body_sha:
            raise PipelineError('body_changed', '표정을 적용한 기본 몸 버전이 다릅니다.', 409)
        maps = payload['maps']
        if not maps or len({m['material'] for m in maps}) != len(maps):
            raise PipelineError('invalid_maps', '중복되지 않은 얼굴 텍스쳐가 필요합니다.', 422)
        body_content = self.body.read_bytes()
        if inspect_glb(body_content, budget_warnings=True)['errors']:
            raise PipelineError('invalid_body', '저장된 몸 GLB가 올바르지 않습니다.', 409)
        doc, binary = parse_glb(body_content, strict=True)
        images = []
        texture_edge_max = 0
        for item in maps:
            index = item['material']
            if index < 0 or index >= len(doc.get('materials', [])):
                raise PipelineError('invalid_material', '기본 몸에 없는 재질입니다.', 422)
            try:
                raw = base64.b64decode(item['png'], validate=True)
                with Image.open(io.BytesIO(raw)) as image:
                    if image.format != 'PNG' or max(image.size) > MAX_EXPRESSION_TEXTURE_EDGE or min(image.size) < 1:
                        raise ValueError('Image bounds')
                    texture_edge_max = max(texture_edge_max, *image.size)
                    image.verify()
            except Exception:
                raise PipelineError('invalid_texture', f'표정 텍스쳐는 {MAX_EXPRESSION_TEXTURE_EDGE}px 이하 PNG여야 합니다.', 422) from None
            images.append((index, raw))
        for index, _ in images:
            previous = doc['materials'][index].get('pbrMetallicRoughness', {}).get('baseColorTexture')
            if previous is None:
                raise PipelineError('missing_uv_texture', '기본 색상 텍스처가 있는 얼굴 재질이 필요합니다.', 422)
        identity = {k: v for k, v in payload.items() if k != 'maps'} | {
            'maps': [(index, hashlib.sha256(raw).hexdigest()) for index, raw in images], 'recipe': 'uv-expression-v2-body-model'}
        expression_id = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:24]
        directory = self.root/expression_id
        with _LOCK:
            from src.services.avatar_expression_pipeline import saved_expression_valid
            existing = read_json(directory/'record.json')
            if (existing.get('composition') == COMPOSITION
                    and (face_content is None or 'face.png' in existing.get('files', {}))
                    and saved_expression_valid(self.body.parent, expression_id)):
                return self.get(expression_id)
            full_model_path = AvatarNativeParts(self.factory).artifact(self.owner, self.job, self.version, 'model.glb')
            full_doc, full_binary = parse_glb(full_model_path.read_bytes(), strict=True)
            material_map, omitted = expression_material_targets(
                doc, binary, full_doc, full_binary, [index for index, _ in images])
            directory.mkdir(parents=True, exist_ok=True)
            files, materials = {}, []
            if face_content is not None:
                (directory/'face.png').write_bytes(face_content)
                files['face.png'] = hashlib.sha256(face_content).hexdigest()
            binary = bytearray(binary)
            for index, raw in images:
                base, _, _ = _texture_image(doc, binary, index)
                output = io.BytesIO()
                base.save(output, 'PNG', optimize=True)
                base_raw, base_name = output.getvalue(), f'body-material-{index}.png'
                (directory/base_name).write_bytes(base_raw)
                files[base_name] = hashlib.sha256(base_raw).hexdigest()
                name = f'material-{index}.png'
                (directory/name).write_bytes(raw)
                files[name] = hashlib.sha256(raw).hexdigest()
                material = doc['materials'][index]
                pbr = _skin_material(material)
                previous = pbr.get('baseColorTexture')
                if previous is None:
                    raise PipelineError('missing_uv_texture', '기본 색상 텍스쳐가 있는 얼굴 재질이 필요합니다.', 422)
                previous_texture = doc['textures'][previous['index']]
                binary.extend(b'\0'*(-len(binary) % 4))
                view = len(doc['bufferViews'])
                doc['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(raw)})
                binary.extend(raw)
                source = len(doc['images'])
                doc['images'].append({'name': name, 'mimeType': 'image/png', 'bufferView': view})
                texture = len(doc['textures'])
                doc['textures'].append({'source': source, **({'sampler': previous_texture['sampler']} if 'sampler' in previous_texture else {})})
                pbr['baseColorTexture'] = {**deepcopy(previous), 'index': texture}
                materials.append({'material': index, 'file': name, 'base_file': base_name})
            doc['buffers'][0]['byteLength'] = len(binary)
            doc.setdefault('extras', {})['expression'] = {**identity, 'id': expression_id}
            model = build_glb(doc, bytes(binary))
            (directory/'body.glb').write_bytes(model)
            files['body.glb'] = hashlib.sha256(model).hexdigest()
            # Only surviving primitives receive textures in the dressed export.
            full_binary = bytearray(full_binary)
            full_materials = []
            for body_index, raw in images:
                targets = material_map.get(body_index, set())
                for full_index in sorted(targets):
                    material = full_doc['materials'][full_index]
                    pbr = _skin_material(material)
                    previous = pbr.get('baseColorTexture')
                    if previous is None:
                        raise PipelineError('missing_uv_texture', '전체 캐릭터 얼굴 재질에 기본 색상 텍스처가 없습니다.', 422)
                    previous_texture = full_doc['textures'][previous['index']]
                    full_binary.extend(b'\0'*(-len(full_binary) % 4))
                    view = len(full_doc['bufferViews'])
                    full_doc['bufferViews'].append({'buffer': 0, 'byteOffset': len(full_binary), 'byteLength': len(raw)})
                    full_binary.extend(raw)
                    source = len(full_doc['images'])
                    full_doc['images'].append({'name': f'expression-material-{body_index}.png',
                                               'mimeType': 'image/png', 'bufferView': view})
                    texture = len(full_doc['textures'])
                    full_doc['textures'].append({'source': source, **({'sampler': previous_texture['sampler']}
                                                                      if 'sampler' in previous_texture else {})})
                    pbr['baseColorTexture'] = {**deepcopy(previous), 'index': texture}
                    full_materials.append({'body_material': body_index, 'material': full_index})
            full_doc['buffers'][0]['byteLength'] = len(full_binary)
            full_doc.setdefault('extras', {})['expression'] = {**identity, 'id': expression_id}
            full_model = build_glb(full_doc, bytes(full_binary))
            (directory/'model.glb').write_bytes(full_model)
            files['model.glb'] = hashlib.sha256(full_model).hexdigest()
            manifest = {**identity, 'id': expression_id, 'materials': materials, 'created_at': now(),
                        'composition': COMPOSITION,
                        'model_materials': full_materials,
                        'model_omitted_body_materials': omitted,
                        'gpu': {'texture_edge_max': texture_edge_max, 'mipmaps': True, 'extra_draw_calls': 0}}
            _write_json(directory/'manifest.json', manifest)
            files['manifest.json'] = digest(directory/'manifest.json')
            _write_json(directory/'record.json', {**manifest, 'files': files})
        return self.get(expression_id)

    def save_generated(self, face_path, name):
        """Bake a sealed generated face into this exact body version."""
        body_content = self.body.read_bytes()
        face_content = face_path.read_bytes()
        saved = self.save({
            'body_sha256': hashlib.sha256(body_content).hexdigest(),
            'name': name,
            'layout': {'eye': .64, 'mouth': .86, 'spacing': .21, 'size': 1},
            'maps': bake_expression(body_content, face_content),
        }, face_content=face_content)
        return self.get(saved['id'])

    def save_overlay(self, asset_id, name):
        """Apply an owned, finished transparent face PNG without a provider call."""
        from src.services.avatar_blueprints import AvatarBlueprints
        path = AvatarBlueprints(self.factory.data).asset(self.owner, asset_id)
        try:
            with Image.open(io.BytesIO(path.read_bytes())) as image:
                if image.format != 'PNG' or max(image.size) > 2048:
                    raise PipelineError('invalid_expression_image', '표정 PNG는 가로·세로 2048px 이하여야 합니다.', 422)
                low, high = image.convert('RGBA').getchannel('A').getextrema()
                if low != 0 or high == 0:
                    raise PipelineError('expression_background', '그림이 있고 배경이 투명한 표정 PNG를 선택해 주세요.', 422)
        except (OSError, ValueError, Image.DecompressionBombError):
            raise PipelineError('invalid_expression_image', '표정 PNG를 읽을 수 없습니다.', 422) from None
        return self.save_generated(path, name)

    def artifact(self, expression_id, name):
        self.get(expression_id)
        record = read_json(self.root/expression_id/'record.json')
        expected = record['files'].get(name)
        path = self.root/expression_id/name
        if not expected or '/' in name or '\\' in name or digest(path) != expected:
            raise PipelineError('not_found', '표정 파일을 찾을 수 없습니다.', 404)
        return path
