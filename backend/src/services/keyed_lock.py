"""One lock per key: the same piece of work runs once while others with that key wait, then read what it left."""
from contextlib import contextmanager
from threading import Lock, RLock

_guard = Lock()
_locks = {}   # key -> [lock, threads holding or waiting for it]


@contextmanager
def keyed_lock(key):
    """Holds the lock of `key`. An entry exists only while a thread holds or waits for it, so the table is as
    large as the number of concurrent callers and a lock that is in use is never dropped."""
    with _guard:
        entry = _locks.setdefault(key, [RLock(), 0])
        entry[1] += 1
    try:
        with entry[0]:
            yield
    finally:
        with _guard:
            entry[1] -= 1
            if not entry[1]:
                del _locks[key]
