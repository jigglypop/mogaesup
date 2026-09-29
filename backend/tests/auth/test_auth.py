"""auth.UserContext 역할/등급 매핑과 JWT 검증을 확인한다.

backend 매핑 (kotlin):
  L1 = ROOT
  L2 = ADMIN
  L3 = COORDINATOR / CHAIR / MANAGER
  L4 = VICE_CHAIR / VICE_COORDINATOR / LEADER
  L5 = MEMBER

role 라벨만 있고 level 클레임이 없을 때도 백엔드와 같은 등급으로 추론해야 한다.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from src import auth
import jwt as pyjwt

from src.auth import UserContext, _compute_level


@pytest.mark.parametrize(
    "roles, expected",
    [
        (["ROOT"], 1),
        (["ADMIN"], 2),
        (["COORDINATOR"], 3),
        (["CHAIR"], 3),
        (["MANAGER"], 3),
        (["VICE_CHAIR"], 4),
        (["VICE_COORDINATOR"], 4),
        (["LEADER"], 4),
        (["MEMBER"], 5),
        (["USER"], 6),
        (["L1"], 1),
        (["L4"], 4),
        (["MEMBER", "ADMIN"], 2),
        (["UNKNOWN"], None),
        ([], None),
    ],
)
def test_compute_level(roles, expected):
    assert _compute_level(roles) == expected


def test_explicit_level_overrides_roles():
    """JWT 의 level 클레임이 있으면 그대로 신뢰 (백엔드 위임)."""
    ctx = UserContext(user_id=1, username="u", roles=["MEMBER"], level=2)
    assert ctx.level == 2


def _request_with_auth(header: str | None = None, path: str = "/") -> Request:
    headers = []
    if header is not None:
        headers.append((b"authorization", header.encode("utf-8")))
    scope = {
        "type": "http",
        "method": "GET",
        "path": path,
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


def test_extract_helpers_cover_multiple_shapes():
    assert auth._extract_user_id({"userId": "12"}) == 12
    assert auth._extract_user_id({"uid": 13}) == 13
    assert auth._extract_user_id({"sub": "14"}) == 14
    with pytest.raises(HTTPException):
        auth._extract_user_id({"sub": "name"})

    assert auth._extract_roles({"roles": "ADMIN MEMBER"}) == ["ADMIN", "MEMBER"]
    assert auth._extract_roles({"roles": ["ADMIN", " member "]}) == ["ADMIN", "member"]
    assert auth._extract_roles({"roles": None}) == []

    assert auth._extract_level({"level": "L4"}) == 4
    assert auth._extract_level({"level": 3}) == 3
    assert auth._extract_level({"level": "bad"}) is None


def test_get_current_user(monkeypatch):
    claims = {"sub": "100", "roles": ["ADMIN"], "level": "L2"}
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


def test_decode_claims_validates_token_properties(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "x" * 32)
    monkeypatch.setenv("JWT_ISSUER", "signight")
    monkeypatch.setenv("JWT_AUDIENCE", "signight-client")

    token = pyjwt.encode(
        {
            "sub": "1",
            "exp": 4102444800,
            "iss": "signight",
            "aud": "signight-client",
            "token_type": "access",
        },
        b"x" * 32,
        algorithm="HS256",
    )
    claims = auth._decode_claims(token)
    assert claims["sub"] == "1"

    refresh = pyjwt.encode(
        {
            "sub": "1",
            "exp": 4102444800,
            "iss": "signight",
            "aud": "signight-client",
            "token_type": "refresh",
        },
        b"x" * 32,
        algorithm="HS256",
    )
    with pytest.raises(HTTPException) as exc:
        auth._decode_claims(refresh)
    assert exc.value.status_code == 401
