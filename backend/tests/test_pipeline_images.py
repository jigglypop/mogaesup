"""Receipts of a paid OpenAI image request and the staging of downloaded files, on local disk and in S3.

S3 is a counting stand-in. Remote storage is told from the local disk by object_storage.is_remote: there one PUT of
the final key is atomic, and a temporary object that is renamed afterwards costs a GET, a PUT and a DELETE.
"""
import base64
from collections import Counter
from contextlib import contextmanager
import copy
from datetime import datetime, timezone
import hashlib
import io
import json
import logging
from pathlib import Path as LocalPath
from types import SimpleNamespace

from botocore.exceptions import ClientError
import httpx
from PIL import Image
import pytest

from api.test_characters import rigged_glb
from src.services import avatar_openai_images as images
from src.services import object_storage, run_lock
from src.services.avatar_image_recovery import (UNCONFIRMED_RETRY, classify_image_failure, decorate_job, has_dependents,
                                                retry_views, settle_interrupted)
from src.services.avatar_multiview_images import can_resume
from src.services.character_pipeline import PipelineError
from src.services.object_storage import StoredPath
from src.services.runtime_activity import RuntimeDraining
from src.services.wardrobe import download_glb

JOB = 'b' * 24
MODIFIED = datetime(2026, 9, 1, tzinfo=timezone.utc)
KEY = 'assets/avatar-factory/1/' + JOB + '/output/body-provider'


def png():
    data = io.BytesIO()
    Image.new('RGBA', (16, 16), 'blue').save(data, format='PNG')
    return data.getvalue()


def answer():
    return {'data': [{'b64_json': base64.b64encode(png()).decode()}]}


class CountingS3:
    """The S3 calls object_storage makes, in memory, counted; a delete can be made to fail like a missing permission."""

    def __init__(self):
        self.objects, self.calls, self.puts = {}, Counter(), []
        self.deny_delete = False
        self.refuse_puts = Counter()  # key -> how many more PUTs of it fail, as an S3 outage would

    def put_object(self, *, Bucket, Key, Body, ContentType, Metadata, ChecksumSHA256, ServerSideEncryption, IfNoneMatch=None):
        self.calls['put_object'] += 1
        if self.refuse_puts[Key] > 0:
            self.refuse_puts[Key] -= 1
            raise ClientError({'Error': {'Code': 'ServiceUnavailable'}}, 'PutObject')
        self.puts.append(Key)
        self.objects[Key] = bytes(Body)

    def head_object(self, *, Bucket, Key, ChecksumMode=None):
        self.calls['head_object'] += 1
        if Key not in self.objects:
            raise ClientError({'Error': {'Code': '404'}}, 'HeadObject')
        return {'ContentLength': len(self.objects[Key]), 'LastModified': MODIFIED}

    def get_object(self, *, Bucket, Key, Range=None, IfMatch=None):
        self.calls['get_object'] += 1
        if Key not in self.objects:
            raise ClientError({'Error': {'Code': 'NoSuchKey'}}, 'GetObject')
        return {'Body': io.BytesIO(self.objects[Key]), 'Metadata': {}}

    def delete_object(self, *, Bucket, Key):
        self.calls['delete_object'] += 1
        if self.deny_delete:
            raise ClientError({'Error': {'Code': 'AccessDenied'}}, 'DeleteObject')
        self.objects.pop(Key, None)

    def copy_object(self, **kwargs):
        self.calls['copy_object'] += 1
        raise AssertionError('nothing here copies objects')

    def list_objects_v2(self, *, Bucket, Prefix, **kwargs):
        self.calls['list_objects_v2'] += 1
        return {'Contents': [{'Key': key, 'Size': len(self.objects[key]), 'LastModified': MODIFIED}
                             for key in sorted(self.objects) if key.startswith(Prefix)]}

    def get_paginator(self, name):
        s3 = self

        class Pages:
            def paginate(self, **kwargs):
                yield s3.list_objects_v2(**kwargs)
        return Pages()


def _clear_caches():
    with object_storage._cache_lock:
        for cache in (object_storage._cache, object_storage._content_cache, object_storage._key_index,
                      object_storage._written_keys, object_storage._generations):
            cache.clear()


@pytest.fixture
def remote(monkeypatch, tmp_path):
    """The data root whose job files live in (counting) S3."""
    s3 = CountingS3()
    monkeypatch.delenv('ASSET_STORAGE_WORKER_LOCAL', raising=False)
    monkeypatch.setenv('ASSET_S3_BUCKET', 'fixture-bucket')
    monkeypatch.setenv('ASSET_S3_PREFIX', 'assets')
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path / 'data'))
    monkeypatch.setattr(object_storage, '_s3', lambda: s3)
    _clear_caches()
    yield StoredPath(tmp_path / 'data'), s3
    _clear_caches()


def receipt_in(root):
    return root / 'avatar-factory' / '1' / JOB / 'output' / 'body-provider'


def edit(source, receipt):
    return images.generate_part_image(source, 'whole character', images.DEFAULT_MODEL, images.DEFAULT_BASE, receipt=receipt)


@pytest.fixture
def source(tmp_path, monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'fixture-only')
    path = tmp_path / 'source.png'
    path.write_bytes(png())
    return path


def serve(monkeypatch, handler):
    monkeypatch.setattr(images, 'image_transport', lambda: httpx.MockTransport(handler))


def never(request):
    pytest.fail('a saved answer must be read, not requested again')


# --- an answer saved as .partial but never promoted ---------------------------------------------------------------------

def lost_attempt(receipt, partial):
    """What a stop between saving the answer as .response.partial and renaming it leaves behind."""
    receipt.with_suffix('.response.partial').write_bytes(partial)
    receipt.with_suffix('.request.json').write_text(json.dumps(
        {'phase': 'response_headers', 'http_status': 200, 'client_request_id': 'earlier', 'request_started': True,
         'request_body_complete': True, 'submission': 'unknown'}))


def test_a_complete_answer_left_as_a_partial_is_used_instead_of_calling_the_request_uncertain(tmp_path, source, monkeypatch):
    receipt = tmp_path / 'body-provider'
    complete = json.dumps(answer()).encode()
    lost_attempt(receipt, complete)
    serve(monkeypatch, never)
    assert edit(source, receipt) == png()
    assert receipt.with_suffix('.response.json').read_bytes() == complete
    assert not receipt.with_suffix('.response.partial').exists()
    assert edit(source, receipt) == png()


@pytest.mark.parametrize('partial', [b'{"data": [{"b64_json": "iVBORw0KGgo', b'{"created": 1}', b'[]', b''])
def test_an_answer_that_is_cut_off_or_has_no_image_data_stays_as_evidence(tmp_path, source, monkeypatch, partial):
    receipt = tmp_path / 'body-provider'
    lost_attempt(receipt, partial)
    serve(monkeypatch, never)
    with pytest.raises(PipelineError) as error:
        edit(source, receipt)
    assert error.value.code == 'image_response_uncertain'
    assert receipt.with_suffix('.response.partial').read_bytes() == partial
    assert not receipt.with_suffix('.response.json').exists()


def test_a_complete_partial_in_s3_is_promoted_even_when_it_cannot_be_deleted(remote, source, monkeypatch, caplog):
    root, s3 = remote
    receipt = receipt_in(root)
    complete = json.dumps(answer()).encode()
    receipt.with_suffix('.response.partial').write_bytes(complete)
    receipt.with_suffix('.request.json').write_text(json.dumps({'phase': 'response_headers', 'submission': 'unknown', 'client_request_id': 'x'}))
    s3.deny_delete = True
    serve(monkeypatch, never)
    with caplog.at_level(logging.WARNING, logger=images.LOGGER.name):
        assert edit(source, receipt) == png()
    assert s3.objects[KEY + '.response.json'] == complete
    assert 'leftover partial kept' in caplog.text


def interrupted_view(tmp_path, partial):
    """A view whose request was in flight when the server stopped, with `partial` left as its answer."""
    receipt = tmp_path / 'output' / 'top-front-provider'
    receipt.parent.mkdir(parents=True)
    lost_attempt(receipt, partial)
    return {'parts': [{'slot': 'top', 'views': {'front': {'status': 'submitting', 'attempted_at': '2026-10-01T00:00:00+00:00'}}}]}, receipt


def test_a_stopped_request_whose_answer_was_complete_is_settled_as_a_saved_response(tmp_path):
    state, receipt = interrupted_view(tmp_path, json.dumps(answer()).encode())
    assert settle_interrupted(tmp_path, state)
    view = state['parts'][0]['views']['front']
    # Saved: the stage continues from the response and sends nothing.
    assert view['status'] == 'submitting' and view['failure']['category'] == 'local_processing'
    assert receipt.with_suffix('.response.json').is_file() and not receipt.with_suffix('.response.partial').exists()


def test_a_stopped_request_whose_answer_was_cut_off_stays_unconfirmed(tmp_path):
    state, receipt = interrupted_view(tmp_path, b'{"data": [{"b64_json": "iVBOR')
    assert settle_interrupted(tmp_path, state)
    view = state['parts'][0]['views']['front']
    assert view['status'] == 'submission_uncertain' and view['failure']['category'] == 'provider_connection'
    assert receipt.with_suffix('.response.partial').is_file() and not receipt.with_suffix('.response.json').exists()


def stopped_attempt(tmp_path, request):
    """A view whose request was in flight when the server stopped, with `request` as its saved receipt and no answer."""
    receipt = tmp_path / 'output' / 'top-front-provider'
    receipt.parent.mkdir(parents=True)
    receipt.with_suffix('.request.json').write_text(json.dumps(request))
    return {'parts': [{'slot': 'top', 'views': {'front': {'status': 'submitting', 'attempted_at': '2026-10-01T00:00:00+00:00'}}}]}, receipt


def test_a_stopped_upload_without_its_completion_mark_stays_unconfirmed(tmp_path):
    # The receipt marks a complete upload only after the body is on the wire: without the mark the provider may still
    # have the whole request, and a stop never makes it "not sent".
    state, receipt = stopped_attempt(tmp_path, {'phase': 'sending', 'request_started': True, 'client_request_id': 'x'})
    assert settle_interrupted(tmp_path, state)
    view = state['parts'][0]['views']['front']
    assert view['status'] == 'submission_uncertain' and view['failure']['category'] == 'provider_connection'
    assert 'submission' not in json.loads(receipt.with_suffix('.request.json').read_text())


def test_a_stopped_request_that_never_started_is_settled_as_not_sent(tmp_path):
    # A receipt written since the start is made durable before any byte (durable_start): its missing start is evidence.
    state, receipt = stopped_attempt(tmp_path, {'phase': 'prepared', 'request_started': False, 'durable_start': True,
                                                'client_request_id': 'x'})
    assert settle_interrupted(tmp_path, state)
    assert state['parts'][0]['views']['front']['status'] == 'not_sent'
    assert json.loads(receipt.with_suffix('.request.json').read_text())['submission'] == 'not_sent'


# --- one rule for every image stage: what the receipt shows decides, never the exception alone --------------------------

def failed_attempt(tmp_path, request=None, response=None):
    receipt = tmp_path / 'top-front-provider'
    if request is not None:
        receipt.with_suffix('.request.json').write_text(json.dumps(request))
    if response is not None:
        receipt.with_suffix('.response.json').write_bytes(response)
    return receipt


@pytest.mark.parametrize('request_saved, response, error, expected', [
    # An answer that arrived (HTTP 200) but could not be stored was paid for: unconfirmed, never a plain failure.
    ({'phase': 'response_unsaved', 'http_status': 200, 'request_started': True, 'submission': 'unknown'}, None,
     OSError('storage unavailable'), ('submission_uncertain', 'local_processing')),
    # The receipt shows the request never left, whatever the exception was.
    ({'phase': 'prepared', 'request_started': False, 'submission': 'not_sent'}, None,
     httpx.ConnectError('refused'), ('not_sent', 'provider_connection')),
    ({'phase': 'prepared', 'request_started': False, 'submission': 'not_sent'}, None,
     RuntimeDraining('draining'), ('not_sent', 'provider_connection')),
    ({'phase': 'awaiting_response', 'request_started': True, 'submission': 'unknown'}, None,
     httpx.ReadError('reset'), ('submission_uncertain', 'provider_connection')),
    ({'phase': 'response_saved', 'http_status': 200}, json.dumps(answer()).encode(),
     OSError('local disk'), ('submitting', 'local_processing')),
    # A kept answer with no usable image fails the same way each time it is read: only an explicit request replaces it.
    ({'phase': 'response_saved', 'http_status': 200}, b'{"data": []}',
     PipelineError('image_missing', 'no image', 422), ('answer_invalid', 'provider_response')),
    (None, None, OSError('before any request'), ('failed', 'local_processing')),
])
def test_an_image_failure_is_classified_from_its_receipt(tmp_path, request_saved, response, error, expected):
    status, failure = classify_image_failure(error, failed_attempt(tmp_path, request_saved, response))
    assert (status, failure['category']) == expected and failure['id'] and failure['message']


def test_a_provider_refusal_is_rejected_with_its_category(tmp_path):
    refusal = images.OpenAIImageHTTPError(400, 'policy', 'diag1234abcd', {'code': 'moderation_blocked'})
    status, failure = classify_image_failure(refusal, failed_attempt(tmp_path, {'http_status': 400}))
    assert status == 'rejected' and failure['category'] == 'policy' and failure['id'] == 'diag1234abcd'
    assert failure['http_status'] == 400 and failure['provider_code'] == 'moderation_blocked'


def unconfirmed_view(tmp_path, kept):
    """A paused job whose front body view was answered but not stored; `kept` is the copy left as its partial."""
    receipt = tmp_path / 'output' / 'body-front-provider'
    receipt.parent.mkdir(parents=True)
    receipt.with_suffix('.request.json').write_text(json.dumps(
        {'phase': 'response_unsaved', 'http_status': 200, 'request_started': True, 'submission': 'unknown'}))
    if kept is not None:
        receipt.with_suffix('.response.partial').write_bytes(kept)
    failure = {'id': 'f00d', 'category': 'local_processing', 'message': '수신 이미지 저장 실패 · 응답 확인 필요'}
    state = {'production_spec': {'generated_views': ['front']},
             'parts': [{'slot': 'body', 'image': {'status': 'pending'}, 'model': {'status': 'pending'},
                        'views': {'front': {'status': 'submission_uncertain', 'failure': failure}}}]}
    (tmp_path / 'pipeline.json').write_text(json.dumps(state))
    public = {'status': 'pipeline_paused', 'next_actions': [], 'progress': {'message': ''},
              'parts': [{'slot': 'body', 'views': {'front': {'status': 'submission_uncertain', 'failure': dict(failure)}}}]}
    return state, public, receipt


def test_an_answer_kept_as_a_partial_is_resumed_and_never_offered_for_another_paid_request(tmp_path):
    state, public, receipt = unconfirmed_view(tmp_path, json.dumps(answer()).encode())
    decorate_job(tmp_path, public)
    assert not [action for action in public['next_actions'] if action['id'] in ('retry_image', 'retry_images')]
    assert can_resume(tmp_path, state)
    assert receipt.with_suffix('.response.json').is_file() and not receipt.with_suffix('.response.partial').exists()


def test_an_answer_lost_before_it_was_stored_can_only_be_requested_again_explicitly(tmp_path):
    state, public, receipt = unconfirmed_view(tmp_path, None)
    assert not can_resume(tmp_path, state)
    decorate_job(tmp_path, public)
    assert [action['failure_id'] for action in public['next_actions'] if action['id'] == 'retry_image'] == ['f00d']


# --- a kept answer that holds no usable image is replaced by one explicit request, never read again ----------------------

class Pipeline:
    """What retry_views uses of the image pipeline: one job's directory and records, and their publication."""

    def __init__(self, directory):
        self.directory = directory
        self.factory = SimpleNamespace(instance='fixture', directory=lambda owner, job_id: directory,
                                       get=lambda owner, job_id: json.loads((directory / 'job.json').read_text()))

    def publish(self, owner, job_id, state):
        (self.directory / 'pipeline.json').write_text(json.dumps(state))


SAVED_BODY = {'slot': 'body', 'image': {'status': 'succeeded'}, 'model': {'status': 'ready', 'task_id': None},
              'views': {'front': {'status': 'succeeded'}, 'side': {'status': 'succeeded'}}}


def paused_job(directory, parts, reference=None):
    """A paused job's records as can_resume, decorate_job and retry_views read them, and its public view."""
    (directory / 'output').mkdir(exist_ok=True)
    state = {'production_spec': {'generated_views': ['front', 'side']}, 'parts': copy.deepcopy(parts)}
    public = {'status': 'pipeline_paused', 'next_actions': [], 'progress': {'message': ''},
              'parts': [{'slot': part['slot'], 'views': copy.deepcopy(part['views'])} for part in parts]}
    if reference is not None:
        state['reference_preparation'] = copy.deepcopy(reference)
        public['reference_preparation'] = copy.deepcopy(reference)
    (directory / 'pipeline.json').write_text(json.dumps(state))
    (directory / 'job.json').write_text(json.dumps({'id': JOB, 'status': 'pipeline_paused'}))
    return state, public


def offered(public):
    """(slot, view, failure ID) of every explicit image request the job offers."""
    return [(action['slot'], action['view'], action['failure_id'])
            for action in public['next_actions'] if action['id'] == 'retry_image' and action['enabled']]


def retried(directory, slot, view, failure_id):
    """The job's records once an explicit request for the view is accepted."""
    _, created = retry_views(Pipeline(directory), 1, JOB, [{'slot': slot, 'view': view, 'failure_id': failure_id}])
    assert created
    return json.loads((directory / 'pipeline.json').read_text())


def oversized():
    content = io.BytesIO()
    Image.new('RGBA', (4097, 1), 'blue').save(content, format='PNG')
    return content.getvalue()


@pytest.mark.parametrize('body', [
    b'{"data": []}', b'{"error": {"code": "server_error"}}', b'<html>gateway</html>',
    json.dumps({'data': [{'b64_json': '%%%'}]}).encode(),
    json.dumps({'data': [{'b64_json': base64.b64encode(b'not an image').decode()}]}).encode(),
    json.dumps({'data': [{'b64_json': base64.b64encode(oversized()).decode()}]}).encode(),
])
def test_an_answer_with_no_usable_image_is_replaced_by_one_explicit_request_instead_of_read_again(tmp_path, source,
                                                                                                    monkeypatch, body):
    receipt = tmp_path / 'output' / 'top-front-provider'
    receipt.parent.mkdir()
    sent = []
    serve(monkeypatch, lambda request: (sent.append(request), httpx.Response(200, content=body))[1])
    for _ in range(2):  # The paid request, then going on from its kept answer.
        with pytest.raises(Exception) as stopped:
            images.generate_standard_part_image([source], 'top', images.DEFAULT_MODEL, images.DEFAULT_BASE, receipt=receipt)
        status, failure = classify_image_failure(stopped.value, receipt)
        assert (status, failure['category']) == ('answer_invalid', 'provider_response')
    assert len(sent) == 1 and receipt.with_suffix('.response.json').read_bytes() == body
    top = {'slot': 'top', 'image': {'status': 'pending'}, 'model': {'status': 'pending'},
           'views': {'front': {'status': status, 'failure': failure}, 'side': {'status': 'pending'}}}
    state, public = paused_job(tmp_path, [SAVED_BODY, top])
    # Going on would read the same answer and stop again, so it is not offered; one explicit request is.
    assert not can_resume(tmp_path, state)
    decorate_job(tmp_path, public)
    assert offered(public) == [('top', 'front', failure['id'])]
    # The answer arrived and was paid for: a new request is not a resend of one of unknown acceptance.
    assert not [action for action in public['next_actions'] if action.get('warning')]
    state = retried(tmp_path, 'top', 'front', failure['id'])
    front = state['parts'][1]['views']['front']
    assert front['status'] == 'pending' and front['receipt'] == f'top-front-retry-{failure["id"]}-provider'
    assert can_resume(tmp_path, state)


def test_a_reference_whose_answer_holds_no_usable_image_is_replaced_by_one_explicit_request(tmp_path):
    receipt = tmp_path / 'output' / 'canonical-reference-provider'
    receipt.parent.mkdir()
    receipt.with_suffix('.response.json').write_bytes(b'{"data": []}')
    status, failure = classify_image_failure(PipelineError('image_missing', 'no image', 422), receipt)
    reference = {'status': status, 'failure': failure,
                 'views': {'front': {'status': status, 'failure': failure, 'prompt': 'front'}, 'side': {'status': 'pending'}}}
    body = {'slot': 'body', 'image': {'status': 'pending'}, 'model': {'status': 'pending'},
            'views': {'front': {'status': 'pending'}, 'side': {'status': 'pending'}}}
    state, public = paused_job(tmp_path, [body], reference)
    assert status == 'answer_invalid' and not can_resume(tmp_path, state)
    decorate_job(tmp_path, public)
    assert offered(public) == [('reference', 'front', failure['id'])]
    reference = retried(tmp_path, 'reference', 'front', failure['id'])['reference_preparation']
    assert reference['status'] == 'pending'
    assert reference['views']['front']['receipt'] == f'canonical-reference-front-retry-{failure["id"]}-provider'


def test_a_reference_whose_answer_holds_no_usable_image_stops_its_own_step(tmp_path):
    from src.services.avatar_production_progress import production_progress
    waiting = {'front': {'status': 'pending'}, 'side': {'status': 'pending'}}
    job = {'id': JOB, 'status': 'pipeline_paused', 'progress': {'stage': 'reference', 'message': ''},
           # A run from the images stage prepares the reference first, and stopped there.
           'character_flow': {'status': 'paused', 'stage': 'images', 'message': '', 'busy': False},
           'production_spec': {'generated_views': ['front', 'side']},
           'reference_preparation': {'status': 'answer_invalid',
                                     'views': {'front': {'status': 'answer_invalid'}, 'side': {'status': 'pending'}}},
           'parts': [{'slot': 'top', 'model_status': 'pending', 'views': waiting}]}
    progress = production_progress(tmp_path, job)
    steps = {step['id']: step['state'] for step in progress['steps']}
    assert (steps['reference'], steps['images'], progress['current']) == ('blocked', 'pending', 'reference')


def test_an_expression_whose_answer_holds_no_usable_image_is_blocked_for_a_request_under_a_new_key(tmp_path):
    from native_assembly_fixture import JOB as BODY_JOB, VERSION, seed_native_assembly
    from src.services.avatar_expression_generation import AvatarExpressionGeneration
    from src.services.avatar_expression_pipeline import unconfirmed_generation
    factory, _ = seed_native_assembly(tmp_path, 'fixture')
    service = AvatarExpressionGeneration(factory, 1, BODY_JOB, VERSION)
    generation = 'a' * 24
    directory = service.directory(generation)
    directory.mkdir(parents=True)
    (directory / 'reference.png').write_bytes(png())
    prompt = 'smile'
    (directory / 'record.json').write_text(json.dumps({
        'id': generation, 'job_id': BODY_JOB, 'body_version': VERSION, 'status': 'accepted', 'stage': 'image',
        'provider_prompt': prompt, 'provider_prompt_sha256': hashlib.sha256(prompt.encode()).hexdigest(),
        'prompt_revision': 'fixture', 'files': {}, 'created_at': '2026-10-01T00:00:00+00:00',
        'references': [{'file': 'reference.png', 'kind': 'source.png', 'sha256': hashlib.sha256(png()).hexdigest()}],
        'image_model': images.DEFAULT_MODEL, 'image_base': images.DEFAULT_BASE}))
    (directory / 'image-provider.response.json').write_bytes(b'{"data": []}')
    service.execute(generation)
    item = service.get(generation)
    # Resuming would read the same answer again; the default expressions' explicit run asks under a new key instead,
    # without the double-charge warning: the answer arrived.
    assert item['status'] == 'blocked' and not item['can_resume'] and item['error']
    assert service.resume(generation)[1] is False
    assert not unconfirmed_generation(directory)


# --- a body shell's views are used only by its later views and its assembly ----------------------------------------------

BODY_SHELL_MODEL = {'status': 'ready', 'task_id': None, 'origin': 'body_shell'}  # As AvatarVariants.create accepts it.


@pytest.mark.parametrize('method, model, side, used', [
    ('body_shell', BODY_SHELL_MODEL, 'pending', False),
    ('body_shell', BODY_SHELL_MODEL, 'succeeded', True),
    ('worn', {'status': 'pending'}, 'pending', False),
    ('worn', {'status': 'PENDING', 'task_id': 'task-1'}, 'pending', True),
    ('isolated', {'status': 'ready', 'task_id': 'task-1'}, 'pending', True),
])
def test_a_view_is_kept_only_while_later_work_uses_it(method, model, side, used):
    part = {'slot': 'top', 'part_method': method, 'model': model,
            'views': {'front': {'status': 'rejected'}, 'side': {'status': side}}}
    state = {'production_spec': {'generated_views': ['front', 'side']}, 'parts': [SAVED_BODY, part]}
    assert has_dependents(state, part, 'front') is used


@pytest.mark.parametrize('stopped, failure, warning', [
    ('rejected', {'id': 'shellfront01', 'category': 'policy', 'message': '이미지 안전 필터로 생성 중단'}, None),
    ('submission_uncertain', {'id': 'shellfront01', 'category': 'provider_connection',
                              'message': '생성 서버 연결 끊김 · 수신된 응답 없음'}, UNCONFIRMED_RETRY),
])
def test_a_failed_view_of_a_body_shell_part_is_replaced_by_one_explicit_request(tmp_path, stopped, failure, warning):
    top = {'slot': 'top', 'part_method': 'body_shell', 'image': {'status': 'pending'}, 'model': BODY_SHELL_MODEL,
           'views': {'front': {'status': stopped, 'failure': failure}, 'side': {'status': 'pending'}}}
    _, public = paused_job(tmp_path, [SAVED_BODY, top])
    decorate_job(tmp_path, public)
    assert offered(public) == [('top', 'front', 'shellfront01')]
    assert next(action for action in public['next_actions'] if action['id'] == 'retry_image').get('warning') == warning
    top = retried(tmp_path, 'top', 'front', 'shellfront01')['parts'][1]
    assert top['views']['front']['status'] == 'pending' and top['model'] == BODY_SHELL_MODEL


# --- one PUT of the final key in S3, temporary file and rename on disk ---------------------------------------------------

def test_an_answer_saved_to_s3_is_one_put_of_its_final_key(remote, source, monkeypatch):
    root, s3 = remote
    serve(monkeypatch, lambda request: httpx.Response(200, headers={'x-request-id': 'fixture'}, json=answer()))
    assert edit(source, receipt_in(root)) == png()
    assert json.loads(s3.objects[KEY + '.response.json']) == answer()
    assert not [key for key in s3.puts if key.endswith('.partial')] and KEY + '.response.partial' not in s3.objects
    assert s3.calls['delete_object'] == s3.calls['copy_object'] == s3.calls['get_object'] == 0
    assert s3.puts.count(KEY + '.response.json') == 1


def test_an_answer_cut_off_on_its_way_to_s3_keeps_the_bytes_that_arrived(remote, source, monkeypatch):
    root, s3 = remote

    class Cut(httpx.SyncByteStream):
        def __iter__(self):
            yield b'{"data":'
            raise httpx.ReadError('connection reset')
    serve(monkeypatch, lambda request: httpx.Response(200, stream=Cut()))
    with pytest.raises(httpx.ReadError):
        edit(source, receipt_in(root))
    assert s3.objects[KEY + '.response.partial'] == b'{"data":' and KEY + '.response.json' not in s3.objects


@pytest.fixture
def quick_retries(monkeypatch):
    monkeypatch.setattr(run_lock, 'FINAL_WRITE_DELAYS', (0, 0))


def test_an_answer_the_store_refuses_once_is_saved_by_the_next_attempt(remote, source, monkeypatch, quick_retries):
    root, s3 = remote
    s3.refuse_puts[KEY + '.response.json'] = 1
    serve(monkeypatch, lambda request: httpx.Response(200, json=answer()))
    assert edit(source, receipt_in(root)) == png()
    assert json.loads(s3.objects[KEY + '.response.json']) == answer() and KEY + '.response.partial' not in s3.objects


def test_an_answer_the_store_keeps_refusing_is_kept_on_this_host_and_used_without_paying_again(remote, source, monkeypatch,
                                                                                               quick_retries):
    root, s3 = remote
    receipt = receipt_in(root)
    s3.refuse_puts[KEY + '.response.json'] = 3  # every attempt of the last save
    sent = []
    serve(monkeypatch, lambda request: (sent.append(request), httpx.Response(200, json=answer()))[1])
    with pytest.raises(ClientError) as refused:
        edit(source, receipt)
    kept = LocalPath(receipt.with_suffix('.response.partial'))
    assert json.loads(kept.read_bytes()) == answer() and KEY + '.response.json' not in s3.objects
    request = json.loads(receipt.with_suffix('.request.json').read_text())
    assert (request['http_status'], request['phase'], request['submission']) == (200, 'response_unsaved', 'unknown')
    # Paid for and not stored: not a plain failure, which an explicit retry would pay for again.
    status, failure = classify_image_failure(refused.value, receipt)
    assert (status, failure['category']) == ('submission_uncertain', 'local_processing')
    # The store is back: the kept answer is moved into place and used; nothing is requested again.
    serve(monkeypatch, never)
    assert edit(source, receipt) == png()
    assert json.loads(s3.objects[KEY + '.response.json']) == answer() and not kept.exists() and len(sent) == 1


def test_a_request_the_runtime_does_not_admit_is_not_sent_and_goes_out_later(tmp_path, source, monkeypatch):
    receipt = tmp_path / 'body-provider'
    sent = []
    serve(monkeypatch, lambda request: (sent.append(request), httpx.Response(200, json=answer()))[1])
    admit = images.paid_request

    @contextmanager
    def draining():
        raise RuntimeDraining('점검 중')
        yield
    monkeypatch.setattr(images, 'paid_request', draining)
    with pytest.raises(RuntimeDraining) as refused:
        edit(source, receipt)
    assert not sent and json.loads(receipt.with_suffix('.request.json').read_text())['submission'] == 'not_sent'
    assert classify_image_failure(refused.value, receipt)[0] == 'not_sent'
    # Admission is open again: the same receipt sends the request it never sent.
    monkeypatch.setattr(images, 'paid_request', admit)
    assert edit(source, receipt) == png() and len(sent) == 1


def test_on_disk_the_answer_is_still_staged_and_renamed(tmp_path, source, monkeypatch):
    renamed = []
    original = StoredPath.replace
    monkeypatch.setattr(StoredPath, 'replace', lambda self, target: (renamed.append(self.name), original(self, target))[1])
    serve(monkeypatch, lambda request: httpx.Response(200, json=answer()))
    receipt = tmp_path / 'body-provider'
    assert edit(source, receipt) == png()
    assert 'body-provider.response.partial' in renamed and receipt.with_suffix('.response.json').is_file()
    assert not receipt.with_suffix('.response.partial').exists()


def test_a_download_to_s3_is_one_put_of_the_final_key(remote, monkeypatch):
    root, s3 = remote
    output = root / 'characters' / 'A' / 'generated.glb'
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=rigged_glb()))) as client:
        download_glb(client, 'https://cdn.invalid/model.glb', output)
    assert s3.puts == ['assets/characters/A/generated.glb'] and s3.objects[s3.puts[0]] == rigged_glb()
    assert s3.calls['delete_object'] == s3.calls['copy_object'] == s3.calls['get_object'] == 0


def test_a_download_on_disk_is_staged_and_renamed(tmp_path, monkeypatch):
    renamed = []
    original = StoredPath.replace
    monkeypatch.setattr(StoredPath, 'replace', lambda self, target: (renamed.append((self.name, StoredPath(target).name)), original(self, target))[1])
    output = StoredPath(tmp_path / 'generated.glb')
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=rigged_glb()))) as client:
        download_glb(client, 'https://cdn.invalid/model.glb', output)
    assert renamed == [('generated.glb.part', 'generated.glb')] and output.read_bytes() == rigged_glb()
    assert not output.with_suffix('.glb.part').exists()


# --- the receipt is also written while httpx runs the request --------------------------------------------------------------

TRANSPORT_EVENTS = ('connection.connect_tcp.started', 'http11.send_request_headers.started', 'http11.send_request_body.complete')


def test_a_receipt_that_cannot_be_updated_during_transport_does_not_abort_the_paid_request(tmp_path, source, monkeypatch, caplog):
    receipt = tmp_path / 'body-provider'
    real = images._write_json
    unavailable = {'now': False}

    def write(path, value):
        if unavailable['now']:
            raise OSError('the record database is unavailable')
        return real(path, value)
    monkeypatch.setattr(images, '_write_json', write)

    def handler(request):
        # httpx reports each step of the request to the trace extension, inside the request. The start is on record
        # before the request is written (a start that cannot be recorded stops it: test_image_request_outcomes.py);
        # only the steps around it fail to save.
        for event in TRANSPORT_EVENTS:
            unavailable['now'] = event != 'http11.send_request_headers.started'
            try:
                request.extensions['trace'](event, {})
            finally:
                unavailable['now'] = False
        return httpx.Response(200, json=answer())
    serve(monkeypatch, handler)
    with caplog.at_level(logging.WARNING, logger=images.LOGGER.name):
        assert edit(source, receipt) == png()
    assert 'Image request receipt not updated' in caplog.text and 'OSError' in caplog.text
    assert json.loads(receipt.with_suffix('.request.json').read_text())['phase'] == 'response_saved'
    assert receipt.with_suffix('.response.json').is_file()


def test_the_receipt_written_before_the_request_is_still_required(tmp_path, source, monkeypatch):
    sent = []

    def write(path, value):
        raise OSError('the record database is unavailable')
    monkeypatch.setattr(images, '_write_json', write)
    serve(monkeypatch, lambda request: sent.append(request))
    with pytest.raises(OSError):
        edit(source, tmp_path / 'body-provider')
    assert not sent


# --- every image stage reads an answer kept on this host as the saved answer it is --------------------------------------

def answer_kept_on_this_host(directory):
    """A request whose answer arrived and was refused by the store: only the complete partial on this host has it."""
    receipt = directory / 'image-provider.json'
    receipt.with_suffix('.request.json').write_text(json.dumps(
        {'phase': 'response_unsaved', 'http_status': 200, 'request_started': True, 'submission': 'unknown'}))
    receipt.with_suffix('.response.partial').write_text(json.dumps(answer()))
    return receipt


def test_a_studio_generation_continues_from_an_answer_kept_on_this_host(tmp_path):
    from src.services.studio_generations import StudioGenerations
    receipt = answer_kept_on_this_host(tmp_path)
    # While its worker may still be writing the answer, it is only read.
    assert StudioGenerations._image_reason(tmp_path, {'files': {}}, idle=False)[0] is False
    assert receipt.with_suffix('.response.partial').exists()
    assert StudioGenerations._image_reason(tmp_path, {'files': {}}) == (True, None)
    assert receipt.with_suffix('.response.json').is_file()


def test_an_expression_generation_continues_from_an_answer_kept_on_this_host(tmp_path):
    from src.services.avatar_expression_generation import AvatarExpressionGeneration
    receipt = answer_kept_on_this_host(tmp_path)
    assert AvatarExpressionGeneration._resume_reason(tmp_path, {'status': 'paused'}, idle=False)[0] is False
    assert AvatarExpressionGeneration._resume_reason(tmp_path, {'status': 'paused'}) == (True, None)
    assert receipt.with_suffix('.response.json').is_file()


def test_an_animal_view_continues_from_an_answer_kept_on_this_host(tmp_path):
    from src.services.animal_production import AnimalProduction, StepPaused
    receipt = answer_kept_on_this_host(tmp_path)
    # Paid and kept: going on reads it, where an unconfirmed request would be blocked from any re-send.
    assert isinstance(AnimalProduction._image_failure(receipt, OSError('storage unavailable')), StepPaused)
    assert receipt.with_suffix('.response.json').is_file()
