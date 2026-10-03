from __future__ import annotations

import pytest

from src.api import server

# The Rust server's studio gateway forwards exactly these families (server/src/factory.rs).
GATEWAY_PREFIXES = ("/api/avatar-factory/", "/api/studio/", "/api/avatar-blueprints/", "/api/characters")

CHARACTER_OPERATIONS = {
    ("GET", "/api/characters"),
    ("POST", "/api/characters"),
    ("GET", "/api/characters/{character_id}"),
    ("PATCH", "/api/characters/{character_id}"),
    ("POST", "/api/characters/{character_id}/sources"),
    ("GET", "/api/characters/{character_id}/artifacts/{artifact_id}"),
    ("POST", "/api/characters/{character_id}/actions/{action_id}"),
    ("GET", "/api/characters/{character_id}/operations/{operation_id}"),
    ("POST", "/api/characters/{character_id}/operations/{operation_id}/recover"),
}

FACTORY_OPERATIONS = {
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
}

# Read directly by the Rust server (server/src/studio.rs, imports.rs) and scripts/props/generate.py.
CALLER_OPERATIONS = {
    ("GET", "/api/studio/catalog"),
    ("GET", "/api/studio/bodies/{job_id}/{version}/expressions"),
    ("GET", "/api/studio/bodies/{job_id}/{version}/expressions/{expression_id}/{name}"),
    ("GET", "/api/studio/generations"),
    ("POST", "/api/studio/generations"),
    ("GET", "/api/studio/generations/{job_id}"),
    ("POST", "/api/studio/generations/{job_id}/resume"),
    ("GET", "/api/studio/generations/{job_id}/artifacts/{name}"),
}


def operations() -> set[tuple[str, str]]:
    return {
        (method.upper(), path)
        for path, item in server.app.openapi()["paths"].items()
        for method in item
        if method in {"get", "post", "put", "patch", "delete"}
    }


def test_app_serves_only_health_and_gateway_routes():
    paths = {path for _, path in operations()}

    assert {"/health", "/api/health"} <= paths
    assert all(path in {"/health", "/api/health"} or path.startswith(GATEWAY_PREFIXES) for path in paths)
    # The legacy world API and its external database left with nothing calling them.
    assert not any(path.startswith("/api/world") for path in paths)
    # The standalone studio screen's avatar API and CORS left with the move behind the gateway.
    assert not any(path.startswith("/api/avatars") for path in paths)
    assert not any(middleware.cls.__name__ == "CORSMiddleware" for middleware in server.app.user_middleware)


def test_app_keeps_routes_that_callers_depend_on():
    current = operations()

    assert {("GET", "/health"), ("GET", "/api/health")} <= current
    assert CHARACTER_OPERATIONS <= current
    assert FACTORY_OPERATIONS <= current
    assert CALLER_OPERATIONS <= current


def test_health_without_a_record_database_pings_nothing(monkeypatch):
    monkeypatch.setattr(server.record_store, "ping", lambda: pytest.fail("no database is configured"))

    health = server.health()

    assert health["status"] == "healthy"
    assert health["connections"] == {"database": {"configured": False, "ok": False}}
    assert set(health["runtime"]) == {"workspace", "revision", "pid"}
    assert set(health["activity"]) == {"paid_requests", "running_tasks"}


def test_health_degrades_without_exposing_database_errors(monkeypatch):
    monkeypatch.setenv("CHARACTER_DATABASE_URL", "postgresql://fixture@127.0.0.1:9/records")
    monkeypatch.setattr(server, "_DB_STATUS", {"value": None, "at": 0.0, "running": False})
    monkeypatch.setattr(server.record_store, "ping", lambda: {
        "configured": True, "ok": False, "error": "connection to db.internal failed for user fixture"})

    server._refresh_database_status()
    health = server.health()

    assert health["status"] == "degraded"
    assert health["connections"] == {"database": {"configured": True, "ok": False}}


def test_startup_is_refused_when_the_records_live_in_the_database_and_the_url_is_gone(monkeypatch):
    from fastapi.testclient import TestClient

    def refuse():
        raise RuntimeError('records live in PostgreSQL, but CHARACTER_DATABASE_URL is not set')

    monkeypatch.setattr(server, 'assert_records_mode', refuse)
    with pytest.raises(RuntimeError, match='CHARACTER_DATABASE_URL'):
        with TestClient(server.app):
            pass


def test_database_readiness_is_degraded_until_the_first_schema_check_finishes(monkeypatch):
    monkeypatch.setattr(server, '_database_status', lambda: {'configured': True, 'ok': None, 'checking': True})
    assert server.health()['status'] == 'degraded'


@pytest.mark.anyio
@pytest.mark.parametrize('anyio_backend', ['asyncio'])
async def test_runtime_control_requires_unforwarded_loopback_and_health_remains_readable(monkeypatch, tmp_path):
    import httpx
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path))
    monkeypatch.setattr(server, '_API_KEY', 'private-api-key')
    token = 'a' * 32
    for peer, base, headers, expected in [
        ('203.0.113.9', 'http://127.0.0.1:8000', {'x-api-key': 'private-api-key'}, 403),
        ('127.0.0.1', 'http://127.0.0.1:8000', {'x-api-key': 'private-api-key', 'x-forwarded-for': '127.0.0.1'}, 403),
        # A page rebound to 127.0.0.1 names its own host; a cross-site page sends its own origin.
        ('127.0.0.1', 'http://rebound.example:8000', {'x-api-key': 'private-api-key'}, 403),
        ('127.0.0.1', 'http://127.0.0.1:8000', {'x-api-key': 'private-api-key', 'origin': 'https://evil.example'}, 403),
        ('127.0.0.1', 'http://rebound.example:8000', {}, 401),
        ('127.0.0.1', 'http://127.0.0.1:8000', {}, 200),
    ]:
        transport = httpx.ASGITransport(app=server.app, client=(peer, 1234))
        async with httpx.AsyncClient(transport=transport, base_url=base) as client:
            response = await client.post('/internal/drain', json={'token': token}, headers=headers)
            assert response.status_code == expected
            if expected == 200:
                assert response.json()['admission']['draining']
                assert (await client.get('/api/health')).status_code == 200
                assert (await client.post('/api/characters', json={})).status_code == 503
                assert (await client.request('DELETE', '/internal/drain', json={'token': 'b' * 32})).status_code == 409
                assert (await client.request('DELETE', '/internal/drain', json={'token': token})).status_code == 200
                # No API key exemption for ordinary mutations.
                assert (await client.post('/api/characters', json={})).status_code == 401


@pytest.mark.anyio
@pytest.mark.parametrize('anyio_backend', ['asyncio'])
async def test_artifact_head_uses_the_same_operator_authentication_as_get(monkeypatch, tmp_path):
    import httpx
    import jwt
    from types import SimpleNamespace
    from src.api.avatar_factory import get_factory
    path = tmp_path / 'model.glb'
    path.write_bytes(b'glTFoffline')
    monkeypatch.setenv('JWT_SECRET', 'x' * 32)
    monkeypatch.setattr(server, '_API_KEY', '')
    factory = SimpleNamespace(artifact=lambda owner, job, name: path)
    server.app.dependency_overrides[get_factory] = lambda: factory
    token = jwt.encode({'sub': '1', 'exp': 4102444800, 'iss': 'mogaesup', 'aud': 'mogaesup-client',
                        'roles': ['ADMIN'], 'token_type': 'access'}, b'x' * 32, algorithm='HS256')
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url='http://test') as client:
            url = '/api/avatar-factory/jobs/' + 'a' * 24 + '/artifacts/model.glb'
            assert (await client.head(url)).status_code == 401
            head = await client.head(url, headers={'Authorization': 'Bearer ' + token})
            assert head.status_code == 200 and head.content == b''
            assert head.headers['content-length'] == str(path.stat().st_size)
    finally:
        server.app.dependency_overrides.pop(get_factory, None)
