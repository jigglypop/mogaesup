"""Keep the backend suite offline.

`src.api.server` loads `backend/.env` (production keys) when it is imported, and a developer's
shell may hold the same keys. Before any test module imports the app, this file turns the
`.env` loader into a no-op, drops every provider/AWS/database/JWT setting from the process,
points the data root at a throwaway directory, hides Blender, and refuses non-loopback
connections so an unfaked provider call fails the test instead of leaving the machine.
"""

import atexit
import ipaddress
import os
from pathlib import Path
import re
import shutil
import socket
import tempfile

import pytest

import src.paths


src.paths._load_dotenv = lambda *args, **kwargs: False

_SETTING = re.compile(
    r"^(ASSET|AVATAR|AWS|MESHY|TRIPO|OPENAI|GEMINI|WORLD|DB|JWT|BLENDER|CHARACTER|API)_|^PG"
    r"|^(DATABASE_URL|PUBLIC_PATHS)$|API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL",
    re.IGNORECASE,
)
for _name in [name for name in os.environ if _SETTING.search(name)]:
    del os.environ[_name]

_SCRATCH = Path(tempfile.mkdtemp(prefix="backend-tests-"))
atexit.register(shutil.rmtree, _SCRATCH, ignore_errors=True)
os.environ.update({
    "ASSET_DATA_ROOT": str(_SCRATCH / "data"),
    # Every StoredPath stays on local disk, even in tests that name a bucket.
    "ASSET_STORAGE_WORKER_LOCAL": "1",
    "ASSET_AUTO_RESUME": "0",
    "BLENDER_EXECUTABLE": str(_SCRATCH / "no-blender" / "blender.exe"),
    "AWS_CONFIG_FILE": str(_SCRATCH / "no-aws" / "config"),
    "AWS_SHARED_CREDENTIALS_FILE": str(_SCRATCH / "no-aws" / "credentials"),
    "AWS_EC2_METADATA_DISABLED": "true",
    "DISABLE_TELEMETRY": "true",
})


class OfflineViolation(RuntimeError):
    """A test tried to leave the machine; fake the provider instead."""


_attempts: list[str] = []


def _is_loopback(host) -> bool:
    if host is None:
        return True
    if isinstance(host, bytes):
        host = host.decode("ascii", "replace")
    host = str(host).strip("[]").split("%", 1)[0].lower()
    if host in ("", "localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _refuse(host) -> None:
    _attempts.append(str(host))
    raise OfflineViolation(f"backend tests are offline; attempted to reach {host!r}")


_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex
_real_getaddrinfo = socket.getaddrinfo


def _connect(self, address):
    if self.family in (socket.AF_INET, socket.AF_INET6) and not _is_loopback(address[0]):
        _refuse(address[0])
    return _real_connect(self, address)


def _connect_ex(self, address):
    if self.family in (socket.AF_INET, socket.AF_INET6) and not _is_loopback(address[0]):
        _refuse(address[0])
    return _real_connect_ex(self, address)


def _getaddrinfo(host, *args, **kwargs):
    if not _is_loopback(host):
        _refuse(host)
    return _real_getaddrinfo(host, *args, **kwargs)


socket.socket.connect = _connect
socket.socket.connect_ex = _connect_ex
socket.getaddrinfo = _getaddrinfo


# libpq opens its own sockets, so PostgreSQL gets the same check at psycopg.connect.
import psycopg
from psycopg.conninfo import conninfo_to_dict

_real_pg_connect = psycopg.connect


def _pg_connect(conninfo="", **kwargs):
    host = conninfo_to_dict(conninfo, **kwargs).get("host")
    for name in str(host or "").split(","):
        if not _is_loopback(name):
            _refuse(name)
    return _real_pg_connect(conninfo, **kwargs)


psycopg.connect = _pg_connect


@pytest.fixture
def storage_configured(monkeypatch):
    """Services that refuse to run without private storage see a bucket; objects stay local."""
    monkeypatch.setenv("ASSET_S3_BUCKET", "offline-fixture-bucket")


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    # Character tests must not index disposable fixtures into the developer's DB, and their
    # run locks must not share the port of a developer's running character server (9878).
    monkeypatch.setenv("CHARACTER_DATABASE_URL", "")
    monkeypatch.setenv("BLENDER_PORT", "62126")
    _attempts.clear()
    yield
    # Production code may swallow the error; the attempt itself still fails the test.
    if _attempts:
        pytest.fail(f"test tried to reach the network: {sorted(set(_attempts))}")
