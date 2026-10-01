"""Provider HTTP helpers: retried status reads, downloads that fail without a readable body, receipts that cannot block a task ID.

Every provider is an httpx.MockTransport; nothing leaves the machine.
"""
import json
import logging
import sys

import httpx
from PIL import Image
import pytest

from src.services import character_jobs, character_motion, meshy_outputs, runtime_activity, wardrobe
from src.services.character_pipeline import PipelineError
from src.services.wardrobe import Wardrobe, _digest, download_glb, get_with_retry


@pytest.fixture
def waits(monkeypatch):
    """The seconds the retry helper would have slept; no test sleeps for real."""
    waited = []
    monkeypatch.setattr(wardrobe, '_sleep', waited.append)
    return waited


def provider(*replies):
    """A client whose requests are answered by `replies` in order (the last repeats); an exception is raised."""
    calls = []

    def handler(request):
        calls.append(request)
        reply = replies[min(len(calls), len(replies)) - 1]
        if isinstance(reply, Exception):
            raise reply
        return reply

    return httpx.Client(base_url='https://provider.invalid', transport=httpx.MockTransport(handler)), calls


def unread(status):
    """An answer whose body is streamed and never read, like the one client.stream() hands over before raise_for_status."""
    return httpx.Response(status, stream=httpx.ByteStream(b'denied'))


def png(tmp_path):
    path = tmp_path / 'part.png'
    Image.new('RGB', (4, 4), 'white').save(path)
    return path


# --- get_with_retry ------------------------------------------------------------------------------------------------

def test_a_busy_provider_is_asked_again_with_growing_waits(waits):
    client, calls = provider(httpx.Response(503), httpx.Response(503), httpx.Response(200, json={'status': 'SUCCEEDED'}))
    assert get_with_retry(client, '/task/1').json() == {'status': 'SUCCEEDED'}
    assert len(calls) == 3 and waits == [1, 2]


@pytest.mark.parametrize('status', [429, 500, 502, 503, 504])
def test_every_listed_status_is_retried(waits, status):
    client, calls = provider(httpx.Response(status), httpx.Response(200, json={}))
    get_with_retry(client, '/task/1')
    assert len(calls) == 2


def test_the_read_gives_up_after_four_attempts(waits):
    client, calls = provider(httpx.Response(503))
    with pytest.raises(httpx.HTTPStatusError) as error:
        get_with_retry(client, '/task/1')
    assert error.value.response.status_code == 503
    assert len(calls) == 4 and waits == [1, 2, 4]


@pytest.mark.parametrize('status', [400, 401, 402, 403, 404, 422])
def test_other_statuses_raise_at_once(waits, status):
    client, calls = provider(httpx.Response(status, json={'message': 'no'}))
    with pytest.raises(httpx.HTTPStatusError):
        get_with_retry(client, '/task/1')
    assert len(calls) == 1 and waits == []


@pytest.mark.parametrize('failure', [httpx.ReadTimeout('slow'), httpx.ConnectError('down'), httpx.RemoteProtocolError('cut')])
def test_a_request_that_got_no_answer_is_asked_again(waits, failure):
    client, calls = provider(failure, httpx.Response(200, json={'ok': True}))
    assert get_with_retry(client, '/task/1').json() == {'ok': True}
    assert len(calls) == 2 and waits == [1]


def test_a_numeric_retry_after_is_honoured_up_to_thirty_seconds(waits):
    client, _ = provider(httpx.Response(429, headers={'retry-after': '7'}),
                         httpx.Response(429, headers={'retry-after': '999'}),
                         httpx.Response(429, headers={'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT'}),
                         httpx.Response(200, json={}))
    get_with_retry(client, '/task/1')
    assert waits == [7, 30, 4]


def test_a_post_is_never_sent_again(waits, tmp_path):
    client, calls = provider(httpx.Response(503))
    with pytest.raises(httpx.HTTPStatusError):
        character_jobs.generate(tmp_path / 'run', png(tmp_path), 1.2, client)
    assert [call.method for call in calls] == ['POST'] and waits == []
    assert character_jobs.state(tmp_path / 'run')['status'] == 'submission_rejected'


# --- the places that poll -------------------------------------------------------------------------------------------

def run_with_task(tmp_path, **fields):
    run = tmp_path / 'run'
    run.mkdir()
    (run / 'character.json').write_text(json.dumps({'stage': 'generation', 'status': 'PENDING', 'task_id': 'task-1', **fields}))
    return run


def test_refresh_survives_a_busy_provider(waits, tmp_path):
    run = run_with_task(tmp_path)
    client, calls = provider(httpx.Response(503), httpx.Response(503), httpx.Response(200, json={'status': 'SUCCEEDED', 'progress': 100}))
    value = character_jobs.refresh(run, client)
    assert value['status'] == 'SUCCEEDED' and character_jobs.state(run)['status'] == 'SUCCEEDED'
    assert json.loads((run / 'generation-result.json').read_text())['status'] == 'SUCCEEDED'
    assert len(calls) == 3 and all(call.method == 'GET' for call in calls)


def test_refresh_of_a_tripo_task_survives_a_gateway_error(waits, tmp_path):
    run = run_with_task(tmp_path, provider='tripo')
    done = {'code': 0, 'data': {'status': 'success', 'progress': 100, 'output': {'pbr_model': 'https://cdn.invalid/m.glb'}}}
    client, calls = provider(httpx.Response(502), httpx.Response(200, json=done))
    assert character_jobs.refresh(run, client)['status'] == 'SUCCEEDED'
    assert [call.url.path for call in calls] == ['/task/task-1'] * 2


def test_fetching_a_task_saves_nothing_until_it_is_recorded(waits, tmp_path):
    run = run_with_task(tmp_path)
    client, _ = provider(httpx.Response(200, json={'status': 'SUCCEEDED', 'progress': 100}))
    value = character_jobs.state(run)
    task = character_jobs.fetch_task(client, value, 'task-1')
    assert not (run / 'generation-result.json').exists() and character_jobs.state(run)['status'] == 'PENDING'
    character_jobs.record_task(run, value, 'task-1', task)
    assert character_jobs.state(run)['status'] == 'SUCCEEDED' and (run / 'generation-result.json').is_file()


def test_motion_task_reads_survive_a_busy_provider(waits, tmp_path):
    pack = {'submitted_tasks': 1, 'max_new_tasks': 1, 'tasks': {'rig': {'task_id': 'rig-1', 'status': 'PENDING'}}}
    client, calls = provider(httpx.ReadTimeout('slow'), httpx.Response(200, json={'status': 'SUCCEEDED', 'result': {'rigged_character_glb_url': 'x'}}))
    value = character_motion._task(tmp_path, pack, 'rig', character_motion.ENDPOINTS['rig'], {}, client)
    assert value['status'] == 'SUCCEEDED' and len(calls) == 2


def test_a_motion_submission_is_still_sent_once(waits, tmp_path):
    pack = {'submitted_tasks': 0, 'max_new_tasks': 1, 'tasks': {}}
    client, calls = provider(httpx.Response(503))
    with pytest.raises(httpx.HTTPStatusError):
        character_motion._task(tmp_path, pack, 'clip', character_motion.ENDPOINTS['animation'], {'rig_task_id': 'r', 'action_id': 1}, client)
    assert [call.method for call in calls] == ['POST'] and waits == []


def prepared(tmp_path):
    wardrobe_run = Wardrobe(tmp_path, object())
    template, reference = tmp_path / 'template.glb', tmp_path / 'image.png'
    template.write_bytes(b'model')
    reference.write_bytes(b'image')
    wardrobe_run.save({'status': 'prepared', 'template': str(template), 'reference': str(reference),
                       'template_sha256': _digest(template), 'reference_sha256': _digest(reference)})
    return wardrobe_run


def test_wardrobe_status_survives_a_busy_provider(waits, tmp_path):
    run = prepared(tmp_path)
    state = run.state()
    run.save({**state, 'status': 'submitted', 'task_id': 'task-1'})
    client, calls = provider(httpx.Response(503), httpx.Response(200, json={'status': 'SUCCEEDED', 'model_urls': {'glb': 'https://cdn.invalid/a.glb'}}))
    assert run.status(client)['status'] == 'generated' and len(calls) == 2


def test_wardrobe_submission_counts_as_a_paid_request_while_in_flight(tmp_path):
    run = prepared(tmp_path)
    counted = []

    def handler(request):
        counted.append(runtime_activity.snapshot()['paid_requests'])
        return httpx.Response(200, json={'result': 'task-1'})

    with httpx.Client(base_url='https://provider.invalid', transport=httpx.MockTransport(handler)) as client:
        run.submit(client)
    assert counted == [1] and runtime_activity.snapshot()['paid_requests'] == 0


# --- downloads ------------------------------------------------------------------------------------------------------

def test_a_refused_download_is_a_pipeline_error_naming_the_status(tmp_path):
    output = tmp_path / 'model.glb'
    with httpx.Client(transport=httpx.MockTransport(lambda request: unread(403))) as client:
        with pytest.raises(PipelineError) as error:
            download_glb(client, 'https://cdn.invalid/model.glb', output)
    assert error.value.code == 'download_failed' and error.value.status == 502 and 'HTTP 403' in error.value.message
    assert not output.exists()


def test_a_download_that_never_connected_is_a_pipeline_error(tmp_path):
    def handler(request):
        raise httpx.ConnectError('private host name must not leak', request=request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(PipelineError) as error:
            download_glb(client, 'https://cdn.invalid/model.glb', tmp_path / 'model.glb')
    assert error.value.code == 'download_failed' and 'private' not in error.value.message


def test_a_download_cut_off_midway_is_a_pipeline_error(tmp_path):
    class Cut(httpx.SyncByteStream):
        def __iter__(self):
            yield b'glTF'
            raise httpx.ReadError('reset')

    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, stream=Cut()))) as client:
        with pytest.raises(PipelineError) as error:
            download_glb(client, 'https://cdn.invalid/model.glb', tmp_path / 'model.glb')
    assert error.value.code == 'download_failed'


def test_download_of_a_task_stops_with_a_pipeline_error_and_keeps_the_receipts(tmp_path, monkeypatch):
    run = run_with_task(tmp_path, status='SUCCEEDED')
    (run / 'generation-result.json').write_text(json.dumps({'status': 'SUCCEEDED', 'model_urls': {'glb': 'https://cdn.invalid/m.glb'}}))
    client_type = httpx.Client
    monkeypatch.setattr(httpx, 'Client', lambda **kwargs: client_type(**kwargs, transport=httpx.MockTransport(lambda request: unread(403))))
    with pytest.raises(PipelineError) as error:
        character_jobs.download(run, 'generation')
    assert error.value.code == 'download_failed'
    assert not (run / 'generation-artifacts.json').exists() and not (run / 'generated.glb').exists()


def test_an_extra_provider_file_that_cannot_be_downloaded_is_a_pipeline_error(tmp_path, monkeypatch):
    monkeypatch.setenv('MESHY_API_KEY', 'fixture-key')
    run, job = tmp_path / 'part', tmp_path / 'job'
    run.mkdir(), (job / 'output').mkdir(parents=True)
    (job / 'pipeline.json').write_text(json.dumps({'meshy_base': 'https://api.meshy.ai'}))
    (run / 'generation-result.json').write_text(json.dumps({'status': 'SUCCEEDED'}))
    (run / 'character.json').write_text(json.dumps({'stage': 'generation', 'status': 'SUCCEEDED', 'task_id': 'task-1',
        'preserve_download_detail': True, 'generation_settings': {'target_formats': ['glb', 'obj']}}))

    def handler(request):
        if request.url.host == 'cdn.invalid':
            return unread(403)
        # The status read that renews the expiring links.
        return httpx.Response(200, json={'status': 'SUCCEEDED', 'model_urls': {'obj': 'https://cdn.invalid/model.obj'}})

    client_type = httpx.Client
    monkeypatch.setattr(httpx, 'Client', lambda **kwargs: client_type(**kwargs, transport=httpx.MockTransport(handler)))
    with pytest.raises(PipelineError) as error:
        meshy_outputs.publish_extras(run, job, 'top')
    assert error.value.code == 'download_failed' and 'HTTP 403' in error.value.message


def test_the_character_cli_reports_a_failed_download_without_a_traceback(tmp_path, monkeypatch):
    import runpy
    from src import character_cli
    run = run_with_task(tmp_path, status='SUCCEEDED')
    (run / 'generation-result.json').write_text(json.dumps({'status': 'SUCCEEDED', 'model_urls': {'glb': 'https://cdn.invalid/m.glb'}}))
    client_type = httpx.Client
    monkeypatch.setattr(httpx, 'Client', lambda **kwargs: client_type(**kwargs, transport=httpx.MockTransport(lambda request: unread(403))))
    monkeypatch.setattr(sys, 'argv', ['character', '--run', str(run), 'download', '--stage', 'generation'])
    with pytest.raises(SystemExit) as error:
        runpy.run_path(character_cli.__file__, run_name='__main__')
    assert 'HTTP 403' in str(error.value.code)


# --- submission receipts --------------------------------------------------------------------------------------------

def failing_receipts(monkeypatch):
    real = character_jobs._write_json

    def write(path, value):
        if path.name.endswith('-submission-response.json'):
            raise OSError('the record database is unavailable')
        return real(path, value)

    monkeypatch.setattr(character_jobs, '_write_json', write)


def test_a_receipt_that_cannot_be_saved_does_not_lose_the_task_id(tmp_path, monkeypatch, caplog):
    failing_receipts(monkeypatch)
    client, calls = provider(httpx.Response(200, json={'result': 'task-1'}))
    with caplog.at_level(logging.WARNING, logger=character_jobs.LOGGER.name):
        value = character_jobs.generate(tmp_path / 'run', png(tmp_path), 1.2, client)
    assert value['task_id'] == 'task-1' and value['status'] == 'PENDING'
    assert character_jobs.state(tmp_path / 'run')['task_id'] == 'task-1' and len(calls) == 1
    assert 'Submission receipt not saved' in caplog.text and 'OSError' in caplog.text


def test_a_motion_task_keeps_its_task_id_when_its_receipt_is_lost(tmp_path, monkeypatch):
    failing_receipts(monkeypatch)
    pack = {'submitted_tasks': 0, 'max_new_tasks': 1, 'tasks': {}}
    client, _ = provider(httpx.Response(200, json={'result': 'clip-1'}), httpx.Response(200, json={'status': 'IN_PROGRESS'}))
    value = character_motion._task(tmp_path, pack, 'clip', character_motion.ENDPOINTS['animation'], {'rig_task_id': 'r', 'action_id': 1}, client)
    assert value['task_id'] == 'clip-1'
