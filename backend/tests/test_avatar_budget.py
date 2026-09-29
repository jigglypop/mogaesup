import io

from PIL import Image

from api.test_characters import rigged_glb
from src.services.asset_delivery import DeliveryPolicy, inspect_glb
from src.services.glb import parse_glb, build_glb


def textured_fixture():
    doc, binary = parse_glb(rigged_glb(), strict=True)
    stream = io.BytesIO(); Image.new('RGB', (8, 8), 'blue').save(stream, format='PNG')
    raw = stream.getvalue()
    doc['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(raw)})
    doc['images'] = [{'bufferView': len(doc['bufferViews'])-1, 'mimeType': 'image/png'}]
    doc['textures'] = [{'source': 0}]
    doc['buffers'][0]['byteLength'] = len(binary)+len(raw)
    return doc, binary+raw


def test_factory_budgets_warn_but_structural_validation_still_rejects():
    doc, binary = textured_fixture(); content = build_glb(doc, binary)
    policy = DeliveryPolicy(max_file_bytes=1, max_texture_pixels=1, max_vertices=1)
    assert inspect_glb(content, policy)['errors'] == ['file size budget exceeded']
    report = inspect_glb(content, policy, budget_warnings=True)
    assert report['errors'] == [] and report['status'] == 'review_required'
    assert set(report['warnings']) == {'file size budget exceeded', 'texture budget exceeded', 'vertices budget exceeded'}
    assert report['metrics']['texture_pixels'] == 64
    doc['skins'][0]['joints'] = [9999]
    rejected = inspect_glb(build_glb(doc, binary), policy, budget_warnings=True)
    assert rejected['errors'] and rejected['status'] == 'rejected'
