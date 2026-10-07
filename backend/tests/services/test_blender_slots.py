"""How many Blender workers run at once: BLENDER_CONCURRENCY, held to what the machine's (or its container's) memory
fits, counted across every process on the data root."""
import contextlib
import errno
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import types

import pytest

from src.paths import BACKEND_ROOT
from src.services import avatar_factory, character_parts, runtime_activity
from src.services.avatar_factory import BlenderSlots, blender_slots

GIB = 2**30


def test_the_studio_instance_runs_one_blender_at_a_time():
    # The t3.large reports 7.6 GiB; two workers of 3.6 GB each were killed for memory there.
    assert blender_slots('2', int(7.6*GIB)) == 1
    assert blender_slots('4', int(7.6*GIB)) == 1


def test_a_larger_machine_keeps_the_requested_count():
    assert blender_slots('2', 16*GIB) == 2
    assert blender_slots('3', 16*GIB) == 3
    assert blender_slots('8', 16*GIB) == 3


def test_at_least_one_worker_and_the_default_of_two():
    assert blender_slots('0', 32*GIB) == 1
    assert blender_slots('', 32*GIB) == 2
    assert blender_slots('2', 2*GIB) == 1


# --- the container's memory limit -------------------------------------------------------------------------------------

def limits(tmp_path, monkeypatch, value):
    path = tmp_path / 'memory.max'
    path.write_text(value + '\n', encoding='ascii')
    monkeypatch.setattr(avatar_factory, 'CGROUP_LIMITS', (str(path), str(tmp_path / 'absent')))
    return avatar_factory


@pytest.mark.parametrize('physical, limit, expected', [
    (32*GIB, str(8*GIB), 8*GIB),     # A container on a large host: the cgroup's limit, not the host's memory.
    (8*GIB, str(32*GIB), 8*GIB),     # A limit above the machine's memory is no limit.
    (8*GIB, 'max', 8*GIB),           # cgroup v2 without a limit.
    (None, str(4*GIB), 4*GIB),       # No sysconf (Windows): the limit alone.
])
def test_the_memory_blender_is_sized_by_is_held_to_the_container_limit(tmp_path, monkeypatch, physical, limit, expected):
    module = limits(tmp_path, monkeypatch, limit)
    if physical is None:
        monkeypatch.delattr(os, 'sysconf', raising=False)
    else:
        sizes = {'SC_PAGE_SIZE': 4096, 'SC_PHYS_PAGES': physical // 4096}
        monkeypatch.setattr(os, 'sysconf', lambda name: sizes[name], raising=False)
    assert module.machine_memory() == expected
    assert module.blender_slots('8') == max(1, min(8, int((expected/GIB-1)//4)))


# --- one count of Blender workers across the processes of a data root -------------------------------------------------

HOLD = """
import sys
sys.path.insert(0, sys.argv[1])
from src.services.runtime_activity import _open_lock, _root, _take_lock
stream = _open_lock(_root() / 'blender-slot-0.lock')
_take_lock(stream)
print('held', flush=True)
sys.stdin.read()
"""


def test_a_blender_slot_held_by_another_process_is_waited_for(tmp_path, monkeypatch):
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path))
    slots = BlenderSlots(1)
    monkeypatch.setattr(BlenderSlots, 'POLL_SECONDS', .05)
    # A CLI (or a deployment's candidate container) on the same data root runs its Blender worker.
    child = subprocess.Popen([sys.executable, '-c', HOLD, str(BACKEND_ROOT)], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, env={**os.environ, 'ASSET_DATA_ROOT': str(tmp_path)})
    try:
        assert child.stdout.readline().strip() == b'held'
        entered = threading.Event()

        def run():
            with slots:
                entered.set()
        thread = threading.Thread(target=run)
        thread.start()
        assert not entered.wait(.5)
        child.stdin.close()
        child.wait(timeout=20)
        assert entered.wait(10)
        thread.join(timeout=10)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()


def test_threads_of_one_process_share_its_count_and_let_go_of_their_slot_files(tmp_path, monkeypatch):
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path))
    slots = BlenderSlots(2)
    inside, release, done = [], threading.Event(), []

    def run():
        with slots:
            inside.append(1)
            release.wait(10)
        done.append(1)
    threads = [threading.Thread(target=run) for _ in range(3)]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + 10
    while len(inside) < 2 and time.monotonic() < deadline:
        time.sleep(.01)
    time.sleep(.2)
    assert len(inside) == 2  # The third waits for one of the two.
    release.set()
    for thread in threads:
        thread.join(timeout=10)
    assert len(inside) == len(done) == 3
    with slots, slots:
        pass  # Both slot files are free again.


def test_a_slot_file_locked_while_it_is_first_written_counts_as_held(tmp_path, monkeypatch):
    """On Windows a thread writing a new slot file's first byte fails once another thread has locked that byte: the
    slot is held, and the next one is tried instead of the error ending the Blender run."""
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path))
    real, refused = runtime_activity._open_lock, []

    def opening(path):
        if path.name == 'blender-slot-0.lock' and not refused:
            refused.append(path.name)
            raise PermissionError(errno.EACCES, 'locked by another handle')
        return real(path)
    monkeypatch.setattr(runtime_activity, '_open_lock', opening)
    slots = BlenderSlots(2)
    with slots:
        assert refused == ['blender-slot-0.lock']
        assert [Path(stream.name).name for stream in slots._held.streams] == ['blender-slot-1.lock']


# --- what a slot lock answers, and a long wait ------------------------------------------------------------------------

def test_a_data_root_that_cannot_lock_is_an_error_not_an_endless_wait(tmp_path, monkeypatch):
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path))
    monkeypatch.setattr(BlenderSlots, 'POLL_SECONDS', .01)

    def cannot_lock(stream, *, blocking=True):
        raise OSError(errno.ENOLCK, 'No locks available')  # NFS mounted with nolock
    monkeypatch.setattr(runtime_activity, '_take_lock', cannot_lock)
    slots, outcome = BlenderSlots(1), []

    def run():
        try:
            with slots:
                outcome.append('entered')
        except OSError as exc:
            outcome.append(exc.errno)
    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(5)
    assert outcome == [errno.ENOLCK]
    assert slots._local.acquire(blocking=False)  # The process's own count was given back.


def test_a_long_wait_for_a_slot_is_logged_once(tmp_path, monkeypatch, caplog):
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path))
    monkeypatch.setattr(BlenderSlots, 'POLL_SECONDS', .02)
    monkeypatch.setattr(BlenderSlots, 'LOG_AFTER_SECONDS', .1)
    caplog.set_level(logging.INFO, logger=avatar_factory.__name__)
    holder, waiter, entered = BlenderSlots(1), BlenderSlots(1), threading.Event()

    def wait():
        with waiter:
            entered.set()
    with holder:  # Another process's worker, as far as `waiter` can tell.
        thread = threading.Thread(target=wait)
        thread.start()
        assert not entered.wait(.5)
    thread.join(10)
    assert entered.is_set()
    warnings = [record for record in caplog.records if record.levelno == logging.WARNING]
    assert len(warnings) == 1 and 'Blender slot' in warnings[0].getMessage()
    assert any('taken after' in record.getMessage() for record in caplog.records)


# --- a worker keeps the slot it was started in ------------------------------------------------------------------------

def test_held_fds_name_only_the_slots_this_thread_holds(tmp_path, monkeypatch):
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path))
    slots, seen = BlenderSlots(2), []
    assert slots.held_fds() == ()
    with slots:
        thread = threading.Thread(target=lambda: seen.append(slots.held_fds()))
        thread.start()
        thread.join(10)
        assert seen == [()]
        assert len(slots.held_fds()) == (0 if os.name == 'nt' else 1)
    assert slots.held_fds() == ()


def test_a_blender_worker_is_handed_the_slot_its_starter_holds(tmp_path, monkeypatch):
    started = []

    class Started:
        pid = os.getpid()

        def poll(self):
            return 0

        def wait(self, timeout=None):
            return 0

    def popen(command, **options):
        started.append(options.get('pass_fds'))
        return Started()
    monkeypatch.setattr(character_parts.subprocess, 'Popen', popen)
    for fds in ((7,), ()):
        monkeypatch.setattr(avatar_factory._QUEUE, 'held_fds', lambda fds=fds: fds)
        with character_parts.blender_process(['blender', '--python', 'worker.py'], tmp_path/'blender.log',
                                             tmp_path/'runner.json', write_json=lambda path, value: None,
                                             checkpoint=False) as process:
            assert process.wait() == 0
    assert started == [(7,), None]


@pytest.mark.skipif(os.name == 'nt', reason='a slot is handed to its worker on POSIX; on Windows it is the process lock')
def test_a_worker_keeps_its_slot_after_the_process_that_started_it_lets_go(tmp_path, monkeypatch):
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path))
    monkeypatch.setattr(BlenderSlots, 'POLL_SECONDS', .05)
    starter, other, entered = BlenderSlots(1), BlenderSlots(1), threading.Event()
    starter.__enter__()
    worker = subprocess.Popen([sys.executable, '-c', 'import sys; sys.stdin.read()'], stdin=subprocess.PIPE,
                              pass_fds=starter.held_fds())
    try:
        # As when the starter is killed: its descriptor is closed and nothing unlocks the slot.
        starter.__exit__(None, None, None)

        def take():
            with other:
                entered.set()
        thread = threading.Thread(target=take)
        thread.start()
        assert not entered.wait(.5)
        worker.stdin.close()
        worker.wait(timeout=20)
        assert entered.wait(10)
        thread.join(10)
    finally:
        if worker.poll() is None:
            worker.kill()
            worker.wait()


# --- CLIs run Blender in a slot too -----------------------------------------------------------------------------------

class FakeSlots:
    """_QUEUE as a CLI sees it: whether a slot is held, and the descriptor it would hand on."""

    def __init__(self):
        self.held = False

    def __enter__(self):
        self.held = True
        return self

    def __exit__(self, *exc):
        self.held = False

    def held_fds(self):
        return (9,) if self.held else ()


def test_the_quality_cli_runs_blender_in_a_slot(tmp_path, monkeypatch):
    from src import quality_cli
    slots, inside = FakeSlots(), []

    @contextlib.contextmanager
    def worker(command, log, runner, **options):
        inside.append(slots.held)
        payload = json.loads(Path(command[-1]).read_text(encoding='utf8'))
        Path(payload['output']).write_text('{"rear_coverage": 1}', encoding='utf8')
        yield types.SimpleNamespace(wait=lambda timeout=None: 0)
    monkeypatch.setattr(quality_cli, '_QUEUE', slots)
    monkeypatch.setattr(quality_cli, 'blender_process', worker)
    monkeypatch.setattr(quality_cli, 'blender_executable', lambda: 'blender')
    assert quality_cli.measure(tmp_path) == {'rear_coverage': 1}
    assert inside == [True] and not slots.held


def test_a_quality_cli_run_as_root_shares_its_scratch_with_the_worker_group(tmp_path):
    from src import quality_cli
    calls = []

    def record(name):
        return lambda *args: calls.append((name, *args))
    group = types.SimpleNamespace(st_gid=10001)  # The group the data root is shared with (infra/entrypoint.py).
    assert quality_cli.share_with_workers(tmp_path, geteuid=lambda: 0, stat=lambda path: group,
                                          chown=record('chown'), chmod=record('chmod'))
    assert calls == [('chown', tmp_path, -1, 10001), ('chmod', tmp_path, 0o2770)]
    calls.clear()
    assert not quality_cli.share_with_workers(tmp_path, geteuid=lambda: 1000, chown=record('chown'), chmod=record('chmod'))
    assert not quality_cli.share_with_workers(tmp_path, geteuid=None, chown=record('chown'), chmod=record('chmod'))
    assert calls == []


def test_the_editor_cli_starts_its_blender_in_a_slot_it_hands_on(tmp_path, monkeypatch):
    from src import editor_cli
    slots, started = FakeSlots(), []
    monkeypatch.setattr(avatar_factory, '_QUEUE', slots)
    spec = types.SimpleNamespace(origin=str(tmp_path/'blender_mcp'/'__init__.py'))
    monkeypatch.setattr(editor_cli, 'importlib', types.SimpleNamespace(util=types.SimpleNamespace(find_spec=lambda name: spec)))
    answers = iter([1, 0])  # The port is free, then Blender listens on it.

    class Probe:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            pass

        def connect_ex(self, address):
            return next(answers)
    monkeypatch.setattr(editor_cli, 'socket', types.SimpleNamespace(socket=Probe))

    def popen(command, **options):
        started.append((slots.held, options.get('pass_fds')))
        return types.SimpleNamespace(pid=4242, poll=lambda: None)
    monkeypatch.setattr(editor_cli.subprocess, 'Popen', popen)
    executable = tmp_path/'blender.exe'
    executable.write_bytes(b'')
    assert editor_cli.start_blender(executable, tmp_path/'editor', 9876)['pid'] == 4242
    assert started == [(True, (9,))] and not slots.held
