"""Receipts of a paid OpenAI image request and the staging of downloaded files, on local disk and in S3.

S3 is a counting stand-in. Remote storage is told from the local disk by object_storage.is_remote: there one PUT of
the final key is atomic, and a temporary object that is renamed afterwards costs a GET, a PUT and a DELETE.
"""
import base64
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
import io
import json
import logging
from pathlib import Path as LocalPath

from botocore.exceptions import ClientError
import httpx
from PIL import Image
import pytest

from api.test_characters import rigged_glb
from src.services import avatar_openai_images as images
from src.services import object_storage, run_lock
from src.services.avatar_image_recovery import classify_image_failure, decorate_job, settle_interrupted
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
    state, receipt = stopped_attempt(tmp_path, {'phase': 'prepared', 'request_started': False, 'client_request_id': 'x'})
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
        # httpx reports each step of the request to the trace extension, inside the request.
        unavailable['now'] = True
        try:
            for event in TRANSPORT_EVENTS:
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
