"""Run a fixed material-boundary recipe in an isolated Blender process."""

from contextlib import contextmanager
import os
from pathlib import Path
import shutil
import subprocess
import json

from src.services.asset_delivery import DeliveryPolicy, inspect_glb
from src.services.asset_editor import _write_json
from src.services.object_storage import publish_checkpoint, sha256 as _digest
from src.services.process_identity import identity
from src.services.worker_env import worker_environment


def blender_executable() -> str | None:
    configured = os.getenv("BLENDER_EXECUTABLE")
    if configured:
        return configured if Path(configured).is_file() else None
    found = shutil.which("blender")
    if found:
        return found
    if os.name == "nt":
        candidates = sorted(Path(os.environ.get("ProgramFiles", "C:/Program Files")).glob("Blender Foundation/Blender */blender.exe"))
        return str(candidates[-1]) if candidates else None
    return None


def stop_process(process: subprocess.Popen, grace: float = 10) -> None:
    """Stop a timed-out worker: terminate, kill it if it ignores that, and reap it.

    Raises subprocess.TimeoutExpired only if the process survives a kill; its runner
    receipt then still names a live process, so callers never report it as stopped.
    """
    process.terminate()
    try:
        process.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=grace)


@contextmanager
def blender_process(command, log_path, runner_path, *, env=None, write_json, receipt=None, checkpoint=True):
    """Start a Blender worker, write its runner.json receipt, and yield the process for the caller to wait on.

    A worker whose receipt cannot be written is stopped: nothing would supervise it, and the next resume would start
    a second one. `write_json` is the caller's own writer; `receipt` returns extra receipt fields once the process exists.
    """
    with log_path.open("wb") as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, env=worker_environment() if env is None else env,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            write_json(runner_path, {"process": identity(process.pid), **(receipt() if receipt else {})})
            if checkpoint:
                publish_checkpoint(runner_path)
        except BaseException:
            stop_process(process)
            raise
        yield process


def separate_materials(model: Path, output: Path, selections: list[dict] | None = None, source_sha256: str | None = None) -> dict:
    executable = blender_executable()
    if not executable:
        raise ValueError("Blender executable is unavailable")
    source = inspect_glb(model.read_bytes())
    if source["errors"] or not source["metrics"]["skins"]:
        raise ValueError("A valid rigged source is required")
    output.mkdir(parents=True, exist_ok=False)
    worker_model = model
    if selections is not None:
        from src.services.character_segmentation import split_faces
        content, parts = split_faces(model.read_bytes(), source_sha256, selections)
        worker_model = output / "selected.glb"
        worker_model.write_bytes(content)
        _write_json(output / "selection.json", {"source_sha256": source_sha256, "selections": selections, "parts": parts})
    _write_json(output / "input.json", {"model": str(worker_model.resolve()), "output": str(output.resolve()),
                                      "original_model": str(model.resolve()),
                                      "source_sha256": _digest(worker_model), "review_only": selections is not None})
    command = [executable, "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1",
               "--python", str(Path(__file__).with_name("character_parts_blender.py")), "--", str(output / "input.json")]
    from src.services.avatar_factory import _QUEUE
    # One BLENDER_CONCURRENCY slot, as for assembly. The only caller holds non-blocking
    # run/Blender file locks, never this semaphore, so waiting here cannot deadlock.
    # The worker's own timeout starts once a slot is granted.
    with _QUEUE, blender_process(command, output / "blender.log", output / "runner.json", write_json=_write_json,
                                 receipt=lambda: {"source_sha256": _digest(model)}, checkpoint=False) as process:
        try:
            code = process.wait(timeout=240)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise ValueError("Blender timed out; isolated worker was stopped")
    if code:
        raise ValueError("Blender separation failed; original model is preserved")
    return finalize(model, output)


def finalize(model: Path, output: Path) -> dict:
    """Validate a sealed worker result; safe to repeat without launching Blender."""
    source = inspect_glb(model.read_bytes())
    payload = json.loads((output / "input.json").read_text(encoding="utf-8"))
    runner = json.loads((output / "runner.json").read_text(encoding="utf-8"))
    seal = json.loads((output / "worker-complete.json").read_text(encoding="utf-8"))
    if runner.get("source_sha256") != _digest(model) or source["errors"]:
        raise ValueError("Original source changed")
    selections = payload.get("review_only", False)
    worker_model = output / "selected.glb" if selections else model
    expected = {"source.blend", "rest.png", "candidates.json", "selected.glb" if selections else "character.glb"}
    if selections:
        expected.add("selection.json")
    if (payload.get("source_sha256") != _digest(worker_model)
            or seal.get("source_sha256") != payload["source_sha256"]
            or seal.get("input_sha256") != _digest(output / "input.json")
            or set(seal.get("files", {})) != expected):
        raise ValueError("Worker completion does not match its input")
    if any(not (output / name).is_file() or _digest(output / name) != digest for name, digest in seal["files"].items()):
        raise ValueError("Worker completion files changed")
    if selections:
        selection = json.loads((output / "selection.json").read_text(encoding="utf-8"))
        if selection.get("source_sha256") != _digest(model):
            raise ValueError("Part selection source changed")
        # The GLB retains exact source buffers; Blender produces the editable .blend and render.
        shutil.copyfile(worker_model, output / "character.glb")
    policy = DeliveryPolicy(required_joints=source["metrics"]["joints"],
                            required_animations=source["metrics"]["animations"])
    quality = inspect_glb((output / "character.glb").read_bytes(), policy)
    _write_json(output / "quality.json", quality)
    if quality["errors"]:
        raise ValueError("Separated model failed validation; original model is preserved")
    result = {"source_sha256": _digest(model), "model_sha256": _digest(output / "character.glb"),
              "recipe": "authored-faces-v1" if selections else "material-boundaries-v1", "status": "review_required"}
    _write_json(output / "complete.json", result)
    return result
