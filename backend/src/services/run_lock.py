"""Lock files that keep one CLI run, and the Blender port it uses, to a single process."""

from __future__ import annotations

import json
import uuid
from contextlib import contextmanager
from src.services.blender_mcp import BlenderExecutionUncertain
from src.services.object_storage import StoredPath as Path


@contextmanager
def run_lock(directory: Path, port: int, *, blender: bool = True):
    """Serialize CLI processes; keep locks after uncertain Blender execution."""
    import tempfile

    directory = directory.resolve()
    directory.parent.mkdir(parents=True, exist_ok=True)
    from src.services.process_identity import identity, lease_guard
    lease = {"version": 1, "token": uuid.uuid4().hex, "directory": str(directory), "owner": identity()}
    locks = [directory.with_name(directory.name + ".lock")]
    if blender:
        locks.append(Path(tempfile.gettempdir()) / f"asset-wardrobe-blender-{port}.lock")
    acquired = []
    uncertain = False
    try:
        with lease_guard(directory):
            for path in locks:
                try:
                    with path.open("x", encoding="utf-8") as stream:
                        stream.write(json.dumps(lease))
                except FileExistsError as exc:
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
