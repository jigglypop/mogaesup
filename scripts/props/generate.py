"""Generate the island's props with gaesup-character's studio pipeline (OpenAI image -> Meshy image-to-3D).

Paid: about one high-quality image plus ~30 Meshy credits per item. Run it yourself from the repo root:

    uv run python scripts/props/generate.py --only chair-basic   # one item first
    uv run python scripts/props/generate.py --all

It starts a local character API on 127.0.0.1:8016 with auto-resume off, a sandbox storage prefix (`mogaesup-props/`
in the asset bucket, away from the studio's own data) and the signight database unreachable, then submits one studio
"prop" generation per manifest item. Each item has a fixed Idempotency-Key, so running the script again only waits for
and downloads what already exists: it never pays twice for the same item. Results land in scripts/props/out/<id>/
(model.glb, image.png, record.json); `node frontend/scripts/props-normalize.mjs` then fits them to the island.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[2]
CHARACTER = ROOT / 'gaesup-character'
HERE = Path(__file__).resolve().parent
OUT = HERE / 'out'
PORT = 8016
BASE = f'http://127.0.0.1:{PORT}'
# A studio owner id of our own: its generations live under mogaesup-props/avatar-factory/7700/.
OWNER = '7700'
KEY_VERSION = 'v1'
PARALLEL = 4
WAIT_MINUTES = 30


def start_api() -> subprocess.Popen:
    env = {
        **os.environ,
        'ASSET_AUTO_RESUME': '0',
        'ASSET_S3_PREFIX': 'mogaesup-props',
        # The studio flow never needs the signight database; make any stray use fail fast instead of touching it.
        'DB_HOST': '127.0.0.1',
        'DB_PORT': '9',
    }
    log = open(HERE / 'api.log', 'wb')
    process = subprocess.Popen(
        [sys.executable, '-m', 'uvicorn', 'src.api.server:app', '--host', '127.0.0.1', '--port', str(PORT)],
        cwd=CHARACTER, env=env, stdout=log, stderr=subprocess.STDOUT,
    )
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            if httpx.get(f'{BASE}/health', timeout=3).status_code == 200:
                return process
        except httpx.HTTPError:
            pass
        if process.poll() is not None:
            raise SystemExit(f'character API exited; see {HERE / "api.log"}')
        time.sleep(0.5)
    process.terminate()
    raise SystemExit('character API did not answer /health within 60 s')


def generate(client: httpx.Client, style: dict, item: dict) -> str:
    target = OUT / item['id']
    if (target / 'model.glb').is_file():
        return f"{item['id']}: already downloaded"
    body = {
        'kind': 'prop',
        'category': item['category'],
        'name': item['name'],
        'prompt': f"{item['prompt']}\n{style[item['category']]}",
        'size': 1024,
    }
    key = f"mogaesup-props-{item['id']}-{KEY_VERSION}"
    response = client.post('/api/studio/generations', json=body, headers={'Idempotency-Key': key})
    if response.status_code >= 400:
        return f"{item['id']}: rejected {response.status_code} {response.text[:200]}"
    record = response.json()
    job = record['id']
    deadline = time.monotonic() + WAIT_MINUTES * 60
    resumed = False
    while record['status'] not in ('complete', 'blocked'):
        if record['status'] == 'paused' and record.get('can_resume') and not resumed:
            # Resuming polls the Meshy task already paid for; it does not submit a new one.
            record = client.post(f'/api/studio/generations/{job}/resume').json()
            resumed = True
        if time.monotonic() > deadline:
            return f"{item['id']}: still {record['status']} after {WAIT_MINUTES} min (job {job}); run again later"
        time.sleep(10)
        record = client.get(f'/api/studio/generations/{job}').json()
    if record['status'] != 'complete':
        return f"{item['id']}: {record['status']} - {record.get('error')}"
    target.mkdir(parents=True, exist_ok=True)
    for name in ('model.glb', 'image.png'):
        artifact = client.get(f'/api/studio/generations/{job}/artifacts/{name}', follow_redirects=True, timeout=120)
        artifact.raise_for_status()
        (target / name).write_bytes(artifact.content)
    (target / 'record.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
    return f"{item['id']}: done ({job})"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', help='comma-separated manifest ids')
    parser.add_argument('--all', action='store_true')
    args = parser.parse_args()
    manifest = json.loads((HERE / 'manifest.json').read_text(encoding='utf-8'))
    items = manifest['items']
    if args.only:
        wanted = set(args.only.split(','))
        items = [item for item in items if item['id'] in wanted]
    elif not args.all:
        raise SystemExit('pass --only <ids> or --all')
    if not items:
        raise SystemExit('no matching manifest items')
    api_key = (dotenv_values(CHARACTER / '.env').get('API_KEY') or '').strip()
    OUT.mkdir(exist_ok=True)
    process = start_api()
    try:
        headers = {'x-user-id': OWNER, **({'x-api-key': api_key} if api_key else {})}
        with httpx.Client(base_url=BASE, headers=headers, timeout=60) as client:
            ready = client.get('/api/studio/generations', params={'kind': 'prop'})
            ready.raise_for_status()
            with ThreadPoolExecutor(PARALLEL) as pool:
                for line in pool.map(lambda item: generate(client, manifest['style'], item), items):
                    print(line, flush=True)
    finally:
        process.terminate()


if __name__ == '__main__':
    main()
