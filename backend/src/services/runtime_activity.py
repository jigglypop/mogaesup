"""Work in progress in this process, so a local restart can wait until it is idle."""
from contextlib import contextmanager
from threading import Lock

_lock = Lock()
_counts = {'paid_requests': 0, 'running_tasks': 0}


@contextmanager
def _counted(name):
    with _lock:
        _counts[name] += 1
    try:
        yield
    finally:
        with _lock:
            _counts[name] -= 1


def paid_request():
    """An in-flight provider POST that may be billed."""
    return _counted('paid_requests')


def running_task():
    """A mutating request with its background work, or an automatic resume."""
    return _counted('running_tasks')


def snapshot():
    with _lock:
        return dict(_counts)


class ActivityMiddleware:
    """Counts mutating requests until their FastAPI background tasks have finished."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope.get('method') in ('GET', 'HEAD', 'OPTIONS'):
            await self.app(scope, receive, send)
            return
        with running_task():
            await self.app(scope, receive, send)
