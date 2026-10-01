"""Generate the island's props with the character server's studio pipeline (OpenAI image -> Meshy or Tripo 3D).

Paid: about one high-quality image plus one 3D task per item: Meshy image-to-3D (~30 credits, the default) or, with
`--provider tripo`, a textured PBR Tripo image_to_model task (~8k faces; needs TRIPO_API_KEY in backend/.env). The
provider's balance before and after is printed at the end. Run it yourself from the repo root:

    uv run python scripts/props/generate.py --only chair-basic   # one item first
    uv run python scripts/props/generate.py --all [--provider tripo]

It starts a local character API on a free 127.0.0.1 port with auto-resume off, a sandbox storage prefix (`mogaesup-props/`
in the asset bucket, away from the studio's own data) and CHARACTER_DATABASE_URL cleared, so its records stay in S3 under
that prefix, then submits one studio "prop" generation per manifest item. Only a server that reports the pid of the process
started here is used: one already listening on 8016 (`npm run dev:character`, with the real prefix and records database) is
never asked. Each item has a fixed Idempotency-Key, so running the script again only waits for and downloads what
already exists: it never pays twice for the same item. An item keeps the provider it was accepted with, except one
blocked before any 3D task was accepted (e.g. refused for credits after its image was made): it keeps its image and has
only its 3D step sent again, to `--provider`. The server refuses that once a 3D task was accepted or its acceptance is
uncertain. Results land in scripts/props/out/<id>/ (model.glb, image.png, record.json);
`node frontend/scripts/props-normalize.mjs` then fits them to the island.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import psutil
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / 'backend'
HERE = Path(__file__).resolve().parent
OUT = HERE / 'out'
# A studio owner id of our own: its generations live under mogaesup-props/avatar-factory/7700/.
OWNER = '7700'
KEY_VERSION = 'v1'
PROVIDERS = {'meshy': 'MESHY_API_KEY', 'tripo': 'TRIPO_API_KEY'}
PARALLEL = 4
WAIT_MINUTES = 30


def free_port() -> int:
    """A loopback port nothing listens on right now: ask the system for one by binding port 0."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def process_family(pid: int) -> set[int]:
    """The process and what it started: a Windows venv's python.exe is a launcher that runs the interpreter as a child."""
    try:
        return {pid, *(child.pid for child in psutil.Process(pid).children(recursive=True))}
    except psutil.Error:
        return {pid}


def is_own_health(answer: object, pids: set[int]) -> bool:
    """Whether a /health answer comes from the server started here: the pid it reports (src/runtime_identity.py) is ours."""
    runtime = answer.get('runtime') if isinstance(answer, dict) else None
    pid = runtime.get('pid') if isinstance(runtime, dict) else None
    return isinstance(pid, int) and not isinstance(pid, bool) and pid in pids


def start_api(timeout: float = 60) -> tuple[subprocess.Popen, str]:
    """Starts the sandboxed API on a free port and returns it with its base URL once its own /health answers. A server
    that happens to listen there is never taken for it, and neither is a /health that is not from the child."""
    port = free_port()
    base = f'http://127.0.0.1:{port}'
    env = {
        **os.environ,
        'ASSET_AUTO_RESUME': '0',
        'ASSET_S3_PREFIX': 'mogaesup-props',
        # Props are a sandbox: their records stay in S3 under their own prefix, never in the studio's record database.
        'CHARACTER_DATABASE_URL': '',
    }
    log = open(HERE / 'api.log', 'wb')
    process = subprocess.Popen(
        [sys.executable, '-m', 'uvicorn', 'src.api.server:app', '--host', '127.0.0.1', '--port', str(port)],
        cwd=BACKEND, env=env, stdout=log, stderr=subprocess.STDOUT,
    )
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise SystemExit(f'character API exited; see {HERE / "api.log"}')
        try:
            answer = httpx.get(f'{base}/health', timeout=3)
            if answer.status_code == 200 and is_own_health(answer.json(), process_family(process.pid)):
                return process, base
        except (httpx.HTTPError, ValueError):
            pass
        time.sleep(0.5)
    process.terminate()
    raise SystemExit(f'character API did not answer its own /health within {timeout:g} s')


def generate(client: httpx.Client, style: dict, item: dict, provider: str) -> str:
    target = OUT / item['id']
    if (target / 'model.glb').is_file():
        return f"{item['id']}: already downloaded"
    body = {
        'kind': 'prop',
        'category': item['category'],
        'name': item['name'],
        'prompt': f"{item['prompt']}\n{style[item['category']]}",
        'size': 1024,
        # Not part of the idempotency fingerprint: an existing job answers with the provider it was accepted with.
        'provider': provider,
    }
    key = f"mogaesup-props-{item['id']}-{KEY_VERSION}"
    response = client.post('/api/studio/generations', json=body, headers={'Idempotency-Key': key})
    if response.status_code >= 400:
        return f"{item['id']}: rejected {response.status_code} {response.text[:200]}"
    record = response.json()
    job = record['id']
    if record.get('can_change_provider') and (
            record['status'] == 'blocked' or (record['status'] == 'paused' and record.get('provider') != provider)):
        # No provider accepted its 3D task (none sent yet, or a definite refusal such as Meshy 402): keep the image
        # and send the 3D step to `provider`. The server re-checks this and refuses once a 3D task was accepted or
        # may have been.
        response = client.post(f'/api/studio/generations/{job}/resume', json={'provider': provider})
        if response.status_code >= 400:
            return f"{item['id']}: blocked - {record.get('error')}; resume refused {response.status_code} {response.text[:200]}"
        record = response.json()
    deadline = time.monotonic() + WAIT_MINUTES * 60
    resumed = False
    while record['status'] not in ('complete', 'blocked'):
        if record['status'] == 'paused' and record.get('can_resume') and not resumed:
            # Resuming polls the 3D task already paid for; it does not submit a new one.
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


def credits(provider: str, settings: dict) -> tuple[float, float] | None:
    """(balance, held by running tasks) from the provider's free read-only balance endpoint; None when unknown.
    Like the API process, the environment wins over backend/.env."""
    def setting(name: str) -> str:
        return (os.environ.get(name) or settings.get(name) or '').strip()
    key = setting(PROVIDERS[provider])
    if not key:
        return None
    if provider == 'tripo':
        url = (setting('TRIPO_API_BASE_URL') or 'https://api.tripo3d.ai/v2/openapi').rstrip('/') + '/user/balance'
    else:
        url = (setting('MESHY_API_BASE_URL') or 'https://api.meshy.ai').rstrip('/') + '/openapi/v1/balance'
    try:
        response = httpx.get(url, headers={'Authorization': f'Bearer {key}'}, timeout=10)
        data = response.json()
        data = (data.get('data') or {}) if provider == 'tripo' else data
        balance, held = data.get('balance'), data.get('frozen') or 0
    except (httpx.HTTPError, ValueError, AttributeError):
        return None
    if response.status_code != 200 or not isinstance(balance, (int, float)) or not isinstance(held, (int, float)):
        return None
    return float(balance), float(held)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--only', help='comma-separated manifest ids')
    parser.add_argument('--all', action='store_true')
    parser.add_argument('--provider', choices=sorted(PROVIDERS), default='meshy',
                        help='3D provider for new items and for items blocked before any 3D task was accepted')
    args = parser.parse_args()
    provider = args.provider
    manifest = json.loads((HERE / 'manifest.json').read_text(encoding='utf-8'))
    items = manifest['items']
    if args.only:
        wanted = set(args.only.split(','))
        items = [item for item in items if item['id'] in wanted]
    elif not args.all:
        raise SystemExit('pass --only <ids> or --all')
    if not items:
        raise SystemExit('no matching manifest items')
    settings = dotenv_values(BACKEND / '.env')
    api_key = (settings.get('API_KEY') or '').strip()
    OUT.mkdir(exist_ok=True)
    before = credits(provider, settings)
    process, base = start_api()
    try:
        headers = {'x-user-id': OWNER, **({'x-api-key': api_key} if api_key else {})}
        with httpx.Client(base_url=base, headers=headers, timeout=60) as client:
            ready = client.get('/api/studio/generations', params={'kind': 'prop'})
            ready.raise_for_status()
            if provider not in ready.json()['capabilities'].get('providers', []):
                raise SystemExit(f'{provider} is not configured on the character API ({PROVIDERS[provider]} in backend/.env)')
            with ThreadPoolExecutor(PARALLEL) as pool:
                for line in pool.map(lambda item: generate(client, manifest['style'], item, provider), items):
                    print(line, flush=True)
    finally:
        process.terminate()
    after = credits(provider, settings)
    if after:
        held = f', {after[1]:g} held by running tasks' if after[1] else ''
        used = f', {before[0] - after[0]:g} used this run' if before else ''
        print(f'{provider.capitalize()} credits: {after[0]:g} left{held}{used}', flush=True)


if __name__ == '__main__':
    main()
