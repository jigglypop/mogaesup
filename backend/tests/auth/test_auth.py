"""auth.py: the operator tokens the Rust studio gateway signs (server/src/factory.rs) and their checks."""
from __future__ import annotations

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

    ctx = auth.get_current_user(_request_with_auth("Bearer token"))
    assert ctx.user_id == 100
    assert ctx.username == "100"
    assert ctx.roles == ["ADMIN"]
    assert ctx.level == 2


def test_public_paths_support_configuration(monkeypatch):
    monkeypatch.setenv("PUBLIC_PATHS", "/api/public-page,/api/public/*")

    assert auth.is_public_path("/api/public-page") is True
    assert auth.is_public_path("/api/public/demo") is True


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
