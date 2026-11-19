"""The receipts of scripts/guardians/rig.py: a paid request is written down before it goes, and nothing is paid twice.

Nothing here reaches OpenAI or Meshy: the clients answer from a mock transport. Run it from the repo root:

    uv run pytest scripts/guardians/test_rig.py
"""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path

import httpx
import pytest
from PIL import Image

import rig


def png(colour: tuple[int, int, int, int] = (255, 140, 0, 255)) -> bytes:
    buffer = io.BytesIO()
    Image.new('RGBA', (8, 12), colour).save(buffer, format='PNG')
    return buffer.getvalue()


def receipt(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


@pytest.fixture
def picture(tmp_path: Path) -> Path:
    path = tmp_path / 'refs' / '09.png'
    path.parent.mkdir()
    path.write_bytes(png((0, 0, 0, 0)))
    return path


class OpenAI:
    """Answers image edits with a drawn picture, noting each request and what the receipt said while it was out."""

    def __init__(self, out: Path, answer: int = 200):
        self.out = out
        self.answer = answer
        self.requests: list[httpx.Request] = []
        self.while_out: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        for path in sorted((self.out / '09' / 'tpose').glob('*.json')):
            self.while_out.append(f"{path.stem} {receipt(path)['status']}")
        if self.answer >= 400:
            return httpx.Response(self.answer, json={'error': {'message': 'no'}})
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(png()).decode()}], 'usage': {'total_tokens': 7}})


def client(handler, base: str = rig.OPENAI) -> httpx.Client:
    return httpx.Client(base_url=base, transport=httpx.MockTransport(handler))


def test_a_view_is_written_down_before_it_is_asked_for_and_never_paid_for_twice(tmp_path: Path, picture: Path):
    out = tmp_path / 'out'
    openai = OpenAI(out)
    with client(openai) as http:
        front = rig.draw(http, out, '09', picture, 'front')
        assert openai.while_out == ['front uncertain']
        kept = receipt(out / '09' / 'tpose' / 'front.json')
        assert kept['status'] == 'done' and kept['image_sha256'] == rig.digest(front) and kept['usage'] == {'total_tokens': 7}
        assert kept['prompt'] == rig.prompt_of('09', 'front') and kept['model'] == rig.DRAWING['model']
        # Drawn already: nothing is sent.
        assert rig.draw(http, out, '09', picture, 'front') == front
        assert len(openai.requests) == 1
        # The left view is drawn from the picture and the front view.
        rig.draw(http, out, '09', picture, 'left')
        assert openai.requests[1].content.count(b'name="image[]"') == 2
        assert len(receipt(out / '09' / 'tpose' / 'left.json')['references']) == 2


def test_a_view_whose_answer_never_came_is_not_sent_again_unless_redrawn(tmp_path: Path, picture: Path):
    out = tmp_path / 'out'
    folder = out / '09' / 'tpose'
    folder.mkdir(parents=True)
    (folder / 'front.json').write_text(json.dumps({'id': '09', 'view': 'front', 'status': 'uncertain'}), encoding='utf-8')
    openai = OpenAI(out)
    with client(openai) as http:
        with pytest.raises(RuntimeError, match='may have been drawn'):
            rig.draw(http, out, '09', picture, 'front')
        assert openai.requests == []
        # Asked by name: the uncertain one is kept aside, still counted, and the view is drawn again.
        rig.archive(folder, 'front')
        rig.draw(http, out, '09', picture, 'front')
    assert receipt(folder / 'front-1.json')['status'] == 'uncertain'
    assert receipt(folder / 'front.json')['status'] == 'done'
    assert rig.spent(out) == (2, 0)


def test_a_refused_or_unsent_view_may_be_asked_for_again(tmp_path: Path, picture: Path):
    out = tmp_path / 'out'
    with client(OpenAI(out, answer=400)) as http, pytest.raises(RuntimeError, match='refused'):
        rig.draw(http, out, '09', picture, 'front')
    assert receipt(out / '09' / 'tpose' / 'front.json')['status'] == 'not_sent'

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError('no route', request=request)

    with client(unreachable) as http, pytest.raises(httpx.ConnectError):
        rig.draw(http, out, '09', picture, 'front')
    assert receipt(out / '09' / 'tpose' / 'front.json')['status'] == 'not_sent'
    openai = OpenAI(out)
    with client(openai) as http:
        rig.draw(http, out, '09', picture, 'front')
    assert len(openai.requests) == 1
    assert rig.spent(out) == (1, 0)


def test_a_view_drawn_for_one_pose_is_not_taken_for_another(tmp_path: Path, picture: Path):
    out = tmp_path / 'out'
    openai = OpenAI(out)
    with client(openai) as http:
        rig.draw(http, out, '09', picture, 'front')
        with pytest.raises(RuntimeError, match='another pose'):
            rig.draw(http, out, '09', picture, 'front', 'a-pose')
        with pytest.raises(RuntimeError, match='another pose'):
            rig.draw(http, out, '09', picture, 'front', longer=True)
    assert len(openai.requests) == 1
    # The T-pose is asked for in words the A-pose and the longer limbs only add to or replace.
    assert 'Pose: a T-pose.' in rig.prompt_of('09', 'front')
    assert 'Pose: an A-pose.' in rig.prompt_of('09', 'front', 'a-pose')
    assert rig.LONGER.strip() in rig.prompt_of('09', 'front', longer=True)
    assert rig.LONGER.strip() not in rig.prompt_of('09', 'front')


def test_views_go_to_meshy_only_as_they_were_accepted(tmp_path: Path):
    out = tmp_path / 'out'
    folder = out / '09' / 'tpose'
    folder.mkdir(parents=True)
    for view in rig.VIEWS:
        (folder / f'{view}.png').write_bytes(png())
    with pytest.raises(RuntimeError, match='not been accepted'):
        rig.accepted_views(out, '09')
    rig.write(folder / 'accepted.json', {'id': '09', 'views': [rig.digest(folder / f'{view}.png') for view in rig.VIEWS]})
    assert [path.stem for path in rig.accepted_views(out, '09')] == list(rig.VIEWS)
    (folder / 'left.png').write_bytes(png((1, 2, 3, 255)))
    with pytest.raises(RuntimeError, match='changed after'):
        rig.accepted_views(out, '09')


class Meshy:
    """Answers task requests with a task ID, or with `answer`, noting what the receipt said while each was out."""

    def __init__(self, receipt_path: Path, answer: int = 202):
        self.path = receipt_path
        self.answer = answer
        self.requests: list[httpx.Request] = []
        self.while_out: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        self.while_out.append(receipt(self.path)['status'])
        if self.answer >= 400:
            return httpx.Response(self.answer, json={'message': 'Pose estimation failed'})
        return httpx.Response(self.answer, json={'result': f'task-{len(self.requests)}'})


def test_a_meshy_task_is_written_down_before_it_goes_and_never_paid_for_twice(tmp_path: Path):
    path = tmp_path / '09' / 'rig.json'
    meshy = Meshy(path)
    task = {'id': '09', 'input_task_id': 'model-1', 'settings': rig.RIG_SETTINGS}
    with client(meshy, rig.MESHY) as http:
        sent = rig.send(http, path, rig.RIG_ENDPOINT, task, {'input_task_id': 'model-1', **rig.RIG_SETTINGS}, what='rigging')
        assert meshy.while_out == ['uncertain']
        assert sent['task_id'] == 'task-1' and receipt(path)['status'] == 'PENDING'
        assert json.loads(meshy.requests[0].content) == {'input_task_id': 'model-1', 'height_meters': 1}
        # Sent already: the same task comes back and nothing is sent.
        assert rig.send(http, path, rig.RIG_ENDPOINT, task, {}, what='rigging')['task_id'] == 'task-1'
        assert len(meshy.requests) == 1
        # Asked for from other inputs, it is not taken for the one already made.
        with pytest.raises(RuntimeError, match='other inputs'):
            rig.send(http, path, rig.RIG_ENDPOINT, {**task, 'input_task_id': 'model-2'}, {}, what='rigging')
        assert len(meshy.requests) == 1


def test_a_meshy_task_whose_answer_never_came_is_left_alone(tmp_path: Path):
    path = tmp_path / '09' / 'task-tpose.json'
    rig.write(path, {'id': '09', 'status': 'uncertain'})
    meshy = Meshy(path)
    with client(meshy, rig.MESHY) as http, pytest.raises(RuntimeError, match='may have been sent'):
        rig.send(http, path, rig.MODEL_ENDPOINT, {'id': '09'}, {}, what='model')
    assert meshy.requests == []


def test_a_rig_that_cannot_read_the_pose_is_written_down_as_not_sent(tmp_path: Path):
    path = tmp_path / '09' / 'rig.json'
    task = {'id': '09', 'input_task_id': 'model-1', 'settings': rig.RIG_SETTINGS}
    rig.write(path, {**task, 'status': 'not_sent'})
    with client(Meshy(path, answer=422), rig.MESHY) as http, pytest.raises(RuntimeError, match='HTTP 422'):
        rig.send(http, path, rig.RIG_ENDPOINT, task, {}, what='rigging')
    kept = receipt(path)
    assert kept['status'] == 'not_sent' and kept['http_status'] == 422 and 'Pose estimation' in kept['error']


def test_the_animations_are_asked_for_in_one_task_with_their_clips_written_down(tmp_path: Path):
    out = tmp_path / 'out'
    meshy = Meshy(out / '09' / 'animations.json')

    def answer(request: httpx.Request) -> httpx.Response:
        if request.method == 'POST':
            return meshy(request)
        assert request.url.path.endswith('/task-1')
        return httpx.Response(200, json={'status': 'SUCCEEDED', 'consumed_credits': 12,
                                         'result': {'animation_glb_url': 'https://assets.meshy.example/animated.glb'}})

    downloads: list[str] = []
    fetch = rig.fetch
    rig.fetch = lambda url, path: (downloads.append(url), path.write_bytes(b'glTF'))
    try:
        with client(answer, rig.MESHY) as http:
            done = rig.animate(http, out, '09', {'task_id': 'rig-1'})
    finally:
        rig.fetch = fetch
    assert json.loads(meshy.requests[0].content) == {'rig_task_id': 'rig-1', 'action_ids': [action for action, _, _ in rig.ACTIONS]}
    kept = receipt(out / '09' / 'animations.json')
    assert [(action['key'], action['clip']) for action in kept['actions']] == [(key, clip) for _, key, clip in rig.ACTIONS]
    assert ('Idle', 'idle') in [(action['key'], action['clip']) for action in kept['actions']]
    assert done['status'] == 'SUCCEEDED' and kept['credits'] == 12 and downloads == ['https://assets.meshy.example/animated.glb']
    assert rig.spent(out) == (0, 12)
