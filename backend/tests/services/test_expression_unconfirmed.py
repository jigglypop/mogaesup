"""Default expressions whose image request may have been processed: an explicit run sends them again only when it was
admitted with the double-charge warning, as images, models and rig do."""
import json
from types import SimpleNamespace

import pytest

from src.services import avatar_expression_generation as generation_module
from src.services import avatar_expression_pipeline as pipeline
from src.services import avatar_expressions as expressions_module
from src.services import avatar_stage_resume as stages
from src.services.character_pipeline import read_json
from src.services.object_storage import StoredPath
from src.services.process_identity import identity

NAMES = pipeline.default_contract()['names']


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


@pytest.fixture
def job(tmp_path):
    """A job whose `neutral` request lost its answer after it was sent and whose other requests were refused."""
    directory = StoredPath(tmp_path / 'job')
    write(directory / 'pipeline.json', {'default_expressions': pipeline.default_contract()})
    write(directory / 'native-parts' / 'current.json', {'version': 'v1'})
    root = directory / 'native-parts' / 'v1' / 'expression-generations'
    for name in NAMES:
        write(root / f'g-{name}' / 'record.json', {'status': 'blocked', 'error': f'{name} stopped'})
        receipt = root / f'g-{name}' / 'image-provider.json'
        if name == 'neutral':
            write(receipt.with_suffix('.request.json'), {'phase': 'awaiting_response', 'request_started': True,
                                                         'request_body_complete': True, 'submission': 'unknown'})
        else:
            write(receipt.with_suffix('.request.json'), {'phase': 'response_rejected', 'submission': 'rejected'})
            write(receipt.with_suffix('.error.json'), {'http_status': 400, 'category': 'policy'})
    write(directory / 'default-expressions.json', {
        'source_version': 'v1', 'generations': {name: f'g-{name}' for name in NAMES}, 'bodies': {}, 'status': 'paused'})
    return directory, root


def test_only_a_request_that_may_have_been_processed_is_unconfirmed(job):
    directory, root = job
    assert pipeline.unconfirmed_generation(root / 'g-neutral')
    assert not pipeline.unconfirmed_generation(root / 'g-smile')  # refused: nothing to pay twice
    items = pipeline.summary(directory)['items']
    assert pipeline.unconfirmed_expressions(directory, items) == ['neutral']
    # A request that never left, or whose answer is kept, is not unconfirmed.
    receipt = root / 'g-neutral' / 'image-provider.json'
    write(receipt.with_suffix('.request.json'), {'phase': 'prepared', 'request_started': False, 'submission': 'not_sent'})
    assert not pipeline.unconfirmed_generation(root / 'g-neutral')
    write(receipt.with_suffix('.request.json'), {'phase': 'response_unsaved', 'http_status': 200, 'submission': 'unknown'})
    write(receipt.with_suffix('.response.json'), {'data': []})
    assert not pipeline.unconfirmed_generation(root / 'g-neutral')


@pytest.fixture
def generations(job, monkeypatch):
    """Expression generations that record the new requests a run makes instead of sending them."""
    directory, root = job
    created = []

    class Generations:
        def __init__(self, factory, owner, job_id, version):
            self.root = root

        def directory(self, generation):
            return self.root / generation

        def get(self, generation):
            record = read_json(self.root / generation / 'record.json')
            return {'id': generation, 'status': record['status'], 'can_resume': False, 'error': record.get('error')}

        def create(self, key, payload):
            created.append(key)
            write(self.root / key / 'record.json', {'status': 'blocked', 'error': f'{key} new'})
            return self.get(key), True

    monkeypatch.setattr(generation_module, 'AvatarExpressionGeneration', Generations)
    monkeypatch.setattr(expressions_module, 'AvatarExpressions', lambda *args: None)
    return SimpleNamespace(directory=lambda owner, job_id: directory), created


def test_an_explicit_run_without_the_warning_never_sends_an_unconfirmed_request_again(generations, job):
    factory, created = generations
    directory, _ = job
    pipeline.execute(factory, 1, 'job', 'v1', retry_blocked=True)
    # The refused ones are asked again under new keys; the one that may have been billed is kept as it is.
    assert created == [f'default-expression-{name}-v1-r1' for name in NAMES if name != 'neutral']
    record = read_json(directory / 'default-expressions.json')
    assert record['generations']['neutral'] == 'g-neutral' and 'neutral stopped' in record['error']


def test_a_run_admitted_with_the_warning_sends_it_again(generations):
    factory, created = generations
    pipeline.execute(factory, 1, 'job', 'v1', retry_blocked=True, retry_unconfirmed=True)
    assert created == [f'default-expression-{name}-v1-r1' for name in NAMES]


def test_an_automatic_run_sends_nothing_again(generations):
    factory, created = generations
    pipeline.execute(factory, 1, 'job', 'v1')
    assert created == []


# --- the expressions stage shows the warning and a run keeps what it was admitted with ------------------------------------

def test_the_expressions_stage_carries_the_double_charge_warning(job):
    directory, _ = job
    public = {'production_mode': 'character_parts', 'default_expressions': pipeline.summary(directory)}
    factory = SimpleNamespace(get=lambda owner, job_id: public, directory=lambda owner, job_id: directory)
    action = next(a for a in stages.AvatarStageResume(factory).get(1, 'a' * 24)['actions'] if a['stage'] == 'expressions')
    assert action['warning'] == pipeline.UNCONFIRMED_RETRY
    # Once nothing is unconfirmed the warning goes away.
    receipt = directory / 'native-parts' / 'v1' / 'expression-generations' / 'g-neutral' / 'image-provider.json'
    write(receipt.with_suffix('.error.json'), {'http_status': 400})
    action = next(a for a in stages.AvatarStageResume(factory).get(1, 'a' * 24)['actions'] if a['stage'] == 'expressions')
    assert 'warning' not in action


def test_a_stage_run_records_the_warning_it_was_admitted_with(job, monkeypatch):
    directory, _ = job
    (directory / 'stage-runs').mkdir()
    factory = SimpleNamespace(directory=lambda owner, job_id: directory)
    shown = {'actions': [{'stage': 'expressions', 'enabled': True, 'reason': None, 'paid': True,
                          'warning': pipeline.UNCONFIRMED_RETRY}]}
    monkeypatch.setattr(stages.AvatarStageResume, 'get', lambda self, owner, job_id: shown)
    _, request_id = stages.AvatarStageResume(factory).start(1, 'a' * 24, 'expressions', 'fixture-stage-key')
    assert read_json(directory / 'stage-runs' / f'{request_id}.json')['warning'] == pipeline.UNCONFIRMED_RETRY


@pytest.mark.parametrize('explicit, warning, expected', [
    (True, pipeline.UNCONFIRMED_RETRY, True),
    (True, None, False),  # also a run admitted before the warning existed
    (False, pipeline.UNCONFIRMED_RETRY, False),
])
def test_a_stage_run_sends_unconfirmed_expressions_again_only_as_admitted(job, monkeypatch, explicit, warning, expected):
    directory, _ = job
    write(directory / 'job.json', {'status': 'review_required'})
    write(directory / 'stage-runs' / 'r1.json', {'id': 'r1', 'stage': 'expressions', 'status': 'accepted',
                                                 'process': identity(), 'explicit': explicit, 'warning': warning})
    calls = []
    monkeypatch.setattr(pipeline, 'execute', lambda *args, **kwargs: calls.append(kwargs))
    monkeypatch.setattr(pipeline, 'summary', lambda directory, version=None: {'status': 'complete'})
    stages.AvatarStageResume(SimpleNamespace(directory=lambda owner, job_id: directory)).execute(1, 'a' * 24, 'r1')
    assert calls == [{'retry_blocked': explicit, 'retry_unconfirmed': expected}]
