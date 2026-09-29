import copy
import json
import sys
from pathlib import Path

import httpx
import pytest

from src import character_cli
from src.services.character_setup import validate_recipe
from src.services.wardrobe import _digest, download_glb


def test_recipe_rejects_different_character_and_invalid_landmarks(tmp_path):
    model = tmp_path / "model.glb"
    model.write_bytes(b"source")
    recipe = {"model_sha256": _digest(model), "default_bone": "head",
              "bones": [{"name": "head", "head": [0, 0, 0], "tail": [0, 0, 1]}],
              "garment_regions": [{"min": [-1, -1, -1], "max": [1, 1, 1]}]}
    validate_recipe(recipe, model)
    for mutation in (
        lambda r: r.update(model_sha256="wrong"),
        lambda r: r["bones"][0].update(parent="missing"),
        lambda r: r["bones"][0].update(tail=[0, 0, 0]),
        lambda r: r["bones"][0].update(tail=[0, float("nan"), 1]),
        lambda r: r.update(weight_regions=[{"min": [-1, -1, -1], "max": [1, 1, 1], "bones": ["missing"]}]),
    ):
        invalid = copy.deepcopy(recipe)
        mutation(invalid)
        with pytest.raises(ValueError):
            validate_recipe(invalid, model)


def test_bad_download_preserves_previous_artifact(tmp_path):
    output = tmp_path / "model.glb"
    output.write_bytes(b"previous")
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b"invalid"))) as client:
        with pytest.raises(ValueError, match="rejected"):
            download_glb(client, "https://cdn.test/model.glb", output)
    assert output.read_bytes() == b"previous"
    assert not output.with_suffix(".glb.part").exists()


def install_client(monkeypatch, handler):
    client_type = httpx.Client
    monkeypatch.setattr(character_cli.httpx, "Client", lambda **kwargs: client_type(
        **kwargs, transport=httpx.MockTransport(handler)))
    monkeypatch.setattr(character_cli, "load_dotenv", lambda: None)
    monkeypatch.setenv("MESHY_API_KEY", "test-only")


@pytest.mark.parametrize("failure", ["timeout", "rejected"])
def test_rig_failure_preserves_generation_id_and_blocks_duplicate_submit(tmp_path, monkeypatch, failure):
    state_path = tmp_path / "character.json"
    state_path.write_text(json.dumps({"stage": "generation", "status": "SUCCEEDED",
                                     "task_id": "generation-1", "height_meters": 1.7}))
    requests = []

    def handler(request):
        requests.append(request)
        assert json.loads(request.content) == {"input_task_id": "generation-1", "height_meters": 1.7}
        if failure == "timeout":
            raise httpx.ReadTimeout("response lost", request=request)
        return httpx.Response(422, json={"message": "Pose estimation failed"})

    install_client(monkeypatch, handler)
    monkeypatch.setattr(sys, "argv", ["character", "--run", str(tmp_path), "rig"])
    with pytest.raises((httpx.ReadTimeout, httpx.HTTPStatusError)):
        character_cli.main()
    state = json.loads(state_path.read_text())
    assert state["generation_task_id"] == "generation-1"
    assert state["status"] == ("submission_uncertain" if failure == "timeout" else "submission_rejected")
    with pytest.raises(SystemExit):
        character_cli.main()
    assert len(requests) == 1


def test_recover_uncertain_rig_uses_get_only(tmp_path, monkeypatch):
    path = tmp_path / "character.json"
    path.write_text(json.dumps({"stage": "rigging", "status": "submission_uncertain",
                               "generation_task_id": "generation-1"}))

    def handler(request):
        assert request.method == "GET"
        assert request.url.path == "/openapi/v1/rigging/recovered-1"
        return httpx.Response(200, json={"status": "SUCCEEDED", "progress": 100})

    install_client(monkeypatch, handler)
    monkeypatch.setattr(sys, "argv", ["character", "--run", str(tmp_path), "status", "--task-id", "recovered-1"])
    character_cli.main()
    state = json.loads(path.read_text())
    assert state["task_id"] == "recovered-1"
    assert state["generation_task_id"] == "generation-1"


def test_download_rig_and_optional_animations_without_api_credentials(tmp_path, monkeypatch):
    (tmp_path / "rigging-result.json").write_text(json.dumps({"status": "SUCCEEDED", "result": {
        "rigged_character_glb_url": "https://cdn.test/rigged.glb",
        "basic_animations": {"walking_glb_url": "https://cdn.test/walking.glb"}}}))
    downloaded = []

    def fake_download(client, url, output):
        assert "Authorization" not in client.headers
        downloaded.append(url)
        output.write_bytes(b"validated model")
        return {"errors": []}

    monkeypatch.setattr(character_cli, "download_glb", fake_download)
    artifacts = character_cli.download(tmp_path, "rigging")
    assert set(artifacts) == {"rigged", "walking"}
    assert len(downloaded) == 2
    assert (tmp_path / "rigging-artifacts.json").is_file()
