"""Read-only character planning shared by the CLI harness and control API."""

from __future__ import annotations

import argparse
import hashlib
import json
from src.services.object_storage import StoredPath as Path
import subprocess


ACTIVE = {"PENDING", "IN_PROGRESS"}
FAILED = {"FAILED", "CANCELED", "CANCELLED", "submission_rejected"}


def _read(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def _digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def _command(*args: object) -> str:
    return subprocess.list2cmdline([str(value) for value in args])


def _latest_local_setup(run: Path) -> Path | None:
    candidates = list(run.glob("local-*/setup.json"))
    return max(candidates, key=lambda path: path.stat().st_mtime) if candidates else None


def _parts_file(run: Path) -> Path | None:
    direct = run / "parts.json"
    if direct.is_file():
        return direct
    candidates = list(run.glob("export/*/parts.json"))
    return max(candidates, key=lambda path: path.stat().st_mtime) if candidates else None


def inspect_character(character: dict, root: Path) -> dict:
    character_id = character.get("id")
    if not isinstance(character_id, str) or not character_id:
        raise ValueError("Every character requires a non-empty id")
    if not isinstance(character.get("image"), str) or not isinstance(character.get("run"), str):
        raise ValueError(f"{character_id}: image and run must be paths")

    image = (root / character["image"]).resolve()
    run = (root / character["run"]).resolve()
    item = {"id": character_id, "state": "source_ready", "next_action": None,
            "requires_external_mutation": False, "command": None, "problems": []}
    if not image.is_file():
        item.update(state="blocked", next_action="provide_source_image")
        item["problems"].append(f"missing image: {image}")
        return item

    state_path = run / "character.json"
    if not state_path.is_file():
        height = character.get("height_meters")
        if type(height) not in (int, float) or not 0.1 <= height <= 100:
            item.update(state="blocked", next_action="set_height_meters")
            item["problems"].append("height_meters must be set before generation")
            return item
        item.update(next_action="submit_generation", requires_external_mutation=True,
                    command=_command("uv", "run", "python", "-m", "src.character_cli",
                                     "--run", character["run"], "generate", "--image",
                                     character["image"], "--height", height))
        return item

    state = _read(state_path)
    item["state"] = f"{state.get('stage', 'unknown')}:{state.get('status', 'unknown')}"
    recorded_image = state.get("image")
    if recorded_image and Path(recorded_image).resolve() != image:
        item["problems"].append("run image path differs from the batch manifest")
    if state.get("image_sha256") and state["image_sha256"] != _digest(image):
        item["problems"].append("source image hash differs from persisted run state")
    if item["problems"]:
        item.update(state="blocked", next_action="resolve_provenance_conflict")
        return item

    parts_path = _parts_file(run)
    if parts_path:
        parts = _read(parts_path)
        roles = {part.get("role") for part in parts.get("parts", []) if isinstance(part, dict)}
        required = set(character.get("required_parts", []))
        if missing := sorted(required - roles):
            item["problems"].append("missing required part roles: " + ", ".join(missing))
        if not isinstance(parts.get("armature"), str) or not parts["armature"]:
            item["problems"].append("parts manifest requires an armature")
        sources = [path for path in (run / "rigged.glb", run / "generated.glb") if path.is_file()]
        if sources and parts.get("source_sha256") not in {_digest(path) for path in sources}:
            item["problems"].append("parts source hash does not match a preserved source GLB")
        if (not item["problems"] and parts.get("technical_status") == "approved"
                and parts.get("visual_status") == "approved"):
            item.update(state="approved", next_action="none")
        else:
            item.update(state="review_required", next_action="complete_parts_review")
        item["parts"] = str(parts_path)
        return item

    if (run / "rigged.glb").is_file():
        item.update(state="rigged", next_action="author_part_separation")
        return item

    stage, status = state.get("stage"), state.get("status")
    status_command = _command("uv", "run", "python", "-m", "src.character_cli",
                              "--run", character["run"], "status")
    if status == "submission_uncertain":
        item.update(state="blocked", next_action="recover_task_id")
        item["problems"].append("find the existing Meshy task ID; do not resubmit")
    elif status in ACTIVE:
        item.update(state="in_progress", next_action="poll_" + str(stage), command=status_command)
    elif stage == "generation" and status == "SUCCEEDED":
        if not (run / "generated.glb").is_file():
            item.update(next_action="download_generation",
                        command=_command("uv", "run", "python", "-m", "src.character_cli",
                                         "--run", character["run"], "download", "--stage", "generation"))
        else:
            item.update(next_action="submit_rigging", requires_external_mutation=True,
                        command=_command("uv", "run", "python", "-m", "src.character_cli",
                                         "--run", character["run"], "rig"))
    elif stage == "rigging" and status == "SUCCEEDED":
        item.update(next_action="download_rigging",
                    command=_command("uv", "run", "python", "-m", "src.character_cli",
                                     "--run", character["run"], "download", "--stage", "rigging"))
    elif status in FAILED:
        setup = _latest_local_setup(run)
        if stage == "rigging" and setup:
            item.update(state="review_required", next_action="review_local_fallback",
                        local_setup=str(setup))
        elif stage == "rigging" and (run / "generated.glb").is_file():
            item.update(state="blocked", next_action="choose_new_run_or_local_fallback")
        else:
            item.update(state="blocked", next_action="inspect_provider_failure")
    else:
        item.update(state="blocked", next_action="inspect_unknown_state")
    return item


def audit(manifest: Path, root: Path) -> list[dict]:
    payload = _read(manifest)
    if payload.get("version") != 1 or not isinstance(payload.get("characters"), list):
        raise ValueError("Manifest requires version 1 and a characters list")
    results = [inspect_character(character, root) for character in payload["characters"]]
    ids = [item["id"] for item in results]
    if len(ids) != len(set(ids)):
        raise ValueError("Character ids must be unique")
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    results = audit(args.manifest, args.root.resolve())
    if args.json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
        return
    print(f"{'ID':<8} {'STATE':<24} {'NEXT ACTION':<34} EXTERNAL")
    for item in results:
        external = "yes" if item["requires_external_mutation"] else "no"
        print(f"{item['id']:<8} {item['state']:<24} {item['next_action']:<34} {external}")
        for problem in item["problems"]:
            print(f"         ! {problem}")
        if item["command"]:
            print(f"         > {item['command']}")


if __name__ == "__main__":
    main()
