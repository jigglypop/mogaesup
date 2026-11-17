"""Rig the 사주 village's guardian dogs: T-pose views drawn with OpenAI, then modelled, rigged and animated with Meshy.

Paid, per dog: four OpenAI gpt-image-2.6-sunburst edits (portrait, high quality), one Meshy multi-image-to-3D task (30 credits),
one rigging task (5) and one animation task holding four actions (3 each). The keys come from backend/.env
(OPENAI_API_KEY, MESHY_API_KEY), are read here and never printed. Run it from the repo root:

    uv run python scripts/guardians/rig.py --balance               # Meshy credits left and what was spent, nothing sent
    uv run python scripts/guardians/rig.py --only 09 --draw        # the four views, to look at before anything else
    uv run python scripts/guardians/rig.py --only 09 --redraw left # a view that came out wrong, drawn again
    uv run python scripts/guardians/rig.py --only 09 --accept      # the views as they are now are the ones to model
    uv run python scripts/guardians/rig.py --only 09               # model, rig and animate the accepted views
    uv run python scripts/guardians/rig.py --all
    uv run python scripts/guardians/rig.py --all --sheet views.png # every dog's picture and views on one sheet

A dog's pictures are drawn one after another, front, left, back and right, from its original picture
(`<refs>/<id>.png`, default `.data/characters/refs/`) and the views drawn before it, so the four agree: the same
character standing in a T-pose, with what it wears and without what it holds (a T-pose holds nothing). Nothing goes to
Meshy until the views have been looked at and accepted; changing a view afterwards needs `--accept` again, and a model
already made from other views stays where it is (give another `--out` to make one anew).

Rigging takes humanoid figures only and answers 422 (not charged) when it cannot read the pose. For a dog whose stubby
limbs it cannot read there are two other ways to draw it, each into a folder of its own:

    uv run python scripts/guardians/rig.py --only 09 --out scripts/guardians/out-apose --pose a-pose --draw
    uv run python scripts/guardians/rig.py --only 09 --out scripts/guardians/out-longer --longer --draw

and then `--accept` and the run without `--draw`, with the same options. A view drawn for one pose is never taken for
another. A dog rigged in such a folder is named in `folders` in scripts/guardians/models.json ({"09": "out-apose"}).

Every paid request has a receipt, written before the request goes and again once it is accepted (<out>/<id>/tpose/
<view>.json, task-tpose.json, rig.json, animations.json; default out scripts/guardians/out/), so running the script
again only waits for and downloads what already exists: it never pays twice. A request whose sending could not be
confirmed (the connection broke after it left) is left alone and named; it is sent again only when asked by name
(`--redraw` for a view; for a Meshy task, find it on Meshy and put its task_id in the receipt). A redrawn view keeps
the one it replaces beside it (left-1.png and left-1.json), so the receipts count every image paid for.

Results: tpose/{front,left,back,right}.png, model-tpose.glb (the posed model) with model-tpose-<side>.png to look at,
rigged.glb, and animated.glb (the rigged model with one clip per action, each named by the action's key in Meshy's
library, as animations.json keeps them). After looking at a dog that came out right, add it to `rigged` in
scripts/guardians/models.json: `node frontend/scripts/guardians-normalize.mjs` then fits it to the village with its
skeleton and clips (named idle, cheer, wave and walk), and a dog left out keeps the model it was made as.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from dotenv import dotenv_values
from PIL import Image

from generate import ROOT, balance, waited, write

HERE = Path(__file__).resolve().parent
OUT = HERE / 'out'
MESHY = 'https://api.meshy.ai'
OPENAI = 'https://api.openai.com'
MODEL_ENDPOINT = '/openapi/v1/multi-image-to-3d'
RIG_ENDPOINT = '/openapi/v1/rigging'
ANIMATION_ENDPOINT = '/openapi/v1/animations'
PARALLEL = 6

VIEWS = ('front', 'left', 'back', 'right')
DRAWING = {'model': 'gpt-image-2.6-sunburst', 'size': '1024x1536', 'quality': 'high', 'output_format': 'png'}
# The views already show a figure in the round, in the pose the rig wants, so Meshy takes them as they are. A rig
# moves every vertex each frame, nine dogs at a time: the mesh stays light.
MODEL_SETTINGS = {'ai_model': 'latest', 'pose_mode': 't-pose', 'should_texture': True, 'enable_pbr': False,
                  'should_remesh': True, 'topology': 'triangle', 'target_polycount': 15000,
                  'image_enhancement': False, 'multi_view_thumbnails': True, 'target_formats': ['glb']}
# The rigged model stands a metre tall; the village sizes it anyway.
RIG_SETTINGS = {'height_meters': 1}
# One clip each, in one file and in this order: the library's id, its key there (which names the clip in the file), and
# what the village calls it.
ACTIONS = ((0, 'Idle', 'idle'), (298, 'Cheer_with_Both_Hands_Up', 'cheer'), (290, 'Wave_One_Hand', 'wave'),
           (30, 'Casual_Walk', 'walk'))

# Who each dog is, for the drawings: what it looks like, what it wears (kept) and what it holds (left out).
DOGS = {
    '01': ('a cream puppy whose face is framed by a white fleecy bonnet, with floppy light orange ears',
           'a light blue scarf', 'a blue snowflake'),
    '02': ('a white curly-haired bichon puppy, its head a cloud of white curls', 'a pink bow on top of its head',
           'a small white fluffy puppy'),
    '03': ('a black and white border collie puppy with big dark grey floppy ears, a white face and chest and a fluffy '
           'black and white tail', None, 'a blue frisbee with a white paw print'),
    '04': ('a cream and orange puppy in a green dinosaur costume: a green hood with a row of yellow spikes over the head '
           'and down the back, a green body and a green dinosaur tail', None, 'a bone'),
    '05': ('a beagle puppy with long brown floppy ears and brown patches', 'a dark purple-grey beret, and a brown '
           'leather satchel hanging at its left hip from a strap across its chest', 'a yellow maple leaf'),
    '06': ('a white poodle puppy covered all over in round fluffy white curls', 'a pink bow on its head', 'a pink heart'),
    '07': ('a fluffy white samoyed puppy with small pointed ears pink inside and a big fluffy white tail',
           'a light blue scarf', None),
    '08': ('a grey and white schnauzer puppy with dark grey floppy ears, big white bushy eyebrows, a white beard, a grey '
           'back and a grey tail', None, 'a chocolate bar'),
    '09': ('a cream puppy in an orange and white corgi hood with pointed ears and a little corgi face on top, and an '
           'orange and white tail', 'a green scarf with a round gold medal on it', None),
    '10': ('a cream puppy in an orange corgi hood with pointed ears and a white fluffy trim, winking with one eye shut, '
           'and an orange and white tail', 'a little yellow bag with a pink heart on it, on a lilac strap across its '
           'chest', None),
    '11': ('a cream puppy in a pale beige chihuahua hood with very big pointed ears pink inside, winking with one eye shut',
           'a small gold crown with a pink jewel on top of the hood', 'a pink heart'),
    '12': ('a cream and white cocker spaniel puppy with long curly golden orange ears like pigtails, winking with one '
           'eye shut', 'a pink bow on each ear', 'a pink tulip'),
    '13': ('a white and orange papillon puppy with very big fluffy orange ears, winking with one eye shut, and a white '
           'fluffy tail', 'a pink bow on each ear, and a big pink bow at its neck', None),
    '14': ('a beige pug puppy with dark brown floppy ears, a dark brown muzzle and dark brown paws', None,
           'a white mug with a brown paw print'),
    '15': ('a cream puppy in a fluffy beige woolly hood and coat of round curls, with small pointed ears',
           'a white daisy by its right ear', 'a little yellow chick'),
    '16': ('a pinkish brown poodle puppy with a cloud of curls on its head and big curly ears', 'a pink bow on each ear',
           'a small teddy bear'),
    '17': ('a cream puppy in a French bulldog hood, cream with grey patches, big upright ears pink inside and a little '
           'bulldog face on top, and a grey tail', 'a cream sweater with a brown letter B on the chest', 'a bone'),
    '18': ('a cream puppy in a grey and white husky hood with pointed ears pink inside and a white fluffy trim',
           'a blue scarf', None),
    '19': ('a cream puppy in a brown hood with long brown floppy ears, a brown body and a brown tail', None, 'a bone'),
    '20': ('a cream puppy in a white dalmatian hood with black spots and long spotted floppy ears, a white body and '
           'grey paws', 'a red scarf', None),
}

# The pose the views are drawn in: as the front view names it, as it describes the arms, as the later views recall it,
# and as a side view sees the near arm. The rig wants a T-pose; an A-pose is the fallback for a dog it cannot read.
POSES = {
    't-pose': ('a T-pose', 'both arms stretched straight out to the sides level with its shoulders', 'T-pose',
               'both arms stretched straight out from the shoulders',
               'stretched straight out from the shoulder, points at the camera and is seen end on'),
    'a-pose': ('an A-pose', 'both arms held straight and angled down and out from the shoulders, halfway between hanging '
               'and level, the paws well clear of the hips', 'A-pose',
               'both arms held straight and angled down and out from the shoulders',
               'angled down and out from the shoulder, is seen in front of its body'),
}
# The other fallback: limbs a little longer than drawn, for a rig that cannot find stubby ones.
LONGER = (' Make its arms and legs a third longer than drawn, so that they stand clear of the head and the body; the head, '
          'face and costume stay exactly as drawn.')

# The style the village's dogs are dressed in since 2026-11-17: each in a soft hoodie of its own colours.
HOODIE = (' Dress it in a cute, soft, slightly oversized hoodie sweatshirt with a kangaroo pocket and drawstrings, in '
          'pastel colours taken from the character itself; where the character already wears a costume hood, that hood '
          'is the hood of the hoodie, worn up; otherwise the hood is down behind its neck and its ears are free. Its '
          'sleeves cover its arms to the paws and the hoodie reaches its hips; its legs and feet show below. Keep the '
          'look sweet and round, like a plush toy.')

LOOK = ('Render it as a smooth matte 3D figure, like a soft vinyl toy painted in the flat colours of the drawing, '
        'softly and evenly lit: no black outlines, no cast shadow, no ground, no text, a plain pure white background. '
        'The whole figure in frame with a margin around it, centred, seen straight on by an orthographic camera at '
        'the height of its chest.')


def same(pose: str) -> str:
    _, _, name, arms, _ = POSES[pose]
    return (f'exactly the same character, model, proportions, colours and clothes as the front view, in the same {name} '
            f'with {arms} and both feet flat on the ground')


def prompt_of(item: str, view: str, pose: str = 't-pose', longer: bool = False, hoodie: bool = False) -> str:
    """What the image model is asked for, for one view of one dog."""
    looks, wears, holds = DOGS[item]
    named, arms, _, _, near = POSES[pose]
    keep = f', and what it wears: {wears}' if wears else ''
    empty = (f'It holds nothing: {holds}, which it holds in the drawing, is left out and its paws are open and empty.'
             if holds else 'It holds nothing: its paws are open and empty.')
    if view == 'front':
        return (f'A character turnaround for 3D modelling and rigging, FRONT VIEW, of the character in the image: '
                f'{looks}. Keep the character exactly as drawn: the same face and expression, eyes, blush, colours, '
                f'markings, ears, fur, hair or hood{keep}. {empty} Pose: {named}. It stands upright on two legs like a '
                f'little person, its body and face turned squarely to the camera, {arms}, the legs straight and a '
                f'little apart, both feet flat on the ground. Keep its chibi proportions, the same big round head and '
                f'small body as drawn, with the limbs clearly shaped: two arms reaching out from the shoulders below '
                f'the head, two short legs with feet, apart from each other and from the body.{LONGER if longer else ""}'
                f'{HOODIE if hoodie else ""} {LOOK}')
    references = ('The first image is the original drawing, the second the front view already made; any further '
                  'images are other views already made. ')
    if view == 'back':
        return (f'{references}Draw the same character turnaround, BACK VIEW: the figure of the front view seen from '
                f'directly behind, {same(pose)}. We see the back of its head or hood, its back and its tail, and nothing of '
                f'its face. Seen from behind its left arm is on the left of the picture and its right arm on the right, '
                f'and whatever it wears on one side shows on that side as seen from behind. {empty} {LOOK}')
    side, other = ('left', 'right') if view == 'left' else ('right', 'left')
    return (f'{references}Draw the same character turnaround, {side.upper()} SIDE VIEW: the figure of the front view '
            f'turned a quarter turn, {same(pose)}, so the camera sees its {side} side in a true profile. It faces the {side} '
            f'edge of the picture: we see one eye, the side of its face and snout in profile, its {side} ear, the side '
            f'of its body and its tail. The face is not turned toward the camera and there is no second face. Its '
            f'{side} arm, {near}; its {other} arm is hidden behind the body. Whatever it wears only on one side stays on that side, as in the '
            f'front view; the character is not mirrored. {empty} {LOOK}')


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def flattened(picture: Path) -> bytes:
    """The original picture on white: it is drawn on a transparent ground."""
    image = Image.open(picture).convert('RGBA')
    ground = Image.new('RGBA', image.size, (255, 255, 255, 255))
    ground.alpha_composite(image)
    buffer = io.BytesIO()
    ground.convert('RGB').save(buffer, format='PNG')
    return buffer.getvalue()


def archive(folder: Path, view: str) -> None:
    """Moves a view and its receipt aside, numbered, so a redraw starts afresh and the old one is still counted."""
    number = 1
    while (folder / f'{view}-{number}.json').exists() or (folder / f'{view}-{number}.png').exists():
        number += 1
    for suffix in ('.json', '.png'):
        current = folder / f'{view}{suffix}'
        if current.exists():
            current.replace(folder / f'{view}-{number}{suffix}')


def draw(client: httpx.Client, out: Path, item: str, picture: Path, view: str, pose: str = 't-pose',
         longer: bool = False, hoodie: bool = False) -> Path:
    """One view of the dog: the one already drawn, or a new one from the picture and the views before it."""
    folder = out / item / 'tpose'
    receipt = folder / f'{view}.json'
    image = folder / f'{view}.png'
    prompt = prompt_of(item, view, pose, longer, hoodie)
    if receipt.exists():
        task = json.loads(receipt.read_text(encoding='utf-8'))
        if task.get('status') == 'done' and image.exists() and digest(image) == task.get('image_sha256'):
            if task.get('prompt') != prompt:
                raise RuntimeError(f'{item}: the {view} view was drawn for another pose; give another --out to draw '
                                   f'this one')
            return image
        if task.get('status') != 'not_sent':
            raise RuntimeError(f'{item}: the {view} view may have been drawn and was not saved; '
                               f'--redraw {view} draws it again (and pays again)')
    earlier = [folder / f'{name}.png' for name in VIEWS[:VIEWS.index(view)]]
    if missing := [path.stem for path in earlier if not path.exists()]:
        raise RuntimeError(f'{item}: the {view} view is drawn after {", ".join(missing)}')
    references = [('picture.png', flattened(picture))] + [(path.name, path.read_bytes()) for path in earlier]
    task = {'id': item, 'view': view, **DRAWING, 'prompt': prompt, 'picture_sha256': digest(picture),
            'references': [hashlib.sha256(data).hexdigest() for _, data in references], 'status': 'uncertain'}
    write(receipt, task)
    try:
        response = client.post('/v1/images/edits', data={**DRAWING, 'prompt': prompt, 'n': '1'},
                               files=[('image[]', (name, data, 'image/png')) for name, data in references])
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
        # The connection never opened, so OpenAI cannot have received the request.
        write(receipt, {**task, 'status': 'not_sent'})
        raise
    if response.status_code >= 400:
        write(receipt, {**task, 'status': 'not_sent', 'http_status': response.status_code})
        raise RuntimeError(f'{item}: OpenAI refused the {view} view (HTTP {response.status_code}): {response.text[:300]}')
    body = response.json()
    encoded = ((body.get('data') or [{}])[0]).get('b64_json')
    if not encoded:
        raise RuntimeError(f'{item}: OpenAI answered without the {view} view; --redraw {view} draws it again')
    image.write_bytes(base64.b64decode(encoded))
    write(receipt, {**task, 'status': 'done', 'image_sha256': digest(image), 'usage': body.get('usage')})
    return image


def accepted_views(out: Path, item: str) -> list[Path]:
    """The four views, as they were when they were looked at and accepted."""
    folder = out / item / 'tpose'
    views = [folder / f'{view}.png' for view in VIEWS]
    acceptance = folder / 'accepted.json'
    if not acceptance.exists():
        raise RuntimeError(f'{item}: the views have not been accepted; look at them, then --accept')
    kept = json.loads(acceptance.read_text(encoding='utf-8'))
    if any(not view.exists() for view in views) or [digest(view) for view in views] != kept.get('views'):
        raise RuntimeError(f'{item}: the views changed after they were accepted; look at them, then --accept again')
    return views


def send(client: httpx.Client, receipt: Path, endpoint: str, task: dict, payload: dict, *, what: str) -> dict:
    """A Meshy task: the one already accepted, or a new one. Raises for one whose sending is uncertain.

    `task` is what the receipt keeps (what the task is made from and how); `payload` is what is sent."""
    if receipt.exists():
        kept = json.loads(receipt.read_text(encoding='utf-8'))
        if kept.get('task_id'):
            if any(kept.get(key) != value for key, value in task.items()):
                raise RuntimeError(f'{task["id"]}: the {what} task was made from other inputs or settings; give another '
                                   f'--out to make it again')
            return kept
        if kept.get('status') != 'not_sent':
            raise RuntimeError(f'{task["id"]}: a {what} task may have been sent and its ID was not saved; find it on '
                               f'Meshy, put it in {receipt.parent.name}/{receipt.name} as task_id, and run again')
    task = {**task, 'status': 'uncertain'}
    write(receipt, task)
    try:
        response = client.post(endpoint, json=payload)
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
        write(receipt, {**task, 'status': 'not_sent'})
        raise
    if response.status_code >= 400:
        # Meshy answered that it did not take the task (a 422 from rigging: the pose could not be read; not charged).
        write(receipt, {**task, 'status': 'not_sent', 'http_status': response.status_code, 'error': response.text[:500]})
        raise RuntimeError(f'{task["id"]}: Meshy refused the {what} task (HTTP {response.status_code}): {response.text[:300]}')
    task_id = response.json().get('result')
    if not isinstance(task_id, str) or not task_id:
        raise RuntimeError(f'{task["id"]}: Meshy accepted the {what} task without an ID; find it on Meshy before sending again')
    task.update(task_id=task_id, status='PENDING')
    write(receipt, task)
    return task


def fetch(url: str, path: Path) -> None:
    with httpx.Client(timeout=300, follow_redirects=True) as plain:
        path.write_bytes(plain.get(url).raise_for_status().content)


def finished(client: httpx.Client, receipt: Path, endpoint: str, task: dict, files: dict[str, Path], urls_of,
             previews: dict[str, Path] | None = None) -> dict:
    """Waits for the task and downloads what it made: `urls_of(state)` gives a URL for each name in `files`, and for
    those of `previews` it has (pictures to look at, which a task may come without)."""
    if task.get('status') == 'SUCCEEDED' and all(path.exists() for path in files.values()):
        return task
    state = waited(client, endpoint, receipt, task)
    urls = urls_of(state)
    for name, path in files.items():
        if not urls.get(name):
            raise RuntimeError(f'{task["id"]}: the finished task has no {name}')
        fetch(urls[name], path)
    for name, path in (previews or {}).items():
        if urls.get(name):
            fetch(urls[name], path)
    task.update(credits=state.get('consumed_credits'),
                files={name: {'sha256': digest(path), 'bytes': path.stat().st_size} for name, path in files.items()})
    write(receipt, task)
    return task


def model(client: httpx.Client, out: Path, item: str, pose: str = 't-pose') -> dict:
    """The posed model, made from the accepted views, the front first."""
    folder = out / item
    views = accepted_views(out, item)
    settings = {**MODEL_SETTINGS, 'pose_mode': pose}
    task = {'id': item, 'views': [digest(view) for view in views], 'settings': settings}
    uris = ['data:image/png;base64,' + base64.b64encode(view.read_bytes()).decode() for view in views]
    task = send(client, folder / 'task-tpose.json', MODEL_ENDPOINT, task, {'image_urls': uris, **settings},
                what='model')
    previews = {side: folder / f'model-tpose-{side}.png' for side in VIEWS}

    def urls_of(state: dict) -> dict:
        return {'glb': (state.get('model_urls') or {}).get('glb'), **(state.get('thumbnail_urls') or {})}

    return finished(client, folder / 'task-tpose.json', MODEL_ENDPOINT, task, {'glb': folder / 'model-tpose.glb'},
                    urls_of, previews)


def rig(client: httpx.Client, out: Path, item: str, model_task: dict) -> dict:
    folder = out / item
    task = {'id': item, 'input_task_id': model_task['task_id'], 'settings': RIG_SETTINGS}
    task = send(client, folder / 'rig.json', RIG_ENDPOINT, task, {'input_task_id': model_task['task_id'], **RIG_SETTINGS},
                what='rigging')
    return finished(client, folder / 'rig.json', RIG_ENDPOINT, task, {'glb': folder / 'rigged.glb'},
                    lambda state: {'glb': (state.get('result') or {}).get('rigged_character_glb_url')})


def checked_actions(client: httpx.Client) -> None:
    """The library still has the chosen actions under the chosen keys (it is free to ask)."""
    ids = ','.join(str(action) for action, _, _ in ACTIONS)
    response = client.get(f'{ANIMATION_ENDPOINT}/library', params={'action_ids': ids})
    response.raise_for_status()
    keys = {entry['action_id']: entry['key'] for entry in response.json()}
    wrong = [f'{action} {key}' for action, key, _ in ACTIONS if keys.get(action) != key]
    if wrong:
        raise RuntimeError(f'the animation library changed: {", ".join(wrong)} is not there as named')


def animate(client: httpx.Client, out: Path, item: str, rig_task: dict) -> dict:
    folder = out / item
    actions = [{'action_id': action, 'key': key, 'clip': clip} for action, key, clip in ACTIONS]
    task = {'id': item, 'rig_task_id': rig_task['task_id'], 'actions': actions}
    payload = {'rig_task_id': rig_task['task_id'], 'action_ids': [action for action, _, _ in ACTIONS]}
    task = send(client, folder / 'animations.json', ANIMATION_ENDPOINT, task, payload, what='animation')
    return finished(client, folder / 'animations.json', ANIMATION_ENDPOINT, task, {'glb': folder / 'animated.glb'},
                    lambda state: {'glb': (state.get('result') or {}).get('animation_glb_url')})


def spent(out: Path) -> tuple[int, int]:
    """Images paid for (drawn, or sent and not confirmed) and Meshy credits recorded, from every receipt under `out`."""
    images = 0
    credits = 0
    for receipt in out.glob('*/tpose/*.json'):
        if receipt.name != 'accepted.json':
            images += json.loads(receipt.read_text(encoding='utf-8')).get('status') in ('done', 'uncertain')
    for name in ('task-tpose.json', 'rig.json', 'animations.json'):
        for receipt in out.glob(f'*/{name}'):
            credits += json.loads(receipt.read_text(encoding='utf-8')).get('credits') or 0
    return images, credits


def sheet(out: Path, refs: Path, items: list[str], path: Path) -> None:
    """Each dog on a row: its picture, then its four views."""
    cell = (256, 384)
    board = Image.new('RGB', (cell[0] * 5, cell[1] * len(items)), 'white')
    for row, item in enumerate(items):
        pictures = [refs / f'{item}.png'] + [out / item / 'tpose' / f'{view}.png' for view in VIEWS]
        for column, picture in enumerate(pictures):
            if not picture.exists():
                continue
            image = Image.open(io.BytesIO(flattened(picture)))
            image.thumbnail(cell)
            board.paste(image, (column * cell[0] + (cell[0] - image.width) // 2, row * cell[1] + (cell[1] - image.height) // 2))
    board.save(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--refs', type=Path, default=ROOT / '.data/characters/refs')
    parser.add_argument('--only', nargs='+', default=[])
    parser.add_argument('--all', action='store_true')
    parser.add_argument('--out', type=Path, default=OUT)
    parser.add_argument('--balance', action='store_true', help='print what is left and what was spent, and stop')
    parser.add_argument('--draw', action='store_true', help='draw the views still missing, and stop')
    parser.add_argument('--redraw', nargs='+', choices=VIEWS, default=[], help='draw these views again, and stop')
    parser.add_argument('--accept', action='store_true', help='keep the views as they are now')
    parser.add_argument('--sheet', type=Path, help='write the pictures and views to one image, and stop')
    parser.add_argument('--pose', choices=tuple(POSES), default='t-pose',
                        help='the pose the views are drawn and modelled in (an A-pose for a dog the rig cannot read)')
    parser.add_argument('--longer', action='store_true', help='draw the arms and legs a third longer than drawn')
    parser.add_argument('--hoodie', action='store_true', help='dress the dog in a hoodie of its own colours')
    args = parser.parse_args()
    keys = dotenv_values(ROOT / 'backend/.env')
    meshy_key = (keys.get('MESHY_API_KEY') or '').strip()
    openai_key = (keys.get('OPENAI_API_KEY') or '').strip()
    if not meshy_key or not openai_key:
        print('MESHY_API_KEY and OPENAI_API_KEY must be set in backend/.env', file=sys.stderr)
        return 2
    meshy = httpx.Client(base_url=MESHY, headers={'Authorization': 'Bearer ' + meshy_key},
                         timeout=httpx.Timeout(120, connect=15))
    openai = httpx.Client(base_url=OPENAI, headers={'Authorization': 'Bearer ' + openai_key},
                          timeout=httpx.Timeout(600, connect=15))
    with meshy, openai:
        before = balance(meshy)
        images, credits = spent(args.out)
        print(f'Meshy balance: {before}; receipts under {args.out.name}/: {images} images drawn, {credits} credits')
        if args.balance:
            return 0
        known = sorted(path.stem for path in args.refs.glob('*.png') if path.stem in DOGS)
        items = [item for item in known if args.all or item in args.only]
        missing = sorted(set(args.only) - set(items))
        if missing or not items:
            print(f'no picture for: {", ".join(missing) or "(nothing asked: --only <ids> or --all)"}', file=sys.stderr)
            return 2
        if args.sheet:
            sheet(args.out, args.refs, items, args.sheet)
            print(f'wrote {args.sheet}')
            return 0
        if args.accept:
            for item in items:
                views = [args.out / item / 'tpose' / f'{view}.png' for view in VIEWS]
                if absent := [view.stem for view in views if not view.exists()]:
                    print(f'FAIL {item}: no {", ".join(absent)} view yet', file=sys.stderr)
                    continue
                write(args.out / item / 'tpose' / 'accepted.json', {'id': item, 'views': [digest(view) for view in views]})
                print(f'ok   {item}: views accepted')
            return 0
        if not args.draw and not args.redraw:
            checked_actions(meshy)

        def run(item: str) -> str:
            picture = args.refs / f'{item}.png'
            try:
                if args.redraw:
                    for view in args.redraw:
                        archive(args.out / item / 'tpose', view)
                    for view in args.redraw:
                        draw(openai, args.out, item, picture, view, args.pose, args.longer, args.hoodie)
                    return f'ok   {item}: redrew {", ".join(args.redraw)}'
                if args.draw:
                    for view in VIEWS:
                        draw(openai, args.out, item, picture, view, args.pose, args.longer, args.hoodie)
                    return f'ok   {item}: views drawn'
                made = model(meshy, args.out, item, args.pose)
                rigged = rig(meshy, args.out, item, made)
                animated = animate(meshy, args.out, item, rigged)
                size = animated['files']['glb']['bytes'] / 1e6
                return f'ok   {item}: {size:.2f} MB  model {made["task_id"]}  rig {rigged["task_id"]}  animations {animated["task_id"]}'
            except Exception as problem:  # one dog failing leaves the others to finish
                return f'FAIL {item}: {problem}'

        with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
            lines = list(pool.map(run, items))
        print('\n'.join(lines))
        after = balance(meshy)
        images, credits = spent(args.out)
        change = f' (spent {before - after:g})' if isinstance(before, (int, float)) and isinstance(after, (int, float)) else ''
        print(f'Meshy balance: {after}{change}; receipts under {args.out.name}/: {images} images drawn, {credits} credits')
        return 1 if any(line.startswith('FAIL') for line in lines) else 0


if __name__ == '__main__':
    sys.exit(main())
