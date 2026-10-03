"""Stage runs whose saves fail: a run that cannot be saved as running or as finished never keeps every stage busy."""
import json
from types import SimpleNamespace

import pytest

from src.services import avatar_stage_resume as stages, run_lock
from src.services.character_pipeline import read_json
from src.services.object_storage import StoredPath
from src.services.process_identity import identity


@pytest.fixture
def job(tmp_path, monkeypatch):
    monkeypatch.setattr(run_lock, 'FINAL_WRITE_DELAYS', (0, 0))
    directory = StoredPath(tmp_path / 'job')
    (directory / 'stage-runs').mkdir(parents=True)
    (directory / 'stage-runs' / 'current.json').write_text(json.dumps({'id': 'r1'}))
    factory = SimpleNamespace(directory=lambda owner, job_id: directory)
    return directory, factory


def save_run(directory, **record):
    (directory / 'stage-runs' / 'r1.json').write_text(json.dumps({'id': 'r1', 'stage': 'rig', **record}))


def test_a_run_of_this_process_is_active_only_while_its_worker_holds_the_lock(job):
    directory, _ = job
    save_run(directory, status='running', process=identity())
    assert stages.stage_run_active(directory)[1] is False
    assert stages._WORKERS.acquire(str(directory))
    try:
        assert stages.stage_run_active(directory)[1] is True
    finally:
        stages._WORKERS.release(str(directory))
    # Accepted work waits for its worker and stays active.
    save_run(directory, status='accepted', process=identity())
    assert stages.stage_run_active(directory)[1] is True


def test_a_run_that_cannot_be_saved_as_running_is_paused_instead_of_left_accepted(job, monkeypatch):
    directory, factory = job
    save_run(directory, status='accepted', process=identity())
    write = stages._write_json
    attempts = []

    def refuse_running(path, record):
        if record.get('status') == 'running':
            attempts.append(1)
            raise OSError('storage unavailable')
        return write(path, record)

    monkeypatch.setattr(stages, '_write_json', refuse_running)
    with pytest.raises(OSError):
        stages.AvatarStageResume(factory).execute(1, 'a' * 24, 'r1')
    record = read_json(directory / 'stage-runs' / 'r1.json')
    assert attempts == [1] and record['status'] == 'paused' and record['error']
    assert stages.stage_run_active(directory)[1] is False and stages._WORKERS == {}
