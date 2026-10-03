"""The MCP adapter makes only allowlisted authenticated calls to a fake gateway."""
import asyncio
import json
import os
import sys

import httpx
import pytest

from src.studio_mcp import StudioClient, build_server

SESSION = 'a'*64
CHARACTER = 'char-'+'b'*12
JOB = 'c'*24
OPERATION = 'd'*32


@pytest.fixture
def adapter():
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={'operation': {'id': OPERATION, 'status': 'accepted'}})
    client = StudioClient('http://127.0.0.1:8080', SESSION, app_origin='http://localhost:5173',
                          writable=True, transport=httpx.MockTransport(handler))
    yield client, calls
    client.close()


def test_exact_read_routes_and_session_stays_in_transport(adapter):
    client, calls = adapter
    expected = {'get_my_permissions': '/api/auth/me', 'list_catalog_items': '/api/catalog/items',
                'list_wardrobe_bodies': '/api/avatar-factory/wardrobe/bodies', 'get_my_look': '/api/looks/me',
                'get_factory_usage': '/api/catalog/admin/factory-usage', 'get_character': '/api/characters/'+CHARACTER,
                'get_factory_job': '/api/avatar-factory/jobs/'+JOB,
                'get_native_assembly': '/api/avatar-factory/jobs/'+JOB+'/native-parts'}
    for name, path in expected.items():
        result = client.read(name, CHARACTER if name == 'get_character' else JOB)
        assert result['ok']
        assert calls[-1].url.path == path
        assert calls[-1].headers['cookie'] == 'mogaesup_session='+SESSION
        assert calls[-1].headers['origin'] == 'http://localhost:5173'
        assert SESSION not in json.dumps(result)
    client.read('get_character_operation', CHARACTER, OPERATION)
    assert calls[-1].url.path == '/api/characters/'+CHARACTER+'/operations/'+OPERATION


def test_allowlisted_mutations_keep_existing_revision_and_idempotency(adapter):
    client, calls = adapter
    assert client.action(CHARACTER, 'inspect_model', 'r123', 'request-1234', {})['ok']
    assert calls[-1].method == 'POST'
    assert calls[-1].url.path.endswith('/actions/inspect_model')
    assert calls[-1].headers['if-match'] == 'r123'
    assert calls[-1].headers['idempotency-key'] == 'request-1234'
    assert json.loads(calls[-1].content) == {}
    body = {'decision': 'approved', 'notes': '외형 및 동작 확인', 'appearance_checked': True, 'motion_checked': True}
    assert client.action(CHARACTER, 'record_review', 'r124', 'request-1235', body)['ok']
    assert json.loads(calls[-1].content) == body
    assert client.native_review(JOB, 'e'*24, 'f'*64, 'native-review-1234', body)['ok']
    assert calls[-1].url.path == f'/api/avatar-factory/jobs/{JOB}/native-parts/'+('e'*24)+'/review'
    assert calls[-1].headers['idempotency-key'] == 'native-review-1234'
    assert json.loads(calls[-1].content) == {'expected_assembly_sha256': 'f'*64, **body}
    assert 'if-match' not in calls[-1].headers


def test_mutation_opt_in_and_arbitrary_api_code_path_are_rejected(adapter):
    client, calls = adapter
    client.writable = False
    assert client.action(CHARACTER, 'inspect_model', 'r', 'request-1234', {})['error']['code'] == 'mcp_read_only'
    assert client.native_review(JOB, 'e'*24, 'f'*64, 'request-1234', {})['error']['code'] == 'mcp_read_only'
    client.writable = True
    for args in [(CHARACTER, 'submit_generation', 'r', 'request-1234', {}),
                 ('../characters/other', 'inspect_model', 'r', 'request-1234', {}),
                 (CHARACTER, 'inspect_model', 'r', 'request-1234', {'code': 'anything'}),
                 (CHARACTER, 'record_review', 'r', 'request-1234', {'decision': 'approved', 'notes': 'valid notes',
                     'appearance_checked': True, 'motion_checked': True, 'path': '/private/data'})]:
        with pytest.raises(ValueError):
            client.action(*args)
    for tool, identifier in [('arbitrary_http', ''), ('get_character', '../escape'), ('get_factory_job', '/tmp/path')]:
        with pytest.raises(ValueError):
            client.read(tool, identifier)
    assert calls == []


@pytest.mark.parametrize('override', [{'job_id': '../escape'}, {'version': '/tmp/file'},
    {'expected_assembly_sha256': 'not a hash'}, {'key': 'short'},
    {'body': {'decision': 'approved', 'notes': 'valid notes', 'appearance_checked': True, 'motion_checked': True, 'path': '/tmp/code'}}])
def test_native_review_accepts_only_typed_identity_and_review(adapter, override):
    client, calls = adapter
    arguments = {'job_id': JOB, 'version': 'e'*24, 'expected_assembly_sha256': 'f'*64, 'key': 'native-key-1234',
                 'body': {'decision': 'approved', 'notes': 'valid notes', 'appearance_checked': True, 'motion_checked': True}, **override}
    with pytest.raises(ValueError):
        client.native_review(**arguments)
    assert calls == []


@pytest.mark.parametrize('origin', ['http://example.com', 'https://user:pass@example.com', 'https://example.com/api',
                                   'https://example.com?token=private', 'https://example.com:invalid', 'file:///tmp/server'])
def test_adapter_origin_is_operator_configured_and_bounded(origin):
    with pytest.raises(ValueError):
        StudioClient(origin, SESSION)


def test_private_output_is_cleaned_and_relative_artifact_urls_survive():
    value = {'access_token': 'private-token', 'payload': {'code': 'private code'}, 'executor_process': {'pid': 1},
             'artifact': {'url': '/api/characters/'+CHARACTER+'/artifacts/model', 'sha256': 'e'*64},
             'error': '/Users/operator/private/file.glb', 'aws': 'https://example.com/glb?signature=private', 'session': SESSION}
    with StudioClientForTest(value) as client:
        result = client.read('get_my_permissions')
    assert result['data']['artifact'] == value['artifact']
    encoded = json.dumps(result)
    assert all(secret not in encoded for secret in ('private-token', 'private code', '/Users/operator', 'signature=private', SESSION))


class StudioClientForTest(StudioClient):
    def __init__(self, response):
        super().__init__('http://localhost:8080', SESSION,
                         transport=httpx.MockTransport(lambda request: httpx.Response(200, json=response)))
    def __enter__(self):
        return self
    def __exit__(self, *args):
        self.close()


def test_timed_out_mutation_has_no_automatic_retry():
    calls = []
    def handler(request):
        calls.append(request)
        raise httpx.ReadTimeout('private server detail', request=request)
    client = StudioClient('http://localhost:8080', SESSION, writable=True, transport=httpx.MockTransport(handler))
    try:
        value = client.action(CHARACTER, 'inspect_model', 'r', 'request-1234', {})
        assert value['error']['code'] == 'api_unavailable'
        assert len(calls) == 1
        assert 'private server detail' not in json.dumps(value)
    finally:
        client.close()


@pytest.mark.parametrize('code, expected', [('revision_conflict', 'revision_conflict'),
    ('idempotency_conflict', 'idempotency_conflict'), ('private-token', 'api_refused')])
def test_api_failure_preserves_only_known_codes_and_never_private_details(code, expected):
    client = StudioClient('http://localhost:8080', SESSION,
        transport=httpx.MockTransport(lambda request: httpx.Response(409,
            json={'error': {'code': code, 'message': '/Users/operator/private detail '+SESSION}})))
    try:
        result = client.read('get_my_permissions')
        assert result['error']['code'] == expected
        assert result['status'] == 409
        assert all(value not in json.dumps(result) for value in (SESSION, '/Users/operator', 'private-token'))
    finally:
        client.close()


def test_rust_gateway_top_level_error_code_is_preserved():
    client = StudioClient('http://localhost:8080', SESSION,
        transport=httpx.MockTransport(lambda request: httpx.Response(401,
            json={'code': 'login_required', 'message': 'private message'})))
    try:
        assert client.read('get_my_permissions')['error']['code'] == 'login_required'
    finally:
        client.close()


def test_sdk_tools_have_typed_schemas_and_reject_invalid_inputs_before_transport(adapter):
    pytest.importorskip('mcp')
    client, calls = adapter
    server = build_server(client)
    tools = {tool.name: tool for tool in asyncio.run(server.list_tools())}
    assert set(tools) == {'get_my_permissions', 'list_catalog_items', 'list_wardrobe_bodies', 'get_my_look',
                         'get_factory_usage', 'get_character', 'get_character_operation', 'get_factory_job',
                         'get_native_assembly', 'inspect_character', 'record_character_review', 'record_native_review'}
    assert all(tool.outputSchema for tool in tools.values())
    assert tools['get_native_assembly'].inputSchema['properties']['job_id']['pattern'] == '^[a-f0-9]{24}$'
    assert tools['get_native_assembly'].annotations.readOnlyHint
    assert tools['inspect_character'].annotations.idempotentHint
    assert tools['record_native_review'].inputSchema['properties']['expected_assembly_sha256']['pattern'] == '^[a-f0-9]{64}$'
    with pytest.raises(Exception):
        asyncio.run(server.call_tool('get_factory_job', {'job_id': '../escape'}))
    assert calls == []
    asyncio.run(server.call_tool('inspect_character', {'character_id': CHARACTER, 'revision': 'r1', 'idempotency_key': 'request-1234'}))
    assert len(calls) == 1
    assert calls[0].url.path.endswith('/actions/inspect_model')
    asyncio.run(server.call_tool('record_native_review', {'job_id': JOB, 'version': 'e'*24,
        'expected_assembly_sha256': 'f'*64, 'idempotency_key': 'native-key-1234',
        'review': {'decision': 'changes_requested', 'notes': '옷 겹침 수정 필요', 'appearance_checked': False, 'motion_checked': False}}))
    assert len(calls) == 2
    assert calls[-1].url.path.endswith('/native-parts/'+('e'*24)+'/review')


def test_local_stdio_process_initializes_and_lists_tools_without_api_calls():
    pytest.importorskip('mcp')
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    async def check():
        params = StdioServerParameters(command=sys.executable, args=['-m', 'src.studio_mcp'],
            env={**os.environ, 'MOGA_STUDIO_API_URL': 'http://127.0.0.1:1', 'MOGA_STUDIO_SESSION': SESSION,
                 'MOGA_STUDIO_MCP_WRITE': '0'})
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                initialized = await session.initialize()
                assert initialized.protocolVersion == '2025-11-25'
                result = await session.list_tools()
                assert len(result.tools) == 12
                assert SESSION not in result.model_dump_json()
                response = await session.call_tool('inspect_character', {
                    'character_id': CHARACTER, 'revision': 'r1', 'idempotency_key': 'request-1234'})
                assert response.structuredContent['error']['code'] == 'mcp_read_only'
    asyncio.run(check())
