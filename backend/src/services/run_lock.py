"""Lock files that keep one CLI run, and the Blender port it uses, to a single process; and the in-process worker
locks and last saves of background jobs."""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from contextlib import contextmanager
from threading import Lock

from src.services.blender_mcp import BlenderExecutionUncertain
from src.services.object_storage import StoredPath as Path

LOGGER = logging.getLogger(__name__)
# Seconds between the attempts of a worker's last save (see final_write).
FINAL_WRITE_DELAYS = (.5, 1, 2, 4, 8)


def _worker_gone(lease: dict) -> bool:
    """The isolated Blender worker of a lease's run is proven not to run: the runner.json receipt the lease names (inside
    the locked run directory) names a process that has exited, or neither that receipt nor the log exists.

    blender_process opens the log before it starts the worker and writes the receipt right after, so a log without a
    receipt may belong to a worker that runs without one, and an unreadable receipt proves nothing: both are kept."""
    from src.services.process_identity import state
    runner, directory = lease.get("runner"), lease.get("directory")
    if not (isinstance(runner, str) and isinstance(directory, str) and runner and directory):
        return False
    receipt = Path(runner)
    try:
        if not receipt.is_relative_to(Path(directory)) or receipt.name != "runner.json":
            return False
        if receipt.is_file():
            worker = json.loads(receipt.read_text(encoding="utf-8"))
            return isinstance(worker, dict) and state(worker.get("process")) == "exited"
        return not receipt.with_name("blender.log").is_file()
    except Exception:  # A store or file error proves nothing about the worker.
        return False


def _reclaimable(path: Path) -> bool:
    """A lock left by a process that has exited (kill -9, OOM, a stopped container) whose work is proven over.

    Without Blender the work ended with the process. A run with an isolated Blender worker names that worker's receipt
    (`runner`), and its lock goes once the worker is proven gone too (_worker_gone). Any other Blender lock stays: a
    lock kept after an uncertain execution, or one of a Blender MCP port, whose Blender may still run the script.
    Leases written before the `blender` field existed are kept too, except the character registry's, which no Blender
    run ever takes."""
    from src.services.process_identity import state
    try:
        lease = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(lease, dict) or lease.get("version") != 1:
        return False
    without_blender = lease.get("blender") is False or (
        "blender" not in lease and isinstance(lease.get("directory"), str)
        and Path(lease["directory"]).name == ".registry")
    if state(lease.get("owner")) != "exited":
        return False
    return without_blender or (lease.get("blender") is True and _worker_gone(lease))


@contextmanager
def run_lock(directory: Path, port: int, *, blender: bool | Path = True):
    """Serialize CLI processes; keep locks after uncertain Blender execution.

    `blender`: whether the run uses Blender, which takes the Blender port lock too. A path instead names the runner.json
    receipt that the run's isolated Blender worker writes (character_parts.blender_process): a lock its owner left when
    it was killed is then reclaimed once that worker is proven gone, instead of refusing every later Blender run."""
    import tempfile

    directory = directory.resolve()
    directory.parent.mkdir(parents=True, exist_ok=True)
    from src.services.process_identity import identity, lease_guard
    runner = None
    if not isinstance(blender, bool):
        runner, blender = str(Path(blender).resolve()), True
    lease = {"version": 1, "token": uuid.uuid4().hex, "directory": str(directory), "owner": identity(),
             "blender": blender, **({"runner": runner} if runner else {})}
    locks = [directory.with_name(directory.name + ".lock")]
    if blender:
        locks.append(Path(tempfile.gettempdir()) / f"asset-wardrobe-blender-{port}.lock")
    acquired = []
    uncertain = False
    try:
        with lease_guard(directory):
            for path in locks:
                for attempt in (1, 2):
                    try:
                        with path.open("x", encoding="utf-8") as stream:
                            stream.write(json.dumps(lease))
                        break
                    except FileExistsError as exc:
                        # The lease guard is held, so no live run can take the lock between this check and the unlink.
                        if attempt == 1 and _reclaimable(path):
                            LOGGER.warning("Reclaimed the lock of an exited process: %s", path.name)
                            path.unlink(missing_ok=True)
                            continue
                        raise ValueError(f"Run or Blender is busy; inspect lock: {path}") from exc
                acquired.append(path)
        yield
    except (BlenderExecutionUncertain, KeyboardInterrupt):
        uncertain = True
        raise
    finally:
        if not uncertain:
            for path in acquired:
                path.unlink(missing_ok=True)


class WorkerLocks(dict):
    """At most one in-process worker per key (a job or record directory). A key is present only while its worker runs
    (or is claimed for one, see claim), so the table is as large as the work running now, and `get(key)` is that
    worker's held lock or None."""

    def __init__(self):
        super().__init__()
        self._guard = Lock()
        self._claims = set()

    def _hold(self, key) -> None:
        lock = Lock()
        lock.acquire()
        self[key] = lock

    def acquire(self, key, *, claimed=False) -> bool:
        """True when the caller now runs `key`'s worker; False while another one does. With `claimed` the caller is the
        executor that a claim (see claim) waits for and takes it over, or acquires as usual when there is none."""
        with self._guard:
            if claimed and key in self._claims:
                self._claims.discard(key)
                return True
            if key in self:
                return False
            self._hold(key)
            return True

    def claim(self, key) -> bool:
        """Hold `key` from the moment its work is accepted for an executor that starts later (a background task), so the
        accepted record and the held lock go together; that executor takes it over with acquire(key, claimed=True).
        False while a worker or another claim holds it."""
        with self._guard:
            if key in self:
                return False
            self._hold(key)
            self._claims.add(key)
            return True

    def release(self, key) -> None:
        with self._guard:
            self._claims.discard(key)
            lock = self.pop(key, None)
        if lock is not None:
            lock.release()

    def busy(self, key) -> bool:
        return key in self

    def snapshot(self) -> set:
        """The keys whose workers run now."""
        with self._guard:
            return set(self)


_SELF = {}


def this_process(value) -> bool:
    """The process identity a record names (pid and start time) is this process."""
    from src.services.process_identity import identity
    if _SELF.get("pid") != os.getpid():
        _SELF.clear()
        _SELF.update(identity())
    return (isinstance(value, dict) and value.get("pid") == _SELF["pid"]
            and isinstance(value.get("created_at"), (int, float)) and not isinstance(value.get("created_at"), bool)
            and abs(value["created_at"] - _SELF["created_at"]) <= .001)


def worker_alive(record: dict, held: bool, *, claimed: bool = False) -> bool:
    """Admitted or running work whose process has not exited. In this process a running record also needs its worker
    lock (`held`, observed before and after reading the record): a worker whose last save failed leaves `running`
    behind and nothing runs it any more, so it reads as interrupted instead of blocking every resume until a restart.

    `claimed`: the caller claims the worker lock when it accepts work (WorkerLocks.claim) and its executor keeps it to
    the end, so in this process an accepted record needs the lock as well: an executor whose first save failed leaves
    `accepted` behind with nothing left to run it."""
    from src.services.process_identity import state
    status = record.get("status")
    if status not in ("accepted", "running") or state(record.get("process")) == "exited":
        return False
    if held or not this_process(record.get("process")):
        return True
    return status == "accepted" and not claimed


def final_write(write, label="record"):
    """A worker's last save (its completion, pause or failure). A storage or database blip must not leave the record
    saying the work still runs: the save is tried again with backoff while the worker still holds its lock, and the
    last error is raised only after that."""
    for delay in (*FINAL_WRITE_DELAYS, None):
        try:
            return write()
        except Exception as exc:
            if delay is None:
                raise
            LOGGER.warning("Saving the %s failed (%s); trying again in %s s", label, type(exc).__name__, delay)
            time.sleep(delay)
