from __future__ import annotations
import base64
import fnmatch
import logging
import os
from typing import Iterable, Optional

import jwt as pyjwt
from fastapi import HTTPException, Request, status

logger = logging.getLogger(__name__)

# The Rust server's studio gateway signs its operator tokens with roles ["ADMIN"] (server/src/factory.rs).
_ADMIN_LEVEL = 2

_DEFAULT_PUBLIC_PATHS = (
    "/health",
    "/api/health",
)


class UserContext:
    __slots__ = ("user_id", "username", "roles", "level")

    def __init__(self, user_id: int, username: str, roles: list[str]):
        self.user_id = user_id
        self.username = username
        self.roles = roles
        self.level = _compute_level(roles)


def _compute_level(roles: Iterable[str]) -> Optional[int]:
    return _ADMIN_LEVEL if any(str(role).upper() == "ADMIN" for role in roles) else None


_PLACEHOLDER_SECRET_MARKERS = (
    "replace-this", "replace_this", "replaceme", "replace-me", "changeme", "change-me", "change_me",
    "your-secret", "your_secret", "yoursecret", "placeholder", "example", "insecure", "not-a-secret",
)


def _is_placeholder_secret(raw: str) -> bool:
    """Template values (such as the one in .env.example) and one-word secrets."""
    lowered = raw.lower()
    if any(marker in lowered for marker in _PLACEHOLDER_SECRET_MARKERS):
        return True
    return lowered.strip("-_ ") in {"secret", "jwt-secret", "jwt_secret", "password", "test", "dev", "default"}


def _resolve_secret() -> bytes:
    raw = (os.getenv("JWT_SECRET") or "").strip()
    if not raw:
        raise RuntimeError("JWT_SECRET 환경변수가 설정되어 있지 않습니다.")
    if _is_placeholder_secret(raw):
        raise RuntimeError("JWT_SECRET 이 예시 값입니다. 임의의 비밀 값으로 설정하세요.")
    min_len = max(32, int(os.getenv("JWT_MIN_SECRET_LENGTH", "32") or "32"))
    raw_bytes = raw.encode("utf-8")
    try:
        decoded = base64.b64decode(raw, validate=False)
    except Exception:
        decoded = b""
    if decoded and len(decoded) >= min_len:
        return decoded
    if len(raw_bytes) < min_len:
        raise RuntimeError(
            f"JWT secret 이 너무 짧습니다 (필요 {min_len} bytes, 실제 {len(raw_bytes)})."
        )
    return raw_bytes


def _bearer_token(request: Request) -> str:
    """The Authorization header only; tokens in query strings end up in access logs."""
    header = request.headers.get("authorization") or ""
    parts = header.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return header.strip()


def _public_path_patterns() -> list[str]:
    raw = os.getenv("PUBLIC_PATHS", "")
    configured = [p.strip() for p in raw.replace("\n", ",").split(",") if p.strip()]
    return [*_DEFAULT_PUBLIC_PATHS, *configured]


def is_public_path(path: str) -> bool:
    normalized = (path or "").strip() or "/"
    for pattern in _public_path_patterns():
        if not pattern:
            continue
        if pattern.endswith("/*") and normalized.startswith(pattern[:-1]):
            return True
        if fnmatch.fnmatch(normalized, pattern):
            return True
    return False


def trusted_loopback(request: Request) -> bool:
    """The real socket peer only; a proxy-supplied loopback address is not an operator identity."""
    client_host = (request.client.host if request.client else "") or ""
    return (client_host in {"127.0.0.1", "::1"}
            and not any(name in request.headers for name in ('forwarded', 'x-forwarded-for', 'x-real-ip')))


def _local_dev_user(request: Request) -> Optional[UserContext]:
    raw_user_id = (request.headers.get("x-user-id") or "").strip()
    if not raw_user_id:
        return None
    if not trusted_loopback(request):
        return None
    try:
        user_id = int(raw_user_id)
    except ValueError:
        return None
    return UserContext(user_id=user_id, username=f"dev:{user_id}", roles=["ADMIN"]) if user_id > 0 else None


def _decode_claims(token: str) -> dict:
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing JWT")
    secret = _resolve_secret()
    # Same defaults as the Rust server's FACTORY_JWT_ISSUER / FACTORY_JWT_AUDIENCE (server/src/config.rs).
    issuer = (os.getenv("JWT_ISSUER") or "mogaesup").strip()
    audience = (os.getenv("JWT_AUDIENCE") or "mogaesup-client").strip()
    try:
        claims = pyjwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            issuer=issuer,
            audience=audience,
            options={"require": ["exp", "iss", "aud"]},
        )
    except pyjwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="JWT expired")
    except pyjwt.InvalidIssuerError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid JWT issuer")
    except pyjwt.InvalidAudienceError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid JWT audience")
    except pyjwt.InvalidTokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid JWT") from None

    token_type = (claims.get("token_type") or "").strip()
    if token_type != "access":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not an access token")
    return claims


def _extract_user_id(claims: dict) -> int:
    for key in ("userId", "uid"):
        raw = claims.get(key)
        if raw is None:
            continue
        try:
            value = int(str(raw))
            if value > 0:
                return value
        except Exception:
            continue
    sub = claims.get("sub") or ""
    try:
        value = int(str(sub))
        if value > 0:
            return value
        raise ValueError('invalid user id')
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="JWT 에 user id 가 없습니다")


def _extract_roles(claims: dict) -> list[str]:
    raw = claims.get("roles")
    if not raw:
        return []
    if isinstance(raw, str):
        return [r.strip() for r in raw.replace(",", " ").split() if r.strip()]
    if isinstance(raw, list):
        return [str(r).strip() for r in raw if str(r).strip()]
    return []


def get_current_user(request: Request) -> UserContext:
    """FastAPI Depends 용. JWT 를 검증하고 UserContext 반환."""
    dev_user = _local_dev_user(request)
    if dev_user:
        return dev_user
    token = _bearer_token(request)
    claims = _decode_claims(token)
    user_id = _extract_user_id(claims)
    username = str(claims.get("sub") or "")
    user = UserContext(user_id=user_id, username=username, roles=_extract_roles(claims))
    if user.level != _ADMIN_LEVEL:
        raise HTTPException(status_code=403, detail="Studio operator access required")
    return user
