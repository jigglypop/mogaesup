"""Whether the process lock is free for other threads while a slow step runs."""
import threading

from src.services.avatar_factory import _LOCK


def lock_free(timeout=2):
    """True when a thread other than the caller can take the process lock now."""
    taken = []

    def take():
        acquired = _LOCK.acquire(timeout=timeout)
        taken.append(acquired)
        if acquired:
            _LOCK.release()
    thread = threading.Thread(target=take)
    thread.start()
    thread.join()
    return taken[0]
