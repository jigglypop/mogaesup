"""Persisted Meshy receipts: a task ID typed by hand recovers an uncertain submission and never replaces a saved one."""
from contextlib import contextmanager
import io
import json
import sys

import httpx
from PIL import Image
import pytest

from src import character_cli
from src.services import character_jobs, run_lock
from src.services.object_storage import StoredPath
from src.services.runtime_activity import RuntimeDraining


def receipt(tmp_path, **value):
    run = StoredPath(tmp_path / 'run')
    run.mkdir(parents=True, exist_ok=True)
    (run / 'character.json').write_text(json.dumps({'stage': 'generation', **value}), encoding='utf-8')
    return run


def provider(task):
    calls = []

    def answer(request):
        calls.append(request.url.path)
        return httpx.Response(200, json=task)
    return httpx.Client(base_url='https://api.meshy.invalid', transport=httpx.MockTransport(answer)), calls


@pytest.mark.parametrize('saved', [{'status': 'IN_PROGRESS', 'task_id': 'task-1'},
                                   {'status': 'submission_uncertain', 'task_id': 'task-1'},
                                   {'status': 'submission_rejected', 'http_status': 402}])
def test_a_different_task_id_is_refused_unless_an_uncertain_submission_has_none(tmp_path, saved):
    run = receipt(tmp_path, **saved)
    client, calls = provider({'status': 'SUCCEEDED', 'progress': 100})
    with pytest.raises(ValueError, match='uncertain submission'):
        character_jobs.refresh(run, client, 'task-typo')
    assert calls == [] and character_jobs.state(run) == {'stage': 'generation', **saved}


def test_the_saved_task_id_may_be_named_and_an_uncertain_submission_is_recovered(tmp_path):
    run = receipt(tmp_path, status='IN_PROGRESS', task_id='task-1')
    client, calls = provider({'status': 'SUCCEEDED', 'progress': 100})
    assert character_jobs.refresh(run, client, 'task-1')['status'] == 'SUCCEEDED'
    uncertain = receipt(tmp_path / 'other', status='submission_uncertain')
    recovered = character_jobs.refresh(uncertain, client, 'task-2')
    assert recovered['task_id'] == 'task-2' and recovered['status'] == 'SUCCEEDED'
    assert calls == ['/openapi/v1/image-to-3d/task-1', '/openapi/v1/image-to-3d/task-2']


def test_the_cli_refuses_a_task_id_that_would_detach_the_saved_task(tmp_path, monkeypatch, capsys):
    run = receipt(tmp_path, status='IN_PROGRESS', task_id='task-1')
    monkeypatch.setenv('MESHY_API_KEY', 'fixture-key')
    monkeypatch.setattr(sys, 'argv', ['character_cli', '--run', str(run), 'status', '--task-id', 'task-typo'])
    with pytest.raises(SystemExit) as stopped:
        character_cli.main()
    assert stopped.value.code == 2 and 'uncertain submission' in capsys.readouterr().err
    assert character_jobs.state(run)['task_id'] == 'task-1'


# --- a submission the provider accepted keeps its task --------------------------------------------------------------

def answered(run, status, body, stage='generation'):
    (run / f'{stage}-submission-response.json').write_text(json.dumps(
        {'http_status': status, 'request_id': 'r-1', 'body': body}), encoding='utf-8')


def test_an_accepted_submission_whose_task_id_was_not_saved_adopts_it_from_the_saved_answer(tmp_path):
    run = receipt(tmp_path, status='submission_uncertain')
    answered(run, 202, json.dumps({'result': 'task-accepted'}))
    adopted = character_jobs.adopt_submitted_task(run, character_jobs.state(run))
    assert adopted['task_id'] == 'task-accepted' and adopted['status'] == 'PENDING'
    assert character_jobs.state(run) == adopted and adopted['recovery_method'] == 'submission_response'


@pytest.mark.parametrize('status, body, provider', [
    (500, json.dumps({'result': 'task-x'}), None),            # not an acceptance
    (200, 'not json', None),
    (200, json.dumps({'result': 'bad id!'}), None),
    (200, json.dumps({'code': 2010, 'data': {}}), 'tripo'),  # a refusal inside a 200 answer
])
def test_an_answer_that_names_no_accepted_task_leaves_the_submission_unconfirmed(tmp_path, status, body, provider):
    run = receipt(tmp_path, status='submission_uncertain', **({'provider': provider} if provider else {}))
    answered(run, status, body)
    saved = character_jobs.state(run)
    assert character_jobs.adopt_submitted_task(run, saved) == saved == character_jobs.state(run)


def png():
    content = io.BytesIO()
    Image.new('RGBA', (4, 4), 'white').save(content, format='PNG')
    return content.getvalue()


def submission(tmp_path, answer):
    image = StoredPath(tmp_path / 'part.png')
    image.write_bytes(png())
    sent = []

    def handler(request):
        sent.append(request)
        return answer(request)
    return StoredPath(tmp_path / 'run'), image, httpx.Client(base_url='https://api.meshy.invalid',
                                                            transport=httpx.MockTransport(handler)), sent


def test_the_task_id_of_an_accepted_submission_survives_a_storage_blip(tmp_path, monkeypatch):
    monkeypatch.setattr(run_lock, 'FINAL_WRITE_DELAYS', (0, 0))
    run, image, client, sent = submission(tmp_path, lambda request: httpx.Response(202, json={'result': 'task-1'}))
    real, refused = character_jobs._write_json, []

    def write(path, value):
        if path.name == 'character.json' and value.get('task_id') and not refused:
            refused.append(path.name)
            raise OSError('storage blip')
        return real(path, value)
    monkeypatch.setattr(character_jobs, '_write_json', write)
    assert character_jobs.generate(run, image, 1.2, client)['task_id'] == 'task-1'
    assert refused and character_jobs.state(run)['task_id'] == 'task-1' and len(sent) == 1


def test_a_submission_the_runtime_does_not_admit_leaves_no_uncertain_receipt(tmp_path, monkeypatch):
    run, image, client, sent = submission(tmp_path, lambda request: httpx.Response(202, json={'result': 'task-1'}))
    admit = character_jobs.paid_request

    @contextmanager
    def draining():
        raise RuntimeDraining('점검 중')
        yield
    monkeypatch.setattr(character_jobs, 'paid_request', draining)
    with pytest.raises(RuntimeDraining):
        character_jobs.generate(run, image, 1.2, client)
    # Nothing was sent: no receipt claims an unconfirmed submission, and the same request goes out once admitted.
    assert not sent and not (run / 'character.json').exists()
    monkeypatch.setattr(character_jobs, 'paid_request', admit)
    assert character_jobs.generate(run, image, 1.2, client)['task_id'] == 'task-1' and len(sent) == 1


def test_a_poll_that_changes_nothing_writes_nothing(tmp_path, monkeypatch):
    run = receipt(tmp_path, status='PENDING', task_id='task-1')
    client, calls = provider({'status': 'IN_PROGRESS', 'progress': 40})
    writes, real = [], character_jobs._write_json
    monkeypatch.setattr(character_jobs, '_write_json', lambda path, value: (writes.append(path.name), real(path, value))[1])
    character_jobs.refresh(run, client)
    assert sorted(writes) == ['character.json', 'generation-result.json']
    writes.clear()
    character_jobs.refresh(run, client)
    assert writes == [] and character_jobs.state(run)['status'] == 'IN_PROGRESS' and len(calls) == 2
