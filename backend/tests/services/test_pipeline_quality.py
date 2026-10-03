"""Runtime delivery preserves the source model; assembly inspection cannot be bypassed."""
from copy import deepcopy
import json

import pytest

from services.test_native_hair_upload import native_fixture
from src.services.glb import build_glb, parse_glb
from src.services.native_hair_upload import _accessor, validate_native_hair
from src.services.avatar_pipeline_quality import REVISION, compact_glb, digest, seal_quality, verify_quality


def with_unused_data(content):
    doc, binary = parse_glb(content, strict=True)
    binary += b'\0' * (-len(binary) % 4)
    doc['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': 1200})
    doc['accessors'].append({'bufferView': len(doc['bufferViews']) - 1, 'count': 100, 'type': 'VEC3', 'componentType': 5126})
    binary += b'\0' * 1200
    doc['buffers'][0]['byteLength'] = len(binary)
    return build_glb(doc, binary)


def test_delivery_removes_unused_data_without_changing_mesh_skin_motion_or_texture():
    source = with_unused_data(native_fixture(texture_edge=32))
    original, ob = parse_glb(source, strict=True)
    result, method = compact_glb(source)
    doc, binary = parse_glb(result, strict=True)
    assert method == 'lossless_buffer_compaction' and len(result) < len(source) - 1000
    assert validate_native_hair(result, body_content=native_fixture(role='body'))['runtime_triangles'] == 1
    for before, after in zip(original['meshes'][0]['primitives'], doc['meshes'][0]['primitives']):
        for semantic, index in before['attributes'].items():
            assert _accessor(original, ob, index) == _accessor(doc, binary, after['attributes'][semantic])
        assert _accessor(original, ob, before['indices']) == _accessor(doc, binary, after['indices'])
    for name in ('materials', 'textures', 'nodes', 'scenes'):
        assert original[name] == doc[name]
    def image_bytes(d, b):
        v = d['bufferViews'][d['images'][0]['bufferView']]
        return b[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]
    assert image_bytes(original, ob) == image_bytes(doc, binary)


def test_unknown_extensions_preserve_the_file_instead_of_guessing_references():
    doc, binary = parse_glb(with_unused_data(native_fixture()), strict=True)
    doc['extensions'] = {'VENDOR_data': {'accessor': len(doc['accessors']) - 1}}
    source = build_glb(doc, binary)
    assert compact_glb(source) == (source, 'source_preserved_extensions')


def sealed(tmp_path):
    files = ['model.glb', 'body.glb', 'hair.glb', 'front.png', 'side.png', 'back.png', 'opposite.png', 'motion.png']
    for name in files:
        (tmp_path / name).write_bytes(with_unused_data(native_fixture()) if name.endswith('.glb') else b'preview')
    measured = {'rear_coverage': {'rays': 85, 'covered': 71, 'ratio': .8353, 'geometric_ratio': .8353}}
    receipt, extra = seal_quality(tmp_path, files, [{'slot': 'hair', 'runtime_budget': {'budget_met': False,
        'runtime_triangles': 12, 'target_triangles': 10}}], {'sha256': 'spec'}, measured)
    seal = {'files': {name: digest((tmp_path / name).read_bytes()) for name in files + extra},
            'result': {'quality': receipt, 'delivery': receipt['delivery']}}
    payload = {'contract': {'pipeline_quality_revision': REVISION}, 'production_spec': {'sha256': 'spec'}}
    return seal, payload


def test_pipeline_receipt_uses_measured_rear_and_actual_export_stats_and_never_approves_visuals(tmp_path):
    seal, payload = sealed(tmp_path)
    verify_quality(tmp_path, seal, payload)
    report = seal['result']['quality']
    assert report['runtime']['triangles'] == 1
    assert report['rear_coverage']['rays'] == 85
    assert report['visual_review'] == 'required' and report['status'] == 'review_required'
    assert any(c['code'] == 'part_budget' and c['status'] == 'exceeded' for c in report['checks'])


@pytest.mark.parametrize('change', ['receipt', 'runtime', 'preview', 'spec', 'missing'])
def test_pipeline_rejects_changed_or_missing_receipts_and_delivery(tmp_path, change):
    seal, payload = sealed(tmp_path)
    if change == 'receipt':
        seal['result']['quality'] = deepcopy(seal['result']['quality'])
        seal['result']['quality']['rear_coverage']['ratio'] = 1
    elif change == 'runtime':
        (tmp_path / 'hair.runtime.glb').write_bytes(b'changed')
    elif change == 'preview':
        seal['files']['back.png'] = 'changed'
    elif change == 'spec':
        payload['production_spec']['sha256'] = 'changed'
    else:
        (tmp_path / 'quality.json').unlink()
    with pytest.raises((ValueError, OSError)):
        verify_quality(tmp_path, seal, payload)


def test_legacy_versions_remain_readable_without_inventing_a_quality_result(tmp_path):
    verify_quality(tmp_path, {}, {'contract': {}})
    assert not (tmp_path / 'quality.json').exists()


def test_same_counts_do_not_let_a_changed_mesh_claim_lossless_delivery(tmp_path):
    seal, payload = sealed(tmp_path)
    doc, binary = parse_glb((tmp_path / 'hair.runtime.glb').read_bytes(), strict=True)
    doc['nodes'][1]['translation'][1] = 9
    changed = build_glb(doc, binary)
    (tmp_path / 'hair.runtime.glb').write_bytes(changed)
    report = json.loads((tmp_path / 'quality.json').read_text(encoding='utf8'))
    report['delivery']['hair'].update(sha256=digest(changed), runtime_bytes=len(changed))
    (tmp_path / 'quality.json').write_text(json.dumps(report), encoding='utf8')
    seal['result'].update(quality=report, delivery=report['delivery'])
    seal['files'].update({'quality.json': digest((tmp_path / 'quality.json').read_bytes()),
                          'hair.runtime.glb': digest(changed)})
    with pytest.raises(ValueError, match='Runtime delivery changed'):
        verify_quality(tmp_path, seal, payload)
