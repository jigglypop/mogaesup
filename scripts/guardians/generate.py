"""Generate the 사주 village's guardian dogs with Meshy image-to-3D: one model for each reference picture.

Paid: one Meshy image-to-3D task for each picture (a textured mesh, about 30 credits; needs MESHY_API_KEY in
backend/.env, which is read here and never printed). The balance before and after is printed. Run it from the repo root:

    uv run python scripts/guardians/generate.py --balance            # what is left, nothing sent
    uv run python scripts/guardians/generate.py --only 09            # one picture first
    uv run python scripts/guardians/generate.py --all
    uv run python scripts/guardians/generate.py --only 06 --views    # a picture that came out flat, made from views

The pictures are `<refs>/<id>.png` (default `.data/characters/refs/`, kept out of git). Each picture's task is written
to <out>/<id>/task.json (default scripts/guardians/out/) before it is sent and again once Meshy has accepted it, so
running the script again only waits for and downloads what already exists: it never pays twice for the same picture. A
task whose sending could not be confirmed (the connection broke after the request left) is left alone and named, to be
looked up on Meshy before anything is sent again. Results: <out>/<id>/model.glb and thumbnail.png;
`node frontend/scripts/guardians-normalize.mjs` then fits them to the village.

The pictures are flat drawings. Sent as they are (`--as-drawn`) Meshy models the drawing itself, a thin cut-out with the
picture on both faces; left to Meshy's own image enhancement (the default here) it reads the drawing as a figure. To
try other settings on a picture already made, give another `--out`.

Some drawings still come out as a thick cut-out (a round fluffy outline reads as a biscuit). `--views` makes those
another way, beside the first result: Meshy's image-to-image draws the figure as a soft toy seen from several sides
(about 6 credits; <out>/<id>/views.json and view-N.png), and its multi-image-to-3D builds the model from those (about
30; task-views.json, model-views.glb). scripts/guardians/models.json names the dogs whose `views` model is the one to
keep; frontend/scripts/guardians-normalize.mjs reads it.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT = HERE / 'out'
BASE = 'https://api.meshy.ai'
ENDPOINT = '/openapi/v1/image-to-3d'
VIEWS_ENDPOINT = '/openapi/v1/image-to-image'
MULTI_ENDPOINT = '/openapi/v1/multi-image-to-3d'
PARALLEL = 6
WAIT_MINUTES = 40
# A guardian stands a metre and a half tall beside its house and is never seen close: a light mesh and one colour map.
# No pose is asked for: they are not humanoids to rig.
SETTINGS = {'ai_model': 'meshy-7', 'model_type': 'standard', 'should_texture': True, 'enable_pbr': False,
            'should_remesh': True, 'target_polycount': 8000, 'image_enhancement': True, 'target_formats': ['glb']}


# What the image model is asked for: the same character as a figure with a back and sides, which a flat drawing lacks.
VIEWS = {'ai_model': 'nano-banana-2', 'generate_multi_view': True, 'prompt': (
    'Redraw this flat sticker as the same character made into a 3D figure, for 3D modeling. Keep the silhouette and '
    'chibi proportions of the drawing exactly: the head just as large against the body as drawn (about two thirds of '
    'the height), the same small body and stubby legs, standing upright in the same pose. Keep the character exactly: '
    'the same face and expression, colours, markings, ears, hair or hood, clothes and accessories, and what it holds. '
    'Give every part full round volume, as deep as it is wide, with a real back and sides, like a smooth matte vinyl '
    'toy painted in the flat colours of the drawing. Soft even studio lighting, no black outline strokes, no cast '
    'shadow, no text, plain white background.')}
# The views already show a figure in the round, so they are used as they are.
MULTI_SETTINGS = {'ai_model': 'meshy-7', 'should_texture': True, 'enable_pbr': False, 'should_remesh': True,
                  'target_polycount': 8000, 'image_enhancement': False, 'target_formats': ['glb']}


def write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def balance(client: httpx.Client) -> float | None:
    try:
        response = client.get('/openapi/v1/balance')
        return response.json().get('balance') if response.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None


def submit(client: httpx.Client, out: Path, settings: dict, item: str, picture: Path, *, receipt_name: str = 'task.json',
           endpoint: str = ENDPOINT, inputs: dict | None = None) -> dict:
    """The picture's task: the one already accepted, or a new one. Raises for one whose sending is uncertain.

    `inputs` is what the task is made from when that is not the picture itself (an earlier task's images)."""
    receipt = out / item / receipt_name
    digest = hashlib.sha256(picture.read_bytes()).hexdigest()
    if receipt.exists():
        task = json.loads(receipt.read_text(encoding='utf-8'))
        if task.get('image_sha256') != digest:
            raise RuntimeError(f'{item}: the picture changed since its task was sent; move {out.name}/{item}/ away to send it anew')
        if task.get('task_id'):
            if task.get('settings') != settings:
                raise RuntimeError(f'{item}: already made with other settings; give another --out to make it again')
            return task
        if task.get('status') != 'not_sent':
            raise RuntimeError(f'{item}: a task may have been sent and its ID was not saved; find it on Meshy, put it in '
                               f'{out.name}/{item}/{receipt_name} as task_id, and run again')
    task = {'id': item, 'image': picture.name, 'image_sha256': digest, 'settings': settings, 'status': 'uncertain'}
    if inputs:
        task['inputs'] = inputs
    write(receipt, task)
    source = inputs or {'image_url': 'data:image/png;base64,' + base64.b64encode(picture.read_bytes()).decode()}
    payload = {**source, **settings}
    try:
        response = client.post(endpoint, json=payload)
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
        # The connection never opened, so Meshy cannot have received the request.
        write(receipt, {**task, 'status': 'not_sent'})
        raise
    if response.status_code >= 400:
        # Meshy answered that it did not take the task.
        write(receipt, {**task, 'status': 'not_sent', 'http_status': response.status_code})
        raise RuntimeError(f'{item}: Meshy refused the task (HTTP {response.status_code}): {response.text[:300]}')
    task_id = response.json().get('result')
    if not isinstance(task_id, str) or not task_id:
        raise RuntimeError(f'{item}: Meshy accepted the task without an ID; find it on Meshy before sending again')
    task.update(task_id=task_id, status='PENDING')
    write(receipt, task)
    return task


def waited(client: httpx.Client, endpoint: str, receipt: Path, task: dict) -> dict:
    """The task's state once Meshy has finished it. Raises when it failed or took too long."""
    deadline = time.monotonic() + WAIT_MINUTES * 60
    while True:
        response = client.get(f"{endpoint}/{task['task_id']}")
        response.raise_for_status()
        state = response.json()
        task.update(status=state.get('status'), progress=state.get('progress'))
        if task['status'] == 'SUCCEEDED':
            return state
        if task['status'] in ('FAILED', 'CANCELED', 'EXPIRED'):
            task['error'] = (state.get('task_error') or {}).get('message')
            write(receipt, task)
            raise RuntimeError(f"{task['id']}: Meshy {task['status']}: {task.get('error')}")
        write(receipt, task)
        if time.monotonic() > deadline:
            raise RuntimeError(f"{task['id']}: still {task['status']} after {WAIT_MINUTES} minutes; run again to keep waiting")
        time.sleep(8)


def from_views(client: httpx.Client, out: Path, item: str, picture: Path) -> dict:
    """The picture drawn as a figure from several sides, then the model built from those views."""
    folder = out / item
    picture_uri = 'data:image/png;base64,' + base64.b64encode(picture.read_bytes()).decode()
    # Always the views endpoint's own input: a receipt that names its task returns before it is used, and one Meshy
    # refused or never received (not_sent) is sent again with it, not with the image-to-3d `image_url`.
    views = submit(client, out, VIEWS, item, picture, receipt_name='views.json', endpoint=VIEWS_ENDPOINT,
                   inputs={'reference_image_urls': [picture_uri]})
    if not views.get('views'):
        state = waited(client, VIEWS_ENDPOINT, folder / 'views.json', views)
        urls = state.get('image_urls') or []
        if not urls:
            raise RuntimeError(f'{item}: the finished views task has no images')
        with httpx.Client(timeout=120, follow_redirects=True) as plain:
            for index, url in enumerate(urls):
                (folder / f'view-{index}.png').write_bytes(plain.get(url).raise_for_status().content)
        views.update(views=len(urls), credits=state.get('consumed_credits'))
        # The picture itself is not kept in the receipt.
        views.pop('inputs', None)
        write(folder / 'views.json', views)
    task = submit(client, out, MULTI_SETTINGS, item, picture, receipt_name='task-views.json', endpoint=MULTI_ENDPOINT,
                  inputs={'input_task_id': views['task_id']})
    model = folder / 'model-views.glb'
    if not (task.get('status') == 'SUCCEEDED' and model.exists()):
        state = waited(client, MULTI_ENDPOINT, folder / 'task-views.json', task)
        glb = (state.get('model_urls') or {}).get('glb')
        if not glb:
            raise RuntimeError(f'{item}: the finished task has no GLB')
        with httpx.Client(timeout=120, follow_redirects=True) as plain:
            model.write_bytes(plain.get(glb).raise_for_status().content)
        task.update(model_sha256=hashlib.sha256(model.read_bytes()).hexdigest(), model_bytes=model.stat().st_size,
                    credits=state.get('consumed_credits'))
        write(folder / 'task-views.json', task)
    return task


def finish(client: httpx.Client, out: Path, task: dict) -> dict:
    """Waits for the task and downloads what it made."""
    item = task['id']
    receipt = out / item / 'task.json'
    model = out / item / 'model.glb'
    deadline = time.monotonic() + WAIT_MINUTES * 60
    while not (task.get('status') == 'SUCCEEDED' and model.exists()):
        response = client.get(f"{ENDPOINT}/{task['task_id']}")
        response.raise_for_status()
        state = response.json()
        task.update(status=state.get('status'), progress=state.get('progress'))
        if task['status'] == 'SUCCEEDED':
            glb = (state.get('model_urls') or {}).get('glb')
            if not glb:
                raise RuntimeError(f'{item}: the finished task has no GLB')
            with httpx.Client(timeout=120, follow_redirects=True) as plain:
                model.write_bytes(plain.get(glb).raise_for_status().content)
                if state.get('thumbnail_url'):
                    (out / item / 'thumbnail.png').write_bytes(plain.get(state['thumbnail_url']).raise_for_status().content)
            task.update(model_sha256=hashlib.sha256(model.read_bytes()).hexdigest(), model_bytes=model.stat().st_size)
            write(receipt, task)
            break
        if task['status'] in ('FAILED', 'CANCELED', 'EXPIRED'):
            task['error'] = (state.get('task_error') or {}).get('message')
            write(receipt, task)
            raise RuntimeError(f"{item}: Meshy {task['status']}: {task.get('error')}")
        write(receipt, task)
        if time.monotonic() > deadline:
            raise RuntimeError(f'{item}: still {task["status"]} after {WAIT_MINUTES} minutes; run again to keep waiting')
        time.sleep(8)
    return task


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--refs', type=Path, default=ROOT / '.data/characters/refs')
    parser.add_argument('--only', nargs='+', default=[])
    parser.add_argument('--all', action='store_true')
    parser.add_argument('--balance', action='store_true')
    parser.add_argument('--out', type=Path, default=OUT)
    parser.add_argument('--as-drawn', action='store_true', help='send the picture without Meshy\'s image enhancement')
    parser.add_argument('--views', action='store_true', help='draw the figure from several sides first, then model those')
    args = parser.parse_args()
    settings = {**SETTINGS, 'image_enhancement': not args.as_drawn}
    key = (dotenv_values(ROOT / 'backend/.env').get('MESHY_API_KEY') or '').strip()
    if not key:
        print('MESHY_API_KEY is not set in backend/.env', file=sys.stderr)
        return 2
    with httpx.Client(base_url=BASE, headers={'Authorization': 'Bearer ' + key}, timeout=httpx.Timeout(120, connect=15)) as client:
        before = balance(client)
        print(f'Meshy balance: {before}')
        if args.balance:
            return 0
        pictures = sorted(args.refs.glob('*.png'))
        items = [(picture.stem, picture) for picture in pictures if args.all or picture.stem in args.only]
        missing = sorted(set(args.only) - {item for item, _ in items})
        if missing or not items:
            print(f'no picture for: {", ".join(missing) or "(nothing asked: --only <ids> or --all)"}', file=sys.stderr)
            return 2

        def run(entry):
            item, picture = entry
            try:
                task = (from_views(client, args.out, item, picture) if args.views
                        else finish(client, args.out, submit(client, args.out, settings, item, picture)))
                return f"ok   {item}: {task['model_bytes'] / 1e6:.2f} MB  task {task['task_id']}"
            except Exception as problem:  # one picture failing leaves the others to finish
                return f'FAIL {item}: {problem}'

        with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
            lines = list(pool.map(run, items))
        print('\n'.join(lines))
        after = balance(client)
        print(f'Meshy balance: {after}' + (f' (spent {before - after:g})' if isinstance(before, (int, float)) and isinstance(after, (int, float)) else ''))
        return 1 if any(line.startswith('FAIL') for line in lines) else 0


if __name__ == '__main__':
    sys.exit(main())
