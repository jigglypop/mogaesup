"""Exercise the operator import client's durable intents without AWS or the network."""
from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
from types import SimpleNamespace

import httpx
import pytest

from src.services.character_pipeline import request_job_id
from src.services.glb import build_glb, parse_glb


spec = importlib.util.spec_from_file_location('studio_import', Path(__file__).parents[2] / 'infra/import-studio-glb.py')
studio_import = importlib.util.module_from_spec(spec)
spec.loader.exec_module(studio_import)


def hair_glb():
    binary = struct.pack('<9f3H', 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 2)
    return build_glb({
        'asset': {'version': '2.0'}, 'buffers': [{'byteLength': len(binary)}],
        'bufferViews': [{'buffer': 0, 'byteLength': 36}, {'buffer': 0, 'byteOffset': 36, 'byteLength': 6}],
        'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': 3, 'type': 'VEC3',
                       'min': [0, 0, 0], 'max': [1, 1, 0]},
                      {'bufferView': 1, 'componentType': 5123, 'count': 3, 'type': 'SCALAR'}],
        'meshes': [{'primitives': [{'attributes': {'POSITION': 0}, 'indices': 1}]}],
        'nodes': [{'mesh': 0, 'extras': {'part_role': 'hair', 'standard_slot': 'hair'}}],
        'scenes': [{'nodes': [0]}], 'scene': 0,
    }, binary)


def native_hair_glb(*, role='hair'):
    """One real skinned triangle and one clip; body and hair share their frozen rig."""
    doc, raw = parse_glb(hair_glb(), strict=True)
    binary = bytearray(raw)
    def accessor(code, shape, count, values, **extra):
        binary.extend(b'\0'*(-len(binary)%4))
        packed = struct.pack('<'+{5121:'B', 5126:'f'}[code]*len(values), *values)
        doc['bufferViews'].append({'buffer':0, 'byteOffset':len(binary), 'byteLength':len(packed)})
        binary.extend(packed)
        doc['accessors'].append({'bufferView':len(doc['bufferViews'])-1, 'componentType':code,
            'type':shape, 'count':count, **extra})
        return len(doc['accessors'])-1
    primitive = doc['meshes'][0]['primitives'][0]
    primitive['attributes'].update(
        JOINTS_0=accessor(5121, 'VEC4', 3, [1, 0, 0, 0]*3),
        WEIGHTS_0=accessor(5126, 'VEC4', 3, [1, 0, 0, 0]*3))
    identity = [1 if i%5 == 0 else 0 for i in range(16)]
    head_bind = list(identity); head_bind[13] = -1
    binds = accessor(5126, 'MAT4', 2, identity+head_bind)
    doc['skins'] = [{'joints':[0, 1], 'inverseBindMatrices':binds}]
    doc['nodes'] = [{'name':'Hips', 'children':[1]}, {'name':'Head', 'translation':[0, 1, 0]},
        {'name':role, 'mesh':0, 'skin':0, 'extras':{'part_role':role, 'standard_slot':role}}]
    doc['scenes'][0]['nodes'] = [0, 2]
    time = accessor(5126, 'SCALAR', 2, [0, 1], min=[0], max=[1])
    rotation = accessor(5126, 'VEC4', 2, [0, 0, 0, 1]*2)
    doc['animations'] = [{'name':'walk', 'samplers':[{'input':time, 'output':rotation}],
        'channels':[{'sampler':0, 'target':{'node':1, 'path':'rotation'}}]}]
    doc['buffers'][0]['byteLength'] = len(binary)
    return build_glb(doc, bytes(binary))


@pytest.fixture
def args(tmp_path):
    source = tmp_path / 'reviewed-hair.glb'
    source.write_bytes(hair_glb())
    return SimpleNamespace(file=str(source), sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
        name='검수 헤어', body_job='1'*24, body_version='2'*24,
        body_sha256=hashlib.sha256(b'frozen body').hexdigest(),
        receipt=str(tmp_path / 'import-receipt.json'), resume=False, fitted_native_hair=False)


@pytest.fixture
def native_args(args):
    args.fitted_native_hair = True
    content = native_hair_glb()
    Path(args.file).write_bytes(content)
    args.sha256 = hashlib.sha256(content).hexdigest()
    args.body_content = native_hair_glb(role='body')
    args.body_sha256 = hashlib.sha256(args.body_content).hexdigest()
    return args


class BodyStream(httpx.SyncByteStream):
    def __init__(self, api):
        self.api = api

    def __iter__(self):
        yield self.api.body[:4]
        if self.api.body_timeout:
            raise httpx.ReadTimeout('private upstream body')
        yield self.api.body[4:]

    def close(self):
        self.api.body_closed += 1


class API:
    def __init__(self, args, *, fault_phase=None, fault=None):
        self.args = args
        self.fault_phase, self.fault = fault_phase, fault
        self.requests, self.posts, self.remote = [], [], {}
        self.body = getattr(args, 'body_content', b'frozen body')
        self.body_timeout = False
        self.body_closed = 0
        self.current = {'version': args.body_version, 'status': 'review_required',
            'artifacts': [{'name': 'body.glb', 'sha256': args.body_sha256,
                'url': f'/api/avatar-factory/jobs/{args.body_job}/native-parts/{args.body_version}/body.glb'}]}
        self.client = httpx.Client(base_url=studio_import.ORIGIN,
            headers={'x-gateway-key': 'offline_gateway_fixture_123'},
            follow_redirects=False, transport=httpx.MockTransport(self.handle))

    def handle(self, request):
        self.requests.append(request)
        assert str(request.url).startswith(studio_import.ORIGIN+'/api/')
        assert request.headers['x-gateway-key'] == 'offline_gateway_fixture_123'
        assert 'authorization' not in request.headers and 'x-user-id' not in request.headers
        route = request.url.path
        if request.method == 'GET':
            if route == f'/api/avatar-factory/jobs/{self.args.body_job}/native-parts':
                return httpx.Response(200, json=self.current)
            if route.endswith('/body.glb'):
                return httpx.Response(200, stream=BodyStream(self))
            if route in self.remote:
                return httpx.Response(200, json=self.remote[route])
            return httpx.Response(404, json={'error': 'missing'})
        assert request.method == 'POST'
        phase = 'upload' if route.endswith('/upload') else 'fit' if route.endswith('/prepare') else 'register'
        # The durable intent must exist before the simulated server can accept anything.
        receipt = json.loads(Path(self.args.receipt).read_text(encoding='utf-8'))
        assert receipt['phases'][phase]['state'] == 'intent'
        key = request.headers['Idempotency-Key']
        assert receipt['phases'][phase]['key'] == key
        self.posts.append((phase, key, request.content))
        fault = self.fault if phase == self.fault_phase else None
        self.fault = None if phase == self.fault_phase else self.fault
        if fault == 'before':
            raise httpx.ReadTimeout('private upstream key must not escape', request=request)
        if isinstance(fault, int):
            return httpx.Response(fault, headers={'location': 'https://foreign.example/secret'},
                                  json={'error': 'private raw error must not escape'})
        if phase == 'upload':
            assert request.headers['content-type'] == 'model/gltf-binary'
            assert request.content == Path(self.args.file).read_bytes()
            result = {'id': self.args.sha256, 'bytes': len(request.content), 'rigged': self.args.fitted_native_hair,
                      'bone_count': 2 if self.args.fitted_native_hair else 0,
                      'animations': ['walk'] if self.args.fitted_native_hair else []}
            lookup = f'/api/avatar-factory/base-bodies/glb-assets/{result["id"]}'
        elif phase == 'register':
            assert request.headers['content-type'] == 'application/json'
            assert json.loads(request.content) == {'name': self.args.name, 'slot': 'hair', 'model_asset': self.args.sha256}
            identifier = request_job_id(1, 'studio-glb', key)
            result = {'id': identifier, 'name': self.args.name, 'slot': 'hair', 'model_asset': self.args.sha256,
                      'source': {'url': f'/api/studio/glb-assets/{identifier}/source.glb', 'sha256': self.args.sha256}}
            lookup = f'/api/studio/glb-assets/{identifier}'
        else:
            library = request_job_id(1, 'studio-glb', receipt['phases']['register']['key'])
            assert route == f'/api/studio/glb-assets/{library}/prepare'
            assert request.headers['content-type'] == 'application/json'
            assert json.loads(request.content) == {'action': 'fit', 'base_job_id': self.args.body_job,
                                                   'base_version': self.args.body_version}
            child_key = 'glbfit_'+hashlib.sha256(f'{library}:{key}'.encode()).hexdigest()[:40]
            result = {'id': request_job_id(1, 'variant', child_key), 'status': 'pipeline_running',
                      'base_job_id': self.args.body_job, 'base_version': self.args.body_version,
                      'part_name': self.args.name, 'requested_slots': ['hair'],
                      'limits': {key: 0 for key in studio_import.ZERO_LIMITS}}
            lookup = f'/api/avatar-factory/jobs/{result["id"]}'
        self.remote[lookup] = deepcopy(result)
        if fault == 'after':
            raise httpx.ReadTimeout('response lost after commit', request=request)
        if fault == 'invalid':
            return httpx.Response(202 if phase == 'fit' else 201, text='private invalid JSON')
        if fault == 'paid':
            result['limits']['meshy_tasks'] = 1
        if fault == 'scope':
            result['base_version'] = '9'*24
        result['internal_error'] = 'do not write raw responses or server paths'
        return httpx.Response(202 if phase == 'fit' else 201, json=result)


def receipt(args):
    return json.loads(Path(args.receipt).read_text(encoding='utf-8'))


@pytest.mark.parametrize('input_fixture', ['args', 'native_args'])
def test_normal_import_freezes_three_intents_and_polls_accepted_fit_without_posts(request, input_fixture):
    args = request.getfixturevalue(input_fixture)
    api = API(args)
    result = studio_import.run(args, api.client)
    assert [phase for phase, _, _ in api.posts] == list(studio_import.PHASES)
    assert len({key for _, key, _ in api.posts}) == 3
    assert api.body_closed == 3
    assert all(value['state'] == 'accepted' for value in result['phases'].values())
    stored = Path(args.receipt).read_text(encoding='utf-8')
    assert args.file not in stored and 'offline_gateway' not in stored and 'internal_error' not in stored
    assert result['provider_calls'] == 0
    assert result['input']['input_mode'] == ('fitted_native_hair' if args.fitted_native_hair else 'unrigged_hair')
    assert 'without_rust_monthly_request_aggregate' in result['operator_channel']
    before = len(api.requests)
    api.current['version'] = '9'*24
    final_route = f'/api/avatar-factory/jobs/{result["phases"]["fit"]["id"]}'
    api.remote[final_route]['status'] = 'review_required'
    again = studio_import.run(args, api.client)
    assert again['phases']['fit']['status'] == 'review_required'
    assert len(api.posts) == 3
    assert [r.url.path for r in api.requests[before:]] == [final_route]


@pytest.mark.parametrize('phase', studio_import.PHASES)
@pytest.mark.parametrize('fault', ['before', 'after'])
@pytest.mark.parametrize('input_fixture', ['args', 'native_args'])
def test_response_loss_never_retries_automatically_and_resume_keeps_key_and_input(request, input_fixture, phase, fault):
    args = request.getfixturevalue(input_fixture)
    api = API(args, fault_phase=phase, fault=fault)
    with pytest.raises(studio_import.ImportStopped, match='uncertain'):
        studio_import.run(args, api.client)
    saved = receipt(args)
    assert saved['phases'][phase]['state'] == 'uncertain'
    key = saved['phases'][phase]['key']
    before = len(api.requests)
    with pytest.raises(studio_import.ImportStopped, match='--resume'):
        studio_import.run(args, api.client)
    assert len(api.requests) == before
    args.resume = True
    recovered = studio_import.run(args, api.client)
    assert all(item['state'] == 'accepted' for item in recovered['phases'].values())
    retries = [(k, body) for p, k, body in api.posts if p == phase]
    assert len(retries) == (2 if fault == 'before' else 1)
    assert all(k == key and body == retries[0][1] for k, body in retries)
    assert len(api.posts) == (4 if fault == 'before' else 3)
    studio_import.run(args, api.client)
    assert len(api.posts) == (4 if fault == 'before' else 3)


@pytest.mark.parametrize('status,state', [(401, 'rejected'), (403, 'rejected'), (409, 'rejected'),
                                         (302, 'uncertain'), (500, 'uncertain')])
def test_auth_conflict_redirect_and_upstream_errors_never_try_fallback(args, status, state):
    api = API(args, fault_phase='upload', fault=status)
    with pytest.raises(studio_import.ImportStopped, match='no fallback') as failure:
        studio_import.run(args, api.client)
    assert 'private raw' not in str(failure.value)
    assert len(api.posts) == 1
    assert receipt(args)['phases']['upload']['state'] == state
    assert all(r.url.host == 'dtcd471nsfyvo.cloudfront.net' for r in api.requests)
    if state == 'rejected':
        before = len(api.requests)
        args.resume = True
        with pytest.raises(studio_import.ImportStopped, match='definitively refused'):
            studio_import.run(args, api.client)
        assert len(api.requests) == before


@pytest.mark.parametrize('fault', ['invalid', 'paid', 'scope'])
def test_unverified_fit_answer_stays_uncertain_and_known_job_is_looked_up(args, fault):
    api = API(args, fault_phase='fit', fault=fault)
    with pytest.raises(studio_import.ImportStopped, match='not verified'):
        studio_import.run(args, api.client)
    assert receipt(args)['phases']['fit']['state'] == 'uncertain'
    args.resume = True
    studio_import.run(args, api.client)
    assert len(api.posts) == 3


@pytest.mark.parametrize('field,value', [('version', '9'*24), ('status', 'running'), ('origin', 'uploaded_glb')])
def test_current_body_mismatch_blocks_every_post(args, field, value):
    api = API(args)
    api.current[field] = value
    with pytest.raises(studio_import.ImportStopped, match='not currently ready'):
        studio_import.run(args, api.client)
    assert not api.posts and not Path(args.receipt).exists()


@pytest.mark.parametrize('change', ['receipt_sha', 'foreign_route', 'bytes', 'timeout'])
def test_named_body_verification_is_bounded_and_fail_closed(args, change):
    api = API(args)
    if change == 'receipt_sha': api.current['artifacts'][0]['sha256'] = '0'*64
    if change == 'foreign_route': api.current['artifacts'][0]['url'] = 'https://foreign.example/body.glb'
    if change == 'bytes': api.body = b'wrong body'
    if change == 'timeout': api.body_timeout = True
    with pytest.raises(studio_import.ImportStopped):
        studio_import.run(args, api.client)
    assert not api.posts
    assert api.body_closed == (1 if change in ('bytes', 'timeout') else 0)


def test_body_stream_limit_stops_and_closes_response(args, monkeypatch):
    api = API(args)
    monkeypatch.setattr(studio_import, 'MAX_BYTES', 5)
    submitted = {'body_job': args.body_job, 'body_version': args.body_version, 'body_sha256': args.body_sha256}
    with pytest.raises(studio_import.ImportStopped, match='bounded size'):
        studio_import.verify_body(api.client, submitted)
    assert api.body_closed == 1 and not api.posts


@pytest.mark.parametrize('operation', ['fsync', 'replace'])
def test_intent_write_failure_sends_no_post(args, monkeypatch, operation):
    api = API(args)
    monkeypatch.setattr(studio_import.os, operation, lambda *a: (_ for _ in ()).throw(OSError('disk unavailable')))
    with pytest.raises(OSError):
        studio_import.run(args, api.client)
    assert not api.posts and not Path(args.receipt).exists()
    assert not list(Path(args.receipt).parent.glob('*.tmp'))


def test_changed_input_cannot_reuse_a_receipt(args):
    api = API(args, fault_phase='register', fault='after')
    with pytest.raises(studio_import.ImportStopped): studio_import.run(args, api.client)
    old = Path(args.receipt).read_bytes()
    args.name = '다른 이름'
    args.resume = True
    before = len(api.requests)
    with pytest.raises(studio_import.ImportStopped, match='fixed input changed'):
        studio_import.run(args, api.client)
    assert len(api.requests) == before and Path(args.receipt).read_bytes() == old


@pytest.mark.parametrize('change', ['sha', 'role', 'skin', 'animation', 'hidden'])
def test_wrong_hash_body_mesh_rig_or_clip_never_reaches_http(args, change):
    if change == 'sha':
        args.sha256 = '0'*64
    else:
        doc, binary = parse_glb(Path(args.file).read_bytes(), strict=True)
        if change == 'role': doc['nodes'][0]['extras']['standard_slot'] = 'body'
        if change == 'skin': doc['skins'] = [{'joints': [0]}]; doc['nodes'][0]['skin'] = 0
        if change == 'animation': doc['animations'] = [{'samplers': [], 'channels': []}]
        if change == 'hidden': doc['nodes'] = []
        content = build_glb(doc, binary)
        Path(args.file).write_bytes(content)
        args.sha256 = hashlib.sha256(content).hexdigest()
    api = API(args)
    with pytest.raises(studio_import.ImportStopped): studio_import.run(args, api.client)
    assert not api.requests


def test_concurrent_receipt_owner_cannot_submit(args):
    api = API(args)
    with studio_import.receipt_lock(Path(args.receipt)):
        with pytest.raises(studio_import.ImportStopped, match='already in use'):
            studio_import.run(args, api.client)
    assert not api.requests


@pytest.mark.parametrize('tamper', ['extra', 'out_of_order', 'wrong_id', 'uncertain_id', 'bool_owner'])
def test_malformed_receipt_is_refused_before_http(args, tamper):
    api = API(args)
    result = studio_import.run(args, api.client)
    if tamper == 'extra': result['secret'] = 'forbidden'
    if tamper == 'out_of_order': result['phases'].pop('register')
    if tamper == 'wrong_id': result['phases']['fit']['id'] = '9'*24
    if tamper == 'uncertain_id': result['phases']['fit']['state'] = 'uncertain'
    if tamper == 'bool_owner': result['owner_id'] = True
    Path(args.receipt).write_text(json.dumps(result), encoding='utf-8')
    before = len(api.requests)
    with pytest.raises(studio_import.ImportStopped, match='unreadable'):
        studio_import.run(args, api.client)
    assert len(api.requests) == before


def test_accepted_missing_job_never_recreates_fit(args):
    api = API(args)
    result = studio_import.run(args, api.client)
    del api.remote[f'/api/avatar-factory/jobs/{result["phases"]["fit"]["id"]}']
    with pytest.raises(studio_import.ImportStopped, match='no POST was repeated'):
        studio_import.run(args, api.client)
    assert len(api.posts) == 3


def test_body_changed_after_upload_stops_before_registration(args):
    api = API(args)
    real_handle = api.handle
    def handle(request):
        response = real_handle(request)
        if request.method == 'POST' and request.url.path.endswith('/upload'):
            api.current['version'] = '9'*24
        return response
    client = httpx.Client(base_url=studio_import.ORIGIN, headers=api.client.headers,
                         transport=httpx.MockTransport(handle))
    with pytest.raises(studio_import.ImportStopped, match='not currently ready'):
        studio_import.run(args, client)
    assert [phase for phase, _, _ in api.posts] == ['upload']
    assert set(receipt(args)['phases']) == {'upload'}


@pytest.mark.parametrize('fault', ['missing_budget', 'bool_budget', 'paid_budget', 'wrong_scope', 'auth_refused'])
def test_resume_lookup_must_prove_scope_and_zero_budget_before_any_post(args, fault):
    api = API(args, fault_phase='fit', fault='after')
    with pytest.raises(studio_import.ImportStopped): studio_import.run(args, api.client)
    saved = receipt(args)
    route = f'/api/avatar-factory/jobs/{studio_import.expected_id(saved, "fit")}'
    job = api.remote[route]
    if fault == 'missing_budget': job['limits'].pop('meshy_tasks')
    if fault == 'bool_budget': job['limits']['meshy_tasks'] = False
    if fault == 'paid_budget': job['limits']['meshy_tasks'] = 1
    if fault == 'wrong_scope': job['base_job_id'] = '9'*24
    real_handle = api.handle
    def handle(request):
        if fault == 'auth_refused' and request.method == 'GET' and request.url.path == route:
            return httpx.Response(403, json={'private': 'must not escape'})
        return real_handle(request)
    client = httpx.Client(base_url=studio_import.ORIGIN, headers=api.client.headers,
                         transport=httpx.MockTransport(handle))
    args.resume = True
    with pytest.raises(studio_import.ImportStopped): studio_import.run(args, client)
    assert len(api.posts) == 3
    assert receipt(args) == saved


def test_main_client_uses_fixed_https_owner_channel_and_prints_only_receipt(args, monkeypatch, capsys):
    api = API(args)
    monkeypatch.setattr(studio_import.argparse.ArgumentParser, 'parse_args', lambda _: args)
    monkeypatch.setattr(studio_import.boto3, 'Session', lambda **kw: kw)
    key = 'offline_gateway_fixture_123'
    def credential(session):
        assert session == {'region_name': studio_import.REGION}
        return key
    monkeypatch.setattr(studio_import, 'gateway_key', credential)
    original_client = httpx.Client
    def client(**settings):
        assert settings['base_url'] == studio_import.ORIGIN
        assert settings['headers'] == {'x-gateway-key': key}
        assert settings['follow_redirects'] is False and settings['trust_env'] is False
        assert settings['verify'] is True
        assert settings['timeout'].connect == 10
        return original_client(**settings, transport=httpx.MockTransport(api.handle))
    monkeypatch.setattr(studio_import.httpx, 'Client', client)
    studio_import.main()
    printed = capsys.readouterr()
    assert printed.err == '' and key not in printed.out and args.file not in printed.out
    value = json.loads(printed.out)
    assert set(value) == {'owner_id', 'origin', 'phases', 'provider_calls'}
    assert value['owner_id'] == 1 and value['provider_calls'] == 0


def test_invalid_local_input_in_main_never_reads_a_credential(args, monkeypatch):
    args.sha256 = '0'*64
    monkeypatch.setattr(studio_import.argparse.ArgumentParser, 'parse_args', lambda _: args)
    def forbidden(*_, **__):
        pytest.fail('Invalid local input must not obtain an AWS session or key.')
    monkeypatch.setattr(studio_import.boto3, 'Session', forbidden)
    with pytest.raises(studio_import.ImportStopped, match='SHA-256 does not match'):
        studio_import.main()


def test_existing_gateway_secret_only_and_sdk_retry_is_disabled():
    calls = []
    class Session:
        def client(self, service, *, config):
            assert config.retries == {'total_max_attempts': 1}
            calls.append(service)
            if service == 'sts':
                return SimpleNamespace(get_caller_identity=lambda: {'Account': studio_import.ACCOUNT})
            assert service == 'secretsmanager'
            def get_secret_value(**request):
                assert request == {'SecretId': studio_import.SECRET}
                return {'SecretString': 'offline_existing_gateway_12345'}
            return SimpleNamespace(get_secret_value=get_secret_value)
    assert studio_import.gateway_key(Session()) == 'offline_existing_gateway_12345'
    assert calls == ['sts', 'secretsmanager']


def test_wrong_account_reads_no_secret():
    class Session:
        def client(self, service, **_):
            assert service == 'sts'
            return SimpleNamespace(get_caller_identity=lambda: {'Account': '000000000000'})
    with pytest.raises(studio_import.ImportStopped, match='no gateway credential was read'):
        studio_import.gateway_key(Session())


def test_native_mode_calls_common_validator_with_frozen_named_body_before_each_post(native_args, monkeypatch):
    api = API(native_args)
    original = studio_import.validate_native_hair
    checks = []
    def validate(content, *, body_content=None):
        checks.append((content, body_content, len(api.posts)))
        return original(content, body_content=body_content)
    monkeypatch.setattr(studio_import, 'validate_native_hair', validate)
    studio_import.run(native_args, api.client)
    source = Path(native_args.file).read_bytes()
    assert checks[0] == (source, None, 0)
    assert checks[1:] == [(source, api.body, number) for number in range(3)]
    assert api.body_closed == 3


@pytest.mark.parametrize('change', ['unrigged', 'untagged', 'body_weights'])
def test_invalid_native_source_is_refused_offline_before_http_or_receipt(native_args, change):
    doc, binary = parse_glb(Path(native_args.file).read_bytes(), strict=True)
    if change == 'unrigged':
        content = hair_glb()
    else:
        if change == 'untagged': doc['nodes'][2].pop('extras')
        if change == 'body_weights':
            item = doc['accessors'][doc['meshes'][0]['primitives'][0]['attributes']['JOINTS_0']]
            offset = doc['bufferViews'][item['bufferView']]['byteOffset']
            binary = bytearray(binary); binary[offset:offset+12] = b'\0'*12
        content = build_glb(doc, bytes(binary))
    Path(native_args.file).write_bytes(content)
    native_args.sha256 = hashlib.sha256(content).hexdigest()
    api = API(native_args)
    with pytest.raises(studio_import.ImportStopped, match='Local fitted native hair validation failed'):
        studio_import.run(native_args, api.client)
    assert not api.requests and not Path(native_args.receipt).exists()


@pytest.mark.parametrize('change', ['rest', 'bind', 'clip'])
def test_native_rig_or_clip_mismatch_is_refused_even_when_body_hash_matches(native_args, change):
    doc, binary = parse_glb(native_args.body_content, strict=True)
    if change == 'rest': doc['nodes'][1]['translation'][1] += .1
    if change == 'bind':
        item = doc['accessors'][doc['skins'][0]['inverseBindMatrices']]
        offset = doc['bufferViews'][item['bufferView']]['byteOffset']+64+13*4
        binary = bytearray(binary); struct.pack_into('<f', binary, offset, -.5)
    if change == 'clip': doc['animations'][0]['name'] = 'run'
    native_args.body_content = build_glb(doc, bytes(binary))
    native_args.body_sha256 = hashlib.sha256(native_args.body_content).hexdigest()
    api = API(native_args)
    with pytest.raises(studio_import.ImportStopped, match='frozen body rig or clips'):
        studio_import.run(native_args, api.client)
    assert not api.posts and api.body_closed == 1 and not Path(native_args.receipt).exists()


def test_native_body_stream_is_bounded_before_common_validation(native_args, monkeypatch):
    api = API(native_args)
    submitted, content = studio_import.fixed_input(native_args)
    monkeypatch.setattr(studio_import, 'MAX_BYTES', 5)
    def forbidden(*_, **__):
        pytest.fail('An oversized named body must not reach native validation.')
    monkeypatch.setattr(studio_import, 'validate_native_hair', forbidden)
    with pytest.raises(studio_import.ImportStopped, match='bounded size'):
        studio_import.verify_body(api.client, submitted, native_hair=content)
    assert api.body_closed == 1 and not api.posts


@pytest.mark.parametrize('rigged', [False, None, 1, 'true'])
def test_native_upload_and_resume_require_exact_rigged_true(native_args, rigged):
    api = API(native_args)
    original = api.handle
    def handle(request):
        response = original(request)
        if request.method == 'POST' and request.url.path.endswith('/upload'):
            value = response.json(); value['rigged'] = rigged
            return httpx.Response(201, json=value)
        return response
    client = httpx.Client(base_url=studio_import.ORIGIN, headers=api.client.headers,
        transport=httpx.MockTransport(handle))
    with pytest.raises(studio_import.ImportStopped, match='not verified'):
        studio_import.run(native_args, client)
    saved = receipt(native_args)
    assert saved['phases']['upload']['state'] == 'uncertain' and len(api.posts) == 1
    api.remote[f'/api/avatar-factory/base-bodies/glb-assets/{native_args.sha256}']['rigged'] = rigged
    native_args.resume = True
    with pytest.raises(studio_import.ImportStopped, match='receipt does not match'):
        studio_import.run(native_args, client)
    assert receipt(native_args) == saved and len(api.posts) == 1


def test_receipt_freezes_native_input_mode_without_silent_conversion(native_args):
    api = API(native_args)
    result = studio_import.run(native_args, api.client)
    path = Path(native_args.receipt)
    stored = path.read_bytes()
    changed = {**result['input'], 'input_mode':'unrigged_hair'}
    with pytest.raises(studio_import.ImportStopped, match='fixed input changed'):
        studio_import.read_receipt(path, changed)
    assert path.read_bytes() == stored and len(api.posts) == 3


def test_explicit_native_cli_option_uses_existing_owner_channel(native_args, monkeypatch, capsys):
    api = API(native_args)
    options = ['import-studio-glb.py', '--fitted-native-hair']
    for option in ('file', 'sha256', 'name', 'body-job', 'body-version', 'body-sha256', 'receipt'):
        options.extend(['--'+option, getattr(native_args, option.replace('-', '_'))])
    monkeypatch.setattr(studio_import.sys, 'argv', options)
    monkeypatch.setattr(studio_import.boto3, 'Session', lambda **_: None)
    key = 'offline_gateway_fixture_123'
    monkeypatch.setattr(studio_import, 'gateway_key', lambda _: key)
    original_client = httpx.Client
    monkeypatch.setattr(studio_import.httpx, 'Client', lambda **settings:
        original_client(**settings, transport=httpx.MockTransport(api.handle)))
    studio_import.main()
    output = capsys.readouterr()
    assert key not in output.out and native_args.file not in output.out and not output.err
    assert receipt(native_args)['input']['input_mode'] == 'fitted_native_hair'
    assert json.loads(output.out)['provider_calls'] == 0 and len(api.posts) == 3
