from __future__ import annotations

from src.api import server


def test_app_preserves_world_routes_and_adds_character_control():
    schema = server.app.openapi()
    paths = set(schema["paths"])

    assert "/health" in paths
    assert "/api/health" in paths
    assert "/api/world/generate" in paths
    assert all(
        path in {"/health", "/api/health", "/api/characters"} or path.startswith(("/api/world/", "/api/characters/", "/api/avatars/", "/api/avatar-factory/", "/api/avatar-blueprints/"))
        for path in paths
    )

    operations = {
        (method.upper(), path)
        for path, item in schema["paths"].items()
        for method in item
        if method in {"get", "post", "put", "patch", "delete"}
    }
    assert operations == {
        ("GET", "/api/avatar-factory/profiles"),
        ("GET", "/api/avatar-factory/capabilities"),
        ("GET", "/api/avatar-factory/motion-library"),
        ("GET", "/api/avatar-factory/motion-defaults"),
        ("PUT", "/api/avatar-factory/motion-defaults"),
        ("GET", "/api/avatar-factory/jobs/{job_id}/meshy"),
        ("GET", "/api/avatar-factory/jobs/{job_id}/native-parts"),
        ("POST", "/api/avatar-factory/jobs/{job_id}/native-parts"),
        ("GET", "/api/avatar-factory/jobs/{job_id}/native-parts/{version}/{name}"),
        ("GET", "/api/avatar-factory/jobs/{job_id}/native-outfits/{version}"),
        ("PUT", "/api/avatar-factory/jobs/{job_id}/native-outfits/{version}"),
        ("POST", "/api/avatar-factory/jobs/{job_id}/meshy/rig"),
        ("POST", "/api/avatar-factory/jobs/{job_id}/meshy/actions"),
        ("POST", "/api/avatar-factory/jobs/{job_id}/meshy/recover"),
        ("GET", "/api/avatar-factory/jobs/{job_id}/meshy/artifacts/{version}/{name}"),
        ("GET", "/api/avatar-factory/jobs/{job_id}/meshy/provider/{name}"),
        ("GET", "/api/avatar-factory/jobs"),
        ("POST", "/api/avatar-factory/image-jobs"),
        ("GET", "/api/avatar-factory/jobs/{job_id}"),
        ("POST", "/api/avatar-factory/jobs/{job_id}/resume"),
        ("POST", "/api/avatar-factory/jobs/{job_id}/recover-task"),
        ("GET", "/api/avatar-factory/jobs/{job_id}/artifacts/{filename}"),
        ("GET", "/api/avatar-blueprints/assets/{asset_id}"),
        ("POST", "/api/avatar-blueprints/assets"),
        ("GET", "/api/avatar-blueprints/{character_id}"),
        ("PUT", "/api/avatar-blueprints/{character_id}"),
        ("GET", "/api/avatar-blueprints/{character_id}/recipe"),
        ("GET", "/health"),
        ("GET", "/api/health"),
        ("POST", "/api/world/textures/generate"),
        ("POST", "/api/world/generate"),
        ("GET", "/api/world/jobs/{job_id}"),
        ("GET", "/api/world/jobs/{job_id}/stream"),
        ("GET", "/api/world/animations/catalog"),
        ("GET", "/api/world/assets"),
        ("PATCH", "/api/world/assets/{asset_id}"),
        ("DELETE", "/api/world/assets/{asset_id}"),
        ("GET", "/api/world/assets/{asset_id}/model"),
        ("GET", "/api/world/assets/{asset_id}/animations/{clip_index}/model"),
        ("POST", "/api/world/placements"),
        ("GET", "/api/world/placements/latest"),
        ("GET", "/api/characters"),
        ("POST", "/api/characters"),
        ("GET", "/api/characters/{character_id}"),
        ("PATCH", "/api/characters/{character_id}"),
        ("POST", "/api/characters/{character_id}/sources"),
        ("GET", "/api/characters/{character_id}/artifacts/{artifact_id}"),
        ("POST", "/api/characters/{character_id}/actions/{action_id}"),
        ("GET", "/api/characters/{character_id}/operations/{operation_id}"),
        ("POST", "/api/characters/{character_id}/operations/{operation_id}/recover"),
        ("GET", "/api/avatars/catalog"),
        ("GET", "/api/avatars/assets/{asset_id}/model"),
        ("GET", "/api/avatars/me"),
        ("PUT", "/api/avatars/me"),
    }


def test_health_reports_optional_database(monkeypatch):
    monkeypatch.setattr(server.db, "ping", lambda: {"configured": False, "ok": False})

    assert server.health() == {
        "status": "healthy",
        "connections": {"database": {"configured": False, "ok": False}},
    }
