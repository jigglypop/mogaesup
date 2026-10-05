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


@pytest.fixture
def blender_port_lock():
    """The global lock of a Blender port, removed afterwards: every Blender run of the host takes it."""
    path = Path(tempfile.gettempdir()) / 'asset-wardrobe-blender-62125.lock'
    path.unlink(missing_ok=True)
    yield path
    path.unlink(missing_ok=True)


def left_by_a_killed_split(tmp_path, port_lock, owner, runner=None, log=False):
    """The run and port locks a server killed during a material split leaves (both hold the same lease), and the
    split's worker directory with the receipt (`runner`: the process it names) and log written so far."""
    directory = tmp_path / 'run'
    output = directory / 'operations' / 'op-1' / 'blender'
    output.mkdir(parents=True)
    if runner is not None:
        (output / 'runner.json').write_text(json.dumps({'process': runner}), encoding='utf-8')
    if log:
        (output / 'blender.log').write_bytes(b'Blender 4.5\n')
    lease = {'version': 1, 'token': 'b' * 32, 'directory': str(directory.resolve()), 'owner': owner, 'blender': True,
             'runner': str((output / 'runner.json').resolve())}
    for path in (tmp_path / 'run.lock', port_lock):
        path.write_text(json.dumps(lease), encoding='utf-8')
    return directory, output / 'runner.json'


@pytest.fixture
def live_worker():
    """The identity of a process that still runs, standing in for a Blender worker the killed server left behind."""
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
    try:
        yield identity(child.pid)
    finally:
        child.kill()
        child.wait(10)


@pytest.mark.parametrize('case', ['worker running', 'log without receipt', 'unreadable receipt', 'owner running',
                                  'no receipt named', 'receipt outside the run'])
def test_a_blender_lock_is_kept_while_its_worker_may_still_run(tmp_path, exited, live_worker, blender_port_lock, case):
    owner = identity() if case == 'owner running' else exited
    runner = live_worker if case == 'worker running' else None if case == 'log without receipt' else exited
    directory, receipt = left_by_a_killed_split(tmp_path, blender_port_lock, owner, runner=runner, log=True)
    if case == 'unreadable receipt':
        receipt.write_text('{"process": ', encoding='utf-8')
    for path in (tmp_path / 'run.lock', blender_port_lock):
        lease = json.loads(path.read_text(encoding='utf-8'))
        if case == 'no receipt named':  # a Blender MCP port: its Blender is no worker of this run
            lease.pop('runner')
        if case == 'receipt outside the run':
            lease['runner'] = str((tmp_path / 'elsewhere' / 'runner.json').resolve())
        path.write_text(json.dumps(lease), encoding='utf-8')
    with pytest.raises(ValueError, match='busy'):
        with lock(directory, 62125, blender=receipt):
            pass
    with pytest.raises(ValueError, match='busy'):
        with lock(tmp_path / 'other-run', 62125):
            pass
    assert json.loads(blender_port_lock.read_text(encoding='utf-8'))['token'] == 'b' * 32
    assert json.loads((tmp_path / 'run.lock').read_text(encoding='utf-8'))['token'] == 'b' * 32


@pytest.mark.parametrize('case', ['worker exited', 'no worker started'])
def test_a_blender_lock_is_reclaimed_once_its_owner_and_worker_are_gone(tmp_path, exited, blender_port_lock, case):
    # A server OOM-killed during a split left both locks, and every later split of any character was busy until
    # someone removed them by hand.
    directory, receipt = left_by_a_killed_split(tmp_path, blender_port_lock, exited,
                                                runner=exited if case == 'worker exited' else None,
                                                log=case == 'worker exited')
    with lock(directory, 62125, blender=receipt):
        for path in (tmp_path / 'run.lock', blender_port_lock):
            saved = json.loads(path.read_text(encoding='utf-8'))
            assert saved['owner'] == identity() and saved['runner'] == str(receipt.resolve())
    assert not (tmp_path / 'run.lock').exists() and not blender_port_lock.exists()


def test_a_blender_lock_names_no_receipt_unless_the_run_gives_one(tmp_path, blender_port_lock):
    with lock(tmp_path / 'run', 62125):
        lease = json.loads(blender_port_lock.read_text(encoding='utf-8'))
        assert lease['blender'] is True and 'runner' not in lease
    with lock(tmp_path / 'run', 62125, blender=False):
        assert not blender_port_lock.exists()
        assert 'runner' not in json.loads((tmp_path / 'run.lock').read_text(encoding='utf-8'))


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


def test_accepted_work_whose_lock_is_claimed_at_acceptance_waits_only_while_the_lock_is_held(exited):
    # The executor's first save failed: `accepted` stays behind, and nothing will run it any more.
    accepted = {'status': 'accepted', 'process': identity()}
    assert worker_alive(accepted, True, claimed=True) and not worker_alive(accepted, False, claimed=True)
    assert not worker_alive({'status': 'running', 'process': identity()}, False, claimed=True)
    assert not worker_alive({'status': 'accepted', 'process': exited}, True, claimed=True)
    other = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
    try:
        assert worker_alive({'status': 'accepted', 'process': identity(other.pid)}, False, claimed=True)
    finally:
        other.kill()
        other.wait(10)


def test_a_claim_holds_the_key_until_its_executor_takes_it_over_and_ends():
    workers = WorkerLocks()
    assert workers.claim('job') and workers.busy('job')
    assert not workers.claim('job') and not workers.acquire('job')
    # Only the executor the claim waits for takes it, once.
    assert workers.acquire('job', claimed=True) and not workers.acquire('job', claimed=True)
    assert workers.busy('job') and workers.get('job').locked()
    workers.release('job')
    assert not workers.busy('job') and dict(workers) == {}
    # Without a claim an executor acquires as usual; a claim released unused leaves nothing behind.
    assert workers.acquire('job', claimed=True) and not workers.claim('job')
    workers.release('job')
    assert workers.claim('job')
    workers.release('job')
    assert not workers.busy('job') and workers.acquire('job')


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


@pytest.mark.parametrize('action, named', [('separate_parts', True), ('separate_materials', True),
                                           ('inspect_model', False)])
def test_a_material_split_names_its_worker_receipt_in_its_lock(tmp_path, action, named):
    from contextlib import contextmanager
    from src.services import character_actions
    taken = []

    class Pipeline:
        instance = 'executor-1'

        @contextmanager
        def lock(self, run, *, blender=False):
            taken.append(blender)
            yield

    run = tmp_path / 'run'
    character_actions._execute(Pipeline(), 'character', 1, run, run / 'operations' / 'op-1' / 'operation.json',
                               {'id': 'op-1', 'action_id': action})
    # The directory perform() gives the split's Blender worker, where blender_process writes runner.json.
    assert taken == [run / 'operations' / 'op-1' / 'blender' / 'runner.json' if named else False]
