"""Identify the code loaded by a local server without exposing workspace paths."""
import hashlib
import json
import os
from pathlib import Path


def _database_identity(url):
    """The records database a server uses (host, port, database name), never its user or password: /health is public
    and the revision must not help anyone guess the credentials."""
    if not url.strip():
        return ''
    try:
        from psycopg.conninfo import conninfo_to_dict
        parts = conninfo_to_dict(url.strip())
    except Exception:
        return 'unreadable'
    return '/'.join(str(parts.get(key) or '') for key in ('host', 'port', 'dbname'))


def runtime_identity():
    from src.paths import load_environment
    load_environment()
    backend = Path(__file__).resolve().parents[1]
    root = backend.parent
    digest = hashlib.sha256()
    for key in ('ASSET_S3_BUCKET', 'ASSET_S3_REGION', 'ASSET_S3_PREFIX', 'ASSET_AWS_PROFILE', 'AVATAR_IMAGE_TLS_MAX_VERSION'):
        digest.update((key+'='+os.getenv(key, '')+'\0').encode())
    digest.update(('CHARACTER_DATABASE='+_database_identity(os.getenv('CHARACTER_DATABASE_URL', ''))+'\0').encode())
    files = [*backend.joinpath('src').rglob('*.py'), *backend.joinpath('assets').rglob('*.json'),
             root/'pyproject.toml', root/'uv.lock']
    for path in sorted(files):
        if path.is_file():
            digest.update(path.relative_to(root).as_posix().encode())
            digest.update(b'\0')
            digest.update(path.read_bytes())
            digest.update(b'\0')
    return {'workspace': hashlib.sha256(str(root).casefold().encode()).hexdigest()[:24],
            'revision': digest.hexdigest(), 'pid': os.getpid()}


if __name__ == '__main__':
    print(json.dumps(runtime_identity()))
