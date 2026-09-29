import hashlib
import json
import struct

import httpx
import pytest
from PIL import Image

from api.test_characters import rigged_glb
from src.services.asset_delivery import inspect_glb
from src.services.character_motion import DEFAULT_ACTIONS, prepare
from src.services.character_segmentation import split_faces, triangle_indices
from src.services.glb import build_glb, parse_glb
from src.services.character_jobs import generate


def animated_fixture():
    doc, binary = parse_glb(rigged_glb(), strict=True)
    offset = len(binary)
    binary += struct.pack('<8f', 0, 1, 0, 0, 0, 0, .1, 0)
    doc['bufferViews'].extend([{'buffer': 0, 'byteOffset': offset, 'byteLength': 8}, {'buffer': 0, 'byteOffset': offset + 8, 'byteLength': 24}])
    doc['accessors'].extend([{'bufferView': 3, 'componentType': 5126, 'count': 2, 'type': 'SCALAR', 'min': [0], 'max': [1]},
                             {'bufferView': 4, 'componentType': 5126, 'count': 2, 'type': 'VEC3'}])
    doc['animations'] = [{'name': 'provider_clip', 'samplers': [{'input': 3, 'output': 4}], 'channels': [{'sampler': 0, 'target': {'node': 2, 'path': 'translation'}}]}]
    doc['buffers'][0]['byteLength'] = len(binary)
    return build_glb(doc, binary)


def test_split_faces_preserves_exact_skin_uv_animation_and_every_triangle():
    source = animated_fixture()
    doc, binary = parse_glb(source)
    result, parts = split_faces(source, hashlib.sha256(source).hexdigest(), [
        {'node_index': 0, 'primitive_index': 0, 'role': 'head', 'faces': [0]},
        {'node_index': 1, 'primitive_index': 0, 'role': 'top', 'faces': [0]},
    ])
    output, output_binary = parse_glb(result, strict=True)
    assert output_binary[:len(binary)] == binary
    assert output['skins'] == doc['skins']
    assert output['accessors'][:len(doc['accessors'])] == doc['accessors']
    assert output['animations'] == doc['animations']
    assert {p['role'] for p in parts} == {'head', 'top'}
    def rendered_triangles(d, b):
        return sum(len(triangle_indices(d, b, p)) for n in d['nodes'] if 'mesh' in n for p in d['meshes'][n['mesh']]['primitives'])
    assert rendered_triangles(output, output_binary) == rendered_triangles(doc, binary)
    assert inspect_glb(result)['metrics']['vertices'] == inspect_glb(source)['metrics']['vertices']
    assert not inspect_glb(result)['errors']


@pytest.mark.parametrize('faces', [[1000], [-1], [0, 0]])
def test_reject_invalid_or_duplicate_selections(faces):
    source = rigged_glb()
    with pytest.raises(ValueError):
        split_faces(source, hashlib.sha256(source).hexdigest(), [{'node_index': 0, 'primitive_index': 0, 'role': 'hat', 'faces': faces}])
    with pytest.raises(ValueError, match='another model'):
        split_faces(source, '0' * 64, [{'node_index': 0, 'primitive_index': 0, 'role': 'hat', 'faces': [0]}])


def provider(tmp_path, *, lose_post=False, pending=False, basic=True):
    calls = []
    def handler(request):
        path = request.url.path
        if path.endswith('/library'):
            return httpx.Response(200, json=[{'action_id': value, 'name': slot, 'key': slot} for slot, value in DEFAULT_ACTIONS.items()])
        if request.method == 'POST':
            calls.append((path, json.loads(request.content)))
            # Intent is on disk before even a lost response.
            assert any(t['status'] == 'submission_uncertain' for t in json.loads((tmp_path / 'motion-pack.json').read_text())['tasks'].values())
            if lose_post:
                raise httpx.ReadTimeout('lost response', request=request)
            return httpx.Response(200, json={'result': 'rig-id' if path.endswith('rigging') else 'anim-' + str(json.loads(request.content)['action_id'])})
        result = {'animation_glb_url': 'https://assets.meshy.ai/animation.glb'}
        if '/rigging/' in path:
            result = {'rigged_character_glb_url': 'https://assets.meshy.ai/rigged.glb'}
            if basic:
                result['basic_animations'] = {'walking_glb_url': 'https://assets.meshy.ai/walk.glb', 'running_glb_url': 'https://assets.meshy.ai/run.glb'}
        return httpx.Response(200, json={'status': 'PENDING' if pending and '/animations/' in path else 'SUCCEEDED', 'result': result})
    return httpx.Client(base_url='https://api.meshy.ai', transport=httpx.MockTransport(handler)), calls


def download(client, url, path):
    assert 'Authorization' not in client.headers  # Never forward the API key to CDN.
    path.write_bytes(animated_fixture())
    return inspect_glb(path.read_bytes())


def test_one_operation_downloads_five_clips_reuses_basic_and_resumes_without_posts(tmp_path):
    model = tmp_path / 'source.glb'; model.write_bytes(rigged_glb())
    client, calls = provider(tmp_path)
    with client:
        result = prepare(tmp_path, model, 1.7, DEFAULT_ACTIONS, 6, client, timeout=0, download_model=download)
        again = prepare(tmp_path, model, 1.7, DEFAULT_ACTIONS, 6, client, timeout=0, download_model=download)
    assert result == again and result['status'] == 'complete'
    assert len(calls) == 4  # Rig + idle/jump/fall, walking/running provided by rigging.
    assert result['clips']['walk']['action_id'] is None
    assert result['clips']['walk']['source'] == 'rigging_basic'
    quality = inspect_glb((tmp_path / 'motions/character.glb').read_bytes())
    assert set(DEFAULT_ACTIONS).issubset(quality['metrics']['animations'])
    assert not quality['errors']


def test_uncertain_rig_is_never_submitted_twice(tmp_path):
    model = tmp_path / 'source.glb'; model.write_bytes(rigged_glb())
    client, calls = provider(tmp_path, lose_post=True)
    with client:
        with pytest.raises(httpx.ReadTimeout):
            prepare(tmp_path, model, 1.7, DEFAULT_ACTIONS, 6, client, timeout=0, download_model=download)
        with pytest.raises(ValueError, match='recovery'):
            prepare(tmp_path, model, 1.7, DEFAULT_ACTIONS, 6, client, timeout=0, download_model=download)
    assert len(calls) == 1


def test_restart_polls_saved_animation_ids_and_cannot_increase_budget(tmp_path):
    model = tmp_path / 'source.glb'; model.write_bytes(rigged_glb())
    client, calls = provider(tmp_path, pending=True)
    with client:
        first = prepare(tmp_path, model, 1.7, DEFAULT_ACTIONS, 4, client, timeout=0, download_model=download)
    assert first['status'] == 'awaiting_provider' and len(calls) == 4
    client, resumed_posts = provider(tmp_path)
    with client:
        result = prepare(tmp_path, model, 1.7, DEFAULT_ACTIONS, 6, client, timeout=0, download_model=download)
    assert result['status'] == 'complete' and result['max_new_tasks'] == 4
    assert resumed_posts == []


def test_missing_basic_animations_obeys_submission_budget(tmp_path):
    model = tmp_path / 'source.glb'; model.write_bytes(rigged_glb())
    client, calls = provider(tmp_path, basic=False)
    with client:
        with pytest.raises(ValueError, match='budget'):
            prepare(tmp_path, model, 1.7, DEFAULT_ACTIONS, 2, client, timeout=0, download_model=download)
    assert len(calls) == 2


@pytest.mark.parametrize('profile,model,polycount', [('meshy-7','meshy-7',30000),('smart-topology','meshy-t2',15000)])
def test_current_generation_profiles_send_supported_controls(tmp_path, profile, model, polycount):
    image = tmp_path / 'source.png'; Image.new('RGB',(16,16)).save(image)
    sent = []
    def handler(request):
        sent.append(json.loads(request.content)); return httpx.Response(200,json={'result':'generation-id'})
    with httpx.Client(base_url='https://api.meshy.ai',transport=httpx.MockTransport(handler)) as client:
        generate(tmp_path / 'run',image,1.7,client,profile)
    assert sent[0]['ai_model'] == model and sent[0]['target_polycount'] == polycount
    if profile == 'smart-topology':
        assert 'should_remesh' not in sent[0] and 'image_enhancement' not in sent[0]
    else:
        assert sent[0]['image_enhancement'] is False
