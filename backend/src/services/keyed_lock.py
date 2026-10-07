"""One lock per key: the same piece of work runs once while others with that key wait, then read what it left."""
from contextlib import contextmanager
from threading import Lock, RLock

_guard = Lock()
_locks = {}   # key -> [lock, threads holding or waiting for it]


class KeyBusy(TimeoutError):
    """keyed_lock's `timeout` passed while other work held the key."""


@contextmanager
def keyed_lock(key, timeout=None):
    """Holds the lock of `key`. An entry exists only while a thread holds or waits for it, so the table is as
    large as the number of concurrent callers and a lock that is in use is never dropped. With `timeout` (seconds)
    a caller that could not take it by then gets KeyBusy instead."""
    with _guard:
        entry = _locks.setdefault(key, [RLock(), 0])
        entry[1] += 1
    try:
        if not entry[0].acquire(timeout=-1 if timeout is None else timeout):
            raise KeyBusy(f'{key!r} is held by other work')
        try:
            yield
        finally:
            entry[0].release()
    finally:
        with _guard:
            entry[1] -= 1
            if not entry[1]:
                del _locks[key]
