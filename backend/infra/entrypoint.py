"""Single-owner deployment: SSM port forwarding, or the whole studio through CloudFront when configured."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
from urllib.parse import urlparse
from xml.sax.saxutils import escape

allowed = {'OPENAI_API_KEY', 'MESHY_API_KEY', 'OPENAI_API_BASE', 'AVATAR_IMAGE_MODEL', 'TRIPO_API_KEY',
           'AVATAR_3D_PROVIDER', 'BLENDER_CONCURRENCY'}
values = json.loads(Path('/run/studio-secrets.json').read_text())
if not values.get('OPENAI_API_KEY') or not values.get('MESHY_API_KEY'):
    raise SystemExit('Provider credentials are not configured')
os.environ.update({key: str(value) for key, value in values.items() if key in allowed})
if not os.environ.get('ASSET_S3_BUCKET'):
    raise SystemExit('S3 bucket is required')

release_sha = os.environ.get('STUDIO_RELEASE_SHA', '').strip()
if not re.fullmatch(r'[0-9a-f]{64}', release_sha):
    raise SystemExit('STUDIO_RELEASE_SHA must be a lowercase SHA-256 digest')
dist = Path('/app/frontend/dist')
(dist / 'version.json').write_text(
    json.dumps({'release_sha': release_sha}, separators=(',', ':')) + '\n',
    encoding='utf-8',
)

site_origin = os.environ.get('PUBLIC_SITE_ORIGIN', '').strip().rstrip('/')
if site_origin:
    parsed = urlparse(site_origin)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.path not in ('', '/') or parsed.params or parsed.query or parsed.fragment:
        raise SystemExit('PUBLIC_SITE_ORIGIN must be an HTTPS origin without a path, query, or fragment')
    index_path = dist / 'index.html'
    index = index_path.read_text(encoding='utf-8')
    social_image = f'{site_origin}/title-background.png'
    public_meta = (
        f'    <link rel="canonical" href="{site_origin}/" />\n'
        f'    <meta property="og:url" content="{site_origin}/" />\n'
        f'    <meta property="og:image" content="{social_image}" />\n'
        f'    <meta property="og:image:alt" content="개숲 캐릭터 공장" />\n'
        f'    <meta name="twitter:image" content="{social_image}" />\n'
        f'    <meta name="twitter:image:alt" content="개숲 캐릭터 공장" />\n'
    )
    index_path.write_text(index.replace('  </head>', public_meta + '  </head>'), encoding='utf-8')
    (dist / 'robots.txt').write_text(
        f'User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: {site_origin}/sitemap.xml\n',
        encoding='utf-8',
    )
    safe_origin = escape(site_origin)
    (dist / 'sitemap.xml').write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f'  <url><loc>{safe_origin}/</loc></url>\n'
        '</urlset>\n',
        encoding='utf-8',
    )
# Port 80: closed API by default; the whole studio when PUBLIC_STUDIO is set (CloudFront only reaches it).
proxy = ['  proxy_pass http://127.0.0.1:8000;', '  proxy_set_header X-User-Id 1;', '  proxy_set_header Host $host;',
         '  proxy_read_timeout 65s;', '  proxy_buffering off;']
public_rules = ([
    'location /api/ {', *proxy, '}',
    # Raw GLB uploads; the API streams them and caps each at 256 MiB.
    'location ~ ^/api/(avatar-factory/base-bodies/glb-assets|studio/glb-assets/upload)$ {',
    '  client_max_body_size 256m;', *proxy, '}',
    'location = /health { return 404; }',
] if os.environ.get('PUBLIC_STUDIO', '').strip().lower() == 'true' else [
    'location /api/ { return 404; }',
    'location = /health { return 404; }',
])
Path('/etc/nginx/studio-public.conf').write_text('\n'.join(public_rules) + '\n', encoding='utf-8')
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
