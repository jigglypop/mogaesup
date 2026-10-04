"""auth.py: the operator tokens the Rust studio gateway signs (server/src/factory.rs) and their checks."""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from src import auth
import jwt as pyjwt

from src.auth import _compute_level


@pytest.mark.parametrize(
    "roles, expected",
    [
        (["ADMIN"], 2),
        (["admin"], 2),
        (["MEMBER", "ADMIN"], 2),
        (["ROOT"], None),
        (["UNKNOWN"], None),
        ([], None),
    ],
)
def test_compute_level(roles, expected):
    assert _compute_level(roles) == expected


def current_user(request: Request) -> auth.UserContext:
    """The FastAPI dependency, awaited as FastAPI awaits it."""
    return asyncio.run(auth.get_current_user(request))


def _request_with_auth(header: str | None = None, path: str = "/", query: str = "") -> Request:
    headers = []
    if header is not None:
        headers.append((b"authorization", header.encode("utf-8")))
    scope = {
        "type": "http",
        "method": "GET",
        "path": path,
        "query_string": query.encode("ascii"),
        "headers": headers,
    }
    return Request(scope)


def test_resolve_secret_accepts_plain_and_base64(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "x" * 32)
    monkeypatch.setenv("JWT_MIN_SECRET_LENGTH", "32")
    assert auth._resolve_secret() == b"x" * 32

    encoded = "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg="
    monkeypatch.setenv("JWT_SECRET", encoded)
    monkeypatch.setenv("JWT_MIN_SECRET_LENGTH", "32")
    assert auth._resolve_secret() == b"x" * 32


def test_resolve_secret_rejects_missing_or_short(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    with pytest.raises(RuntimeError, match="JWT_SECRET"):
        auth._resolve_secret()

    monkeypatch.setenv("JWT_SECRET", "short")
    monkeypatch.setenv("JWT_MIN_SECRET_LENGTH", "32")
    with pytest.raises(RuntimeError, match="32"):
        auth._resolve_secret()


def test_bearer_token_parses_prefixed_and_raw_headers():
    assert auth._bearer_token(_request_with_auth("Bearer abc.def")) == "abc.def"
    assert auth._bearer_token(_request_with_auth("raw-token")) == "raw-token"
    assert auth._bearer_token(_request_with_auth()) == ""


def test_bearer_token_ignores_query_string_tokens():
    request = _request_with_auth(query="access_token=abc.def&token=abc.def")
    assert auth._bearer_token(request) == ""


def test_extract_helpers_cover_multiple_shapes():
    assert auth._extract_user_id({"userId": "12"}) == 12
    assert auth._extract_user_id({"uid": 13}) == 13
    assert auth._extract_user_id({"sub": "14"}) == 14
    with pytest.raises(HTTPException):
        auth._extract_user_id({"sub": "name"})

    assert auth._extract_roles({"roles": "ADMIN MEMBER"}) == ["ADMIN", "MEMBER"]
    assert auth._extract_roles({"roles": ["ADMIN", " member "]}) == ["ADMIN", "member"]
    assert auth._extract_roles({"roles": None}) == []


def test_get_current_user(monkeypatch):
    claims = {"sub": "100", "roles": ["ADMIN"]}
    monkeypatch.setattr(auth, "_decode_claims", lambda token: claims)

    ctx = current_user(_request_with_auth("Bearer token"))
    assert ctx.user_id == 100
    assert ctx.username == "100"
    assert ctx.roles == ["ADMIN"]
    assert ctx.level == 2


def test_public_paths_support_configuration(monkeypatch):
    monkeypatch.setenv("PUBLIC_PATHS", "/api/public-page,/api/public/*")

    assert auth.is_public_path("/api/public-page") is True
    assert auth.is_public_path("/api/public/demo") is True


def test_gateway_signed_member_name_is_audit_identity_with_fixed_factory_owner(monkeypatch):
    monkeypatch.setenv('JWT_SECRET', 'x'*32)
    ctx = current_user(_request_with_auth('Bearer '+_token(name='actual-member', roles=['ADMIN'])))
    assert ctx.user_id == 1
    assert ctx.username == 'actual-member'


def _token(**claims) -> str:
    return pyjwt.encode({"sub": "1", "exp": 4102444800, "iss": "mogaesup", "aud": "mogaesup-client",
                         "token_type": "access", **claims}, b"x" * 32, algorithm="HS256")


def test_decode_claims_defaults_match_the_rust_gateway(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "x" * 32)
    monkeypatch.delenv("JWT_ISSUER", raising=False)
    monkeypatch.delenv("JWT_AUDIENCE", raising=False)

    assert auth._decode_claims(_token())["sub"] == "1"
    for stale in ({"iss": "signight"}, {"aud": "signight-client"}):
        with pytest.raises(HTTPException) as exc:
            auth._decode_claims(_token(**stale))
        assert exc.value.status_code == 401


def test_decode_claims_validates_token_properties(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "x" * 32)
    monkeypatch.setenv("JWT_ISSUER", "studio-issuer")
    monkeypatch.setenv("JWT_AUDIENCE", "studio-client")

    configured = {"iss": "studio-issuer", "aud": "studio-client"}
    assert auth._decode_claims(_token(**configured))["sub"] == "1"

    with pytest.raises(HTTPException) as exc:
        auth._decode_claims(_token(**configured, token_type="refresh"))
    assert exc.value.status_code == 401


@pytest.mark.parametrize('token_type', ['', None, 'refresh'])
def test_a_missing_or_wrong_access_token_type_is_rejected(monkeypatch, token_type):
    monkeypatch.setenv('JWT_SECRET', 'x' * 32)
    with pytest.raises(HTTPException) as exc:
        auth._decode_claims(_token(token_type=token_type))
    assert exc.value.status_code == 401


def test_config_cannot_lower_the_secret_minimum(monkeypatch):
    monkeypatch.setenv('JWT_SECRET', 'short-secret-value')
    monkeypatch.setenv('JWT_MIN_SECRET_LENGTH', '1')
    with pytest.raises(RuntimeError, match='32'):
        auth._resolve_secret()


@pytest.mark.parametrize('roles', [[], ['MEMBER'], ['ROOT']])
def test_a_signed_non_operator_token_cannot_use_the_studio(monkeypatch, roles):
    monkeypatch.setenv('JWT_SECRET', 'x' * 32)
    with pytest.raises(HTTPException) as exc:
        current_user(_request_with_auth('Bearer ' + _token(roles=roles)))
    assert exc.value.status_code == 403


@pytest.mark.parametrize('forwarded', ['forwarded', 'x-forwarded-for', 'x-real-ip'])
def test_a_forwarded_loopback_peer_cannot_supply_local_operator_identity(forwarded):
    request = Request({'type': 'http', 'headers': [(b'x-user-id', b'1'), (forwarded.encode(), b'127.0.0.1')],
                       'client': ('127.0.0.1', 8000)})
    assert auth.trusted_loopback(request) is False and auth._local_dev_user(request) is None


@pytest.mark.parametrize('peer', ['203.0.113.5', 'localhost', 'testclient'])
def test_local_operator_identity_requires_the_actual_loopback_socket(peer):
    request = Request({'type': 'http', 'headers': [(b'x-user-id', b'1')], 'client': (peer, 8000)})
    assert auth._local_dev_user(request) is None


@pytest.mark.parametrize('value', ['0', '-1', 'true', '1.0'])
def test_local_identity_requires_a_positive_integer(value):
    request = Request({'type': 'http', 'headers': [(b'x-user-id', value.encode())], 'client': ('127.0.0.1', 8000)})
    assert auth._local_dev_user(request) is None


def _local(*headers, peer='127.0.0.1'):
    return Request({'type': 'http', 'headers': [(b'x-user-id', b'1'), *headers], 'client': (peer, 8000)})


@pytest.mark.parametrize('host', [b'127.0.0.1:8016', b'127.0.0.1', b'localhost:8000', b'LOCALHOST', b'[::1]:8000', b'[::1]'])
def test_a_local_operator_is_accepted(host):
    assert auth._local_dev_user(_local((b'host', host))).level == 2
    assert auth.trusted_loopback(_local((b'host', host), peer='::1'))


@pytest.mark.parametrize('host', [None, b'', b'evil.example:8016', b'evil.example', b'127.0.0.1.evil.example:8016',
                                  b'localhost.evil.example', b'127.0.0.1:80:80', b'localhost:port', b'[::1]x', b'0.0.0.0:8016'])
def test_a_page_rebound_to_the_loopback_address_is_not_the_operator(host):
    # DNS rebinding: the browser connects to 127.0.0.1 but names its own site in Host.
    request = _local(*([(b'host', host)] if host is not None else []))
    assert auth.trusted_loopback(request) is False and auth._local_dev_user(request) is None


@pytest.mark.parametrize('origin', [b'https://evil.example', b'http://evil.example:8016', b'null', b'http://127.0.0.1:99999',
                                    b'file://', b'http://127.0.0.1.evil.example'])
def test_a_cross_site_page_cannot_use_the_loopback_operator(origin):
    # A page elsewhere posting to the operator's port forward or a local server sends its own Origin.
    request = _local((b'host', b'127.0.0.1:8080'), (b'origin', origin))
    assert auth.trusted_loopback(request) is False and auth._local_dev_user(request) is None


@pytest.mark.parametrize('origin', [b'http://127.0.0.1:5180', b'http://localhost:5173', b'https://localhost', b'http://[::1]:8000'])
def test_a_loopback_origin_is_still_local(origin):
    assert auth._local_dev_user(_local((b'host', b'127.0.0.1:8016'), (b'origin', origin))).level == 2


def test_a_missing_jwt_secret_is_a_server_fault_not_a_caller_error(monkeypatch):
    monkeypatch.delenv('JWT_SECRET', raising=False)
    with pytest.raises(HTTPException) as exc:
        current_user(_request_with_auth('Bearer ' + _token(roles=['ADMIN'])))
    assert exc.value.status_code == 503 and 'JWT_SECRET' in exc.value.detail
    monkeypatch.setenv('JWT_SECRET', 'replace-this-secret-value-for-real-use')
    with pytest.raises(HTTPException) as exc:
        current_user(_request_with_auth('Bearer ' + _token(roles=['ADMIN'])))
    assert exc.value.status_code == 503
    # Without any token the caller is told so first.
    with pytest.raises(HTTPException) as exc:
        current_user(_request_with_auth())
    assert exc.value.status_code == 401


def test_authentication_needs_no_worker_thread(monkeypatch):
    """Long background jobs can hold every worker thread; an async route still authenticates and answers."""
    import anyio
    import httpx
    from fastapi import Depends, FastAPI

    monkeypatch.setenv('JWT_SECRET', 'x' * 32)
    app = FastAPI()

    @app.get('/whoami')
    async def whoami(user: auth.UserContext = Depends(auth.get_current_user)):
        return {'user_id': user.user_id}

    async def call():
        limiter = anyio.to_thread.current_default_thread_limiter()
        limiter.total_tokens = 1
        taken, finish = anyio.Event(), anyio.Event()

        async def long_job():
            async with limiter:
                taken.set()
                await finish.wait()

        async with anyio.create_task_group() as group:
            group.start_soon(long_job)
            await taken.wait()
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                    with anyio.fail_after(5):
                        return await client.get('/whoami', headers={'Authorization': 'Bearer ' + _token(roles=['ADMIN'])})
            finally:
                finish.set()

    response = anyio.run(call)
    assert response.status_code == 200 and response.json() == {'user_id': 1}
