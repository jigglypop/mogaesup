"""One user operation, resumable rigging and animation API tasks; no blind retries."""

import base64
import json
import re
import time
from src.services.object_storage import StoredPath as Path

import httpx

from src.services import character_jobs
from src.services.animation_glb import merge_character_clips
from src.services.asset_editor import _write_json
from src.services.asset_delivery import inspect_glb
from src.services.wardrobe import _digest, download_glb
from src.services.meshy_status import BLOCKED
from src.services.runtime_activity import paid_request

DEFAULT_ACTIONS = {"idle": 0, "walk": 1, "run": 14, "jump": 466, "fall": 502}
ENDPOINTS = {"rig": "/openapi/v1/rigging", "animation": "/openapi/v1/animations"}


def read_pack(run: Path) -> dict:
    path = run / "motion-pack.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def library(client: httpx.Client) -> list[dict]:
    response = client.get("/openapi/v1/animations/library")
    response.raise_for_status()
    values = response.json()
    if not isinstance(values, list) or any(not isinstance(v.get("action_id"), int) for v in values):
        raise ValueError("Unexpected Meshy library response")
    return values


def _save(run, pack):
    _write_json(run / "motion-pack.json", pack)


def _task(run, pack, slot, endpoint, payload, client):
    tasks = pack.setdefault("tasks", {})
    value = tasks.get(slot)
    if value is None:
        if pack["submitted_tasks"] >= pack["max_new_tasks"]:
            raise ValueError("Authorized task budget exhausted")
        receipt_payload = {k: v for k, v in payload.items() if k != "model_url"}
        if "model_url" in payload:
            receipt_payload["input_sha256"] = pack["input_sha256"]
        value = {"status": "submission_uncertain", "endpoint": endpoint, "payload": receipt_payload}
        tasks[slot] = value
        pack["submitted_tasks"] += 1
        _save(run, pack)  # durable intent before every possibly paid POST
        try:
            with paid_request():
                response = client.post(endpoint, json=payload)
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
            value.update(status="submission_not_sent")
            _save(run, pack)
            raise
        if response.status_code in character_jobs.NOT_ACCEPTED:
            value.update(status="submission_rejected", http_status=response.status_code)
            _save(run, pack)
        character_jobs.save_submission_response(run, slot, response)
        response.raise_for_status()
        task_id = response.json().get("result")
        if not isinstance(task_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", task_id):
            raise ValueError("Recover the submitted task ID before continuing")
        # Do not persist an imported model's base64 payload in every task receipt.
        if "model_url" in value["payload"]:
            value["payload"] = {"height_meters": payload["height_meters"], "input_sha256": pack["input_sha256"]}
        value.update(task_id=task_id, status="PENDING")
        _save(run, pack)
    if value["status"] in BLOCKED:
        raise ValueError("Existing provider attempt requires recovery; no automatic resubmission")
    if value["status"] != "SUCCEEDED":
        response = client.get(f"{endpoint}/{value['task_id']}")
        response.raise_for_status()
        task = response.json()
        value.update(status=task["status"], progress=task.get("progress"), result=task.get("result"), consumed_credits=task.get("consumed_credits"))
        _save(run, pack)
    elif slot == "rig" or slot not in pack.get("clips", {}):
        # Output URLs expire. Recover fresh URLs with a GET, never another POST.
        response = client.get(f"{endpoint}/{value['task_id']}")
        response.raise_for_status()
        task = response.json()
        value.update(status=task["status"], result=task.get("result"), consumed_credits=task.get("consumed_credits"))
        _save(run, pack)
    if value["status"] in {"FAILED", "CANCELED"}:
        raise ValueError("Provider task failed; original assets are preserved")
    return value


def prepare(run: Path, model: Path | None, height: float, actions: dict, max_new_tasks: int,
            client: httpx.Client, *, timeout: float = 1200, poll_interval: float = 5, download_model=download_glb) -> dict:
    pack = read_pack(run)
    if not pack:
        available = {item["action_id"]: item for item in library(client)}
        if set(actions) != set(DEFAULT_ACTIONS) or any(value not in available for value in actions.values()):
            raise ValueError("Choose five currently available library actions")
        provider = character_jobs.state(run) if (run / "character.json").exists() else {}
        if provider and provider.get("status") != "SUCCEEDED":
            raise ValueError("Resolve the existing Meshy task first")
        if not height or not (model or provider.get("task_id")):
            raise ValueError("A source model or successful generation and height are required")
        tasks = {}
        if provider.get("stage") == "rigging":
            tasks["rig"] = {"task_id": provider["task_id"], "status": "PENDING", "endpoint": ENDPOINTS["rig"], "payload": {}}
        pack = {"version": 1, "status": "in_progress", "input_sha256": _digest(model) if model else None,
                "height_meters": height, "generation_task_id": provider.get("task_id") if provider.get("stage") == "generation" else None,
                "actions": actions, "catalog": {slot: available[action] for slot, action in actions.items()},
                "max_new_tasks": max_new_tasks, "submitted_tasks": 0, "tasks": tasks, "clips": {}}
        _save(run, pack)
    if pack.get("status") == "complete":
        output = run / "motions/character.glb"
        if not output.is_file() or _digest(output) != pack.get("model_sha256"):
            raise ValueError("Completed animation package changed")
        return pack
    if model and pack.get("input_sha256") != _digest(model):
        raise ValueError("Source model changed; preserve this pack and register a new source")
    deadline = time.monotonic() + timeout
    output = run / "motions"
    output.mkdir(exist_ok=True)
    while True:
        if pack.get("generation_task_id"):
            rig_payload = {"input_task_id": pack["generation_task_id"], "height_meters": pack["height_meters"]}
        elif "rig" in pack["tasks"]:
            rig_payload = {}
        else:
            rig_payload = {"model_url": "data:model/gltf-binary;base64," + base64.b64encode(model.read_bytes()).decode(), "height_meters": pack["height_meters"]}
        rig = _task(run, pack, "rig", ENDPOINTS["rig"], rig_payload, client)
        if rig["status"] == "SUCCEEDED":
            result = rig.get("result") or {}
            with httpx.Client(timeout=120, follow_redirects=True) as downloader:
                canonical = output / "rigged.glb"
                if not canonical.exists():
                    download_model(downloader, result["rigged_character_glb_url"], canonical)
                for slot, action_id in pack["actions"].items():
                    if slot in pack["clips"]:
                        path = output / (slot + ".glb")
                        if not path.exists() or _digest(path) != pack["clips"][slot]["sha256"]:
                            raise ValueError("Downloaded animation changed")
                        continue
                    basic = (result.get("basic_animations") or {}).get({"walk": "walking_glb_url", "run": "running_glb_url"}.get(slot, ""))
                    if basic:
                        url, task_id, source_kind = basic, rig["task_id"], "rigging_basic"
                    else:
                        task = _task(run, pack, slot, ENDPOINTS["animation"], {"rig_task_id": rig["task_id"], "action_id": action_id}, client)
                        if task["status"] != "SUCCEEDED":
                            continue
                        url, task_id, source_kind = task["result"]["animation_glb_url"], task["task_id"], "animation_library"
                    path = output / (slot + ".glb")
                    download_model(downloader, url, path)
                    quality = inspect_glb(path.read_bytes())
                    if quality["errors"] or not quality["metrics"]["animations"]:
                        raise ValueError(f"Invalid animation result: {slot}")
                    pack["clips"][slot] = {"sha256": _digest(path), "task_id": task_id, "source": source_kind,
                                            "action_id": action_id if not basic else None,
                                            "lineage": pack["tasks"].get(slot, rig).get("recovery_method", "submitted_by_pipeline")}
                    _save(run, pack)
            if set(pack["clips"]) == set(DEFAULT_ACTIONS):
                merged = merge_character_clips(canonical.read_bytes(), {slot: (output / (slot + ".glb")).read_bytes() for slot in pack["clips"]})
                quality = inspect_glb(merged)
                if quality["errors"]:
                    raise ValueError("Merged character failed validation")
                (output / "character.glb").write_bytes(merged)
                _write_json(output / "quality.json", quality)
                pack.update(status="complete", model_sha256=_digest(output / "character.glb"))
                _save(run, pack)
                return pack
        if time.monotonic() >= deadline:
            pack["status"] = "awaiting_provider"
            _save(run, pack)
            return pack
        time.sleep(poll_interval)


def recover(run: Path, slot: str, task_id: str, client: httpx.Client):
    pack = read_pack(run)
    task = pack.get("tasks", {}).get(slot)
    if not task or task["status"] != "submission_uncertain":
        raise ValueError("No uncertain submission for this stage")
    response = client.get(f"{task['endpoint']}/{task_id}")
    response.raise_for_status()
    result = response.json()
    if slot != "rig":
        if (result.get("rig_task_id") is not None and result["rig_task_id"] != pack["tasks"]["rig"]["task_id"]
                or result.get("action_id") is not None and result["action_id"] != pack["actions"][slot]):
            raise ValueError("Recovered animation belongs to another input")
    # The documented task response may omit input IDs. Keep operator recovery explicit;
    # a successful GET is not evidence that the provider echoed the input lineage.
    task.update(task_id=task_id, status="PENDING", recovery_method="operator_task_id")
    _save(run, pack)
