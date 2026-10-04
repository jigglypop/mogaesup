"""Paid garment tools of the local studio MCP, against a fake gateway: opt-in, SinglePart payloads, keys and the queue."""
import asyncio
import hashlib
import json
import os
import re
import sys
from pathlib import Path

import httpx
import pytest

from src.studio_garments import (MAX_IN_FLIGHT, SINGLE_PART, STATE_DIR, GarmentRequest, GarmentStudio, cli, design_id,
                                 garment_spec, load_catalog, single_part_request)
from src.studio_mcp import StudioClient, build_server, main

SESSION = 'a'*64
BODY = 'b'*24
VERSION = 'c'*24
SEALED = 'f'*24
REPO = Path(__file__).resolve().parents[3]
STUDIO_UI = REPO/'frontend'/'src'/'character'/'studio'
CATALOG = json.loads((STUDIO_UI/'garment-styles.json').read_text(encoding='utf-8'))
DESIGNS = {design_id(item['slot'], item['name']): item for item in CATALOG['garments']}
BLOUSON = design_id('top', '오트밀 유틸리티 블루종')
SKIRT = design_id('bottom', '데님 롱 스커트')
SNEAKERS = design_id('shoes', '파스텔 청키 스니커즈')
BUCKET_HAT = design_id('hat', '파스텔 버킷햇')
HOODIE = design_id('top', '버터 옐로 오버핏 후드티')
JOGGERS = design_id('bottom', '그레이 조거 팬츠')
GARMENT_TOOLS = {'list_garment_options', 'start_garment', 'get_garment_job', 'enqueue_garments', 'get_garment_queue',
                 'advance_garment_queue', 'resolve_garment_item'}


def ts_object(source, name):
    """A plain object literal of the studio's TypeScript (`const name ... = {...};`) as JSON."""
    found = re.search(r'const '+name+r'\b[^=]*=\s*(\{.*?\});', source, re.S)
    assert found, f'{name} is no longer a plain object literal; compare it with studio_garments.py by hand'
    text = re.sub(r'([{,]\s*)([A-Za-z_]\w*)\s*:', r'\1"\2":', found.group(1)).replace("'", '"')
    return json.loads(re.sub(r',\s*}', '}', text))


MESHY_OPTIONS_TS = (STUDIO_UI/'meshy-options.ts').read_text(encoding='utf-8')
SCREEN_DEFAULTS = ts_object(MESHY_OPTIONS_TS, 'defaultMeshyOptions')
SCREEN_POLYCOUNT = ts_object(MESHY_OPTIONS_TS, 'partPolycount')


def meshy(slot):
    """meshyDefaultsFor(slot) of meshy-options.ts: what SinglePart sends until someone edits the Meshy settings."""
    return {**SCREEN_DEFAULTS, 'target_polycount': SCREEN_POLYCOUNT[slot]}


class FakeGateway:
    """The Rust gateway and the character server behind it, as far as garments go: single-part jobs kept per
    Idempotency-Key (a replay gets the job its key made), the wardrobe bodies and the parts listing."""

    def __init__(self):
        self.requests = []
        self.jobs = {}
        self.keys = {}
        self.created = 0
        self.ready_version = VERSION
        self.listed = {}
        self.post_answers = []

    def handler(self, request):
        self.requests.append(request)
        path = request.url.path
        if request.method == 'POST' and path == SINGLE_PART:
            return self.single_part(request)
        if request.method != 'GET':
            return httpx.Response(405, json={'code': 'not_found', 'message': '찾을 수 없습니다.'})
        if path == '/api/avatar-factory/wardrobe/bodies':
            return httpx.Response(200, json={'revision': 'r1', 'default': {'job_id': BODY, 'version': VERSION}, 'bodies': [
                {'job_id': BODY, 'version': VERSION, 'name': '모개', 'body_type': 'female', 'is_default': True, 'part_jobs': 0}]})
        if path == f'/api/avatar-factory/jobs/{BODY}':
            return httpx.Response(200, json={'id': BODY, 'status': 'review_required', 'ready_version': self.ready_version})
        if path == f'/api/avatar-factory/wardrobe/bodies/{BODY}/parts':
            def rows(kind):
                return [{'job_id': job_id, 'version': job['ready_version'], 'slot': job['requested_slots'][0],
                         'name': job['part_name'], **({'sha256': 'e'*64} if kind == 'parts' else {'reason': 'needs_anchors'})}
                        for job_id, job in self.jobs.items() if self.listed.get(job_id) == kind]
            return httpx.Response(200, json={'body': {'job_id': BODY, 'version': VERSION}, 'parts': rows('parts'),
                                             'unavailable': rows('unavailable')})
        found = re.fullmatch(r'/api/avatar-factory/jobs/([a-f0-9]{24})', path)
        if found and found.group(1) in self.jobs:
            return httpx.Response(200, json=self.jobs[found.group(1)])
        return httpx.Response(404, json={'error': {'code': 'not_found', 'message': '생산 작업을 찾을 수 없습니다.'}})

    def single_part(self, request):
        key, body = request.headers['idempotency-key'], json.loads(request.content)
        if self.post_answers:
            answer = self.post_answers.pop(0)
            if answer == 'lost':  # The studio took it and the answer never came back.
                self.accept(key, body)
                raise httpx.ReadTimeout('connection lost', request=request)
            return httpx.Response(answer[0], json=answer[1])
        job = self.accept(key, body)
        if job is None:
            return httpx.Response(409, json={'error': {'code': 'idempotency_conflict', 'message': '입력이 변경되었습니다.'}})
        return httpx.Response(202, json=job)

    def accept(self, key, body):
        fingerprint = json.dumps(body, sort_keys=True)
        if key in self.keys:
            saved, job_id = self.keys[key]
            return self.jobs[job_id] if saved == fingerprint else None
        job_id = hashlib.sha256(key.encode()).hexdigest()[:24]
        self.keys[key] = fingerprint, job_id
        self.created += 1
        self.jobs[job_id] = {'id': job_id, 'status': 'pipeline_queued', 'base_job_id': body['base_job_id'],
                             'base_version': body['base_version'], 'requested_slots': [body['slot']],
                             'part_name': body['part_name'], 'ready_version': None,
                             'character_flow': {'status': 'running', 'stage': 'images', 'busy': True, 'message': '생성 중'}}
        return self.jobs[job_id]

    def finish(self, job_id, listed='parts'):
        self.jobs[job_id].update(status='review_required', ready_version=SEALED, character_flow={
            'status': 'review_required', 'stage': 'complete', 'busy': False, 'message': '조립 완료'})
        self.listed[job_id] = listed

    def finish_all(self):
        for job_id, job in self.jobs.items():
            if job['ready_version'] is None:
                self.finish(job_id)

    def posts(self):
        return [request for request in self.requests if request.method == 'POST']


@pytest.fixture
def gateway():
    return FakeGateway()


def make_studio(gateway, directory, *, writable=True, paid=True):
    client = StudioClient('http://127.0.0.1:8080', SESSION, app_origin='http://localhost:5173', writable=writable,
                          paid=paid, transport=httpx.MockTransport(gateway.handler))
    return GarmentStudio(client, state_dir=directory)


@pytest.fixture
def studio(gateway, tmp_path):
    studio = make_studio(gateway, tmp_path)
    yield studio
    studio.client.close()


def designed(*identifiers):
    return [{'body_job_id': BODY, 'design_id': identifier} for identifier in identifiers]


def items(studio):
    return {item['item']: item for item in studio.queue()['data']['items']}


# Opt-in ---------------------------------------------------------------------

@pytest.mark.parametrize('writable, paid', [(False, False), (True, False), (False, True)])
def test_paid_garment_tools_are_absent_without_both_flags(gateway, tmp_path, writable, paid):
    pytest.importorskip('mcp')
    studio = make_studio(gateway, tmp_path, writable=writable, paid=paid)
    try:
        names = {tool.name for tool in asyncio.run(build_server(studio.client, studio).list_tools())}
        assert not names & GARMENT_TOOLS and len(names) == 12
        assert studio.start(designed(BLOUSON)[0], 'start-key-0001') == {'ok': False, 'error': {'code': 'mcp_paid_off'}}
        assert studio.enqueue(designed(BLOUSON), 'enqueue-key-01')['error']['code'] == 'mcp_paid_off'
        assert studio.advance(3, 'advance-key-01')['error']['code'] == 'mcp_paid_off'
        assert gateway.requests == [] and not list(tmp_path.iterdir())
    finally:
        studio.client.close()


def test_paid_garment_tools_are_listed_with_both_flags(studio, gateway):
    pytest.importorskip('mcp')
    tools = {tool.name: tool for tool in asyncio.run(build_server(studio.client, studio).list_tools())}
    assert GARMENT_TOOLS <= set(tools) and len(tools) == 12+len(GARMENT_TOOLS)
    assert all(tools[name].outputSchema for name in GARMENT_TOOLS)
    for name in ('start_garment', 'advance_garment_queue', 'resolve_garment_item'):
        assert tools[name].annotations.openWorldHint and not tools[name].annotations.readOnlyHint
        assert tools[name].inputSchema['properties']['idempotency_key']['pattern'] == '^[a-zA-Z0-9_-]{8,100}$'
    assert tools['advance_garment_queue'].inputSchema['properties']['max_new']['maximum'] == 3
    assert all(tools[name].annotations.readOnlyHint for name in ('list_garment_options', 'get_garment_job', 'get_garment_queue'))
    assert gateway.requests == []


@pytest.mark.parametrize('paid, count', [('1', 12+len(GARMENT_TOOLS)), ('0', 12)])
def test_local_stdio_lists_paid_tools_only_when_paid_is_set_too(paid, count):
    pytest.importorskip('mcp')
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    async def check():
        params = StdioServerParameters(command=sys.executable, args=['-m', 'src.studio_mcp'],
            env={**os.environ, 'MOGA_STUDIO_API_URL': 'http://127.0.0.1:1', 'MOGA_STUDIO_SESSION': SESSION,
                 'MOGA_STUDIO_MCP_WRITE': '1', 'MOGA_STUDIO_MCP_PAID': paid})
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.list_tools()
                assert len(result.tools) == count
                assert SESSION not in result.model_dump_json()
    asyncio.run(check())


# The request SinglePart.tsx sends ---------------------------------------------

def test_python_mirror_matches_the_studio_screen_sources():
    from src.studio_garments import _MESHY_DEFAULTS, _METHODS, _POLYCOUNT
    assert _MESHY_DEFAULTS == SCREEN_DEFAULTS
    assert _POLYCOUNT == {slot: SCREEN_POLYCOUNT[slot] for slot in _POLYCOUNT}
    screen = (STUDIO_UI/'SinglePart.tsx').read_text(encoding='utf-8')
    methods = re.search(r'const methodOptions\b[^=]*=\s*\{(.*?)\};', screen, re.S)
    assert methods and dict(re.findall(r"(\w+): \[\['(\w+)'", methods.group(1))) == _METHODS
    assert "revision: 'garment-fit-v1'" in (STUDIO_UI/'garment-fit.ts').read_text(encoding='utf-8')


def test_designed_garments_are_sent_as_single_part_sends_a_chosen_style():
    style = CATALOG['style']
    blouson, skirt = DESIGNS[BLOUSON], DESIGNS[SKIRT]
    request = lambda identifier: single_part_request(
        garment_spec(GarmentRequest(body_job_id=BODY, design_id=identifier), *load_catalog()), BODY, VERSION)
    common = {'base_job_id': BODY, 'base_version': VERSION, 'hair_length': 'source', 'view_mode': 'front_side_back'}
    assert request(BLOUSON) == {**common, 'slot': 'top', 'bottom_kind': 'source',
        'fit_profile': {'revision': 'garment-fit-v1', 'sleeve': 'source', 'ease': 'source'},
        'meshy_options': meshy('top'), 'part_method': 'worn', 'part_name': '오트밀 유틸리티 블루종',
        'description': f"{blouson['brief']} {style}"}
    assert request(SKIRT) == {**common, 'slot': 'bottom', 'bottom_kind': 'skirt',
        'fit_profile': {'revision': 'garment-fit-v1', 'kind': 'skirt', 'ease': 'source'},
        'meshy_options': meshy('bottom'), 'part_method': 'worn', 'part_name': '데님 롱 스커트',
        'description': f"{skirt['brief']} {style}"}
    for identifier, slot in ((SNEAKERS, 'shoes'), (BUCKET_HAT, 'hat')):
        assert request(identifier) == {**common, 'slot': slot, 'bottom_kind': 'source', 'meshy_options': meshy(slot),
            'part_name': DESIGNS[identifier]['name'], 'description': f"{DESIGNS[identifier]['brief']} {style}"}
    # Every designed garment is a request the character server's own input model takes as it is.
    from src.api.avatar_factory import SinglePartVariantInput
    for identifier in DESIGNS:
        sent = request(identifier)
        assert SinglePartVariantInput.model_validate(sent).model_dump(exclude_unset=True) == sent


def test_briefs_keep_the_screen_defaults_with_their_slot_choices():
    style = CATALOG['style']
    hair = single_part_request(garment_spec(GarmentRequest(body_job_id=BODY, slot='hair', name='단발 보브',
        brief='Short fluffy bob with soft straight bangs', hair_length='short'), *load_catalog()), BODY, VERSION)
    assert hair == {'base_job_id': BODY, 'base_version': VERSION, 'slot': 'hair', 'hair_length': 'short',
                    'bottom_kind': 'source', 'view_mode': 'front_side_back', 'meshy_options': meshy('hair'),
                    'part_method': 'worn', 'part_name': '단발 보브',
                    'description': f'Short fluffy bob with soft straight bangs {style}'}
    glasses = single_part_request(garment_spec(GarmentRequest(body_job_id=BODY, slot='glasses', name='동그란 안경',
        brief='Round thin gold wire glasses'), *load_catalog()), BODY, VERSION)
    assert 'part_method' not in glasses and 'fit_profile' not in glasses
    assert glasses['meshy_options'] == meshy('glasses')
    pants = single_part_request(garment_spec(GarmentRequest(body_job_id=BODY, slot='bottom', name='체크 바지',
        brief='Navy checked straight trousers', bottom_kind='pants'), *load_catalog()), BODY, VERSION)
    assert pants['bottom_kind'] == 'pants' and pants['fit_profile'] == {'revision': 'garment-fit-v1', 'kind': 'pants', 'ease': 'source'}


def test_catalog_is_the_studio_file_validated_and_never_written(studio, gateway, tmp_path):
    before = (STUDIO_UI/'garment-styles.json').read_bytes()
    result = studio.options()
    assert result['ok'] and len(result['data']['garments']) == len(CATALOG['garments']) == len(DESIGNS)
    assert {item['id'] for item in result['data']['garments']} == set(DESIGNS)
    assert result['data']['bodies'] == [{'job_id': BODY, 'version': VERSION, 'name': '모개', 'body_type': 'female', 'is_default': True}]
    assert (STUDIO_UI/'garment-styles.json').read_bytes() == before
    for broken in ('{"style": "x", "garments": []}', '{not json',
                   json.dumps({'style': CATALOG['style'], 'garments': [CATALOG['garments'][0]]*2})):
        (tmp_path/'styles.json').write_text(broken, encoding='utf-8')
        other = GarmentStudio(studio.client, catalog_path=tmp_path/'styles.json', state_dir=tmp_path)
        assert other.options()['error']['code'] == 'catalog_unavailable'
        assert other.start(designed(BLOUSON)[0], 'start-key-0001')['error']['code'] == 'catalog_unavailable'
    assert not gateway.posts()


# Keys ------------------------------------------------------------------------

def test_start_forwards_the_key_and_a_replay_gets_the_same_job(studio, gateway):
    first = studio.start(designed(BLOUSON)[0], 'garment-key-0001')
    again = studio.start(designed(BLOUSON)[0], 'garment-key-0001')
    assert first['ok'] and again['data']['job_id'] == first['data']['job_id']
    assert gateway.created == 1
    posts = gateway.posts()
    assert [post.url.path for post in posts] == [SINGLE_PART]*2
    assert {post.headers['idempotency-key'] for post in posts} == {'garment-key-0001'}
    assert all(post.headers['cookie'] == 'mogaesup_session='+SESSION and post.headers['origin'] == 'http://localhost:5173'
               for post in posts)
    assert posts[0].content == posts[1].content
    assert studio.start(designed(BLOUSON)[0], 'garment-key-0002')['data']['job_id'] != first['data']['job_id']
    assert gateway.created == 2
    assert SESSION not in json.dumps([first, again])


def test_start_through_the_sdk_tool(studio, gateway):
    pytest.importorskip('mcp')
    server = build_server(studio.client, studio)
    asyncio.run(server.call_tool('start_garment', {'garment': designed(SKIRT)[0], 'idempotency_key': 'sdk-key-0001'}))
    post, = gateway.posts()
    assert post.headers['idempotency-key'] == 'sdk-key-0001' and json.loads(post.content)['bottom_kind'] == 'skirt'


def test_lost_start_answer_is_recovered_with_the_same_key(studio, gateway):
    gateway.post_answers = ['lost']
    lost = studio.start(designed(HOODIE)[0], 'garment-key-0003')
    assert lost['ok'] is False and lost['outcome'] == 'uncertain' and gateway.created == 1
    recovered = studio.start(designed(HOODIE)[0], 'garment-key-0003')
    assert recovered['ok'] and gateway.created == 1


def test_start_checks_the_wardrobe_body_before_paying(studio, gateway):
    gateway.ready_version = 'd'*24  # The body is being assembled again: a part request would be refused (base_changed).
    assert studio.start(designed(BLOUSON)[0], 'garment-key-0004')['error']['code'] == 'wardrobe_body_not_ready'
    assert studio.start({'body_job_id': 'e'*24, 'design_id': BLOUSON}, 'garment-key-0005')['error']['code'] == 'wardrobe_body_not_found'
    assert gateway.posts() == []


@pytest.mark.parametrize('garment', [
    {'body_job_id': BODY, 'slot': 'top', 'name': '셔츠', 'brief': 'like https://example.com/shirt.png please'},
    {'body_job_id': BODY, 'slot': 'top', 'name': '셔츠', 'brief': 'copy the shirt on www.example.com'},
    {'body_job_id': BODY, 'slot': 'top', 'name': '셔츠', 'brief': 'use the texture shirt.png from the drive'},
    {'body_job_id': BODY, 'slot': 'top', 'name': '셔츠', 'brief': 'use /Users/operator/private/shirt.glb'},
    {'body_job_id': BODY, 'slot': 'top', 'name': '셔츠', 'brief': 'use C:\\temp\\shirt texture'},
    {'body_job_id': BODY, 'slot': 'top', 'name': '셔츠', 'brief': 'Navy shirt; import os; os.system(rm)'},
    {'body_job_id': BODY, 'slot': 'top', 'name': '셔츠', 'brief': 'Navy shirt with key '+SESSION},
    {'body_job_id': BODY, 'slot': 'top', 'name': '../../etc/passwd', 'brief': 'Navy shirt with a white collar'},
    {'body_job_id': BODY, 'slot': 'top', 'brief': 'Navy shirt with a white collar'},
    {'body_job_id': BODY, 'slot': 'weapon', 'name': '목검', 'brief': 'A short wooden practice sword'},
    {'body_job_id': BODY, 'slot': 'top', 'name': '셔츠', 'brief': 'Navy shirt with collar', 'bottom_kind': 'skirt'},
    {'body_job_id': '../escape', 'design_id': BLOUSON},
    {'body_job_id': BODY, 'design_id': 'https://example.com'},
    {'body_job_id': BODY, 'design_id': BLOUSON, 'brief': 'with longer sleeves please'},
    {'body_job_id': BODY, 'design_id': BLOUSON, 'slot': 'bottom'},
    {'body_job_id': BODY, 'design_id': BLOUSON, 'path': '/tmp/model.glb'},
])
def test_urls_paths_code_and_secrets_are_refused_before_any_request(studio, gateway, garment):
    with pytest.raises(ValueError):
        studio.start(garment, 'start-key-0001')
    with pytest.raises(ValueError):
        studio.enqueue([garment], 'enqueue-key-01')
    assert gateway.requests == [] and not studio.queue_path.exists()
    pytest.importorskip('mcp')
    with pytest.raises(Exception):
        asyncio.run(build_server(studio.client, studio).call_tool(
            'start_garment', {'garment': garment, 'idempotency_key': 'start-key-0001'}))
    assert gateway.requests == []


def test_keys_items_and_counts_are_typed(studio, gateway):
    for call in (lambda: studio.advance(3, 'short'), lambda: studio.advance(3, 'key with spaces'),
                 lambda: studio.advance(4, 'advance-key-01'), lambda: studio.advance(True, 'advance-key-01'),
                 lambda: studio.resolve('q-../escape', 'replay', 'resolve-key-1'),
                 lambda: studio.resolve('q-'+'a'*12, 'delete', 'resolve-key-1'),
                 lambda: studio.status('../escape'),
                 lambda: studio.enqueue(designed(*[BLOUSON]*31), 'enqueue-key-01')):
        with pytest.raises(ValueError):
            call()
    assert gateway.requests == []


# The queue ---------------------------------------------------------------------

def test_queue_keeps_three_in_flight_and_finishes_into_the_wardrobe(studio, gateway):
    queued = studio.enqueue(designed(BLOUSON, SKIRT, SNEAKERS, BUCKET_HAT, HOODIE), 'enqueue-key-01')
    assert len(queued['queued']) == 5 and queued['counts']['pending'] == 5 and gateway.requests == []
    first = studio.advance(3, 'advance-key-01')
    assert len(first['started']) == MAX_IN_FLIGHT == first['paid_submissions'] == len(gateway.posts())
    assert first['counts']['running'] == 3 and first['counts']['pending'] == 2 and first['stopped'] is None
    # Each item's request is the one SinglePart sends, under the item's own saved key.
    saved = json.loads(studio.queue_path.read_text(encoding='utf-8'))
    for post, item in zip(gateway.posts(), saved['items']):
        assert post.headers['idempotency-key'] == item['key'] and json.loads(post.content) == item['request']
    full = studio.advance(3, 'advance-key-02')
    assert full['started'] == [] and full['paid_submissions'] == 0 and len(gateway.posts()) == 3
    jobs = [item['job_id'] for item in first['started']]
    gateway.finish(jobs[0])
    gateway.finish(jobs[1], listed='unavailable')
    step = studio.advance(3, 'advance-key-03')
    assert [item['job_id'] for item in step['finished']] == [jobs[0]]
    assert step['finished'][0]['wardrobe'] == {'version': SEALED, 'sha256': 'e'*64, 'name': '오트밀 유틸리티 블루종'}
    assert [(item['job_id'], item['code']) for item in step['attention']] == [(jobs[1], 'needs_anchors')]
    assert len(step['started']) == 2 and step['counts'] == {'pending': 0, 'running': 3, 'done': 1, 'stalled': 1,
                                                            'uncertain': 0, 'failed': 0, 'dropped': 0}
    gateway.finish_all()
    gateway.listed[jobs[1]] = 'parts'  # Fitted again in the studio: the wardrobe lists it now.
    last = studio.advance(3, 'advance-key-04')
    assert len(last['finished']) == 4 and last['counts']['done'] == 5 and last['counts']['running'] == 0
    assert gateway.created == len(gateway.posts()) == 5
    assert SESSION not in studio.queue_path.read_text(encoding='utf-8')


def test_a_replayed_advance_sends_nothing(studio, gateway):
    studio.enqueue(designed(BLOUSON, SKIRT), 'enqueue-key-01')
    first = studio.advance(1, 'advance-key-01')
    replayed = studio.advance(1, 'advance-key-01')
    assert replayed['replayed'] and replayed['started'] == first['started'] and len(gateway.posts()) == 1
    assert studio.advance(2, 'advance-key-01')['error']['code'] == 'idempotency_conflict'
    assert len(gateway.posts()) == 1


def test_enqueue_is_idempotent_and_skips_garments_already_queued(studio):
    first = studio.enqueue(designed(BLOUSON), 'enqueue-key-01')
    again = studio.enqueue(designed(BLOUSON), 'enqueue-key-01')
    assert again['replayed'] and again['queued'] == first['queued']
    more = studio.enqueue(designed(BLOUSON, SKIRT), 'enqueue-key-02')
    assert [item['design_id'] for item in more['queued']] == [SKIRT]
    assert more['skipped'][0]['item'] == first['queued'][0]['item'] and more['skipped'][0]['reason'] == 'already_queued'
    assert studio.enqueue(designed(SKIRT), 'enqueue-key-01')['error']['code'] == 'idempotency_conflict'
    assert studio.queue()['data']['counts']['pending'] == 2


def test_queue_state_lives_in_one_file_per_origin_under_the_repository_data_directory(studio):
    assert STATE_DIR == REPO/'.data'/'studio-mcp'
    default = GarmentStudio(studio.client)
    origin = hashlib.sha256(b'http://127.0.0.1:8080').hexdigest()[:16]
    assert default.queue_path == STATE_DIR/f'garments-{origin}.json'
    assert studio.queue_path.name == default.queue_path.name


@pytest.mark.parametrize('status, answer, code, item_state', [
    (402, {'error': {'code': 'payment_required', 'message': '결제 필요'}}, 'api_refused', 'pending'),
    (403, {'code': 'paid_operator_only', 'message': '권한 없음'}, 'paid_operator_only', 'pending'),
    (403, {'code': 'factory_paid_off', 'message': '유료 꺼짐'}, 'factory_paid_off', 'pending'),
    (409, {'code': 'conflict', 'message': '겹침'}, 'conflict', 'pending'),
    (409, {'error': {'code': 'base_changed', 'message': '기본 몸 변경'}}, 'base_changed', 'failed'),
    (422, {'error': {'code': 'insufficient_credits', 'message': '크레딧 부족'}}, 'insufficient_credits', 'pending'),
    (429, {'code': 'factory_budget', 'message': '한도 소진'}, 'factory_budget', 'pending'),
    (503, {'detail': '작업 수락이 중지되어 있습니다. 잠시 후 다시 시도하세요.'}, 'draining', 'pending'),
])
def test_the_first_refusal_stops_the_advance(studio, gateway, status, answer, code, item_state):
    queued = studio.enqueue(designed(BLOUSON, SKIRT, SNEAKERS), 'enqueue-key-01')['queued']
    gateway.post_answers = [(status, answer)]
    result = studio.advance(3, 'advance-key-01')
    assert result['stopped'] == {'kind': 'refusal', 'code': code, 'status': status, 'item': queued[0]['item']}
    assert result['paid_submissions'] == 1 and len(gateway.posts()) == 1 and result['started'] == []
    state = items(studio)
    assert state[queued[0]['item']]['state'] == item_state
    assert all(state[item['item']]['state'] == 'pending' for item in queued[1:])
    # The next advance goes on; a refused garment that was never accepted is sent under the same key.
    following = studio.advance(3, 'advance-key-02')
    assert following['stopped'] is None and len(following['started']) == (3 if item_state == 'pending' else 2)
    keys = [post.headers['idempotency-key'] for post in gateway.posts()]
    assert len(keys) == len(set(keys))+(item_state == 'pending')


@pytest.mark.parametrize('answer', ['lost', (504, {'code': 'factory_timeout', 'message': '응답 없음'}),
                                    (502, {'code': 'factory_unavailable', 'message': '연결 실패'}),
                                    (503, {'code': 'studio_waking', 'message': '켜는 중'}),
                                    (500, {'error': {'code': 'internal', 'message': '/srv/private trace'}})])
def test_an_uncertain_submission_is_never_sent_again_on_its_own(studio, gateway, answer):
    queued = studio.enqueue(designed(BLOUSON, SKIRT), 'enqueue-key-01')['queued']
    unsure = queued[0]['item']
    gateway.post_answers = [answer]
    result = studio.advance(3, 'advance-key-01')
    assert result['stopped']['kind'] == 'uncertain' and result['attention'][0]['item'] == unsure
    assert items(studio)[unsure]['state'] == 'uncertain' and len(gateway.posts()) == 1
    for step in range(2, 5):
        studio.advance(3, f'advance-key-0{step}')
    keys = [post.headers['idempotency-key'] for post in gateway.posts()]
    assert len(keys) == 2 and len(set(keys)) == 2 and items(studio)[unsure]['state'] == 'uncertain'
    # Only the operator sends it again: its own request under its own key, so the studio makes it at most once.
    resolved = studio.resolve(unsure, 'replay', 'resolve-key-01')
    assert resolved['outcome'] == 'accepted' and resolved['item']['state'] == 'running'
    assert gateway.posts()[-1].headers['idempotency-key'] == keys[0]
    assert gateway.posts()[-1].content == gateway.posts()[0].content
    assert gateway.created == 2
    assert studio.resolve(unsure, 'replay', 'resolve-key-01')['replayed'] and len(gateway.posts()) == 3
    assert studio.resolve(unsure, 'replay', 'resolve-key-02')['error']['code'] == 'action_unavailable'
    assert '/srv/private' not in json.dumps(result)


def test_an_interrupted_submission_is_uncertain_on_the_next_run(studio, gateway, monkeypatch):
    queued = studio.enqueue(designed(BLOUSON), 'enqueue-key-01')['queued']

    def interrupted(request, key):
        raise KeyboardInterrupt
    monkeypatch.setattr(studio, '_post', interrupted)
    with pytest.raises(KeyboardInterrupt):
        studio.advance(1, 'advance-key-01')
    saved = json.loads(studio.queue_path.read_text(encoding='utf-8'))['items'][0]
    assert saved['state'] == 'submitting' and saved['request']['part_name'] == '오트밀 유틸리티 블루종'
    monkeypatch.undo()
    result = studio.advance(3, 'advance-key-02')
    assert result['attention'] == [{**queued[0], 'state': 'uncertain', 'code': 'interrupted'}]
    assert result['started'] == [] and gateway.posts() == []
    assert studio.resolve(queued[0]['item'], 'drop', 'resolve-key-01')['item']['state'] == 'dropped'
    assert studio.advance(3, 'advance-key-03')['paid_submissions'] == 0


def test_body_checks_and_an_unreachable_studio_stop_before_paying(studio, gateway):
    studio.enqueue(designed(BLOUSON) + [{'body_job_id': 'e'*24, 'design_id': SKIRT}], 'enqueue-key-01')
    gateway.ready_version = 'd'*24
    waiting = studio.advance(3, 'advance-key-01')
    assert waiting['waiting'] == [{'body_job_id': BODY, 'code': 'wardrobe_body_not_ready'}]
    assert [item['code'] for item in waiting['failed']] == ['wardrobe_body_not_found'] and gateway.posts() == []
    gateway.ready_version = VERSION
    asleep = FakeGateway()
    asleep.handler = lambda request: httpx.Response(503, json={'code': 'studio_waking', 'message': '켜는 중'})
    sleeping = make_studio(asleep, studio.queue_path.parent)
    try:
        result = sleeping.advance(3, 'advance-key-02')
        assert result['stopped'] == {'kind': 'transient', 'code': 'studio_waking', 'status': 503}
        assert result['paid_submissions'] == 0
    finally:
        sleeping.client.close()
    assert len(studio.advance(3, 'advance-key-03')['started']) == 1


def test_queue_file_is_locked_and_never_replaced_when_unreadable(studio, gateway):
    from src.services.process_identity import lease_guard
    studio.enqueue(designed(BLOUSON), 'enqueue-key-01')
    with lease_guard(studio.queue_path):
        assert studio.advance(3, 'advance-key-01')['error']['code'] == 'queue_busy'
        assert studio.enqueue(designed(SKIRT), 'enqueue-key-02')['error']['code'] == 'queue_busy'
    for broken in ('{"version": 1, "items": [',
                   '{"version": 1, "receipts": {}, "items": [{"id": "q-aaaaaaaaaaaa", "state": "running"}]}'):
        studio.queue_path.write_text(broken, encoding='utf-8')
        assert studio.advance(3, 'advance-key-01')['error']['code'] == 'queue_unreadable'
        assert studio.queue()['error']['code'] == 'queue_unreadable'
        assert studio.queue_path.read_text(encoding='utf-8') == broken
    assert gateway.posts() == []


def test_garment_job_status_reports_the_wardrobe_entry(studio, gateway):
    started = studio.start(designed(BLOUSON)[0], 'garment-key-0001')['data']['job_id']
    other = studio.start(designed(SKIRT)[0], 'garment-key-0002')['data']['job_id']
    assert studio.status(started)['data']['state'] == 'running'
    gateway.finish(started)
    gateway.finish(other, listed='unavailable')
    done = studio.status(started)['data']
    assert done['state'] == 'done' and done['wardrobe']['sha256'] == 'e'*64 and done['slot'] == 'top'
    assert done['flow'] == {'status': 'review_required', 'stage': 'complete', 'busy': False, 'message': '조립 완료'}
    stalled = studio.status(other)['data']
    assert stalled['state'] == 'stalled' and stalled['reason'] == 'needs_anchors' and 'wardrobe' not in stalled
    assert studio.status('0'*24)['error']['code'] == 'not_found'


# The terminal loop ---------------------------------------------------------------

def test_cli_caps_paid_submissions_per_run_and_sleeps_between_polls(studio, gateway):
    studio.enqueue(designed(BLOUSON, SKIRT, SNEAKERS, BUCKET_HAT, HOODIE, JOGGERS), 'enqueue-key-01')
    sleeps, lines = [], []

    def sleep(seconds):
        sleeps.append(seconds)
        gateway.finish_all()
    code = cli(['--max-new', '3', '--until-empty', '--max-paid', '4', '--poll-seconds', '30'],
               studio=studio, sleep=sleep, clock=lambda: 0.0, write=lines.append)
    assert code == 0 and len(gateway.posts()) == 4 and sleeps == [30, 30]
    assert json.loads(lines[-1]) == {'exit': 0, 'paid_this_run': 4}
    steps = [json.loads(line) for line in lines[:-1]]
    assert [step['paid_submissions'] for step in steps] == [3, 1, 0]
    assert steps[-1]['counts']['done'] == 4 and steps[-1]['counts']['pending'] == 2
    assert all(SESSION not in line for line in lines)


def test_cli_stops_at_a_refusal_and_after_one_step_without_until_empty(studio, gateway):
    studio.enqueue(designed(BLOUSON, SKIRT), 'enqueue-key-01')
    gateway.post_answers = [(429, {'code': 'factory_budget', 'message': '한도 소진'})]
    lines = []
    assert cli(['--until-empty', '--poll-seconds', '10'], studio=studio, sleep=pytest.fail, write=lines.append) == 2
    assert len(gateway.posts()) == 1 and json.loads(lines[-1])['exit'] == 2
    assert cli(['--max-new', '1'], studio=studio, sleep=pytest.fail, write=lines.append) == 0
    assert len(gateway.posts()) == 2


def test_cli_needs_both_flags_and_a_valid_origin(monkeypatch, capsys):
    monkeypatch.setenv('MOGA_STUDIO_API_URL', 'http://127.0.0.1:1')
    monkeypatch.setenv('MOGA_STUDIO_SESSION', SESSION)
    monkeypatch.setenv('MOGA_STUDIO_MCP_WRITE', '1')
    monkeypatch.delenv('MOGA_STUDIO_MCP_PAID', raising=False)
    with pytest.raises(SystemExit) as stopped:
        main(['garments', '--max-new', '1'])
    assert stopped.value.code == 1 and 'MOGA_STUDIO_MCP_PAID=1' in capsys.readouterr().err
    monkeypatch.setenv('MOGA_STUDIO_MCP_PAID', '1')
    monkeypatch.setenv('MOGA_STUDIO_API_URL', 'http://example.com')
    assert cli(['--max-new', '1']) == 1
    output = capsys.readouterr()
    assert 'HTTPS origin' in output.err and SESSION not in output.err+output.out


def test_drain_refusal_keeps_its_code_for_existing_tools():
    client = StudioClient('http://localhost:8080', SESSION, writable=True,
        transport=httpx.MockTransport(lambda request: httpx.Response(503, json={'detail': '작업 수락이 중지되어 있습니다.'})))
    try:
        result = client.action('char-'+'b'*12, 'inspect_model', 'r1', 'request-1234', {})
        assert result == {'ok': False, 'status': 503, 'error': {'code': 'draining', 'message': 'The API refused this request'}}
    finally:
        client.close()
