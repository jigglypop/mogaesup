"""The admission middleware takes admission.guard and its lease file in threads of its own, never on the event loop,
while the grant it hands to the route, background tasks and their pools is still set in the request's context."""
import asyncio
from contextlib import contextmanager
import threading

import anyio
from fastapi import BackgroundTasks, FastAPI
import httpx
import pytest

from src.services import runtime_activity as activity

TOKEN = 'a' * 32
REFUSAL = {'detail': '작업 수락이 중지되어 있습니다. 잠시 후 다시 시도하세요.', 'code': 'draining'}


@pytest.fixture(autouse=True)
def isolated_runtime(monkeypatch, tmp_path):
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path))


def client_for(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test')


@pytest.mark.anyio
@pytest.mark.parametrize('anyio_backend', ['asyncio'])
async def test_a_request_waiting_for_a_held_admission_guard_leaves_the_event_loop_free(monkeypatch):
    app = FastAPI()
    app.add_middleware(activity.ActivityMiddleware)

    @app.post('/work')
    async def work():
        return {'admitted': activity._admitted.get() is not None}

    @app.get('/ping')
    async def ping():
        return {'ok': True}

    waiting, held, release, released = (threading.Event() for _ in range(4))
    original = activity._guard

    @contextmanager
    def observed():
        waiting.set()
        with original():
            yield
    monkeypatch.setattr(activity, '_guard', observed)

    def control_thread():
        # As health's state() in a control thread holds it while it reads every lease on a slow disk.
        with activity._lock:
            held.set()
            release.wait(5)
        released.set()

    holder = threading.Thread(target=control_thread, daemon=True)
    holder.start()
    assert held.wait(5)
    try:
        async with client_for(app) as client:
            post = asyncio.create_task(client.post('/work'))
            assert await asyncio.to_thread(waiting.wait, 5)
            # A blocked loop would serve this only after the holder gave up after 5 s.
            assert (await client.get('/ping')).status_code == 200
            assert not released.is_set() and not post.done()
            release.set()
            response = await asyncio.wait_for(post, 5)
            assert response.status_code == 200 and response.json() == {'admitted': True}
    finally:
        release.set()
        holder.join(5)
    assert activity.snapshot() == {'paid_requests': 0, 'running_tasks': 0}


@pytest.mark.anyio
@pytest.mark.parametrize('anyio_backend', ['asyncio'])
async def test_admission_and_release_run_in_their_own_threads_while_jobs_hold_every_default_thread(monkeypatch):
    app = FastAPI()
    app.add_middleware(activity.ActivityMiddleware)
    calls = []

    def recorded(function):
        def call(*args, **kwargs):
            try:
                asyncio.get_running_loop()
                calls.append((function.__name__, 'event loop'))
            except RuntimeError:
                calls.append((function.__name__, 'worker thread'))
            return function(*args, **kwargs)
        return call

    for name in ('_admit', '_release'):
        monkeypatch.setattr(activity, name, recorded(getattr(activity, name)))

    @app.post('/work')
    async def work():
        return {'leases': activity.snapshot()['running_tasks']}

    limiter = anyio.to_thread.current_default_thread_limiter()
    previous = limiter.total_tokens
    limiter.total_tokens = 1
    taken, finish = anyio.Event(), anyio.Event()

    async def long_job():
        async with limiter:
            taken.set()
            await finish.wait()

    try:
        async with anyio.create_task_group() as group:
            group.start_soon(long_job)
            await taken.wait()
            try:
                async with client_for(app) as client:
                    with anyio.fail_after(5):
                        response = await client.post('/work')
            finally:
                finish.set()
    finally:
        limiter.total_tokens = previous
    assert response.status_code == 200 and response.json() == {'leases': 1}
    assert calls == [('_admit', 'worker thread'), ('_release', 'worker thread')]
    assert activity.snapshot() == {'paid_requests': 0, 'running_tasks': 0}


@pytest.mark.anyio
@pytest.mark.parametrize('anyio_backend', ['asyncio'])
async def test_the_grant_set_on_the_loop_reaches_the_route_its_background_task_and_their_pool_during_a_drain():
    app = FastAPI()
    app.add_middleware(activity.ActivityMiddleware)
    started, finish = threading.Event(), threading.Event()
    seen = {}

    def paid():
        with activity.paid_request():
            return activity.snapshot()['paid_requests']

    def background():
        seen['background'] = activity._admitted.get()
        started.set()
        assert finish.wait(5)
        seen['paid'] = paid()
        with activity.ContextThreadPoolExecutor(max_workers=1) as pool:
            seen['pool'] = pool.submit(paid).result(timeout=5)

    @app.post('/work')
    def work(tasks: BackgroundTasks):
        seen['route'] = activity._admitted.get()
        tasks.add_task(background)
        return {'accepted': True}

    async with client_for(app) as client:
        existing = asyncio.create_task(client.post('/work'))
        try:
            assert await asyncio.to_thread(started.wait, 5)
            assert activity.begin_drain(TOKEN)['activity']['running_tasks'] == 1
            refused = await client.post('/work')
            assert refused.status_code == 503 and refused.headers['retry-after'] == '5'
            assert refused.json() == REFUSAL
        finally:
            finish.set()
        assert (await asyncio.wait_for(existing, 5)).status_code == 200
        grant = seen['route']
        assert grant is not None and seen['background'] == grant
        assert grant.parent == (activity._root() / 'work') and not grant.exists()
        assert seen['paid'] == 1 and seen['pool'] == 1
        assert activity.snapshot() == {'paid_requests': 0, 'running_tasks': 0}
        # The request ended its grant: it admits nothing after the fact.
        with pytest.raises(activity.RuntimeDraining):
            paid()
        activity.resume(TOKEN)
        assert (await client.post('/work')).status_code == 200


@pytest.mark.anyio
@pytest.mark.parametrize('anyio_backend', ['asyncio'])
async def test_an_admission_that_cannot_be_verified_is_refused_with_the_same_body(monkeypatch):
    app = FastAPI()
    app.add_middleware(activity.ActivityMiddleware)

    @app.post('/work')
    async def work():
        pytest.fail('nothing runs without an admission')

    def unreadable(*args, **kwargs):
        raise OSError('lease file cannot be created')

    async with client_for(app) as client:
        (activity._root()).mkdir(parents=True, exist_ok=True)
        (activity._root() / 'drain.json').write_text('[]')
        unverified = await client.post('/work')
        (activity._root() / 'drain.json').unlink()
        monkeypatch.setattr(activity, '_admit', unreadable)
        failed = await client.post('/work')
    for response in (unverified, failed):
        assert response.status_code == 503 and response.headers['retry-after'] == '5'
        assert response.json() == REFUSAL


def test_draining_reads_the_receipt_and_counts_an_unreadable_one_as_closed():
    assert activity.draining() is False
    activity.begin_drain(TOKEN)
    assert activity.draining() is True
    activity.resume(TOKEN)
    assert activity.draining() is False
    (activity._root() / 'drain.json').write_text('{"version": 2}')
    assert activity.draining() is True
