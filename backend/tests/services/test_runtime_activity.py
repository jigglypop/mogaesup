import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import threading

from fastapi import FastAPI
from fastapi.responses import JSONResponse
import httpx
import pytest
from starlette.background import BackgroundTask

from src.services import runtime_activity as activity

TOKEN = 'a' * 32


@pytest.fixture(autouse=True)
def isolated_runtime(monkeypatch, tmp_path):
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path))


def test_single_worker_and_token_owned_resume():
    with activity.server_lease():
        with pytest.raises(activity.RuntimeUncertain):
            with activity.server_lease():
                pass
        assert activity.begin_drain(TOKEN)['admission']['draining']
        for callback in (activity.begin_drain, activity.resume):
            with pytest.raises(activity.RuntimeDraining):
                callback('b' * 32)
        assert activity.state()['admission']['draining']
        assert not activity.resume(TOKEN)['admission']['draining']


def test_a_container_or_process_restart_keeps_drain_until_its_owner_resumes():
    with activity.server_lease():
        activity.begin_drain(TOKEN)
        with pytest.raises(activity.RuntimeUncertain):
            with activity.server_lease():
                pass
        assert activity.state()['admission']['draining']
    with activity.server_lease():
        assert activity.state()['admission']['draining']
        assert not activity.resume(TOKEN)['admission']['draining']


def test_candidate_starts_closed_once_and_only_a_real_reboot_clears_old_drain(monkeypatch):
    monkeypatch.setenv('ASSET_START_DRAIN_TOKEN', TOKEN)
    monkeypatch.setattr(activity, '_boot_id', lambda: 'boot-one')
    with activity.server_lease():
        assert activity.state()['admission']['draining']
        with pytest.raises(activity.RuntimeDraining):
            with activity.running_task():
                pass
        activity.resume(TOKEN)
    with activity.server_lease():
        assert not activity.state()['admission']['draining']
        activity.begin_drain('b' * 32)
    monkeypatch.setattr(activity, '_boot_id', lambda: 'boot-two')
    with activity.server_lease():
        assert not activity.state()['admission']['draining']


def test_concurrent_admission_and_drain_never_hide_an_admitted_task():
    with ThreadPoolExecutor(max_workers=1) as pool:
        for _ in range(25):
            start = threading.Barrier(2)
            observed, release = threading.Event(), threading.Event()

            def task():
                start.wait()
                try:
                    with activity.running_task():
                        observed.set()
                        assert release.wait(5)
                        with activity.paid_request():
                            assert activity.snapshot()['paid_requests'] == 1
                        return True
                except activity.RuntimeDraining:
                    observed.set()
                    return False

            future = pool.submit(task)
            start.wait()
            activity.begin_drain(TOKEN)
            assert observed.wait(5)
            count = activity.snapshot()['running_tasks']
            with pytest.raises(activity.RuntimeDraining):
                with activity.running_task():
                    pass
            release.set()
            admitted = future.result(timeout=5)
            assert count == int(admitted)
            assert activity.snapshot() == {'paid_requests': 0, 'running_tasks': 0}
            activity.resume(TOKEN)


def test_parallel_provider_stages_inherit_the_admitted_command_grant():
    continue_stage = threading.Event()

    def stage():
        assert continue_stage.wait(5)
        with activity.paid_request():
            return activity.snapshot()['paid_requests']

    with activity.ContextThreadPoolExecutor(max_workers=1) as pool:
        with activity.running_task():
            admitted_stage = pool.submit(stage)
            activity.begin_drain(TOKEN)
            continue_stage.set()
            assert admitted_stage.result(timeout=5) == 1
        # The pool lives longer than the command, but cannot reuse its expired grant.
        with pytest.raises(activity.RuntimeDraining):
            pool.submit(stage).result(timeout=5)


def test_a_leftover_receipt_cannot_extend_an_ended_admission_grant(tmp_path):
    from contextvars import copy_context
    with activity.running_task():
        context = copy_context()
        grant = activity._admitted.get()
    # A failed unlink or crashed parent can leave bytes behind without an actual held lease.
    activity.begin_drain(TOKEN)
    grant.write_bytes(b'0{"version":1,"kind":"running_tasks"}')
    assert grant.exists()

    def delayed_stage():
        with activity.paid_request():
            pytest.fail('stale file was accepted as a live admission')

    with pytest.raises(activity.RuntimeDraining):
        context.run(delayed_stage)


@pytest.mark.anyio
@pytest.mark.parametrize('anyio_backend', ['asyncio'])
async def test_drain_rejects_new_mutations_and_allows_existing_background_work_to_finish():
    app = FastAPI()
    app.add_middleware(activity.ActivityMiddleware)
    admitted, finish = asyncio.Event(), asyncio.Event()
    ran = []

    async def background():
        admitted.set()
        await finish.wait()
        with activity.paid_request():
            ran.append(activity.snapshot()['paid_requests'])

    @app.post('/work')
    async def work():
        return JSONResponse({'accepted': True}, background=BackgroundTask(background))

    @app.get('/health')
    async def health():
        return activity.state()

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        existing = asyncio.create_task(client.post('/work'))
        try:
            await asyncio.wait_for(admitted.wait(), 5)
            drained = activity.begin_drain(TOKEN)
            assert drained['activity']['running_tasks'] == 1
            rejected = await client.post('/work')
            assert rejected.status_code == 503 and rejected.headers['retry-after'] == '5'
            healthy = await client.get('/health')
            assert healthy.status_code == 200 and healthy.json()['admission']['draining']
        finally:
            finish.set()
        assert (await asyncio.wait_for(existing, 5)).status_code == 200
        assert ran == [1] and activity.snapshot()['running_tasks'] == 0
        activity.resume(TOKEN)
        assert (await client.post('/work')).status_code == 200


def test_a_worker_process_retains_its_own_lease_after_the_admitting_parent_finishes(tmp_path):
    bootstrap = Path(activity.__file__).with_name('runtime_blender_bootstrap.py')
    ready, finish = tmp_path / 'ready', tmp_path / 'finish'
    code = ('import runpy,sys,time; from pathlib import Path; runpy.run_path(sys.argv[1]); '
            'Path(sys.argv[2]).touch();\nwhile not Path(sys.argv[3]).exists(): time.sleep(.02)')
    child = None
    try:
        with activity.running_task():
            env = activity.worker_environment(os.environ)
            child = subprocess.Popen([sys.executable, '-c', code, str(bootstrap), str(ready), str(finish)],
                                     env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            # Event-based handshake: the worker already holds its lease when the parent ends its grant.
            import time
            deadline = time.monotonic() + 5
            while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
                time.sleep(.01)
            assert ready.exists(), child.communicate(timeout=5)
            assert activity.snapshot()['running_tasks'] == 2
        assert activity.begin_drain(TOKEN)['activity']['running_tasks'] == 1
        finish.touch()
        assert child.wait(timeout=5) == 0
        assert activity.snapshot()['running_tasks'] == 0
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=5)


def test_a_dead_parent_grant_cannot_start_a_blender_recipe(tmp_path):
    with activity.running_task():
        environment = activity.worker_environment(os.environ)
    bootstrap = Path(activity.__file__).with_name('runtime_blender_bootstrap.py')
    recipe = tmp_path / 'recipe-ran'
    done = subprocess.run([sys.executable, '-c', 'import runpy,sys; from pathlib import Path; '
                           'runpy.run_path(sys.argv[1]); Path(sys.argv[2]).touch()', str(bootstrap), str(recipe)],
                          env=environment, capture_output=True, timeout=5)
    assert done.returncode != 0 and not recipe.exists()


def test_exited_process_leases_are_reclaimed_and_unknown_live_leases_are_busy(tmp_path):
    root = tmp_path / '.runtime' / 'work'
    root.mkdir(parents=True)
    stale = root / 'stale.json'
    stale.write_bytes(b'0{"version":1,"kind":"running_tasks"}')
    assert activity.snapshot()['running_tasks'] == 0 and not stale.exists()
    corrupt = root / 'corrupt.json'
    with corrupt.open('w+b') as stream:
        stream.write(b'0not-json')
        stream.flush()
        activity._take_lock(stream)
        state = activity.state()
        assert state['admission']['verified'] is False and state['activity']['running_tasks'] == 1
    assert activity.state()['admission']['verified'] is True


def test_invalid_drain_receipt_is_never_idle(tmp_path):
    root = tmp_path / '.runtime'
    root.mkdir()
    (root / 'drain.json').write_text('[]')
    state = activity.state()
    assert state['admission']['verified'] is False and state['activity']['running_tasks'] > 0
    with pytest.raises(activity.RuntimeUncertain):
        with activity.running_task():
            pass
