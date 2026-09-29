from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
import struct
from types import SimpleNamespace
import zipfile

import pytest
from pydantic import ValidationError

from src.services.asset_delivery import DeliveryPolicy, DeliveryRecipe, build_delivery, inspect_glb
from src.services.asset_editor import AssetEditor, RevisionConflict
from src.services.blender_edits import EditRecipe, edit_script
from src.services.blender_mcp import BlenderExecutionError, BlenderExecutionUncertain
from src.services.glb import parse_glb


def glb(doc=None, binary=None):
    binary = binary if binary is not None else struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
    doc = doc or {
        "asset": {"version": "2.0"}, "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [{"buffer": 0, "byteLength": len(binary)}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "nodes": [{"mesh": 0}], "scenes": [{"nodes": [0]}], "scene": 0,
    }
    encoded = json.dumps(doc).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary += b"\x00" * (-len(binary) % 4)
    return (struct.pack("<III", 0x46546C67, 2, 28 + len(encoded) + len(binary))
            + struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
            + struct.pack("<II", len(binary), 0x004E4942) + binary)


def test_preflight_does_not_approve_visuals_or_rights():
    report = inspect_glb(glb())
    assert report["errors"] == []
    assert report["status"] == "review_required"
    assert report["metrics"]["triangles"] == 1


@pytest.mark.parametrize("mutation", [
    lambda d: d["accessors"][0].update(count=10),
    lambda d: d["bufferViews"][0].update(buffer=-1),
    lambda d: d["buffers"][0].update(uri="https://example.test/model.bin"),
    lambda d: d["nodes"][0].update(children=[0]),
    lambda d: d["meshes"][0]["primitives"][0].update(material=4),
    lambda d: d.update(images=[{"uri": "file:///private.png"}]),
    lambda d: d["accessors"][0].update(count=True),
])
def test_preflight_rejects_invalid_resources_and_references(mutation):
    doc, binary = parse_glb(glb())
    mutation(doc)
    assert inspect_glb(glb(doc, binary))["status"] == "rejected"


def test_policy_limits_and_missing_animations():
    report = inspect_glb(glb(), DeliveryPolicy(max_vertices=2, required_animations=["walk"]))
    assert report["errors"] == ["vertices budget exceeded", "required animations missing"]


@pytest.mark.parametrize("data", [b"bad", glb() + b"extra", glb()[:-1]])
def test_strict_container_rejects_bad_lengths(data):
    assert inspect_glb(data)["status"] == "rejected"


def test_legacy_parser_keeps_trailing_byte_behavior():
    assert parse_glb(glb() + b"extra") == parse_glb(glb())


def delivery_recipe(model, source, **kwargs):
    return DeliveryRecipe.model_validate({
        "asset_id": "hat", "revision": 1, "part_type": "rigid", "slot": "hat", "socket": "head",
        "body_asset_id": "body", "body_revision": 1, "rig_ref": "rig-v1", "fit_ref": "fit-v1",
        "occlusion_ref": "none-v1", "review": {
            "reviewer": "test-reviewer", "model_sha256": hashlib.sha256(model).hexdigest(),
            "source_sha256": hashlib.sha256(source).hexdigest(),
            "rights_evidence": "test-only", "visual_evidence": "test-only", "runtime_evidence": "test-only",
        }, **kwargs,
    })


def test_delivery_hashes_and_exclusive_output(tmp_path):
    model, source = tmp_path / "model.glb", tmp_path / "source.blend"
    model.write_bytes(glb())
    source.write_bytes(b"test source; never executed")
    recipe = delivery_recipe(model.read_bytes(), source.read_bytes())
    output = tmp_path / "delivery.zip"
    build_delivery(model, source, recipe, output)
    with zipfile.ZipFile(output) as archive:
        assert set(archive.namelist()) == {"model.glb", "source.blend", "manifest.json"}
        assert archive.read("model.glb") == model.read_bytes()
        assert archive.testzip() is None
    with pytest.raises(FileExistsError):
        build_delivery(model, source, recipe, output)
    source.write_bytes(b"changed")
    with pytest.raises(ValueError, match="source hash"):
        build_delivery(model, source, recipe, tmp_path / "new.zip")
    assert not (tmp_path / "new.zip").exists()


def test_delivery_requires_reviews(tmp_path):
    model = tmp_path / "model.glb"
    model.write_bytes(glb())
    with pytest.raises(ValueError, match="review"):
        build_delivery(model, tmp_path / "source.blend", delivery_recipe(glb(), b"", review=None), tmp_path / "out.zip")


@pytest.mark.parametrize("operation", [
    {"op": "python", "code": "print(1)"},
    {"op": "transform", "object": "body", "scale": [1, 0, 1]},
    {"op": "transform", "object": "body", "location": [float("nan"), 1, 1]},
    {"op": "material", "object": "body", "base_color": [2, 0, 0, 1]},
    {"op": "visibility", "object": "body", "visible": "false"},
])
def test_edit_contract_rejects_invalid_operations(operation):
    with pytest.raises(ValidationError):
        EditRecipe(user_prompt="edit", operations=[operation])


def test_script_treats_names_as_data():
    name = "body'); raise RuntimeError('injected') #"
    code = edit_script(source="a.glb", blend_output="b.blend", glb_output="b.glb", importing=True,
                       operations=[{"op": "visibility", "object": name, "visible": True}])
    compile(code, "<generated-edit>", "exec")
    first_lines = "\n".join(code.splitlines()[1:2])
    namespace = {"json": json}
    exec(first_lines, namespace)
    assert namespace["p"]["operations"][0]["object"] == name


class FakeBlender:
    port = 9999

    def __init__(self):
        self.calls = 0
        self.error = None

    async def execute(self, code, user_prompt):
        self.calls += 1
        if self.error:
            raise self.error
        namespace = {"json": json}
        exec(code.splitlines()[1], namespace)
        payload = namespace["p"]
        Path(payload["blend_output"]).write_bytes(b"source")
        Path(payload["glb_output"]).write_bytes(glb())
        return {"objects": []}


def test_editor_conflicts_and_failed_edits_preserve_previous_revision(tmp_path):
    client = FakeBlender()
    editor = AssetEditor(tmp_path / "projects", client)
    model = tmp_path / "input.glb"
    model.write_bytes(glb())
    first = asyncio.run(editor.import_model("test", model, "import"))
    recipe = EditRecipe(user_prompt="hide", operations=[{"op": "visibility", "object": "body", "visible": False}])
    with pytest.raises(RevisionConflict):
        asyncio.run(editor.edit("test", recipe, 2))
    assert client.calls == 1
    client.error = BlenderExecutionError("missing object")
    with pytest.raises(BlenderExecutionError):
        asyncio.run(editor.edit("test", recipe, 1))
    assert editor.inspect("test") == first
    assert editor.history("test")[-1]["status"] == "failed"
    client.error = None
    second = asyncio.run(editor.edit("test", recipe, 1))
    assert second["revision"] == 2
    assert Path(first["source"]).read_bytes() == b"source"


def test_uncertain_mutation_blocks_resubmission(tmp_path):
    client = FakeBlender()
    client.error = BlenderExecutionUncertain("timeout")
    editor = AssetEditor(tmp_path / "projects", client)
    model = tmp_path / "input.glb"
    model.write_bytes(glb())
    with pytest.raises(BlenderExecutionUncertain):
        asyncio.run(editor.import_model("test", model, "import"))
    with pytest.raises(RevisionConflict):
        asyncio.run(editor.import_model("test", model, "import"))
    assert client.calls == 1
    assert editor.history("test")[0]["status"] == "uncertain"


def test_editor_rejects_path_traversal(tmp_path):
    editor = AssetEditor(tmp_path, FakeBlender())
    with pytest.raises(ValueError):
        editor.project_path("../escape")
