"""Recovering a part separation whose server process died: what the run left on disk and the Blender workers' own
work leases decide, never the `running` record alone."""

from contextlib import ExitStack
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

import pytest

from api.test_characters import rigged_glb
from src.services import avatar_factory, character_actions, character_parts, character_recovery, runtime_activity
from src.services.asset_editor import _write_json
from src.services.character_pipeline import CharacterPipeline, PipelineError, read_json
from src.services.character_recovery import recover

PORT = 62131
# This test process under another start time: a process that has exited, as the killed server has.
EXITED = {'pid': os.getpid(), 'created_at': 1.5}


class Crash(KeyboardInterrupt):
    """The server process ends here (OOM, a container restart); like a real crash it leaves the run's locks behind."""


def port_lock():
    """The Blender port lock every split of this pipeline takes (run_lock)."""
    return Path(tempfile.gettempdir()) / f'asset-wardrobe-blender-{PORT}.lock'


class SlotsTaken:
    """Every Blender slot stays with assemblies until the server dies: the split never gets to start its worker."""
    def __enter__(self):
        raise Crash

    def __exit__(self, *exc):
        return False


@pytest.fixture
def character(tmp_path, monkeypatch):
    """A character with an inspected model that Blender may split."""
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path / 'data'))
    monkeypatch.setattr(character_parts, 'blender_executable', lambda: 'blender')
    pipeline = CharacterPipeline(tmp_path / 'data', port=PORT)
    value = pipeline.create('Split', 1.7, 1)
    value = pipeline.upload(value['id'], 1, rigged_glb(), 'model', value['revision'])
    operation, _ = pipeline.accept(value['id'], 1, 'inspect_model', 'inspect-request-1', value['revision'], {})
    character_actions.execute(pipeline, value['id'], 1, operation['id'])
    _, run, control = pipeline.entry(value['id'], 1)
    control['inspection']['material_boundaries'] = True  # The fixture model has one material; nothing splits it here.
    _write_json(run / 'control.json', control)
    yield pipeline, value['id'], run
    port_lock().unlink(missing_ok=True)


def split_until_the_server_dies(pipeline, character_id):
    revision = pipeline.detail(character_id, 1)['revision']
    operation, _ = pipeline.accept(character_id, 1, 'separate_materials', 'split-request-1', revision, {})
    with pytest.raises(Crash):
        character_actions.execute(pipeline, character_id, 1, operation['id'])
    return operation['id']


def restart(pipeline, character_id, run, operation_id):
    """The records and locks the killed server left name a process that has exited; a new server process starts."""
    path = run / 'operations' / operation_id / 'operation.json'
    _write_json(path, {**read_json(path), 'executor_process': EXITED})
    for lock in (run.with_name(run.name + '.lock'), port_lock()):
        lock.write_text(json.dumps({**json.loads(lock.read_text(encoding='utf-8')), 'owner': EXITED}), encoding='utf-8')
    runner = path.parent / 'blender' / 'runner.json'
    if runner.exists():
        _write_json(runner, {**read_json(runner), 'process': EXITED})
    restarted = CharacterPipeline(pipeline.root, port=PORT)
    detail = restarted.detail(character_id, 1)
    assert detail['operation']['status'] == 'recovery_required'
    assert not any(action['enabled'] for action in detail['next_actions'])
    return restarted, detail['revision']


def assert_released(pipeline, character_id, run):
    assert not run.with_name(run.name + '.lock').exists()
    assert not port_lock().exists()
    detail = pipeline.detail(character_id, 1)
    assert detail['model_id'] == 'imported'
    assert any(action['enabled'] for action in detail['next_actions'])


def test_a_split_whose_server_died_waiting_for_a_blender_slot_is_recovered(character, monkeypatch):
    pipeline, character_id, run = character
    monkeypatch.setattr(avatar_factory, '_QUEUE', SlotsTaken())
    operation_id = split_until_the_server_dies(pipeline, character_id)
    output = run / 'operations' / operation_id / 'blender'
    assert (output / 'input.json').is_file()
    assert not (output / 'runner.json').exists() and not (output / 'blender.log').exists()
    restarted, revision = restart(pipeline, character_id, run, operation_id)
    # After the restart an assembly runs a Blender worker of its own; this split never started one.
    with runtime_activity.running_task():
        monkeypatch.setenv('ASSET_RUNTIME_GRANT', str(runtime_activity._admitted.get()))
        with runtime_activity.worker_task():
            assert runtime_activity.live_workers() == 1
            recovered = recover(restarted, character_id, 1, operation_id, revision)
    assert recovered['status'] == 'failed' and recovered['error']['code'] == 'executor_interrupted'
    assert read_json(output.parent / 'operation.json')['recovery_result'] == 'interrupted'
    assert_released(restarted, character_id, run)


def test_a_worker_started_unrecorded_is_waited_for_while_it_holds_its_own_lease(character, monkeypatch, tmp_path):
    pipeline, character_id, run = character
    bootstrap = Path(runtime_activity.__file__).with_name('runtime_blender_bootstrap.py')
    ready, finish = tmp_path / 'ready', tmp_path / 'finish'
    code = ('import runpy,sys,time; from pathlib import Path; runpy.run_path(sys.argv[1]); '
            'Path(sys.argv[2]).touch();\nwhile not Path(sys.argv[3]).exists(): time.sleep(.02)')
    start, workers = subprocess.Popen, []

    def blender(command, **kwargs):
        # The worker gets past its bootstrap, then the server dies before runner.json names it.
        workers.append(start([sys.executable, '-c', code, str(bootstrap), str(ready), str(finish)], env=kwargs['env']))
        deadline = time.monotonic() + 10
        while not ready.exists() and workers[0].poll() is None and time.monotonic() < deadline:
            time.sleep(.01)
        assert ready.exists(), workers[0].returncode
        raise Crash

    monkeypatch.setattr(subprocess, 'Popen', blender)
    try:
        operation_id = split_until_the_server_dies(pipeline, character_id)
        output = run / 'operations' / operation_id / 'blender'
        assert (output / 'blender.log').is_file() and not (output / 'runner.json').exists()
        restarted, revision = restart(pipeline, character_id, run, operation_id)
        # The recovery request holds an admission lease of its own, as every POST does: only a worker's lease counts.
        with runtime_activity.running_task():
            with pytest.raises(PipelineError) as waiting:
                recover(restarted, character_id, 1, operation_id, revision)
        assert waiting.value.code == 'worker_unconfirmed'
        assert read_json(output.parent / 'operation.json')['status'] == 'running'
        finish.touch()
        assert workers[0].wait(timeout=10) == 0
        with runtime_activity.running_task():
            recovered = recover(restarted, character_id, 1, operation_id, revision)
        assert recovered['status'] == 'failed' and recovered['error']['code'] == 'executor_interrupted'
        assert_released(restarted, character_id, run)
    finally:
        for worker in workers:
            if worker.poll() is None:
                worker.kill()
                worker.wait(timeout=5)


def test_a_completion_that_can_never_be_adopted_fails_the_split_and_keeps_its_files(character, monkeypatch):
    pipeline, character_id, run = character

    class Sealed:
        """A worker that sealed outputs that do not match its input as the server died."""
        def __init__(self, command, **kwargs):
            self.pid, self.output = os.getpid(), Path(command[-1]).parent

        def wait(self, timeout=None):
            (self.output / 'worker-complete.json').write_text(json.dumps({'source_sha256': 'f' * 64, 'files': {}}))
            raise Crash

        def poll(self):
            return 0

    monkeypatch.setattr(subprocess, 'Popen', Sealed)
    operation_id = split_until_the_server_dies(pipeline, character_id)
    output = run / 'operations' / operation_id / 'blender'
    restarted, revision = restart(pipeline, character_id, run, operation_id)
    finalize = character_parts.finalize

    def unreadable(model, directory):
        raise PermissionError('read refused')

    # A read that failed may pass on the next attempt: the split and its locks stay.
    monkeypatch.setattr(character_parts, 'finalize', unreadable)
    with pytest.raises(PipelineError) as retry:
        recover(restarted, character_id, 1, operation_id, revision)
    assert retry.value.code == 'completion_invalid'
    assert restarted.detail(character_id, 1)['operation']['status'] == 'recovery_required'
    monkeypatch.setattr(character_parts, 'finalize', finalize)
    recovered = recover(restarted, character_id, 1, operation_id, revision)
    assert recovered['status'] == 'failed' and recovered['error']['code'] == 'completion_invalid'
    assert read_json(output.parent / 'operation.json')['recovery_result'] == 'completion_invalid'
    assert (output / 'worker-complete.json').is_file() and (output / 'runner.json').is_file()
    assert_released(restarted, character_id, run)


def test_a_split_whose_blender_lock_another_split_reclaimed_is_still_recovered(character, monkeypatch):
    pipeline, character_id, run = character
    monkeypatch.setattr(avatar_factory, '_QUEUE', SlotsTaken())
    operation_id = split_until_the_server_dies(pipeline, character_id)
    restarted, revision = restart(pipeline, character_id, run, operation_id)
    # Another character's split takes the Blender lock the killed one left: no receipt, no log (run_lock._worker_gone).
    other = restarted.create('Other', 1.7, 1)
    _, other_run, _ = restarted.entry(other['id'], 1)
    with restarted.lock(other_run, blender=other_run / 'operations' / 'x' / 'blender' / 'runner.json'):
        assert json.loads(port_lock().read_text(encoding='utf-8'))['directory'] == str(other_run.resolve())
    recovered = recover(restarted, character_id, 1, operation_id, revision)
    assert recovered['status'] == 'failed' and recovered['error']['code'] == 'executor_interrupted'
    assert_released(restarted, character_id, run)


def test_recovery_leaves_the_blender_lock_another_split_took_meanwhile(character, monkeypatch):
    pipeline, character_id, run = character

    class Started:
        """The worker started and was recorded; the server dies while waiting on it."""
        def __init__(self, command, **kwargs):
            self.pid = os.getpid()

        def wait(self, timeout=None):
            raise Crash

        def poll(self):
            return 0

    monkeypatch.setattr(subprocess, 'Popen', Started)
    operation_id = split_until_the_server_dies(pipeline, character_id)
    restarted, revision = restart(pipeline, character_id, run, operation_id)
    other = restarted.create('Other', 1.7, 1)
    _, other_run, _ = restarted.entry(other['id'], 1)
    stack, original, started = ExitStack(), character_recovery.read_json, []

    def reading(target, *args, **kwargs):
        if Path(target).name == 'runner.json' and not started:
            # Another character's split starts now and reclaims the killed split's Blender lock (run_lock._reclaimable).
            started.append(other_run)
            receipt = other_run / 'operations' / 'y' / 'blender' / 'runner.json'
            stack.enter_context(restarted.lock(other_run, blender=receipt))
        return original(target, *args, **kwargs)

    monkeypatch.setattr(character_recovery, 'read_json', reading)
    with stack:
        recovered = recover(restarted, character_id, 1, operation_id, revision)
        assert recovered['status'] == 'failed' and recovered['error']['code'] == 'executor_interrupted'
        assert not run.with_name(run.name + '.lock').exists()
        assert json.loads(port_lock().read_text(encoding='utf-8'))['directory'] == str(other_run.resolve())
    assert not port_lock().exists()
