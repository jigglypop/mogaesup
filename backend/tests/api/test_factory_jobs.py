"""GET /api/avatar-factory/jobs and POST /api/avatar-factory/jobs/{id}/resume on disposable job records.

Every studio tab polls the job listing every 10 s and the app server reads it too. Its megabytes of JSON are encoded in
the worker thread, once per listing snapshot, into the bytes FastAPI rendered the returned dict to before."""
import asyncio
import json

import fastapi.routing
import pytest
from fastapi import FastAPI
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from src.api.avatar_factory import get_factory, router
from src.api.characters import pipeline_error_handler
from src.auth import UserContext, get_current_user
from src.services import avatar_character_flow
from src.services.avatar_base_bodies import AvatarBaseBodies
from src.services.character_pipeline import PipelineError
from wardrobe_fixture import OWNER, Library, put

BODY, BODY_VERSION, PART, PLAIN, LATER = 'b' * 24, '1' * 24, 'c' * 24, 'd' * 24, 'e' * 24
V1 = 'a' * 24
NAME = '모개숲 주민 "하나" \\ 줄\n바꿈 😀 </script>'


@pytest.fixture
def library(tmp_path):
    library = Library(tmp_path)
    library.job(BODY, name='기본 몸', job_kind='base_body')
    library.assembly(BODY, BODY_VERSION)
    library.current(BODY, BODY_VERSION)
    library.register((BODY, BODY_VERSION))
    library.job(PART, base=(BODY, BODY_VERSION), requested=['hair'], name=NAME,
                fit={'ratio': 0.1 + 0.2, 'height': 1.81, 'large': 2 ** 53 + 1, 'flags': [True, False, None],
                     'empty': {}, 'none': []})
    library.assembly(PART, V1)
    library.current(PART, V1)
    # A job of the removed local factory: no image input, files listed as artifacts.
    put(library.directory(PLAIN)/'job.json', {'id': PLAIN, 'status': 'failed', 'created_at': '2026-09-19T00:00:00+00:00',
                                              'error': '작업 기록 오류 — 다시 생산해 주세요', 'files': {'front.png': 'f' * 64}})
    library.catalog()
    return library


@pytest.fixture
def client(library):
    app = FastAPI()
    app.include_router(router, prefix='/api')
    app.add_exception_handler(PipelineError, pipeline_error_handler)
    app.dependency_overrides[get_factory] = lambda: library.factory
    app.dependency_overrides[get_current_user] = lambda: UserContext(OWNER, 'tester', ['ADMIN'])
    with TestClient(app) as client:
        yield client


def test_the_job_listing_is_the_json_a_returned_dict_was_rendered_to(client, library):
    response = client.get('/api/avatar-factory/jobs')

    assert response.status_code == 200
    assert response.headers['content-type'] == 'application/json'
    jobs = library.factory.listing(OWNER)
    assert [job['id'] for job in jobs] == [PLAIN, PART, BODY]
    # What FastAPI made of {'jobs': listing} before: jsonable_encoder, then starlette's JSONResponse.
    assert response.content == JSONResponse(jsonable_encoder({'jobs': jobs})).body
    assert response.headers['content-length'] == str(len(response.content))
    # Korean text and emoji stay UTF-8, as before (ensure_ascii=False).
    assert '모개숲 주민'.encode() in response.content and '😀'.encode() in response.content
    listed = response.json()['jobs']
    assert listed[1]['character_name'] == NAME and listed[1]['fit']['ratio'] == 0.1 + 0.2
    assert listed[0]['artifacts'] == [{'name': 'front.png', 'sha256': 'f' * 64,
                                       'url': f'/api/avatar-factory/jobs/{PLAIN}/artifacts/front.png'}]


def test_a_listing_snapshot_is_shared_and_encoded_once_until_it_is_replaced(library):
    factory = library.factory
    first = factory.listing_json(OWNER)

    assert factory.listing_json(OWNER) is first
    # Callers get the snapshot itself, not a deep copy of every job per call.
    assert factory.listing(OWNER) is factory.listing(OWNER)
    library.job(LATER, name='새 작업')
    factory._listings.pop(OWNER)  # What a service does once it has created a job.
    second = factory.listing_json(OWNER)
    assert second is not first
    assert [job['id'] for job in json.loads(second)['jobs']] == [LATER, PLAIN, PART, BODY]
    assert factory.listing_json(OWNER) is second
    assert json.loads(second)['jobs'][1:] == json.loads(first)['jobs']


def test_the_listing_is_encoded_in_a_worker_thread_and_not_again_on_the_event_loop(client, library, monkeypatch):
    factory = library.factory
    encode, threads = factory.listing_json, []

    def listing_json(owner):
        try:
            asyncio.get_running_loop()
            threads.append('event loop')
        except RuntimeError:
            threads.append('worker thread')
        return encode(owner)

    async def serialize_response(**kwargs):
        raise AssertionError('FastAPI encoded the job listing on the event loop')

    monkeypatch.setattr(factory, 'listing_json', listing_json)
    monkeypatch.setattr(fastapi.routing, 'serialize_response', serialize_response)
    response = client.get('/api/avatar-factory/jobs')

    assert response.status_code == 200 and threads == ['worker thread']
    assert response.content == encode(OWNER)


def test_listing_callers_leave_the_shared_snapshot_unchanged(library):
    factory = library.factory
    encoded = factory.listing_json(OWNER)
    before = json.dumps(factory.listing(OWNER), sort_keys=True)

    library.wardrobe.bodies()
    assert {part['job_id'] for part in library.wardrobe.parts(BODY)['parts']} == {PART, BODY}
    library.wardrobe.parts(BODY, operator=False)
    assert [job['id'] for job in AvatarBaseBodies(factory).listing(OWNER)] == [BODY]

    assert json.dumps(factory.listing(OWNER), sort_keys=True) == before
    assert factory.listing_json(OWNER) is encoded


def test_resume_refuses_a_second_continuation_while_the_character_flow_runs(client, library, monkeypatch):
    continued = []
    monkeypatch.setattr(avatar_character_flow, 'continue_character',
                        lambda factory, owner, job_id: continued.append(job_id))
    # A continuation is rigging the job: its worker record says so, and the job reads as busy.
    worker = library.directory(PART)/'meshy/worker.json'
    put(worker, {'status': 'running'})
    assert client.get(f'/api/avatar-factory/jobs/{PART}').json()['character_flow']['busy'] is True

    response = client.post(f'/api/avatar-factory/jobs/{PART}/resume')

    assert response.status_code == 409
    assert response.json() == {'error': {'code': 'worker_running', 'message': '진행 중인 작업입니다.'}}
    assert continued == []
    # Once that run has ended, the job continues again.
    put(worker, {'status': 'complete'})
    assert client.get(f'/api/avatar-factory/jobs/{PART}').json()['character_flow']['busy'] is False
    assert client.post(f'/api/avatar-factory/jobs/{PART}/resume').status_code == 202
    assert continued == [PART]
