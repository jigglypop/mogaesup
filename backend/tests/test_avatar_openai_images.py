import base64
import io
import json
import os

import httpx
import pytest
from PIL import Image

from src.services import avatar_openai_images as images
from src.services.character_pipeline import PipelineError


def png():
    data = io.BytesIO()
    Image.new('RGBA', (16, 16), 'blue').save(data, format='PNG')
    return data.getvalue()


@pytest.mark.parametrize(('status', 'error', 'category'), [
    (400, {'type': 'invalid_request_error'}, 'invalid_request'),
    (400, {'param': 'model'}, 'model'),
    (400, {'code': 'invalid_image_size'}, 'size'),
    (401, {}, 'auth'),
    (400, {'code': 'content_policy_violation'}, 'policy'),
])
def test_provider_error_categories_are_guarded(status, error, category):
    assert images._error_category(status, error) == category


def test_large_reference_is_compact_and_original_is_unchanged(tmp_path):
    source = tmp_path/'reference.png'
    Image.frombytes('RGB', (1254, 1254), os.urandom(1254*1254*3)).save(source)
    original = source.read_bytes()
    url = images.reference_data_url(source)
    assert url.startswith('data:image/jpeg;base64,')
    data = base64.b64decode(url.split(',', 1)[1])
    assert len(data) < len(original)/2
    with Image.open(io.BytesIO(data)) as image:
        assert image.size == (1024, 1024)
    assert source.read_bytes() == original


@pytest.mark.parametrize('failure', [None, 'timeout', 'rejected', 'missing'])
def test_reference_edit_uses_exact_model_once(tmp_path, monkeypatch, failure):
    monkeypatch.setenv('OPENAI_API_KEY', 'fixture-only')
    source = tmp_path/'source.png'; source.write_bytes(png())
    calls = []
    def transport(request):
        calls.append(request)
        assert request.url.path == '/v1/images/edits'
        assert request.headers['authorization'] == 'Bearer fixture-only'
        assert b'gpt-image-2.5-sunburst' in request.content
        assert request.headers['content-type'] == 'application/json'
        payload = json.loads(request.content)
        assert payload['n'] == 1 and len(payload['images']) == 1
        assert base64.b64decode(payload['images'][0]['image_url'].split(',', 1)[1]) == png()
        assert b'crystal staff' in request.content
        if failure == 'timeout': raise httpx.ReadTimeout('lost response')
        if failure == 'rejected': return httpx.Response(404, json={'error': {'message': 'unavailable'}})
        return httpx.Response(200, json={'data': [] if failure else [{'b64_json': base64.b64encode(png()).decode()}]})
    monkeypatch.setattr(images, 'image_transport', lambda: httpx.MockTransport(transport))
    if failure:
        with pytest.raises((httpx.HTTPError, PipelineError)):
            images.generate_part_image(source, 'crystal staff', images.DEFAULT_MODEL, images.DEFAULT_BASE)
    else:
        assert images.generate_part_image(source, 'crystal staff', images.DEFAULT_MODEL, images.DEFAULT_BASE) == png()
    assert len(calls) == 1
    assert source.read_bytes() == png()


def test_response_receipt_reuses_received_bytes_without_post(tmp_path, monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'fixture-only')
    source = tmp_path/'source.png'; source.write_bytes(png())
    receipt = tmp_path/'body-provider'; calls = []
    def transport(request):
        calls.append(request)
        return httpx.Response(200, headers={'x-request-id': 'fixture-request'},
                              json={'data': [{'b64_json': base64.b64encode(png()).decode()}]})
    monkeypatch.setattr(images, 'image_transport', lambda: httpx.MockTransport(transport))
    for _ in range(2):
        assert images.generate_part_image(source, 'whole character', images.DEFAULT_MODEL, images.DEFAULT_BASE, receipt=receipt) == png()
    assert len(calls) == 1
    metadata = json.loads(receipt.with_suffix('.request.json').read_text())
    assert metadata['phase'] == 'response_saved' and metadata['request_id'] == 'fixture-request'
    assert 'fixture-only' not in receipt.with_suffix('.request.json').read_text()


def test_interrupted_response_keeps_partial_bytes_and_request_id(tmp_path, monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'fixture-only')
    source = tmp_path/'source.png'; source.write_bytes(png())
    receipt = tmp_path/'body-provider'; calls = []
    class BrokenStream(httpx.SyncByteStream):
        def __iter__(self):
            yield b'{"data":'
            raise httpx.ReadError('connection reset')
    def transport(request):
        calls.append(request)
        return httpx.Response(200, headers={'x-request-id': 'fixture-interrupted'}, stream=BrokenStream())
    monkeypatch.setattr(images, 'image_transport', lambda: httpx.MockTransport(transport))
    with pytest.raises(httpx.ReadError):
        images.generate_part_image(source, 'whole character', images.DEFAULT_MODEL, images.DEFAULT_BASE, receipt=receipt)
    assert len(calls) == 1
    assert receipt.with_suffix('.response.partial').read_bytes() == b'{"data":'
    assert not receipt.with_suffix('.response.json').exists()
    metadata = json.loads(receipt.with_suffix('.request.json').read_text())
    assert metadata['phase'] == 'response_headers'
    assert metadata['request_id'] == 'fixture-interrupted' and metadata['error_type'] == 'ReadError'


def test_rejected_response_is_sanitized_classified_and_never_reposted(tmp_path, monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'fixture-only')
    source = tmp_path/'source.png'; source.write_bytes(png())
    receipt = tmp_path/'body-provider'; calls = []
    private_url = 'https://private.invalid/source?credential=secret'
    def transport(request):
        calls.append(request)
        return httpx.Response(400, headers={'x-request-id': 'fixture-rejected'}, json={'error': {
            'message': 'Bad image at '+private_url,
            'type': 'invalid_request_error', 'param': 'size', 'code': 'invalid_image_size',
            'source_url': private_url,
        }})
    monkeypatch.setattr(images, 'image_transport', lambda: httpx.MockTransport(transport))
    for _ in range(2):
        with pytest.raises(images.OpenAIImageHTTPError) as error:
            images.generate_part_image(source, 'whole character', images.DEFAULT_MODEL,
                                       images.DEFAULT_BASE, receipt=receipt)
        assert error.value.category == 'size'
        assert error.value.diagnostic_id
    assert len(calls) == 1
    saved = json.loads(receipt.with_suffix('.error.json').read_text())
    metadata = json.loads(receipt.with_suffix('.request.json').read_text())
    assert saved['provider_error'] == {
        'code': 'invalid_image_size', 'type': 'invalid_request_error', 'param': 'size'}
    assert saved['request_id'] == 'fixture-rejected' and saved['http_status'] == 400
    assert saved['body_bytes'] > 0 and len(saved['body_sha256']) == 64
    assert metadata['phase'] == 'response_rejected'
    assert metadata['provider_error_category'] == 'size'
    assert private_url not in receipt.with_suffix('.error.json').read_text()
    assert private_url not in receipt.with_suffix('.request.json').read_text()


# --- automatic retries of requests the provider cannot have processed -------------------------------------------

@pytest.fixture
def retried(tmp_path, monkeypatch):
    """An image edit whose transport answers from `answers` in order; returns (run, posts, delays)."""
    monkeypatch.setenv('OPENAI_API_KEY', 'fixture-only')
    source = tmp_path/'source.png'; source.write_bytes(png())
    posts, delays, answers = [], [], []
    monkeypatch.setattr(images.time, 'sleep', delays.append)

    def transport(request):
        posts.append(request.content)
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer(request) if callable(answer) else answer
    monkeypatch.setattr(images, 'image_transport', lambda: httpx.MockTransport(transport))

    def run():
        return images.generate_part_image(source, 'whole character', images.DEFAULT_MODEL, images.DEFAULT_BASE,
                                          receipt=tmp_path/'body-provider')
    return run, answers, posts, delays, tmp_path/'body-provider'


def ok():
    return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(png()).decode()}]})


def sent(complete, error):
    """A transport failure after the request started; `complete`: the whole body reached the provider."""
    def answer(request):
        trace = request.extensions['trace']
        trace('http11.send_request_headers.started', {})
        if complete:
            trace('http11.send_request_body.complete', {})
        raise error
    return answer


def metadata(receipt):
    return json.loads(receipt.with_suffix('.request.json').read_text())


def test_a_busy_provider_is_asked_again_with_the_same_bytes_after_its_retry_after(retried):
    run, answers, posts, delays, receipt = retried
    answers.extend([httpx.Response(429, headers={'retry-after': '7'}, json={'error': {'code': 'rate_limit_exceeded'}}), ok()])
    assert run() == png()
    assert len(posts) == 2 and posts[0] == posts[1] and delays == [7.0]
    saved = metadata(receipt)
    assert [attempt['reason'] for attempt in saved['auto_retries']] == ['provider_busy']
    assert saved['auto_retries'][0]['http_status'] == 429 and saved['phase'] == 'response_saved'
    assert not receipt.with_suffix('.error.json').exists()


def test_retries_stop_after_their_limit_and_the_refusal_is_kept(retried):
    run, answers, posts, delays, receipt = retried
    answers.extend([httpx.Response(503, json={'error': {'type': 'server_error'}})] * 3)
    with pytest.raises(images.OpenAIImageHTTPError) as refused:
        run()
    assert refused.value.category == 'provider_unavailable'
    assert len(posts) == images.AUTO_RETRIES + 1 and len(delays) == images.AUTO_RETRIES
    assert json.loads(receipt.with_suffix('.error.json').read_text())['http_status'] == 503
    with pytest.raises(images.OpenAIImageHTTPError):
        run()
    assert len(posts) == images.AUTO_RETRIES + 1


@pytest.mark.parametrize('answer, reason', [
    (httpx.ConnectError('connection refused'), 'not_sent'),
    (sent(False, httpx.WriteError('reset while uploading')), 'incomplete_upload'),
])
def test_a_request_the_provider_never_received_whole_is_sent_again(retried, answer, reason):
    run, answers, posts, delays, receipt = retried
    answers.extend([answer, ok()])
    assert run() == png()
    assert len(posts) == 2 and posts[0] == posts[1] and delays == [1.5]
    saved = metadata(receipt)
    assert [attempt['reason'] for attempt in saved['auto_retries']] == [reason]
    # Each attempt has its own client request id.
    assert saved['auto_retries'][0]['client_request_id'] != saved['client_request_id']


@pytest.mark.parametrize('answer', [sent(True, httpx.ReadError('connection reset')), httpx.ReadTimeout('no answer')])
def test_a_request_that_may_have_been_processed_is_never_sent_again(retried, answer):
    run, answers, posts, delays, receipt = retried
    answers.append(answer)
    with pytest.raises(httpx.TransportError):
        run()
    assert len(posts) == 1 and delays == []
    saved = metadata(receipt)
    assert saved['submission'] == 'unknown' and 'auto_retries' not in saved
    # The saved intent now refuses another paid request until the operator decides.
    with pytest.raises(PipelineError) as uncertain:
        run()
    assert uncertain.value.code == 'image_response_uncertain' and len(posts) == 1


def test_a_tls_record_rejection_after_the_upload_is_sent_again(retried):
    run, answers, posts, delays, receipt = retried

    def rejected(request):
        trace = request.extensions['trace']
        trace('http11.send_request_headers.started', {})
        trace('http11.send_request_body.complete', {})
        failure = httpx.ReadError('tls failure')
        cause = OSError('bad record mac')
        cause.reason = 'SSLV3_ALERT_BAD_RECORD_MAC'
        trace('http11.receive_response_headers.failed', {'exception': cause})
        raise failure
    answers.extend([rejected, ok()])
    assert run() == png()
    assert [attempt['reason'] for attempt in metadata(receipt)['auto_retries']] == ['tls_rejected']
