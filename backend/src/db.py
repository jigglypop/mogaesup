from __future__ import annotations

import logging
import os
import time
from contextlib import contextmanager
from typing import Any, Iterable, Optional, Sequence

logger = logging.getLogger(__name__)

_CONNECT_MAX_RETRIES = int(os.getenv("DB_CONNECT_MAX_RETRIES", "2") or "2")
_CONNECT_RETRY_BACKOFF = float(os.getenv("DB_CONNECT_RETRY_BACKOFF", "0.5") or "0.5")


def _driver():
    # File-backed character/avatar work must remain available without a DB driver.
    import psycopg
    from psycopg.rows import dict_row
    return psycopg.connect, dict_row


def _connection_kwargs(row_factory=None) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "autocommit": True,
        "row_factory": row_factory,
        "connect_timeout": int(os.getenv("DB_CONNECT_TIMEOUT", "10") or "10"),
        "application_name": os.getenv("DB_APPLICATION_NAME", "asset-3d-api") or "asset-3d-api",
    }
    sslmode = os.getenv("DB_SSLMODE", "").strip()
    if sslmode:
        kwargs["sslmode"] = sslmode
    statement_timeout_ms = int(os.getenv("DB_STATEMENT_TIMEOUT_MS", "30000") or "30000")
    if statement_timeout_ms > 0:
        kwargs["options"] = f"-c statement_timeout={statement_timeout_ms}"
    return kwargs


def _connect():
    connect, row_factory = _driver()
    database_url = os.getenv("DATABASE_URL", "").strip()
    kwargs = _connection_kwargs(row_factory)
    if database_url:
        return connect(database_url, **kwargs)
    return connect(
        host=os.getenv("DB_HOST", "").strip(),
        port=int(os.getenv("DB_PORT", "5432") or "5432"),
        user=os.getenv("DB_USERNAME", os.getenv("DB_USER", "postgres")),
        password=os.getenv("DB_PASSWORD", ""),
        dbname=os.getenv("DB_NAME", "postgres"),
        **kwargs,
    )


def is_configured() -> bool:
    return bool(os.getenv("DATABASE_URL", "").strip() or os.getenv("DB_HOST", "").strip())


def _connect_with_retry():
    attempt = 0
    while True:
        try:
            return _connect()
        except Exception as e:
            attempt += 1
            if attempt > _CONNECT_MAX_RETRIES:
                logger.warning("DB 연결 실패 (재시도 %s회 소진): %s", _CONNECT_MAX_RETRIES, e)
                raise
            wait = _CONNECT_RETRY_BACKOFF * attempt
            logger.warning("DB 연결 실패, %.1fs 후 재시도 (%s/%s): %s", wait, attempt, _CONNECT_MAX_RETRIES, e)
            time.sleep(wait)


@contextmanager
def get_conn():
    """단일 PostgreSQL 연결 컨텍스트를 반환한다."""
    if not is_configured():
        raise RuntimeError("DATABASE_URL 또는 DB_HOST가 설정되어 있지 않습니다.")
    conn = _connect_with_retry()
    try:
        yield conn
    finally:
        try:
            conn.close()
        except Exception as e:
            logger.debug("DB 연결 종료 중 오류(무시): %s", e)


def ping() -> dict[str, Any]:
    """재시도 없이 PostgreSQL 연결 상태를 확인한다."""
    if not is_configured():
        return {"configured": False, "ok": False}
    try:
        conn = _connect()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
            return {"configured": True, "ok": True}
        finally:
            conn.close()
    except Exception as e:
        logger.warning("DB 헬스체크 ping 실패: %s", e)
        return {"configured": True, "ok": False, "error": str(e)}


def fetch_one(sql: str, params: Optional[Sequence[Any] | dict] = None) -> Optional[dict]:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params or ())
        return cur.fetchone()


def fetch_all(sql: str, params: Optional[Sequence[Any] | dict] = None) -> list[dict]:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params or ())
        return list(cur.fetchall())


def execute(sql: str, params: Optional[Sequence[Any] | dict] = None) -> int:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params or ())
        return cur.rowcount


def execute_many(sql: str, params_list: Iterable[Sequence[Any] | dict]) -> int:
    with get_conn() as conn, conn.cursor() as cur:
        cur.executemany(sql, list(params_list))
        return cur.rowcount


def execute_returning_id(sql: str, params: Optional[Sequence[Any] | dict] = None) -> int:
    """`RETURNING id` 쿼리를 실행하고 생성된 ID를 반환한다."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params or ())
        row = cur.fetchone()
        if not row or row.get("id") is None:
            raise RuntimeError("INSERT 쿼리가 id를 반환하지 않았습니다. RETURNING id를 확인하세요.")
        return int(row["id"])


def load_settings(prefixes: Optional[Iterable[str]] = None) -> dict[str, str]:
    """`agent_settings`의 setting_key/value 맵을 반환한다."""
    if not is_configured():
        return {}
    try:
        rows = fetch_all("SELECT setting_key, setting_value FROM agent_settings")
    except Exception as e:
        logger.warning("agent_settings 로드 실패: %s", e)
        return {}
    result: dict[str, str] = {}
    prefix_list = tuple(prefixes) if prefixes else None
    for row in rows:
        key = (row.get("setting_key") or "").strip()
        if not key:
            continue
        if prefix_list and not key.startswith(prefix_list):
            continue
        result[key] = row.get("setting_value") or ""
    return result


def setting_or_env(key: str, env_key: str = "", default: str = "", settings: Optional[dict[str, str]] = None) -> str:
    """`agent_settings`를 우선하고 환경변수와 기본값을 차례로 사용한다."""
    if settings is not None:
        value = (settings.get(key) or "").strip()
        if value:
            return value
    elif is_configured():
        try:
            row = fetch_one(
                "SELECT setting_value FROM agent_settings WHERE setting_key=%s",
                (key,),
            )
            if row and row.get("setting_value"):
                return str(row["setting_value"]).strip()
        except Exception as e:
            logger.warning("setting_or_env(%s) DB 조회 실패: %s", key, e)
    if env_key:
        env_val = (os.getenv(env_key, "") or "").strip()
        if env_val:
            return env_val
    return default
