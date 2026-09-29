"""Image-first paper-doll blueprints. Layer design precedes any 3D submission."""
from copy import deepcopy
import hashlib
import io
import json
import math
import os
from src.services.object_storage import StoredPath as Path
import re
from threading import RLock
import uuid

from PIL import Image

from src.paths import BACKEND_ROOT
from src.services.asset_editor import _write_json
from src.services.character_pipeline import CharacterPipeline, PipelineError, read_json, now
from src.services.avatar_equipment import EQUIPMENT, equipment_layer

LOCK = RLock()
SLOTS = ['body', 'face', 'hairBack', 'hairFront', 'hat', 'top', 'bottom', 'shoes']
LEGACY_SLOTS = SLOTS[:]
SLOTS += list(EQUIPMENT)
ORDER = ['hairBack', 'body', 'shoes', 'bottom', 'top', 'face', 'hairFront', 'hat']
LABELS = ['공통 몸', '얼굴', '뒷머리', '앞머리', '머리 장식', '상의', '하의', '신발']
PLACEMENTS = [[116, 45, 280, 430], [131, 45, 250, 226], [75, 38, 362, 366], [92, 40, 328, 278],
              [65, 4, 382, 267], [94, 278, 324, 146], [168, 363, 176, 98], [186, 423, 140, 91]]
# Actual atlas regions, retained as editable design data. The original bitmap is immutable.
RECTS = [[0, 0, .25, .56], [.25, 0, .25, .56], [.50, 0, .25, .56], [.75, 0, .25, .56],
         [0, .56, .262, .44], [.262, .56, .25, .44], [.512, .56, .238, .44], [.75, .56, .25, .44]]
PROMPT = '''Design an eight-part modular paper-doll atlas from the reference character.
Use a 4 column by 2 row grid, transparent background, no text or grid lines.
Top row: 1 complete common SD body mannequin in an opaque plain bodysuit, bald and blank face;
2 complete round head with the reference eyes and mouth, without hair or hat;
3 complete back hair including the hidden crown; 4 front hair and bangs, transparent face opening.
Bottom row: 5 original head accessory (headband, bow, hair ornament or hat), preserving its actual type and open spaces, without head or hair; 6 top with complete collar, sleeves and waist,
without hands or skirt; 7 bottom with a complete waistband and opaque inner shorts, without legs;
8 shoes pair with complete hidden tops, without legs.
Use the SAME approximately 1.6-head-tall front A-pose template for every character. Preserve the reference
identity, colors and clothing. Finish the shapes hidden by other pieces; do not merely crop visible fragments.
Keep neck, shoulder, wrist, waist and ankle connection positions consistent. Provide generous hidden overlap.
Each part is separate. No combined character. Parts are design candidates for review before 3D generation.'''


class AvatarBlueprints:
    def __init__(self, root):
        self.data = Path(root).resolve(); self.root = self.data/'avatar-blueprints'
        self.pipeline = CharacterPipeline(self.data)

    def directory(self, owner, character_id):
        self.pipeline.entry(character_id, owner)
        return self.root/str(int(owner))/character_id

    def read(self, owner, character_id):
        directory = self.directory(owner, character_id)
        character = self.pipeline.detail(character_id, owner)
        saved = read_json(directory/'blueprint.json').get('current')
        source_hash = hashlib.sha256(self.pipeline.artifact(character_id, owner, 'reference').read_bytes()).hexdigest() if any(a['id'] == 'reference' for a in character['artifacts']) else None
        if saved:
            saved = deepcopy(saved)
            existing = {layer['slot'] for layer in saved['layers']}
            saved['layers'] += [equipment_layer(slot, 8+i) for i, slot in enumerate(EQUIPMENT) if slot not in existing]
            return {**saved, 'source_sha256': source_hash}
        provenance = read_json(BACKEND_ROOT/'assets/avatars/image-design/provenance.json')
        reference_path = self.pipeline.artifact(character_id, owner, 'reference') if any(a['id'] == 'reference' for a in character['artifacts']) else None
        is_sample = owner == 1 and reference_path and hashlib.sha256(reference_path.read_bytes()).hexdigest() == provenance.get('source_sha256')
        layers = []
        for i, slot in enumerate(LEGACY_SLOTS):
            available = is_sample or (owner == 1 and slot == 'body')
            layers.append({'slot': slot, 'label': LABELS[i], 'asset': 'sample-A-atlas' if available else None,
                           'crop': RECTS[i], 'placement': PLACEMENTS[i], 'visible': True, 'opacity': 1., 'order': ORDER.index(slot),
                           'background': 'border-gray', 'status': 'design_candidate' if available else 'needs_image'})
        layers += [equipment_layer(slot, 8+i) for i, slot in enumerate(EQUIPMENT)]
        reference = next((a for a in character['artifacts'] if a['id'] == 'reference'), None)
        return {'revision': '0', 'character_id': character_id, 'source_sha256': source_hash, 'source_url': reference['url'] if reference else None,
                'profile': 'maple-paper-doll-v1', 'canvas': [512, 512], 'layers': layers,
                'anchors': {'head': [256, 155], 'neck': [256, 276], 'shoulderL': [326, 295], 'shoulderR': [186, 295],
                            'wristL': [365, 344], 'wristR': [147, 344], 'waist': [256, 369], 'ankleL': [289, 447], 'ankleR': [223, 447]},
                'overlap': {'neck': 12, 'wrist': 10, 'waist': 18, 'ankle': 12},
                'generation': None, 'visual_approval': 'pending', 'three_d_status': 'not_submitted'}

    def asset(self, owner, asset_id):
        if asset_id == 'sample-A-atlas':
            if owner != 1:
                raise PipelineError('not_found', '이미지 파츠를 찾을 수 없습니다.', 404)
            return BACKEND_ROOT/'assets/avatars/image-design/A-atlas-v1.png'
        if not re.fullmatch(r'[a-f0-9]{64}', asset_id):
            raise PipelineError('not_found', '이미지 파츠를 찾을 수 없습니다.', 404)
        path = self.root/str(int(owner))/'assets'/f'{asset_id}.png'
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != asset_id:
            raise PipelineError('not_found', '이미지 파츠를 찾을 수 없습니다.', 404)
        return path

    def upload(self, owner, content):
        if not os.getenv('ASSET_S3_BUCKET', '').strip():
            raise PipelineError('storage_required', 'S3 저장소 설정이 필요합니다.', 503)
        if len(content) > 32*1024*1024:
            raise PipelineError('image_too_large', '이미지는 32MB 이하로 올려 주세요.', 422)
        try:
            with Image.open(io.BytesIO(content)) as image:
                if image.format != 'PNG' or image.width*image.height > 32_000_000:
                    raise ValueError('PNG required')
                size = image.size; alpha = image.mode in ('RGBA', 'LA') or 'transparency' in image.info
                image.verify()
        except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
            raise PipelineError('invalid_image', '유효한 PNG 파츠 이미지를 선택하세요.', 422) from exc
        asset_id = hashlib.sha256(content).hexdigest(); path = self.root/str(int(owner))/'assets'/f'{asset_id}.png'
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_bytes(content)
        return {'id': asset_id, 'width': size[0], 'height': size[1], 'alpha': alpha}

    def save(self, owner, character_id, layers, revision, key):
        directory = self.directory(owner, character_id)
        if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}', key):
            raise PipelineError('invalid_key', '저장 요청 식별자가 필요합니다.', 422)
        slots = {layer['slot'] for layer in layers}
        if len(slots) != len(layers) or slots not in (set(LEGACY_SLOTS), set(SLOTS)):
            raise PipelineError('invalid_layers', '몸·의상·장비 공통 슬롯을 유지해 주세요.', 422)
        for layer in layers:
            if layer['asset']:
                self.asset(owner, layer['asset'])
            x, y, w, h = layer['crop']
            if x < 0 or y < 0 or w <= 0 or h <= 0 or x+w > 1.00001 or y+h > 1.00001:
                raise PipelineError('invalid_crop', '잘라낼 영역이 이미지 밖에 있습니다.', 422)
            x, y, w, h = layer['placement']
            if not all(math.isfinite(v) for v in (*layer['crop'], x, y, w, h)) or not (-512 <= x <= 1024 and -512 <= y <= 1024 and 1 <= w <= 1024 and 1 <= h <= 1024):
                raise PipelineError('invalid_placement', '파츠 위치 또는 크기가 허용 범위를 벗어났습니다.', 422)
        fingerprint = hashlib.sha256(json.dumps([layers, revision], sort_keys=True).encode()).hexdigest()
        with LOCK:
            journal = read_json(directory/'blueprint.json'); receipt = journal.get('receipts', {}).get(key)
            if receipt:
                if receipt['fingerprint'] != fingerprint:
                    raise PipelineError('idempotency_conflict', '같은 요청에 다른 설계가 있습니다.')
                return receipt['response']
            current = self.read(owner, character_id)
            if current['revision'] != revision:
                raise PipelineError('revision_conflict', '더 최근 설계가 있습니다. 다시 불러오세요.')
            layers = deepcopy(layers) + [layer for layer in current['layers'] if layer['slot'] not in slots]
            current.update(layers=layers, revision=uuid.uuid4().hex, updated_at=now(), visual_approval='pending')
            receipts = journal.get('receipts', {}); receipts[key] = {'fingerprint': fingerprint, 'response': deepcopy(current)}
            directory.mkdir(parents=True, exist_ok=True)
            _write_json(directory/'blueprint.json', {'current': current, 'receipts': dict(list(receipts.items())[-64:])})
            return current

    def recipe(self, owner, character_id):
        result = deepcopy(self.read(owner, character_id))
        result['pipeline'] = ['image_parts', 'hidden_shape_completion', 'overlay_review', 'per_part_3d', 'canonical_weight_transfer', 'glb_runtime']
        result['generation_prompt'] = PROMPT
        result['equipment'] = deepcopy(EQUIPMENT)
        result['generation_gate'] = 'Review transparent, complete per-part silhouettes and front/side/back references before submitting 3D jobs.'
        return result
