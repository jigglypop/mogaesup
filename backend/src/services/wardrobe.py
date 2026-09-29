"""Local, resumable wardrobe runs; existing world API and DB are unchanged."""

from __future__ import annotations

import base64
import json
import re
import uuid
from contextlib import contextmanager
from src.services.object_storage import StoredPath as Path
from src.services.object_storage import sha256

import httpx

from src.services.asset_delivery import DeliveryPolicy, inspect_glb, read_model
from src.services.asset_editor import _write_json
from src.services.blender_mcp import BlenderMCP
from src.services.blender_mcp import BlenderExecutionUncertain
from src.services.glb import parse_glb


def _digest(path: Path) -> str:
    return sha256(path)


def download_glb(client: httpx.Client, url: str, output: Path, *, preserve_detail: bool = False) -> dict:
    """Validate a CDN download before replacing an artifact; client has no API key."""
    policy = DeliveryPolicy(max_file_bytes=256 * 1024 * 1024) if preserve_detail else DeliveryPolicy()
    data = bytearray()
    with client.stream("GET", url) as response:
        response.raise_for_status()
        for chunk in response.iter_bytes():
            data.extend(chunk)
            if len(data) > policy.max_file_bytes:
                raise ValueError("Generated GLB exceeds file budget")
    quality = inspect_glb(bytes(data), policy, budget_warnings=preserve_detail)
    if quality["errors"]:
        raise ValueError("Generated GLB rejected: " + "; ".join(quality["errors"]))
    temporary = output.with_suffix(".glb.part")
    temporary.write_bytes(data)
    temporary.replace(output)
    return quality


def _worker(payload: dict) -> str:
    worker = Path(__file__).with_name("wardrobe_blender.py").read_text(encoding="utf-8")
    return (worker + "\nimport bpy, json\np = json.loads(" + repr(json.dumps(payload)) + ")\n"
            "if p['stage'] == 'prepare':\n    bpy.ops.wm.read_factory_settings(use_empty=True)\n"
            "else:\n    bpy.ops.wm.open_mainfile(filepath=p['base_blend'], use_scripts=False, load_ui=False)\n"
            "window = bpy.context.window_manager.windows[0]\n"
            "area = next(a for a in window.screen.areas if a.type == 'VIEW_3D')\n"
            "region = next(r for r in area.regions if r.type == 'WINDOW')\n"
            "with bpy.context.temp_override(window=window, area=area, region=region):\n"
            "    print('ASSET_EDITOR_RESULT=' + json.dumps(run(p)))\n")


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


class Wardrobe:
    def __init__(self, directory: Path, blender: BlenderMCP):
        self.directory = directory.resolve()
        self.blender = blender

    def state(self) -> dict:
        return json.loads((self.directory / "run.json").read_text(encoding="utf-8"))

    def save(self, state: dict) -> None:
        _write_json(self.directory / "run.json", state)

    async def prepare(self, base: Path, reference: Path, source_object: str) -> dict:
        from PIL import Image

        base, reference = base.resolve(), reference.resolve()
        quality = inspect_glb(read_model(base, DeliveryPolicy()))
        if quality["errors"]:
            raise ValueError("Invalid baseline: " + "; ".join(quality["errors"]))
        with Image.open(reference) as img:
            img.verify()
        if reference.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
            raise ValueError("Reference must be PNG or JPEG")
        self.directory.mkdir(parents=True, exist_ok=False)
        state = {"status": "preparing", "base": str(base), "base_sha256": _digest(base),
                 "reference": str(reference), "reference_sha256": _digest(reference),
                 "source_object": source_object, "base_blend": str(self.directory / "base.blend"),
                 "template": str(self.directory / "template.glb")}
        self.save(state)
        state["baseline"] = await self.blender.execute(_worker({**state, "stage": "prepare"}),
                                                       "Extract baseline clothing in rest pose")
        state.update(status="prepared", template_sha256=_digest(Path(state["template"])),
                     base_blend_sha256=_digest(Path(state["base_blend"])))
        self.save(state)
        return state

    def submit(self, api: httpx.Client) -> dict:
        state = self.state()
        if state["status"] != "prepared":
            raise ValueError("Run is not prepared; use status to resume an existing task")
        for key in ("reference", "template"):
            if _digest(Path(state[key])) != state[key + "_sha256"]:
                raise ValueError(f"{key} changed after preparation")
        reference = Path(state["reference"])
        mime = "image/png" if reference.suffix.lower() == ".png" else "image/jpeg"
        payload = {"model_url": "data:application/octet-stream;base64," + base64.b64encode(
                       Path(state["template"]).read_bytes()).decode(),
                   "image_style_url": f"data:{mime};base64," + base64.b64encode(reference.read_bytes()).decode(),
                   "enable_original_uv": True, "enable_pbr": True, "target_formats": ["glb"]}
        # Persist before POST: a timeout must never cause an automatic second charge.
        state["status"] = "submission_uncertain"
        self.save(state)
        response = api.post("/openapi/v1/retexture", json=payload)
        response.raise_for_status()
        task_id = response.json().get("result")
        if not isinstance(task_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+", task_id):
            raise ValueError("Meshy returned no valid task ID; inspect the Meshy dashboard")
        state.update(status="submitted", task_id=task_id)
        self.save(state)
        return state

    def status(self, api: httpx.Client, task_id: str | None = None) -> dict:
        state = self.state()
        task_id = task_id or state.get("task_id")
        if not task_id or not re.fullmatch(r"[a-zA-Z0-9_-]+", task_id):
            raise ValueError("Provide a valid task ID from the Meshy dashboard")
        response = api.get(f"/openapi/v1/retexture/{task_id}")
        response.raise_for_status()
        task = response.json()
        state.update(task_id=task_id, provider_status=task.get("status"), progress=task.get("progress"))
        if task.get("status") == "SUCCEEDED":
            state["garment_url"] = task.get("model_urls", {}).get("glb")
            if not state["garment_url"]:
                raise ValueError("Meshy task succeeded without a GLB URL")
            state["status"] = "generated"
        elif task.get("status") in {"FAILED", "CANCELED", "CANCELLED"}:
            state["status"] = "provider_failed"
        else:
            state["status"] = "submitted"
        self.save(state)
        return state

    def download(self, client: httpx.Client) -> Path:
        state = self.state()
        if state["status"] != "generated":
            raise ValueError("Run status must be generated before downloading")
        output = self.directory / "generated.glb"
        download_glb(client, state["garment_url"], output)
        return output

    async def dress(self, garment: Path, fit: str = "bounds") -> dict:
        if fit not in {"bounds", "none"}:
            raise ValueError("fit must be bounds or none")
        state = self.state()
        for key in ("base", "base_blend"):
            if _digest(Path(state[key])) != state[key + "_sha256"]:
                raise ValueError(f"{key} changed after preparation")
        garment = garment.resolve()
        policy = DeliveryPolicy()
        quality = inspect_glb(read_model(garment, policy), policy)
        if quality["errors"]:
            raise ValueError("Invalid garment: " + "; ".join(quality["errors"]))
        # Every fit has separate outputs, including failed attempts.
        import uuid
        output = self.directory / ("fit-" + uuid.uuid4().hex)
        output.mkdir()
        payload = {**state, "stage": "dress", "garment": str(garment), "fit": fit,
                   "output_glb": str(output / "model.glb"), "output_blend": str(output / "source.blend")}
        _write_json(output / "attempt.json", {"status": "running", "garment_sha256": _digest(garment)})
        result = await self.blender.execute(_worker(payload), "Fit clothing and transfer baseline rig weights")
        baseline, _ = parse_glb(Path(state["base"]).read_bytes(), strict=True)
        policy.required_animations = [a["name"] for a in baseline.get("animations", [])]
        policy.required_joints = state["baseline"]["bones"]
        quality = inspect_glb(read_model(Path(payload["output_glb"]), policy), policy)
        _write_json(output / "quality.json", quality)
        if quality["errors"]:
            raise ValueError("Dressed GLB rejected: " + "; ".join(quality["errors"]))
        result.update(status="review_required", model=payload["output_glb"], source=payload["output_blend"],
                      quality=quality)
        _write_json(output / "attempt.json", result)
        state["latest_fit"] = result
        self.save(state)
        return result
