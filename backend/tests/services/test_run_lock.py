"""Run lock files left by a killed process, and the in-process worker locks and last saves of background jobs."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from src.services import run_lock
from src.services.process_identity import identity
from src.services.run_lock import WorkerLocks, final_write, run_lock as lock, worker_alive


@pytest.fixture(scope='module')
def exited():
    """The identity of a process that has exited: what a lock left by kill -9 or an OOM names."""
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
    try:
        owner = identity(child.pid)
    finally:
        child.kill()
        child.wait(10)
    return owner


def leave_lock(path, owner, **fields):
    path.write_text(json.dumps({'version': 1, 'token': 'a' * 32, 'directory': str(path.with_suffix('')), 'owner': owner,
                                **fields}), encoding='utf-8')


def test_a_lock_of_an_exited_run_without_blender_is_reclaimed(tmp_path, exited):
    directory = tmp_path / 'run'
    leave_lock(tmp_path / 'run.lock', exited, blender=False)
    with lock(directory, 62124, blender=False):
        saved = json.loads((tmp_path / 'run.lock').read_text(encoding='utf-8'))
        assert saved['owner'] == identity() and saved['blender'] is False
    assert not (tmp_path / 'run.lock').exists()


def test_the_character_registry_lock_of_an_exited_process_is_reclaimed_even_from_before_the_blender_field(tmp_path, exited):
    # characters/.registry.lock blocked POST /api/characters for ever after one killed create.
    registry = tmp_path / 'characters' / '.registry'
    registry.parent.mkdir()
    leave_lock(registry.with_name('.registry.lock'), exited)
    with lock(registry, 62124, blender=False):
        pass


@pytest.mark.parametrize('fields', [{'blender': True}, {}, {'version': 2}])
def test_a_lock_that_may_belong_to_a_running_blender_is_kept(tmp_path, exited, fields):
    directory = tmp_path / 'run'
    leave_lock(tmp_path / 'run.lock', exited, **fields)
    with pytest.raises(ValueError, match='busy'):
        with lock(directory, 62124, blender=False):
            pass
    assert json.loads((tmp_path / 'run.lock').read_text(encoding='utf-8'))['owner'] == exited


def test_a_lock_of_a_live_process_or_an_unreadable_one_is_kept(tmp_path):
    directory = tmp_path / 'run'
    leave_lock(tmp_path / 'run.lock', identity(), blender=False)
    with pytest.raises(ValueError, match='busy'):
        with lock(directory, 62124, blender=False):
            pass
    (tmp_path / 'run.lock').write_text('not json', encoding='utf-8')
    with pytest.raises(ValueError, match='busy'):
        with lock(directory, 62124, blender=False):
            pass


def test_a_blender_port_lock_is_never_reclaimed(tmp_path, exited):
    port = tempfile.gettempdir()
    path = Path(port) / 'asset-wardrobe-blender-62125.lock'
    leave_lock(path, exited, blender=True)
    try:
        with pytest.raises(ValueError, match='busy'):
            with lock(tmp_path / 'run', 62125):
                pass
        assert not (tmp_path / 'run.lock').exists()
    finally:
        path.unlink(missing_ok=True)


def test_worker_locks_hold_one_worker_per_key_and_forget_it_afterwards():
    workers = WorkerLocks()
    assert workers.acquire('job') and not workers.acquire('job')
    assert workers.busy('job') and workers.get('job').locked() and workers.snapshot() == {'job'}
    workers.release('job')
    assert not workers.busy('job') and workers.get('job') is None and dict(workers) == {}
    workers.release('job')  # releasing twice changes nothing
    assert workers.acquire('job')


def test_a_running_record_of_this_process_runs_only_while_its_worker_holds_the_lock(exited):
    mine = {'status': 'running', 'process': identity()}
    assert worker_alive(mine, True) and not worker_alive(mine, False)
    # Accepted work is waiting for its worker; another live process's record is that process's to judge.
    assert worker_alive({'status': 'accepted', 'process': identity()}, False)
    other = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
    try:
        assert worker_alive({'status': 'running', 'process': identity(other.pid)}, False)
    finally:
        other.kill()
        other.wait(10)
    assert not worker_alive({'status': 'running', 'process': exited}, True)
    assert not worker_alive({'status': 'paused', 'process': identity()}, True)


def test_a_last_save_is_tried_again_and_its_last_error_raised(monkeypatch):
    monkeypatch.setattr(run_lock, 'FINAL_WRITE_DELAYS', (0, 0, 0))
    attempts = []

    def flaky():
        attempts.append(1)
        if len(attempts) < 3:
            raise OSError('storage blip')
        return 'saved'
    assert final_write(flaky) == 'saved' and len(attempts) == 3

    def down():
        attempts.append(1)
        raise ConnectionError('database down')
    attempts.clear()
    with pytest.raises(ConnectionError):
        final_write(down)
    assert len(attempts) == 4
