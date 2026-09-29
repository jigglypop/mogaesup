from __future__ import annotations

import struct
from types import SimpleNamespace

import httpx
import pytest

from src.api import world


def test_compose_world_plan_has_gaesup_contract():
    plan = world.compose_world_plan({"prompt": "숲속 집", "kind": "house", "title": "테스트 월드", "sig_id": "sig-1"})
    assert plan["title"] == "테스트 월드"
    assert plan["locale"] == "ko"
    assert plan["sig_id"] == "sig-1"
    assert plan["tiles"]
    assert plan["walls"]
    assert plan["props"]
    assert {prop["id"] for prop in plan["props"]} >= {
        "signight-title-board",
        "signight-night-light",
        "signight-archive-marker",
    }
    assert "home-sign" not in {prop["id"] for prop in plan["props"]}
    assert plan["edits"]["ko"]["title"] == "테스트 월드"


def test_world_generate_without_provider_uses_structured_plan(monkeypatch):
    monkeypatch.setattr(world.db, "load_settings", lambda prefixes=None: {})
    monkeypatch.setattr(world.db, "setting_or_env", lambda key, env_key="", default="", settings=None: default)
    monkeypatch.setattr(world.db, "is_configured", lambda: False)
    user = SimpleNamespace(user_id=7)

    result = world.world_generate(
        body={"prompt": "작은 집", "kind": "house", "title": "모개숲", "sig_id": "sig-2"},
        user=user,
    )

    assert result["status"] == "planned"
    assert result["provider_configured"] is False
    assert result["plan"]["title"] == "모개숲"
    assert result["plan"]["tiles"]

    fetched = world.world_job(result["job_id"], user=user)
    assert fetched["job_id"] == result["job_id"]


def test_meshy_task_create_402_reports_credit_shortage(monkeypatch):
    def fake_post(*args, **kwargs):
        request = httpx.Request("POST", "https://api.meshy.ai/openapi/v1/rigging")
        return httpx.Response(402, request=request, json={"message": "Insufficient funds"})

    monkeypatch.setattr(world.httpx, "post", fake_post)
    monkeypatch.setattr(world, "_meshy_headers", lambda settings: {"Authorization": "Bearer test"})

    with pytest.raises(world.MeshyInsufficientFundsError) as exc:
        world._create_meshy_task({}, "/openapi/v1/rigging", {"model_url": "https://example.test/a.glb"}, 30)

    message = str(exc.value)
    assert "Meshy 크레딧" in message
    assert "/openapi/v1/rigging" in message


def test_latest_placement_reads_memory_when_db_missing(monkeypatch):
    monkeypatch.setattr(world.db, "is_configured", lambda: False)
    user = SimpleNamespace(user_id=9)
    created = world.world_save_placement(
        body={
            "sig_id": "sig-55",
            "plan": {
                "id": "p-1",
                "title": "테스트",
                "locale": "ko",
                "sig_id": "sig-55",
                "tiles": [],
                "walls": [],
                "props": [],
                "assets": [],
                "edits": {"ko": {"title": "테스트", "description": "desc"}},
            },
        },
        user=user,
    )
    assert created["status"] == "saved"
    latest = world.world_latest_placement(sig_id="sig-55", user=user)
    assert latest["sig_id"] == "sig-55"
    assert latest["plan"]["title"] == "테스트"


def test_meshy_rigging_prefers_input_task_id(monkeypatch):
    created: dict[str, object] = {}

    def fake_create(settings, path, payload, timeout):
        created["path"] = path
        created["payload"] = payload
        return "rig-task"

    monkeypatch.setattr(world, "_create_meshy_task", fake_create)
    monkeypatch.setattr(
        world,
        "_wait_meshy_task",
        lambda **kwargs: {
            "status": "SUCCEEDED",
            "result": {
                "rigged_character_glb_url": "https://example.test/rigged.glb",
                "rigged_character_fbx_url": "https://example.test/rigged.fbx",
                "basic_animations": {
                    "idle_glb_url": "https://example.test/idle.glb",
                    "idle_fbx_url": "https://example.test/idle.fbx",
                },
            },
        },
    )
    monkeypatch.setattr(world, "_meshy_animation_action_ids", lambda settings, body: [0])
    monkeypatch.setattr(
        world,
        "_animate_meshy_character",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("basic preset should be one-shot")),
    )

    task_id, rigged = world._rig_meshy_character(
        settings={},
        body={"generate_basic_animations": True, "height_meters": 1.8},
        input_task_id="source-task",
        model_url="https://example.test/source.glb",
        timeout=30,
    )

    assert task_id == "rig-task"
    assert rigged["model_url"] == "https://example.test/rigged.glb"
    assert created["path"] == "/openapi/v1/rigging"
    assert created["payload"]["input_task_id"] == "source-task"
    assert "model_url" not in created["payload"]
    assert created["payload"]["generate_basic_animations"] is True
    assert rigged["animation_clips"][0]["model_url"] == "https://example.test/idle.glb"


def test_meshy_rigging_defaults_to_humanoid_height(monkeypatch):
    created: dict[str, object] = {}

    def fake_create(settings, path, payload, timeout):
        created["payload"] = payload
        return "rig-task"

    monkeypatch.setattr(world, "_create_meshy_task", fake_create)
    monkeypatch.setattr(
        world,
        "_wait_meshy_task",
        lambda **kwargs: {
            "status": "SUCCEEDED",
            "result": {
                "rigged_character_glb_url": "https://example.test/rigged.glb",
            },
        },
    )
    monkeypatch.setattr(world, "_meshy_animation_action_ids", lambda settings, body: [])

    world._rig_meshy_character(
        settings={},
        body={"generate_basic_animations": False},
        input_task_id="source-task",
        model_url="https://example.test/source.glb",
        timeout=30,
    )

    assert created["payload"]["height_meters"] == 1.7


def test_meshy_rigging_requires_six_action_combined_glb(monkeypatch):
    monkeypatch.setattr(world, "_create_meshy_task", lambda settings, path, payload, timeout: "rig-task")
    monkeypatch.setattr(
        world,
        "_wait_meshy_task",
        lambda **kwargs: {
            "status": "SUCCEEDED",
            "result": {
                "rigged_character_glb_url": "https://example.test/rigged.glb",
                "basic_animations": {
                    "walking_glb_url": "https://example.test/walk.glb",
                    "running_glb_url": "https://example.test/run.glb",
                },
            },
        },
    )
    monkeypatch.setattr(world, "_meshy_animation_action_ids", lambda settings, body: [249, 692, 657, 466, 28, 502])
    monkeypatch.setattr(world, "_animate_meshy_character", lambda **kwargs: [])
    monkeypatch.setattr(world, "_combine_meshy_character_animation_model", lambda **kwargs: kwargs["rigged"])

    with pytest.raises(RuntimeError, match="six-action combined GLB"):
        world._rig_meshy_character(
            settings={},
            body={"generate_basic_animations": True},
            input_task_id="source-task",
            model_url="https://example.test/source.glb",
            timeout=30,
        )


def test_meshy_rigging_custom_action_slots_override_basic_clips(monkeypatch):
    created: list[dict[str, object]] = []

    def fake_create(settings, path, payload, timeout):
        created.append({"path": path, "payload": payload})
        return "rig-task" if path == "/openapi/v1/rigging" else f"anim-{payload['action_id']}"

    def fake_wait(**kwargs):
        task_id = kwargs["task_id"]
        if task_id == "rig-task":
            return {
                "status": "SUCCEEDED",
                "result": {
                    "rigged_character_glb_url": "https://example.test/rigged.glb",
                    "basic_animations": {
                        "walking_glb_url": "https://example.test/basic-walk.glb",
                    },
                },
            }
        action_id = int(str(task_id).split("-")[-1])
        return {"status": "SUCCEEDED", "result": {"animation_glb_url": f"https://example.test/{action_id}.glb"}}

    def fake_combine(**kwargs):
        rigged = kwargs["rigged"]
        rigged["combined_model_url"] = "https://example.test/combined.glb"
        rigged["combined_animation_clips"] = [
            {"canonical_name": clip["canonical_name"]}
            for clip in rigged["animation_clips"]
            if isinstance(clip, dict) and clip.get("canonical_name")
        ]
        return rigged

    monkeypatch.setattr(world, "_create_meshy_task", fake_create)
    monkeypatch.setattr(world, "_wait_meshy_task", fake_wait)
    monkeypatch.setattr(world, "_combine_meshy_character_animation_model", fake_combine)

    _task_id, rigged = world._rig_meshy_character(
        settings={},
        body={
            "generate_basic_animations": False,
            "animation_action_ids": [0, 1, 14, 86, 28, 502],
            "animation_action_slots": ["idle", "walk", "run", "jump", "greet", "fall"],
        },
        input_task_id="source-task",
        model_url="https://example.test/source.glb",
        timeout=30,
    )

    assert created[0]["payload"].get("generate_basic_animations") is None
    assert [item["payload"]["action_id"] for item in created[1:]] == [0, 1, 14, 86, 28, 502]
    assert [clip["canonical_name"] for clip in rigged["animation_clips"]] == ["idle", "walk", "run", "jump", "greet", "fall"]
    assert rigged["missing_combined_animations"] == []


def test_meshy_image_to_3d_payload_keeps_character_pose_options(monkeypatch):
    created: list[dict[str, object]] = []

    def fake_create(settings, path, payload, timeout):
        created.append({"path": path, "payload": payload})
        return "image-task"

    monkeypatch.setattr(world, "_create_meshy_task", fake_create)
    monkeypatch.setattr(
        world,
        "_wait_meshy_task",
        lambda **kwargs: {
            "status": "SUCCEEDED",
            "model_urls": {"glb": "https://example.test/model.glb"},
        },
    )
    monkeypatch.setattr(world, "_source_image_url", lambda body, user_id: "https://example.test/input.png")
    monkeypatch.setattr(world, "_should_rig_character", lambda settings, body: False)

    configured, payload = world._call_meshy_provider(
        settings={},
        body={
            "_user_id": 7,
            "kind": "character",
            "prompt": "humanoid character",
            "pose_mode": "a-pose",
            "target_polycount": 25000,
            "topology": "quad",
            "texture_prompt": "blue jacket",
            "texture_finish": "pbr",
        },
        job_id="job-1",
    )

    assert configured is True
    assert payload["model_url"] == "https://example.test/model.glb"
    assert created[0]["path"] == "/openapi/v1/image-to-3d"
    assert created[0]["payload"]["pose_mode"] == "a-pose"
    assert created[0]["payload"]["ai_model"] == "latest"
    assert created[0]["payload"]["enable_pbr"] is True
    assert created[0]["payload"]["image_enhancement"] is True
    assert created[0]["payload"]["remove_lighting"] is True
    assert created[0]["payload"]["auto_size"] is True
    assert created[0]["payload"]["target_polycount"] == 25000
    assert created[0]["payload"]["topology"] == "quad"
    assert created[0]["payload"]["texture_prompt"] == "blue jacket"


def test_meshy_image_to_3d_matte_texture_removes_bloom(monkeypatch):
    created: list[dict[str, object]] = []

    monkeypatch.setattr(world, "_create_meshy_task", lambda settings, path, payload, timeout: created.append({"path": path, "payload": payload}) or "image-task")
    monkeypatch.setattr(world, "_wait_meshy_task", lambda **kwargs: {"status": "SUCCEEDED", "model_urls": {"glb": "https://example.test/model.glb"}})
    monkeypatch.setattr(world, "_source_image_url", lambda body, user_id: "https://example.test/input.png")
    monkeypatch.setattr(world, "_should_rig_character", lambda settings, body: False)

    world._call_meshy_provider(
        settings={},
        body={
            "_user_id": 7,
            "kind": "character",
            "prompt": "humanoid character",
            "texture_prompt": "blue jacket",
            "texture_finish": "matte",
        },
        job_id="job-1",
    )

    payload = created[0]["payload"]
    assert payload["enable_pbr"] is False
    assert payload["hd_texture"] is False
    assert "no bloom" in payload["texture_prompt"]


def test_stabilize_world_asset_model_url_uploads_provider_model(monkeypatch):
    monkeypatch.setattr(world, "_settings", lambda: {"gemini_s3_bucket": "bucket"})
    monkeypatch.setattr(world, "_fetch_model_bytes", lambda url: (b"glb-data", "model/gltf-binary"))
    monkeypatch.setattr(
        world,
        "_upload_to_s3",
        lambda content, mime, media_kind, settings: {
            "bucket": "bucket",
            "key": "world/model.glb",
            "url": "https://cdn.example.test/world/model.glb",
            "mime_type": mime,
        },
    )

    item = world._stabilize_world_asset_model_url({
        "model_url": "https://provider.example.test/signed/model.glb?token=secret",
        "metadata": {"provider": "meshy"},
    })

    assert item["model_url"] == "https://cdn.example.test/world/model.glb"
    assert item["metadata"]["original_model_url"].startswith("https://provider.example.test/signed/model.glb")
    assert item["metadata"]["stored_model_key"] == "world/model.glb"
    assert item["metadata"]["stored_model_mime_type"] == "model/gltf-binary"


def test_prepare_world_asset_item_stabilizes_backend_owned_assets(monkeypatch):
    monkeypatch.setattr(world, "_settings", lambda: {"gemini_s3_bucket": "bucket"})
    monkeypatch.setattr(world, "_fetch_model_bytes", lambda url: (b"glb-data", "model/gltf-binary"))
    monkeypatch.setattr(
        world,
        "_upload_to_s3",
        lambda content, mime, media_kind, settings: {
            "bucket": "bucket",
            "key": "world/model.glb",
            "url": "https://cdn.example.test/world/model.glb",
            "mime_type": mime,
        },
    )

    item = world._prepare_world_asset_item(
        7,
        "sig-1",
        "job-1",
        {
            "kind": "character",
            "label": "generated",
            "model_url": "https://provider.example.test/signed/model.glb?token=secret",
            "metadata": {"provider": "meshy"},
        },
    )

    assert item["model_url"] == "https://cdn.example.test/world/model.glb"
    assert item["metadata"]["stored_model_bucket"] == "bucket"
    assert item["user_id"] == 7
    assert item["sig_id"] == "sig-1"
    assert item["job_id"] == "job-1"


def test_model_mime_from_url_handles_glb():
    assert world._model_mime_from_url("https://example.test/a.glb?x=1", "") == "model/gltf-binary"
    assert world._model_mime_from_url("https://example.test/a.gltf", "") == "model/gltf+json"


def test_meshy_animation_defaults_use_rigging_basic_animations(monkeypatch):
    def fail_catalog(*args, **kwargs):
        raise AssertionError("catalog should not be called for default preset")

    monkeypatch.setattr(world, "_meshy_catalog_animation_action_ids", fail_catalog)

    assert world._meshy_animation_action_ids({"world_meshy_animation_mode": "free", "world_meshy_animation_max_count": "0"}, {}) == []
    assert world._meshy_animation_action_ids({}, {"animation_action_ids": []}) == []


def test_meshy_animation_preset_defaults_to_six_gaesup_actions(monkeypatch):
    def fail_catalog(*args, **kwargs):
        raise AssertionError("catalog should not be called for preset")

    monkeypatch.setattr(world, "_meshy_catalog_animation_action_ids", fail_catalog)

    assert world._meshy_animation_action_ids({}, {}) == [249, 692, 657, 466, 28, 502]
    assert world._meshy_animation_action_ids({"world_meshy_animation_action_ids": "0,1,14,28"}, {}) == [249, 692, 657, 466, 28, 502]
    assert world._meshy_animation_action_ids({"world_meshy_animation_max_count": "4"}, {}) == [249, 692, 657, 466, 28, 502]


def test_combine_glb_animations_renames_and_maps_nodes():
    base = world._build_glb(
        {
            "asset": {"version": "2.0"},
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{"name": "Root"}],
            "buffers": [{"byteLength": 0}],
        },
        b"",
    )
    times = struct.pack("<ff", 0.0, 1.0)
    rotations = struct.pack("<ffffffff", 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
    binary = times + rotations
    animation = world._build_glb(
        {
            "asset": {"version": "2.0"},
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{"name": "Root"}],
            "buffers": [{"byteLength": len(binary)}],
            "bufferViews": [
                {"buffer": 0, "byteOffset": 0, "byteLength": len(times)},
                {"buffer": 0, "byteOffset": len(times), "byteLength": len(rotations)},
            ],
            "accessors": [
                {"bufferView": 0, "componentType": 5126, "count": 2, "type": "SCALAR", "min": [0], "max": [1]},
                {"bufferView": 1, "componentType": 5126, "count": 2, "type": "VEC4"},
            ],
            "animations": [
                {
                    "name": "Walking_Woman",
                    "samplers": [{"input": 0, "output": 1, "interpolation": "LINEAR"}],
                    "channels": [{"sampler": 0, "target": {"node": 0, "path": "rotation"}}],
                }
            ],
        },
        binary,
    )

    combined, merged = world._combine_glb_animations(
        base,
        [{"model_url": "https://example.test/walk.glb", "content": animation, "canonical_name": "walk", "name": "Walking_Woman", "action_id": 692}],
    )
    doc, combined_binary = world._parse_glb(combined)

    assert merged == [{"canonical_name": "walk", "name": "walk", "source_name": "Walking_Woman", "model_url": "https://example.test/walk.glb", "action_id": 692}]
    assert doc["animations"][0]["name"] == "walk"
    assert doc["animations"][0]["extras"]["canonicalName"] == "walk"
    assert doc["animations"][0]["extras"]["sourceName"] == "Walking_Woman"
    assert doc["animations"][0]["channels"][0]["target"]["node"] == 0
    assert doc["buffers"][0]["byteLength"] == len(combined_binary)


def test_animate_meshy_character_keeps_per_action_failures(monkeypatch):
    created: list[dict[str, object]] = []

    def fake_create(settings, path, payload, timeout):
        created.append(payload)
        if payload["action_id"] == 28:
            raise RuntimeError("bad action")
        return f"anim-{payload['action_id']}"

    def fake_wait(**kwargs):
        return {
            "status": "SUCCEEDED",
            "result": {
                "animation_glb_url": f"https://example.test/{kwargs['task_id']}.glb",
                "animation_fbx_url": f"https://example.test/{kwargs['task_id']}.fbx",
            },
        }

    monkeypatch.setattr(world, "_create_meshy_task", fake_create)
    monkeypatch.setattr(world, "_wait_meshy_task", fake_wait)

    animations = world._animate_meshy_character(
        settings={"world_meshy_animation_fps": "24"},
        rig_task_id="rig-1",
        action_ids=[0, 28],
        timeout=30,
    )

    assert created[0]["post_process"] == {"operation_type": "change_fps", "fps": 24}
    assert animations[0]["name"] == "Idle"
    assert animations[0]["status"] == "ready"
    assert animations[1]["name"] == "Big_Wave_Hello"
    assert animations[1]["status"] == "error"
