"""The default expressions' status: a status read trusts the saved records' hashes, serving and baking verify them."""
import hashlib
import json

import pytest

from src.services import avatar_expression_pipeline as pipeline
from src.services.object_storage import StoredPath
from src.services.process_identity import identity

NAMES = ['neutral', 'smile']


@pytest.fixture
def job(tmp_path):
    directory = StoredPath(tmp_path / 'job')
    root = directory / 'native-parts' / 'v1' / 'expressions' / 'e1'
    root.mkdir(parents=True)
    files = {}
    for name in ('body.glb', 'model.glb', 'manifest.json', 'face-material.png'):
        (root / name).write_bytes(name.encode())
        files[name] = hashlib.sha256(name.encode()).hexdigest()
    (root / 'record.json').write_text(json.dumps({'files': files, 'materials': [{'file': 'face-material.png'}]}))
    (directory / 'native-parts' / 'current.json').write_text(json.dumps({'version': 'v1'}))
    (directory / 'pipeline.json').write_text(json.dumps({'default_expressions': pipeline.default_contract()}))
    (directory / 'default-expressions.json').write_text(json.dumps({
        'source_version': 'v1', 'generations': {}, 'bodies': {'v1': {'neutral': 'e1'}}, 'status': 'paused'}))
    return directory, root


def test_a_status_read_trusts_the_saved_hashes_and_hashes_no_file(job, monkeypatch):
    directory, _ = job
    monkeypatch.setattr(pipeline, 'sha256', lambda path: pytest.fail('a status read must not hash the expression files'))
    status = pipeline.summary(directory)
    assert [item['applied'] for item in status['items']][:1] == [True] and status['completed'] == 1


def test_serving_and_baking_still_verify_every_file(job):
    directory, root = job
    assert pipeline.saved_expression_valid(directory / 'native-parts' / 'v1', 'e1')
    (root / 'model.glb').write_bytes(b'changed')
    assert not pipeline.saved_expression_valid(directory / 'native-parts' / 'v1', 'e1')
    assert pipeline.saved_expression_valid(directory / 'native-parts' / 'v1', 'e1', verify=False)
    # A record that does not name a file it needs is incomplete either way.
    record = json.loads((root / 'record.json').read_text())
    del record['files']['manifest.json']
    (root / 'record.json').write_text(json.dumps(record))
    assert not pipeline.saved_expression_valid(directory / 'native-parts' / 'v1', 'e1', verify=False)


def test_a_run_of_this_process_is_busy_only_while_its_worker_holds_the_lock(job):
    directory, _ = job
    state = json.loads((directory / 'default-expressions.json').read_text())
    (directory / 'default-expressions.json').write_text(json.dumps({**state, 'status': 'running', 'process': identity()}))
    assert pipeline.summary(directory)['busy'] is False
    assert pipeline._WORKERS.acquire(str(directory))
    try:
        assert pipeline.summary(directory)['busy'] is True
    finally:
        pipeline._WORKERS.release(str(directory))
