import hashlib
import json
from src.services import character_audit as AUDIT


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def manifest(tmp_path):
    image = tmp_path / "image.png"
    image.write_bytes(b"source")
    payload = {"version": 1, "characters": [{"id": "A", "image": "image.png",
               "run": "run", "height_meters": 1.7,
               "required_parts": ["body", "outfit_base"]}]}
    path = tmp_path / "batch.json"
    write_json(path, payload)
    return path, image


def test_uncertain_submission_never_plans_an_external_retry(tmp_path):
    batch, image = manifest(tmp_path)
    write_json(tmp_path / "run/character.json", {
        "image": str(image),
        "image_sha256": hashlib.sha256(image.read_bytes()).hexdigest(),
        "stage": "generation",
        "status": "submission_uncertain",
    })

    result = AUDIT.audit(batch, tmp_path)[0]

    assert result["next_action"] == "recover_task_id"
    assert result["requires_external_mutation"] is False
    assert result["command"] is None


def test_parts_approval_requires_roles_armature_and_matching_source(tmp_path):
    batch, image = manifest(tmp_path)
    source = tmp_path / "run/rigged.glb"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"rigged")
    write_json(tmp_path / "run/character.json", {
        "image": str(image),
        "image_sha256": hashlib.sha256(image.read_bytes()).hexdigest(),
        "stage": "rigging",
        "status": "SUCCEEDED",
    })
    write_json(tmp_path / "run/parts.json", {
        "source_sha256": "wrong",
        "parts": [{"role": "body"}],
        "technical_status": "approved",
        "visual_status": "approved",
    })

    result = AUDIT.audit(batch, tmp_path)[0]

    assert result["state"] == "review_required"
    assert result["next_action"] == "complete_parts_review"
    assert len(result["problems"]) == 3
