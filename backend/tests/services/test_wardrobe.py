import json
from pathlib import Path

import httpx
import pytest

from src.services.blender_mcp import BlenderExecutionUncertain, BlenderMCP
from src.services.wardrobe import Wardrobe, _digest, _worker, run_lock


def prepared(tmp_path):
    wardrobe = Wardrobe(tmp_path, BlenderMCP())
    template, reference = tmp_path / "template.glb", tmp_path / "image.png"
    template.write_bytes(b"model")
    reference.write_bytes(b"image")
    wardrobe.save({"status": "prepared", "template": str(template), "reference": str(reference),
                   "template_sha256": _digest(template), "reference_sha256": _digest(reference)})
    return wardrobe


def test_submission_is_resumable_without_double_charge(tmp_path):
    wardrobe = prepared(tmp_path)
    requests = []

    def handler(request):
        requests.append(request)
        if request.method == "POST":
            payload = json.loads(request.content)
            assert payload["model_url"].startswith("data:application/octet-stream;base64,")
            assert payload["image_style_url"].startswith("data:image/png;base64,")
            return httpx.Response(200, json={"result": "task-1"})
        return httpx.Response(200, json={"status": "SUCCEEDED", "model_urls": {"glb": "https://cdn.test/a.glb"}})

    with httpx.Client(base_url="https://api.test", transport=httpx.MockTransport(handler)) as client:
        wardrobe.submit(client)
        with pytest.raises(ValueError, match="not prepared"):
            wardrobe.submit(client)
        assert wardrobe.status(client)["status"] == "generated"
    assert [r.method for r in requests] == ["POST", "GET"]


def test_timeout_does_not_allow_resubmission(tmp_path):
    wardrobe = prepared(tmp_path)

    def handler(request):
        raise httpx.ReadTimeout("lost response", request=request)

    with httpx.Client(base_url="https://api.test", transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(httpx.ReadTimeout):
            wardrobe.submit(client)
        assert wardrobe.state()["status"] == "submission_uncertain"
        with pytest.raises(ValueError):
            wardrobe.submit(client)


def test_changed_reference_rejected_before_post(tmp_path):
    wardrobe = prepared(tmp_path)
    Path(wardrobe.state()["reference"]).write_bytes(b"changed")
    with pytest.raises(ValueError, match="reference changed"):
        wardrobe.submit(None)
    assert wardrobe.state()["status"] == "prepared"


def test_worker_compiles_and_paths_are_data():
    payload = {"stage": "prepare", "base": "x'\nraise Exception('injected')"}
    compile(_worker(payload), "worker", "exec")


def test_lock_rejects_concurrent_run_and_releases(tmp_path):
    directory = tmp_path / "run"
    with run_lock(directory, 62123):
        with pytest.raises(ValueError, match="busy"):
            with run_lock(directory, 62123):
                pass
    with run_lock(directory, 62123):
        pass


def test_download_rejects_invalid_glb(tmp_path):
    wardrobe = prepared(tmp_path)
    wardrobe.save({"status": "generated", "garment_url": "https://cdn.test/a.glb"})
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b"bad"))) as client:
        with pytest.raises(ValueError, match="rejected"):
            wardrobe.download(client)
    assert not (tmp_path / "generated.glb").exists()
