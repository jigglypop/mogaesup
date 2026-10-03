"""Persisted Meshy receipts: a task ID typed by hand recovers an uncertain submission and never replaces a saved one."""
import json
import sys

import httpx
import pytest

from src import character_cli
from src.services import character_jobs
from src.services.object_storage import StoredPath


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
