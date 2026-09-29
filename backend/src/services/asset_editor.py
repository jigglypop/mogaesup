"""Local revision storage for an operator's dedicated Blender MCP instance."""

from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Callable, TypeVar

from src.services.asset_delivery import DeliveryPolicy, inspect_glb, read_model
from src.services.blender_edits import EditRecipe, edit_script
from src.services.blender_mcp import BlenderMCP, BlenderExecutionUncertain


class RevisionConflict(ValueError):
    pass


_T = TypeVar("_T")


def _retry_file_io(operation: Callable[[], _T]) -> _T:
    for attempt in range(6):
        try:
            return operation()
        except PermissionError as error:
            # Windows can briefly deny open/rename during an atomic replacement.
            transient = getattr(error, "winerror", None) in (5, 32, 33) or (os.name == "nt" and error.errno == errno.EACCES)
            if not transient or attempt == 5:
                raise
            time.sleep(.01 * 2 ** attempt)
    raise AssertionError("Unreachable file retry state")


def _write_json(path: Path, value: dict) -> None:
    from src.services.object_storage import write_json
    if write_json(path, value):
        return
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        # Retry only the atomic commit, never the underlying character action.
        _retry_file_io(lambda: temporary.replace(path))
    finally:
        _retry_file_io(lambda: temporary.unlink(missing_ok=True))
    from src.services.object_storage import mark_changed
    mark_changed(path)


class AssetEditor:
    def __init__(self, root: Path, client: BlenderMCP, policy: DeliveryPolicy | None = None):
        self.root = root.resolve()
        self.client = client
        self.policy = policy or DeliveryPolicy()

    def project_path(self, project: str) -> Path:
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}", project):
            raise ValueError("Invalid project ID")
        path = self.root / project
        if not path.resolve().is_relative_to(self.root):
            raise ValueError("Project path escapes editor root")
        return path

    def inspect(self, project: str) -> dict:
        return json.loads((self.project_path(project) / "head.json").read_text(encoding="utf-8"))

    def history(self, project: str) -> list[dict]:
        return [json.loads(path.read_text(encoding="utf-8"))
                for path in sorted(self.project_path(project).glob("revisions/*/attempt.json"))]

    async def import_model(self, project: str, model: Path, user_prompt: str) -> dict:
        return await self._commit(project, expected_revision=0, model=model, recipe=None, user_prompt=user_prompt)

    async def edit(self, project: str, recipe: EditRecipe, expected_revision: int) -> dict:
        if type(expected_revision) is not int or expected_revision < 1:
            raise ValueError("Expected revision must be positive")
        return await self._commit(project, expected_revision=expected_revision, model=None,
                                  recipe=recipe, user_prompt=recipe.user_prompt)

    async def _commit(self, project: str, *, expected_revision: int, model: Path | None,
                      recipe: EditRecipe | None, user_prompt: str) -> dict:
        project_path = self.project_path(project)
        self.root.mkdir(parents=True, exist_ok=True)
        # One state root per addon. A file lock also serializes separate CLI processes.
        lock = self.root / f".blender-{self.client.port}.lock"
        try:
            lock_file = lock.open("x", encoding="utf-8")
        except FileExistsError as exc:
            raise RevisionConflict("Blender is busy or an uncertain attempt needs operator inspection") from exc
        uncertain = False
        attempt = None
        try:
            with lock_file:
                lock_file.write(project)
            head_path = project_path / "head.json"
            previous = self.inspect(project) if head_path.exists() else None
            current_revision = previous["revision"] if previous else 0
            if current_revision != expected_revision:
                raise RevisionConflict(f"Expected revision {expected_revision}, current revision {current_revision}")
            revision = current_revision + 1
            directory = project_path / "revisions" / f"{revision:06d}-{uuid.uuid4().hex}"
            directory.mkdir(parents=True)
            if model is not None:
                data = read_model(model, self.policy)
                quality = inspect_glb(data, self.policy)
                if quality["errors"]:
                    raise ValueError("Source GLB rejected: " + "; ".join(quality["errors"]))
                source = directory / "input.glb"
                source.write_bytes(data)
            else:
                source = Path(previous["source"])
                if not source.resolve().is_relative_to(project_path):
                    raise ValueError("Source path escapes project")
                with source.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                if digest != previous["source_sha256"]:
                    raise ValueError("Committed Blender source was modified outside the editor")
            blend_output, glb_output = directory / "source.blend", directory / "model.glb"
            operations = [op.model_dump() for op in recipe.operations] if recipe else []
            attempt = {"project": project, "revision": revision, "status": "running",
                       "expected_revision": expected_revision, "operations": operations,
                       "source": str(blend_output), "model": str(glb_output)}
            _write_json(directory / "attempt.json", attempt)
            snapshot = await self.client.execute(edit_script(
                source=str(source), blend_output=str(blend_output), glb_output=str(glb_output),
                operations=operations, importing=model is not None), user_prompt)
            if not blend_output.is_file() or not glb_output.is_file():
                raise BlenderExecutionUncertain("Blender reported completion but output files are missing")
            data = read_model(glb_output, self.policy)
            quality = inspect_glb(data, self.policy)
            _write_json(directory / "quality.json", quality)
            if quality["errors"]:
                raise ValueError("Edited GLB rejected: " + "; ".join(quality["errors"]))
            with blend_output.open("rb") as stream:
                source_hash = hashlib.file_digest(stream, "sha256").hexdigest()
            result = {**attempt, "status": "review_required", "model_sha256": quality["sha256"],
                      "source_sha256": source_hash, "quality": quality, "scene": snapshot}
            _write_json(directory / "attempt.json", result)
            _write_json(head_path, result)
            return result
        except BaseException as exc:
            uncertain = isinstance(exc, (BlenderExecutionUncertain, KeyboardInterrupt))
            if attempt is not None:
                attempt["status"] = "uncertain" if uncertain else "failed"
                _write_json(directory / "attempt.json", attempt)
            raise
        finally:
            if not uncertain:
                lock.unlink(missing_ok=True)
