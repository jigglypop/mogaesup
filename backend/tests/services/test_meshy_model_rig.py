import base64
import hashlib
import io
import json

import httpx
import pytest
from PIL import Image

from api.test_characters import rigged_glb
from src.services import character_jobs
from src.services.glb import build_glb, parse_glb


def textured_glb():
    doc, binary = parse_glb(rigged_glb(), strict=True)
    stream = io.BytesIO()
    Image.new('RGB', (4, 4), 'pink').save(stream, format='PNG')
    png = stream.getvalue()
    binary += b'\0' * (-len(binary) % 4)
    doc['bufferViews'].append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(png)})
    doc['images'] = [{'bufferView': len(doc['bufferViews']) - 1, 'mimeType': 'image/png'}]
    doc['textures'] = [{'source': 0}]
    doc['materials'] = [{'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}}}]
    binary += png
    doc['buffers'][0]['byteLength'] = len(binary)
    return build_glb(doc, binary)


def test_model_rig_preserves_source_and_recovers_lost_submission(tmp_path):
    model = tmp_path / 'assembly.glb'
    original = textured_glb()
    model.write_bytes(original)
    run = tmp_path / 'rig-version'
    posts = []

    def transport(request):
        if request.method == 'POST':
            posts.append(json.loads(request.content))
            journal = character_jobs.state(run)
            assert journal['status'] == 'submission_uncertain'
            assert journal['source_sha256'] == hashlib.sha256(original).hexdigest()
            assert (run / 'rig-input.glb').read_bytes() == original
            raise httpx.ReadTimeout('lost', request=request)
        return httpx.Response(200, json={'status': 'SUCCEEDED', 'progress': 100})

    with httpx.Client(base_url='https://fixture.invalid', transport=httpx.MockTransport(transport)) as client:
        with pytest.raises(httpx.ReadTimeout):
            character_jobs.rig_model(run, model, 1.81, client)
        with pytest.raises(ValueError, match='Existing run'):
            character_jobs.rig_model(run, model, 1.81, client)
        recovered = character_jobs.refresh(run, client, 'existing-rig-task')
    assert len(posts) == 1
    assert base64.b64decode(posts[0]['model_url'].split(',', 1)[1]) == original
    assert recovered['task_id'] == 'existing-rig-task'
    assert model.read_bytes() == original


def test_quadruped_generation_uses_reference_pose_and_blocks_api_rigging(tmp_path):
    image = tmp_path / 'animal.png'
    Image.new('RGB', (4, 4), 'white').save(image)
    run = tmp_path / 'quadruped'
    posts = []

    def transport(request):
        posts.append(json.loads(request.content))
        return httpx.Response(200, json={'result': 'quad-task'})

    with httpx.Client(base_url='https://fixture.invalid', transport=httpx.MockTransport(transport)) as client:
        character_jobs.generate(run, image, .6, client, 'smart-topology', body_type='quadruped')
        before = (run / 'character.json').read_bytes()
        with pytest.raises(ValueError, match='web app'):
            character_jobs.rig(run, client)
        with pytest.raises(ValueError, match='web app'):
            character_jobs.rig_model(tmp_path / 'quad-rig', tmp_path / 'absent.glb', .6, client, body_type='quadruped')
    assert len(posts) == 1
    assert 'pose_mode' not in posts[0]
    assert posts[0]['model_type'] == 'smart-topology'
    assert (run / 'character.json').read_bytes() == before
    assert not (tmp_path / 'quad-rig').exists()


def test_invalid_model_never_submits(tmp_path):
    model = tmp_path / 'untextured.glb'
    model.write_bytes(rigged_glb())
    with httpx.Client(transport=httpx.MockTransport(lambda request: pytest.fail('Unexpected POST'))) as client:
        with pytest.raises(ValueError, match='textured'):
            character_jobs.rig_model(tmp_path / 'rejected', model, 1.81, client)
    assert not (tmp_path / 'rejected').exists()

