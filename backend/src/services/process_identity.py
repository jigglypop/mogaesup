"""Read-only process identity checks; PID reuse and access errors are not completion."""

import os
from contextlib import contextmanager
from pathlib import Path

import psutil


def identity(pid: int | None = None) -> dict:
    process = psutil.Process(pid or os.getpid())
    return {"pid": process.pid, "created_at": process.create_time()}


def state(value: dict | None) -> str:
    if not isinstance(value, dict) or not isinstance(value.get("pid"), int) or value["pid"] <= 0 or not isinstance(value.get("created_at"), (float, int)):
        return "unknown"
    try:
        process = psutil.Process(value["pid"])
        if abs(process.create_time() - value["created_at"]) > .001:
            return "exited"
        if not process.is_running() or process.status() in {psutil.STATUS_ZOMBIE, psutil.STATUS_DEAD}:
            return "exited"
        return "running"
    except psutil.NoSuchProcess:
        return "exited"
    except (psutil.AccessDenied, OSError):
        return "unknown"


@contextmanager
def lease_guard(directory: Path):
    """A short OS lock serializes lease changes and is released on process exit."""
    # StoredPath may represent S3 assets, but OS byte locks require a local file.
    directory = Path(directory)
    path = directory.with_name(directory.name + ".lock.guard")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        stream.seek(0, 2)
        if not stream.tell():
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise ValueError("Run is busy; lease update in progress") from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
