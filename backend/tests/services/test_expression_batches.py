"""Five-expression batches (avatar_expression_batches): one batch per request key, and each child's paid image request
sent at most once, also when the batch's own record was not saved or a child's request has an uncertain outcome.
The child generation service is faked; its paid requests are counted."""
import hashlib
from types import SimpleNamespace

import pytest

from src.services import avatar_expression_batches as batches, run_lock
from src.services.avatar_expression_batches import NAMES, AvatarExpressionBatches
from src.services.avatar_expression_references import AvatarExpressionReferences
from src.services.character_pipeline import PipelineError
from src.services.object_storage import StoredPath

ASSETS = ['a' * 64, 'b' * 64]


class Generation:
    """AvatarExpressionGeneration as the batch drives it. A child is found again by its request key; `execute` sends
    its one paid image request, whose outcome (`outcomes`, by expression name) is complete, uncertain (the child is
    blocked and never resumable) or not sent (the child pauses and may be resumed)."""

    def __init__(self, root, outcomes=None):
        self.body = StoredPath(root) / 'bodies' / 'v1' / 'body.glb'
        self.job, self.version, self.owner, self.body_sha256 = 'e' * 24, 'v1', 1, 'f' * 64
        self.factory = SimpleNamespace(root=StoredPath(root))
        self.outcomes = dict(outcomes or {})
        self.keys, self.children, self.sent = {}, {}, []

    @staticmethod
    def capabilities():
        return {'ready': True, 'reason': None}

    def create(self, key, payload):
        if key in self.keys:
            return self.get(self.keys[key]), False
        child = hashlib.sha256(key.encode()).hexdigest()[:24]
        self.keys[key] = child
        self.children[child] = {'name': payload['name'], 'status': 'accepted', 'error': None}
        return self.get(child), True

    def get(self, child):
        record = self.children[child]
        return {'id': child, 'status': record['status'], 'error': record['error'],
                'can_resume': record['status'] in ('accepted', 'paused')}

    def resume(self, child):
        record = self.children[child]
        if record['status'] not in ('accepted', 'paused'):
            return self.get(child), False
        record['status'] = 'accepted'
        return self.get(child), True

    def execute(self, child):
        record = self.children[child]
        if record['status'] != 'accepted':
            return
        self.sent.append(record['name'])
        outcome = self.outcomes.get(record['name'], 'complete')
        record['status'] = {'complete': 'complete', 'uncertain': 'blocked', 'not sent': 'paused'}[outcome]
        if outcome != 'complete':
            record['error'] = f"{record['name']}: {outcome}"


class Prompts:
    def __init__(self, factory, owner):
        pass

    @staticmethod
    def values(group):
        assert group == 'expression'
        return {name: f'{name} expression' for name in NAMES}


@pytest.fixture
def batch(tmp_path, monkeypatch):
    monkeypatch.setattr(batches, 'StudioPrompts', Prompts)
    monkeypatch.setattr(AvatarExpressionReferences, '__init__', lambda self, factory, owner, job: None)
    monkeypatch.setattr(AvatarExpressionReferences, 'sources', lambda self, assets: [])
    monkeypatch.setattr(run_lock, 'FINAL_WRITE_DELAYS', (0, 0))
    write = batches._write_json

    def store(path, value):
        # Batch records live in S3, which has no directories; on the test's local disk they are made.
        path.parent.mkdir(parents=True, exist_ok=True)
        return write(path, value)
    monkeypatch.setattr(batches, '_write_json', store)

    def make(outcomes=None):
        generation = Generation(tmp_path, outcomes)
        return AvatarExpressionBatches(generation), generation
    return make


def test_a_batch_is_created_once_per_request_key(batch):
    service, generation = batch()
    first, dispatch = service.create('batch-key-1', {'reference_assets': ASSETS})
    again, dispatch_again = service.create('batch-key-1', {'reference_assets': ASSETS})
    # Still accepted, so the replay may hand it to an executor; the executor runs it once.
    assert dispatch and dispatch_again and again['id'] == first['id']
    with pytest.raises(PipelineError) as conflict:
        service.create('batch-key-1', {'reference_assets': list(reversed(ASSETS))})
    assert conflict.value.code == 'idempotency_conflict'
    service.execute(first['id'])
    service.execute(first['id'])
    assert generation.sent == list(NAMES) and service.get(first['id'])['status'] == 'complete'
    assert service.create('batch-key-1', {'reference_assets': ASSETS})[1] is False


def test_a_lost_batch_write_finds_the_same_children_and_sends_no_paid_request_twice(batch, monkeypatch):
    service, generation = batch()
    created, _ = service.create('batch-key-1', {'reference_assets': ASSETS})
    store = batches._write_json

    def down_after_cry(path, value):
        # Storage fails from the save that records the third child on, the last saves included.
        if 'cry' in value.get('generations', {}):
            raise OSError('storage unavailable')
        return store(path, value)
    monkeypatch.setattr(batches, '_write_json', down_after_cry)
    service.execute(created['id'])
    # Three children were created, but the saved batch names only the first two and pauses.
    assert generation.sent == ['neutral', 'smile'] and len(generation.children) == 5
    assert sorted(service._record(created['id'])['generations']) == ['neutral', 'smile']
    public = service.get(created['id'])
    assert public['status'] == 'paused' and public['can_resume']

    monkeypatch.setattr(batches, '_write_json', store)
    _, dispatch = service.resume(created['id'])
    assert dispatch
    service.execute(created['id'])
    assert sorted(generation.sent) == sorted(NAMES) and len(generation.children) == 5
    assert service.get(created['id'])['status'] == 'complete'


def test_a_child_whose_paid_request_has_an_uncertain_outcome_is_never_sent_again(batch):
    service, generation = batch({'smile': 'uncertain'})
    created, _ = service.create('batch-key-1', {'reference_assets': ASSETS})
    service.execute(created['id'])
    public = service.get(created['id'])
    assert public['status'] == 'blocked' and not public['can_resume'] and 'smile' in public['error']
    assert [item['status'] for item in public['items']] == ['complete', 'blocked', 'complete', 'complete', 'complete']
    # Neither a resume nor another executor sends it again.
    assert service.resume(created['id'])[1] is False
    service.execute(created['id'])
    assert generation.sent.count('smile') == 1 and len(generation.sent) == 5


def test_a_child_whose_request_never_left_is_sent_once_more_by_a_resume(batch):
    service, generation = batch({'cry': 'not sent'})
    created, _ = service.create('batch-key-1', {'reference_assets': ASSETS})
    service.execute(created['id'])
    assert service.get(created['id'])['status'] == 'paused'
    generation.outcomes.clear()
    assert service.resume(created['id'])[1]
    service.execute(created['id'])
    assert generation.sent.count('cry') == 2 and len(generation.sent) == 6
    assert service.get(created['id'])['status'] == 'complete'
