"""Layout interpretation stays offline; provider responses and all paid calls are mocked."""
import json
from unittest.mock import Mock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api.characters import pipeline_error_handler
from src.api.layouts import router
from src.auth import UserContext, get_current_user
from src.services.character_pipeline import PipelineError, read_json
from src.services.store_layouts import StoreLayouts, interpret_rules


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('ASSET_DATA_ROOT', str(tmp_path))
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    monkeypatch.delenv('LAYOUT_TEXT_MODEL', raising=False)
    app = FastAPI(); app.include_router(router, prefix='/api')
    app.add_exception_handler(PipelineError, pipeline_error_handler)
    app.dependency_overrides[get_current_user] = lambda: UserContext(1, 'operator', ['ADMIN'])
    with TestClient(app) as value:
        yield value, tmp_path, app


def test_rules_work_without_provider_or_payment(client, monkeypatch):
    api, _, _ = client
    post = Mock(side_effect=AssertionError('rules must not contact provider'))
    monkeypatch.setattr(httpx.Client, 'post', post)
    # TestClient itself uses post, so invoke the service directly for the no-provider assertion.
    result = interpret_rules('가로 10 세로 12 사무실 4인 콘크리트')
    assert result['kind'] == 'office' and result['widthCells'] == 3 and result['seats'] == 4
    assert result['floorPresetId'] == 'concrete' and result['wallPresetId'] == 'modern-concrete'
    assert len(result['warnings']) == 1
    assert interpret_rules('3×4칸 커피 매장')['depthCells'] == 4
    assert interpret_rules('매장')['seats'] == 0
    post.assert_not_called()


@pytest.mark.parametrize('description', ['', '40m×12m 매장', '13인 카페', 'x'*2001])
def test_rules_reject_unbounded_intent(description):
    with pytest.raises(PipelineError) as error:
        interpret_rules(description)
    assert error.value.status == 422


def test_capabilities_and_ai_input_are_authenticated_and_bounded(client):
    api, _, app = client
    assert api.get('/api/studio/layouts/capabilities').json() == {'rules': True, 'ai': False}
    assert api.post('/api/studio/layouts/interpret', json={'description': '카페', 'mode': 'rules'}).status_code == 200
    for body in ({'description': '카페', 'mode': 'ai'}, {'description': '카페', 'mode': 'ai', 'requestId': '../path'},
                 {'description': '카페', 'mode': 'rules', 'command': 'execute'}, {'description': ' '}, {'description': 'x'*2001}):
        assert api.post('/api/studio/layouts/interpret', json=body).status_code == 422
    app.dependency_overrides.clear()
    assert api.get('/api/studio/layouts/capabilities').status_code in (401, 403, 503)


def test_ai_requires_matching_header_and_available_key_without_post(client, monkeypatch):
    api, _, _ = client
    body = {'description': '카페', 'mode': 'ai', 'requestId': 'layout-req-001'}
    assert api.post('/api/studio/layouts/interpret', json=body).status_code == 422
    assert api.post('/api/studio/layouts/interpret', json=body, headers={'Idempotency-Key': body['requestId']}).status_code == 503


def test_gateway_member_token_cannot_pay_even_when_provider_is_available(client, monkeypatch):
    api, _, app = client
    monkeypatch.setenv('OPENAI_API_KEY', 'offline-provider-fixture')
    app.dependency_overrides[get_current_user] = lambda: UserContext(1, 'member', ['ADMIN', 'MEMBER'])
    assert api.get('/api/studio/layouts/capabilities').json()['ai'] is False
    response = api.post('/api/studio/layouts/interpret', json={'description': '카페', 'mode': 'ai', 'requestId': 'layout-req-001'},
                        headers={'Idempotency-Key': 'layout-req-001'})
    assert response.status_code == 403


def paid_provider(monkeypatch, path, result=None, fail=False):
    monkeypatch.setenv('OPENAI_API_KEY', 'offline-provider-fixture')
    calls = []
    class Client:
        def __init__(self, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def post(self, url, **kwargs):
            assert read_json(path)['status'] == 'submitting'  # Intent committed BEFORE payment.
            calls.append((url, kwargs))
            if fail: raise httpx.ReadTimeout('offline timeout')
            document = {'id': 'resp-fixture', 'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(result)}]}]}
            return httpx.Response(200, json=document, request=httpx.Request('POST', url))
    monkeypatch.setattr('src.services.store_layouts.httpx.Client', Client)
    return calls


def test_paid_intent_durable_replay_and_owner_separation(client, monkeypatch):
    _, root, _ = client
    path = root/'avatar-factory/layout-interpretations/1/layout-req-001/record.json'
    result = {**interpret_rules('12m×12m 카페2인'), 'interpretation': 'ai'}
    calls = paid_provider(monkeypatch, path, result)
    service = StoreLayouts(1)
    assert service.interpret('카페', 'ai', 'layout-req-001') == result
    assert StoreLayouts(1).interpret('카페', 'ai', 'layout-req-001') == result
    assert len(calls) == 1
    payload = calls[0][1]['json']
    assert payload['model'] == 'gpt-4.1-mini' and payload['store'] is False
    assert payload['text']['format']['strict'] is True and payload['text']['format']['schema']['additionalProperties'] is False
    assert read_json(path)['providerResponseId'] == 'resp-fixture'
    with pytest.raises(PipelineError, match='설명이 달라졌습니다'):
        service.interpret('사무실', 'ai', 'layout-req-001')
    assert not (root/'avatar-factory/layout-interpretations/2/layout-req-001/record.json').exists()


@pytest.mark.parametrize('invalid_result', [None, {'kind': 'cafe', 'command': 'execute'}])
def test_uncertain_payment_never_resubmits(client, monkeypatch, invalid_result):
    _, root, _ = client
    path = root/'avatar-factory/layout-interpretations/1/layout-req-001/record.json'
    calls = paid_provider(monkeypatch, path, invalid_result, fail=invalid_result is None)
    with pytest.raises(PipelineError) as first:
        StoreLayouts(1).interpret('카페', 'ai', 'layout-req-001')
    assert first.value.status == 504
    assert read_json(path)['status'] == 'uncertain'
    with pytest.raises(PipelineError) as repeated:
        StoreLayouts(1).interpret('카페', 'ai', 'layout-req-001')
    assert repeated.value.status == 409 and len(calls) == 1


def test_drain_blocks_receipt_and_provider(client, monkeypatch):
    _, root, _ = client
    monkeypatch.setenv('OPENAI_API_KEY', 'offline-provider-fixture')
    from src.services.runtime_activity import begin_drain, resume
    token = 'a'*32
    begin_drain(token)
    try:
        from src.services.runtime_activity import RuntimeDraining
        with pytest.raises(RuntimeDraining):
            StoreLayouts(1).interpret('카페', 'ai', 'layout-req-001')
        assert not (root/'avatar-factory/layout-interpretations/1/layout-req-001/record.json').exists()
    finally:
        resume(token)


@pytest.mark.parametrize('provider_failed', [False, True])
def test_final_receipt_failure_keeps_paid_reservation_and_original_submission(client, monkeypatch, provider_failed):
    _, root, _ = client
    path = root/'avatar-factory/layout-interpretations/1/layout-req-001/record.json'
    result = {**interpret_rules('카페'), 'interpretation': 'ai'}
    calls = paid_provider(monkeypatch, path, result, fail=provider_failed)
    from src.services import store_layouts
    real_write = store_layouts._write_json
    def write(record_path, document):
        if document['status'] != 'submitting':
            raise OSError('offline storage fixture failure')
        real_write(record_path, document)
    monkeypatch.setattr(store_layouts, '_write_json', write)
    with pytest.raises(PipelineError) as error:
        StoreLayouts(1).interpret('카페', 'ai', 'layout-req-001')
    assert error.value.status == 504
    assert read_json(path)['status'] == 'submitting'
    with pytest.raises(PipelineError) as replay:
        StoreLayouts(1).interpret('카페', 'ai', 'layout-req-001')
    assert replay.value.status == 409 and len(calls) == 1
