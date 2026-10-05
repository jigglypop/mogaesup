"""Atomic admission and OS-held work leases shared by the single API worker and local CLIs."""
from contextlib import contextmanager
from contextvars import ContextVar, copy_context
from concurrent.futures import ThreadPoolExecutor
import errno
import json
import os
from pathlib import Path
import re
from threading import RLock
import uuid

_lock = RLock()
_admitted = ContextVar('runtime_admitted_work', default=None)


class RuntimeDraining(RuntimeError):
    pass


class RuntimeUncertain(RuntimeError):
    pass


class ContextThreadPoolExecutor(ThreadPoolExecutor):
    """Already admitted commands retain their grant across parallel provider and fitting stages."""
    def submit(self, function, /, *args, **kwargs):
        context = copy_context()
        return super().submit(context.run, function, *args, **kwargs)


def _root():
    # This module is also loaded by Blender's isolated Python, which has no server dependencies.
    configured = os.getenv('ASSET_DATA_ROOT')
    root = Path(configured).expanduser().resolve() if configured else Path(__file__).resolve().parents[2] / 'data'
    return root / '.runtime'


def _take_lock(stream, *, blocking=True):
    stream.seek(0)
    if os.name == 'nt':
        import msvcrt
        msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))


def _unlock(stream):
    stream.seek(0)
    if os.name == 'nt':
        import msvcrt
        msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def _open_lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    stream = path.open('a+b')
    stream.seek(0, 2)
    if not stream.tell():
        stream.write(b'0')
        stream.flush()
    return stream


@contextmanager
def _guard():
    with _lock, _open_lock(_root() / 'admission.guard') as stream:
        _take_lock(stream)
        try:
            yield
        finally:
            _unlock(stream)


def _drain():
    path = _root() / 'drain.json'
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        if (type(value.get('version')) is not int or value['version'] != 1
                or not isinstance(value.get('token'), str) or not re.fullmatch(r'[a-f0-9]{32}', value['token'])):
            raise ValueError('invalid drain receipt')
        return value
    except (OSError, ValueError, AttributeError) as exc:
        raise RuntimeUncertain('수락 중지 기록을 확인할 수 없습니다.') from exc


def _write_drain(value):
    path = _root() / 'drain.json'
    temporary = path.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def _boot_id():
    try:
        return Path('/proc/sys/kernel/random/boot_id').read_text(encoding='ascii').strip() or None
    except OSError:
        return None


def _startup_token():
    """The deployment's admission token: ASSET_START_DRAIN_TOKEN, or the file ASSET_START_DRAIN_TOKEN_FILE names (what
    deploy-on-instance.sh mounts, so the token is in neither `ps` nor `docker inspect`). The deployment removes the file
    once the candidate has applied it; a later restart then finds none and keeps the drain it has."""
    token = os.getenv('ASSET_START_DRAIN_TOKEN', '')
    path = os.getenv('ASSET_START_DRAIN_TOKEN_FILE', '')
    if not token and path:
        try:
            token = Path(path).read_text(encoding='utf-8').strip()
        except FileNotFoundError:
            token = ''
    return token


@contextmanager
def server_lease():
    """Only one API worker per data root; the kernel releases the lease even after a crash."""
    stream = _open_lock(_root() / 'server.guard')
    try:
        try:
            _take_lock(stream, blocking=False)
        except OSError as exc:
            raise RuntimeUncertain('같은 데이터 루트에서 API worker가 이미 실행 중입니다.') from exc
        with _guard():
            previous = _drain()
            if previous and previous.get('boot_id') and _boot_id() and previous['boot_id'] != _boot_id():
                # A requested instance poweroff ended this kernel's work. A process/container restart is not a reboot.
                # Checked first: a drain of an earlier boot never blocks the startup token below.
                (_root() / 'drain.json').unlink(missing_ok=True)
                previous = None
            startup_token = _startup_token()
            if startup_token and not re.fullmatch(r'[a-f0-9]{32}', startup_token):
                raise RuntimeUncertain('Invalid startup admission token')
            # The deployment that started this container closes admission with its token once, on the container's first
            # start; a restart keeps whatever drain is current. A token reused by a later deployment (one that resumes
            # the drain an earlier, failed one left) comes with a new start id and is applied again.
            start_id = os.getenv('ASSET_START_DRAIN_ID', '') or startup_token
            if startup_token and not re.fullmatch(r'[a-f0-9]{32}', start_id):
                raise RuntimeUncertain('Invalid startup admission id')
            applied = _root() / 'startups' / (start_id + '.json')
            if startup_token and not applied.exists():
                if previous and previous['token'] != startup_token:
                    raise RuntimeUncertain('Another operation owns runtime admission')
                _write_drain({'version': 1, 'token': startup_token, 'boot_id': _boot_id()})
                applied.parent.mkdir(parents=True, exist_ok=True)
                applied.write_text('{"version":1}', encoding='utf-8')
        yield
    finally:
        stream.close()


def begin_drain(token):
    with _guard():
        previous = _drain()
        if previous and previous['token'] != token:
            raise RuntimeDraining('다른 점검이 수락을 중지한 상태입니다.')
        _write_drain({'version': 1, 'token': token, 'boot_id': _boot_id()})
        return _snapshot_locked()


def resume(token):
    with _guard():
        previous = _drain()
        if previous and previous['token'] != token:
            raise RuntimeDraining('다른 점검의 수락 중지는 해제할 수 없습니다.')
        (_root() / 'drain.json').unlink(missing_ok=True)
        return _snapshot_locked()


def _snapshot_locked():
    counts = {'paid_requests': 0, 'running_tasks': 0}
    verified = True
    for path in (_root() / 'work').glob('*.json'):
        try:
            with path.open('r+b') as stream:
                try:
                    _take_lock(stream, blocking=False)
                except OSError as exc:
                    if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                        raise
                    # Windows byte locks are mandatory; the metadata lives after the locked byte.
                    stream.seek(1)
                    value = json.loads(stream.read())
                    kind = value['kind']
                    if type(value.get('version')) is not int or value['version'] != 1 or kind not in counts:
                        raise ValueError('invalid work lease')
                    counts[kind] += 1
                    continue
                # No process holds the lease: an exited worker cannot still run a paid POST or Blender.
                _unlock(stream)
            path.unlink(missing_ok=True)
        except FileNotFoundError:
            continue
        except (OSError, ValueError, KeyError, TypeError):
            verified = False
            counts['running_tasks'] += 1
    return {'activity': counts, 'admission': {'version': 1, 'draining': _drain() is not None, 'verified': verified}}


def state():
    try:
        with _guard():
            return _snapshot_locked()
    except (OSError, RuntimeUncertain):
        return {'activity': {'paid_requests': 0, 'running_tasks': 1},
                'admission': {'version': 1, 'draining': True, 'verified': False}}


def snapshot():
    return state()['activity']


def draining():
    """Whether new work is refused now; a drain receipt that cannot be read counts as a drain."""
    try:
        return _drain() is not None
    except RuntimeUncertain:
        return True


def _admit(kind, inherit=False):
    """Blocking half of an admission: check the drain under admission.guard and hold a new kernel work lease."""
    path = _root() / 'work' / (uuid.uuid4().hex + '.json')
    with _guard():
        grant = _inherited_grant() if inherit else _admitted.get()
        if _drain() and not (grant and _grant_is_live(grant)):
            raise RuntimeDraining('점검 중입니다. 작업 수락이 다시 열리면 재시도하세요.')
        path.parent.mkdir(parents=True, exist_ok=True)
        stream = path.open('x+b')
        try:
            stream.write(b'0' + json.dumps({'version': 1, 'kind': kind}).encode())
            stream.flush()
            _take_lock(stream)
        except BaseException:
            stream.close()
            path.unlink(missing_ok=True)
            raise
    return path, stream


def _release(path, stream):
    stream.close()
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass  # A subsequent snapshot reclaims a lease that no process holds.


@contextmanager
def _counted(kind, *, inherit=False):
    path, stream = _admit(kind, inherit)
    token = _admitted.set(path)
    try:
        yield
    finally:
        _admitted.reset(token)
        _release(path, stream)


def paid_request():
    return _counted('paid_requests')


def running_task():
    return _counted('running_tasks')


def worker_environment(environment):
    """Pass an existing admission grant to a fixed worker bootstrap, never credentials."""
    grant = _admitted.get()
    if not grant:
        raise RuntimeUncertain('Worker launch requires an admitted task')
    return {**environment, 'ASSET_RUNTIME_GRANT': str(grant)}


def _inherited_grant():
    """Called inside admission.guard, so validating the parent and adding the child are atomic."""
    grant = Path(os.environ.get('ASSET_RUNTIME_GRANT', '')).resolve()
    if grant.parent != (_root() / 'work').resolve():
        raise RuntimeUncertain('Invalid worker admission grant')
    if not _grant_is_live(grant):
        raise RuntimeUncertain('Parent worker admission has ended')
    return grant


def _grant_is_live(grant):
    try:
        with grant.open('r+b') as stream:
            try:
                _take_lock(stream, blocking=False)
            except OSError as exc:
                if exc.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    return True
                raise
            _unlock(stream)
            return False
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise RuntimeUncertain('Worker admission cannot be verified') from exc


def worker_task():
    return _counted('running_tasks', inherit=True)


ADMISSION_THREADS = 4
DRAINING_BODY = {'detail': '작업 수락이 중지되어 있습니다. 잠시 후 다시 시도하세요.', 'code': 'draining'}


class ActivityMiddleware:
    """Admit before dispatch; keep the grant until FastAPI background work finishes.

    Admission waits on admission.guard (held by health, the drain control and local CLIs) and writes a lease file, so
    it runs in a few threads of its own: neither a slow disk nor a held guard stops the event loop, and long jobs that
    hold the default threads cannot keep a request from being admitted. The grant is set on the loop, in the request's
    context, which the route, its background tasks and their worker threads copy.
    """
    def __init__(self, app):
        # Imported here: Blender's isolated Python loads this module without the server's dependencies.
        from anyio.lowlevel import RunVar
        self.app = app
        self._threads = RunVar('runtime_admission_threads')

    def _limiter(self):
        """ADMISSION_THREADS for the running event loop (a limiter belongs to one loop)."""
        import anyio
        try:
            return self._threads.get()
        except LookupError:
            limiter = anyio.CapacityLimiter(ADMISSION_THREADS)
            self._threads.set(limiter)
            return limiter

    async def __call__(self, scope, receive, send):
        if (scope['type'] != 'http' or scope.get('method') in ('GET', 'HEAD', 'OPTIONS')
                or scope.get('path', '').startswith('/internal/')):
            await self.app(scope, receive, send)
            return
        import anyio
        limiter = self._limiter()
        try:
            path, stream = await anyio.to_thread.run_sync(_admit, 'running_tasks', limiter=limiter)
        except (RuntimeDraining, RuntimeUncertain, OSError):
            from starlette.responses import JSONResponse
            response = JSONResponse(DRAINING_BODY, status_code=503, headers={'Retry-After': '5'})
            await response(scope, receive, send)
            return
        token = _admitted.set(path)
        try:
            await self.app(scope, receive, send)
        finally:
            _admitted.reset(token)
            with anyio.CancelScope(shield=True):
                await anyio.to_thread.run_sync(_release, path, stream, limiter=limiter)
