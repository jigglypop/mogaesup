"""Single-owner deployment: the API through SSM port forwarding, or through CloudFront when configured."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

allowed = {'OPENAI_API_KEY', 'MESHY_API_KEY', 'OPENAI_API_BASE', 'AVATAR_IMAGE_MODEL', 'TRIPO_API_KEY',
           'AVATAR_3D_PROVIDER', 'BLENDER_CONCURRENCY', 'CHARACTER_DATABASE_URL', 'STUDIO_GATEWAY_KEY'}
# The gateway key is written into nginx's rules: no quote, space, `;`, `$` or anything else nginx would read.
GATEWAY_KEY = re.compile(r'[A-Za-z0-9._~-]{16,}')


def public_rules(public, gateway_key=''):
    """The rules of nginx.conf's port-80 server (/etc/nginx/studio-public.conf): closed unless `public`. With a gateway key
    the API answers 403 to a request that does not send it as x-gateway-key."""
    if not public:
        return ['location /api/ { return 404; }', 'location = /health { return 404; }']
    if not gateway_key or not GATEWAY_KEY.fullmatch(gateway_key):
        raise SystemExit('STUDIO_GATEWAY_KEY must be at least 16 characters of A-Z a-z 0-9 . _ ~ -')
    gate = [f'  if ($http_x_gateway_key != "{gateway_key}") {{ return 403; }}']
    proxy = ['  proxy_pass http://127.0.0.1:8000;', '  proxy_set_header X-User-Id 1;', '  proxy_set_header Host $host;',
             '  proxy_set_header Forwarded "";', '  proxy_set_header X-Forwarded-For "";', '  proxy_set_header X-Real-IP "";',
             '  proxy_read_timeout 65s;', '  proxy_buffering off;']
    return [
        'location /api/ {', *gate, *proxy, '}',
        # Raw GLB uploads; the API streams them and caps each at 256 MiB.
        'location ~ ^/api/(avatar-factory/base-bodies/glb-assets|studio/glb-assets/upload)$ {',
        '  client_max_body_size 256m;', *gate, *proxy, '}',
        'location = /health { return 404; }',
    ]


def write_public_rules(path, public, gateway_key):
    # nginx injects X-User-Id 1, so without the key whatever reaches port 80 acts as the studio owner.
    path.write_text('\n'.join(public_rules(public, gateway_key)) + '\n', encoding='utf-8')
    path.chmod(0o600)


def main():
    values = json.loads(Path('/run/studio-secrets.json').read_text())
    if not values.get('OPENAI_API_KEY') or not values.get('MESHY_API_KEY'):
        raise SystemExit('Provider credentials are not configured')
    os.environ.update({key: str(value) for key, value in values.items() if key in allowed})
    if not os.environ.get('ASSET_S3_BUCKET'):
        raise SystemExit('S3 bucket is required')

    release_sha = os.environ.get('STUDIO_RELEASE_SHA', '').strip()
    if not re.fullmatch(r'[0-9a-f]{64}', release_sha):
        raise SystemExit('STUDIO_RELEASE_SHA must be a lowercase SHA-256 digest')
    # The studio screens live in the mogaesup app now; this container serves the API and its release stamp only.
    static = Path('/app/static')
    static.mkdir(parents=True, exist_ok=True)
    (static / 'version.json').write_text(
        json.dumps({'release_sha': release_sha}, separators=(',', ':')) + '\n',
        encoding='utf-8',
    )

    # Port 80: closed by default; the API when PUBLIC_STUDIO is set (CloudFront only reaches it). Only nginx needs the
    # gateway key, so the API and the Blender workers it starts do not inherit it.
    public = os.environ.get('PUBLIC_STUDIO', '').strip().lower() == 'true'
    gateway_key = os.environ.pop('STUDIO_GATEWAY_KEY', '').strip()
    write_public_rules(Path('/etc/nginx/studio-public.conf'), public, gateway_key)
    children = [subprocess.Popen(['python', '-m', 'uvicorn', 'src.api.server:app', '--host', '127.0.0.1', '--port', '8000', '--workers', '1', '--no-proxy-headers']),
                subprocess.Popen(['nginx', '-g', 'daemon off;'])]

    def stop(*_):
        for child in children:
            child.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while all(child.poll() is None for child in children):
            time.sleep(1)
    finally:
        failed = next((child.returncode for child in children if child.returncode not in (None, 0)), None)
        stop()
        for child in children:
            try: child.wait(timeout=20)
            except subprocess.TimeoutExpired: child.kill()
        if failed is not None:
            raise SystemExit(failed)


if __name__ == '__main__':
    main()
