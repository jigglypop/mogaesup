"""Opt-in integration check using a disposable rig fixture and real Blender."""

import json
from pathlib import Path
import struct
import tempfile
import hashlib

from api.test_characters import rigged_glb
from src.services.character_parts import separate_materials
from src.services.glb import parse_glb
from src.services.asset_delivery import inspect_glb


def material_fixture():
    doc, binary = parse_glb(rigged_glb(), strict=True)
    doc['nodes'][2]['children'] = [3]
    doc['nodes'].append({'name': 'tip', 'translation': [0, 1, 0]})
    doc['skins'][0]['joints'] = [2, 3]
    binary = binary[:36] + bytes([0, 1, 0, 0] * 3) + struct.pack('<12f', *([.5, .5, 0, 0] * 3))
    doc['nodes'][1].pop('mesh')
    doc['nodes'][1].pop('skin')
    first = doc['meshes'][0]['primitives'][0]
    first['material'] = 0
    doc['meshes'][0]['primitives'].append({**first, 'material': 1})
    doc['materials'] = [{'pbrMetallicRoughness': {'baseColorFactor': color, 'metallicFactor': 0}}
                        for color in ([.6, .3, .8, 1], [.8, .7, .9, 1])]
    encoded = json.dumps(doc).encode()
    encoded += b' ' * (-len(encoded) % 4)
    return struct.pack('<III', 0x46546C67, 2, 28 + len(encoded) + len(binary)) + struct.pack('<II', len(encoded), 0x4E4F534A) + encoded + struct.pack('<II', len(binary), 0x004E4942) + binary


if __name__ == '__main__':
    root = Path(tempfile.mkdtemp(prefix='wardrobe-blender-check-'))
    model = root / 'source.glb'
    original = material_fixture()
    model.write_bytes(original)
    output = root / 'version'
    result = separate_materials(model, output)
    quality = inspect_glb((output / 'character.glb').read_bytes())
    doc, _ = parse_glb((output / 'character.glb').read_bytes(), strict=True)
    assert not quality['errors'], quality
    assert len([node for node in doc['nodes'] if 'mesh' in node]) == 2
    assert all('skin' in node for node in doc['nodes'] if 'mesh' in node)
    assert model.read_bytes() == original
    assert (output / 'source.blend').is_file() and (output / 'rest.png').is_file()
    face_output = root / 'authored-version'
    separate_materials(model, face_output, [
        {'node_index': 0, 'primitive_index': 0, 'role': 'head', 'faces': [0]},
        {'node_index': 0, 'primitive_index': 1, 'role': 'hat', 'faces': [0]},
    ], hashlib.sha256(original).hexdigest())
    face_doc, face_binary = parse_glb((face_output / 'character.glb').read_bytes(), strict=True)
    source_doc, source_binary = parse_glb(original, strict=True)
    assert face_binary[:len(source_binary)] == source_binary
    assert face_doc['skins'] == source_doc['skins']
    assert (face_output / 'source.blend').is_file() and (face_output / 'rest.png').is_file()
    print(json.dumps({'status': 'passed', 'output': str(output), 'result': result, 'quality': quality['metrics']}))
