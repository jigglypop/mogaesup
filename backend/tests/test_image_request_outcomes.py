"""What a paid image request's receipt proves after a server error answer, a receipt write that fails, or a restart.

A request is sent again only when its receipt proves the provider never processed it. A server error answer, a request
whose outcome was never recorded and an older receipt that only lacks its start are unconfirmed: an explicit retry
carries the double-charge warning."""
import base64
import io
import json

import httpcore
import httpx
from PIL import Image
import pytest

from src.services import avatar_openai_images as images
from src.services.avatar_image_recovery import (UNCONFIRMED_RETRY, classify_image_failure, decorate_job,
                                                settle_interrupted)
from src.services.character_pipeline import PipelineError


def png():
    data = io.BytesIO()
    Image.new('RGBA', (16, 16), 'blue').save(data, format='PNG')
    return data.getvalue()


def answer():
    return {'data': [{'b64_json': base64.b64encode(png()).decode()}]}


@pytest.fixture
def source(tmp_path, monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'fixture-only')
    path = tmp_path / 'source.png'
    path.write_bytes(png())
    return path


def edit(source, receipt):
    return images.generate_part_image(source, 'whole character', images.DEFAULT_MODEL, images.DEFAULT_BASE, receipt=receipt)


def serve(monkeypatch, handler):
    posts = []

    def transport(request):
        posts.append(request)
        return handler(request)
    monkeypatch.setattr(images, 'image_transport', lambda: httpx.MockTransport(transport))
    return posts


def saved(receipt):
    return json.loads(receipt.with_suffix('.request.json').read_text())


# --- server error answers are unconfirmed -------------------------------------------------------------------------------

@pytest.mark.parametrize('status, error', [
    (500, {'type': 'server_error'}),
    (502, {}),
    (504, {}),
    # Outside the busy refusals that are asked again: a 503 that names a quota is not "nothing was generated".
    (503, {'code': 'insufficient_quota'}),
])
def test_a_server_error_answer_is_unconfirmed_and_never_sent_again(tmp_path, source, monkeypatch, status, error):
    receipt = tmp_path / 'body-provider'
    posts = serve(monkeypatch, lambda request: httpx.Response(status, headers={'x-request-id': 'fixture-5xx'},
                                                              json={'error': error}))
    with pytest.raises(images.OpenAIImageUnconfirmed) as unconfirmed:
        edit(source, receipt)
    assert unconfirmed.value.status_code == status and unconfirmed.value.diagnostic_id
    assert not isinstance(unconfirmed.value, httpx.HTTPStatusError)
    # No refusal on record: that would make it final and offer a plain retry.
    assert not receipt.with_suffix('.error.json').exists()
    request = saved(receipt)
    assert request['submission'] == 'unknown' and request['phase'] == 'response_unconfirmed'
    # The answer is kept as evidence only.
    assert request['http_status'] == status and request['request_id'] == 'fixture-5xx'
    assert request['response_bytes'] > 0 and len(request['response_sha256']) == 64
    with pytest.raises(PipelineError) as again:
        edit(source, receipt)
    assert again.value.code == 'image_response_uncertain' and len(posts) == 1
    state, failure = classify_image_failure(unconfirmed.value, receipt)
    assert state == 'submission_uncertain' and failure['category'] == 'provider_unavailable'
    assert failure['http_status'] == status and f'HTTP {status}' in failure['message']
    # The receipt alone gives the same answer, whatever exception the caller saw.
    assert classify_image_failure(OSError('later step'), receipt)[0] == 'submission_uncertain'


def test_a_client_error_answer_is_still_a_final_refusal(tmp_path, source, monkeypatch):
    receipt = tmp_path / 'body-provider'
    serve(monkeypatch, lambda request: httpx.Response(400, json={'error': {'type': 'invalid_request_error'}}))
    with pytest.raises(images.OpenAIImageHTTPError) as refused:
        edit(source, receipt)
    assert saved(receipt)['submission'] == 'rejected' and receipt.with_suffix('.error.json').is_file()
    assert classify_image_failure(refused.value, receipt)[0] == 'rejected'


def test_a_lost_answer_after_a_complete_upload_is_unconfirmed(tmp_path, source, monkeypatch):
    receipt = tmp_path / 'body-provider'

    def timeout(request):
        trace = request.extensions['trace']
        trace('http11.send_request_headers.started', {})
        trace('http11.send_request_body.complete', {})
        raise httpx.ReadTimeout('no answer')
    posts = serve(monkeypatch, timeout)
    with pytest.raises(httpx.ReadTimeout) as lost:
        edit(source, receipt)
    assert len(posts) == 1 and saved(receipt)['submission'] == 'unknown'
    assert classify_image_failure(lost.value, receipt)[0] == 'submission_uncertain'


# --- the studio offers an unconfirmed image only as an explicit retry with the double-charge warning ---------------------

def paused_job(tmp_path, view, receipt_files):
    """A paused job whose body front view stopped as `view`; `receipt_files` are written next to its receipt."""
    receipt = tmp_path / 'output' / 'body-front-provider'
    receipt.parent.mkdir(parents=True)
    for suffix, value in receipt_files.items():
        receipt.with_suffix(suffix).write_text(json.dumps(value))
    state = {'production_spec': {'generated_views': ['front']},
             'parts': [{'slot': 'body', 'image': {'status': 'pending'}, 'model': {'status': 'pending'},
                        'views': {'front': dict(view)}}]}
    (tmp_path / 'pipeline.json').write_text(json.dumps(state))
    public = {'status': 'pipeline_paused', 'next_actions': [], 'progress': {'message': ''},
              'parts': [{'slot': 'body', 'views': {'front': dict(view)}}]}
    decorate_job(tmp_path, public)
    return public


def test_an_unconfirmed_image_is_offered_only_with_the_double_charge_warning(tmp_path):
    failure = {'id': 'f00d01', 'category': 'provider_unavailable', 'message': '생성 서버 오류 응답 (HTTP 502) · 접수 여부 확인 불가'}
    public = paused_job(tmp_path, {'status': 'submission_uncertain', 'failure': failure}, {
        '.request.json': {'phase': 'response_unconfirmed', 'http_status': 502, 'request_started': True,
                          'submission': 'unknown'}})
    retry = next(action for action in public['next_actions'] if action['id'] == 'retry_image')
    batch = next(action for action in public['next_actions'] if action['id'] == 'retry_images')
    assert retry['failure_id'] == 'f00d01' and retry['warning'] == UNCONFIRMED_RETRY
    assert batch['warning'] == UNCONFIRMED_RETRY
    assert 'HTTP 502' in public['error']


def test_a_server_error_an_earlier_server_recorded_as_refused_is_shown_as_unconfirmed(tmp_path):
    failure = {'id': 'f00d02', 'category': 'provider_unavailable', 'message': '이미지 서비스 일시 오류'}
    public = paused_job(tmp_path, {'status': 'rejected', 'failure': failure}, {
        '.request.json': {'phase': 'response_rejected', 'http_status': 504, 'request_started': True,
                          'submission': 'rejected'},
        '.error.json': {'diagnostic_id': 'f00d02', 'http_status': 504, 'category': 'provider_unavailable',
                        'provider_error': {}}})
    view = public['parts'][0]['views']['front']
    assert view['status'] == 'submission_uncertain' and 'HTTP 504' in view['failure']['message']
    retry = next(action for action in public['next_actions'] if action['id'] == 'retry_image')
    assert retry['warning'] == UNCONFIRMED_RETRY


@pytest.mark.parametrize('status, error', [(400, {'code': 'moderation_blocked'}), (503, {'type': 'server_error'})])
def test_a_final_refusal_is_offered_without_the_warning(tmp_path, status, error):
    failure = {'id': 'f00d03', 'category': 'policy', 'message': ''}
    public = paused_job(tmp_path, {'status': 'rejected', 'failure': failure}, {
        '.request.json': {'phase': 'response_rejected', 'http_status': status, 'submission': 'rejected'},
        '.error.json': {'diagnostic_id': 'f00d03', 'http_status': status, 'provider_error': error}})
    assert public['parts'][0]['views']['front']['status'] == 'rejected'
    retry = next(action for action in public['next_actions'] if action['id'] == 'retry_image')
    assert 'warning' not in retry


# --- the start of a request is on record before its first byte ------------------------------------------------------------

RESPONSE = json.dumps(answer()).encode()


class Wire(httpcore.NetworkStream):
    """A connection that keeps every byte httpcore writes and answers with `reply`."""

    def __init__(self, written, reply):
        self.written, self.reply = written, list(reply)

    def read(self, max_bytes, timeout=None):
        return self.reply.pop(0) if self.reply else b''

    def write(self, buffer, timeout=None):
        self.written.append(bytes(buffer))

    def close(self):
        pass

    def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        return self

    def get_extra_info(self, info):
        return None


class Network(httpcore.NetworkBackend):
    def __init__(self):
        self.written = []

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        head = (f'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {len(RESPONSE)}\r\n\r\n').encode()
        return Wire(self.written, [head + RESPONSE])


def wire_client(network):
    """An httpx client that runs httpcore's real HTTP/1.1 connection, with its trace calls, over `network`."""
    transport = httpx.HTTPTransport()
    transport._pool = httpcore.ConnectionPool(network_backend=network)
    return httpx.Client(transport=transport)


PAYLOAD = {'model': images.DEFAULT_MODEL, 'prompt': 'whole character', 'n': 1, 'size': '1024x1024'}


def send(network, receipt):
    with wire_client(network) as client:
        return images.edit_response(client, 'https://images.invalid/v1', 'fixture-only', PAYLOAD, receipt)


@pytest.fixture
def storage(monkeypatch):
    """Receipt writes that fail while `failing(value)` is true for the receipt being written."""
    real = images._write_json
    rule = {'failing': lambda value: False}

    def write(path, value):
        if rule['failing'](value):
            raise OSError('the record database is unavailable')
        return real(path, value)
    monkeypatch.setattr(images, '_write_json', write)
    return rule


def starting(value):
    return value.get('phase') == 'sending' and value.get('request_started') is True


def test_the_wire_sees_the_request_when_its_start_is_on_record(tmp_path):
    network = Network()
    assert send(network, tmp_path / 'body-provider') == answer()
    assert b''.join(network.written).startswith(b'POST /v1/images/edits')
    assert saved(tmp_path / 'body-provider')['phase'] == 'response_saved'


def test_a_start_that_cannot_be_recorded_stops_the_request_before_its_first_byte(tmp_path, storage):
    receipt = tmp_path / 'body-provider'
    network = Network()
    storage['failing'] = starting
    with pytest.raises(images.ImageReceiptUnsaved) as stopped:
        send(network, receipt)
    # httpcore ran its connection and stopped at the trace call: no header or body byte reached the wire.
    assert network.written == []
    request = saved(receipt)
    assert request['submission'] == 'not_sent' and request['request_started'] is False
    assert request['start_unrecorded'] == 'OSError'
    assert 'http11.send_request_headers.started' in [item['event'] for item in request['events']]
    assert classify_image_failure(stopped.value, receipt)[0] == 'not_sent'
    # Nothing was sent, so the same request goes out once the receipt can be written.
    storage['failing'] = lambda value: False
    assert send(network, receipt) == answer()
    assert b''.join(network.written).startswith(b'POST /v1/images/edits')


def test_a_stop_that_cannot_record_its_outcome_either_still_reads_as_not_sent(tmp_path, storage):
    receipt = tmp_path / 'body-provider'
    network = Network()
    # The start and every later write fail: the receipt keeps what was written before the request.
    storage['failing'] = lambda value: value.get('request_started') is True or 'submission' in value or bool(value.get('events'))
    with pytest.raises(images.ImageReceiptUnsaved) as stopped:
        send(network, receipt)
    assert network.written == []
    request = saved(receipt)
    assert 'submission' not in request and request['durable_start'] is True and request['request_started'] is False
    assert classify_image_failure(stopped.value, receipt)[0] == 'not_sent'
    # A restart settles it as not sent, and the request may go out again.
    state = {'parts': [{'slot': 'top', 'views': {'front': {'status': 'submitting', 'attempted_at': 'x'}}}]}
    stopped_receipt = tmp_path / 'output' / 'top-front-provider'
    stopped_receipt.parent.mkdir()
    stopped_receipt.with_suffix('.request.json').write_text(json.dumps(request))
    assert settle_interrupted(tmp_path, state)
    assert state['parts'][0]['views']['front']['status'] == 'not_sent'
    storage['failing'] = lambda value: False
    assert send(network, receipt) == answer()


def test_an_older_receipt_that_only_lacks_its_start_is_never_settled_as_not_sent(tmp_path):
    # Written by a server that went on with the request when the start could not be recorded.
    receipt = tmp_path / 'output' / 'top-front-provider'
    receipt.parent.mkdir()
    receipt.with_suffix('.request.json').write_text(json.dumps(
        {'phase': 'prepared', 'request_started': False, 'client_request_id': 'x',
         'events': [{'event': 'connection.start_tls.complete', 'at_seconds': 0.2}]}))
    state = {'parts': [{'slot': 'top', 'views': {'front': {'status': 'submitting', 'attempted_at': 'x'}}}]}
    assert settle_interrupted(tmp_path, state)
    view = state['parts'][0]['views']['front']
    assert view['status'] == 'submission_uncertain' and view['failure']['category'] == 'provider_connection'
    assert 'submission' not in json.loads(receipt.with_suffix('.request.json').read_text())


def test_later_receipt_updates_never_abort_a_request_whose_start_is_on_record(tmp_path, storage):
    receipt = tmp_path / 'body-provider'
    network = Network()
    # Connection steps before the start and steps after the complete upload: only the trace calls httpx makes.
    storage['failing'] = lambda value: value.get('phase') == 'awaiting_response' or (
        value.get('phase') == 'prepared' and bool(value.get('events')))
    assert send(network, receipt) == answer()
    assert network.written and saved(receipt)['phase'] == 'response_saved'


# --- a failed last receipt write never replaces the provider's outcome --------------------------------------------------

def test_the_provider_failure_is_raised_when_its_outcome_cannot_be_recorded(tmp_path, source, monkeypatch, storage):
    receipt = tmp_path / 'body-provider'

    def lost(request):
        trace = request.extensions['trace']
        trace('http11.send_request_headers.started', {})
        trace('http11.send_request_body.complete', {})
        raise httpx.ReadError('connection reset')
    posts = serve(monkeypatch, lost)
    storage['failing'] = lambda value: 'submission' in value
    with pytest.raises(httpx.ReadError) as failure:
        edit(source, receipt)
    assert len(posts) == 1
    request = saved(receipt)
    assert request['request_started'] is True and 'submission' not in request
    assert classify_image_failure(failure.value, receipt)[0] == 'submission_uncertain'
    # A request that started with no recorded outcome is unconfirmed even when the caller only saw a local error.
    status, recorded = classify_image_failure(OSError('the record database is unavailable'), receipt)
    assert status == 'submission_uncertain' and recorded['category'] == 'provider_connection'
    with pytest.raises(PipelineError) as again:
        edit(source, receipt)
    assert again.value.code == 'image_response_uncertain' and len(posts) == 1
