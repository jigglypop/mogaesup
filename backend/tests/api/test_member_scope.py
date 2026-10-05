"""A member's wardrobe reads as they reach the API in the AWS container: from the loopback, with Host 127.0.0.1 and the
X-User-Id 1 nginx adds on the SSM port, carrying the token the studio gateway signs with MEMBER (server/src/factory.rs).
The token decides: a member is listed and served only what the wardrobe offers, whatever header came with it."""
import jwt as pyjwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api.avatar_factory import get_factory, router
from src.api.characters import pipeline_error_handler
from src.services.character_pipeline import PipelineError, read_json
from wardrobe_fixture import Library, put, sha

BODY, BODY_VERSION, PART, V1, LATER = 'b' * 24, '1' * 24, 'c' * 24, 'a' * 24, '6' * 24
SECRET = 'x' * 32


def token(*roles, name='member-7', exp=4102444800):
    return 'Bearer ' + pyjwt.encode({'sub': '1', 'userId': 1, 'roles': list(roles), 'token_type': 'access', 'name': name,
                                     'iss': 'mogaesup', 'aud': 'mogaesup-client', 'exp': exp},
                                    SECRET.encode(), algorithm='HS256')


MEMBER = {'authorization': token('ADMIN', 'MEMBER')}
OPERATOR = {'authorization': token('ADMIN', name='studio-admin')}
OWNER = {}   # the owner's own studio requests carry no token


@pytest.fixture
def library(tmp_path, monkeypatch):
    monkeypatch.setenv('JWT_SECRET', SECRET)
    library = Library(tmp_path)
    library.job(BODY)
    library.assembly(BODY, BODY_VERSION, slots=(), contents={'body': b'body'})
    library.current(BODY, BODY_VERSION)
    library.register((BODY, BODY_VERSION))
    library.job(PART, base=(BODY, BODY_VERSION), requested=['hair', 'top'])
    library.assembly(PART, V1, contents={'hair': b'hair', 'model': b'whole character'})
    record = library.directory(PART)/'native-parts'/V1/'record.json'
    value = read_json(record)
    value['result']['parts'].append({'slot': 'top', 'available': False, 'unavailable_reason': 'fit_exception'})
    put(record, value)
    library.current(PART, V1)
    library.catalog()
    return library


@pytest.fixture
def client(library):
    app = FastAPI()
    app.include_router(router, prefix='/api')
    app.add_exception_handler(PipelineError, pipeline_error_handler)
    app.dependency_overrides[get_factory] = lambda: library.factory
    # What nginx makes of every request: the loopback peer, its own Host, and X-User-Id 1.
    with TestClient(app, base_url='http://127.0.0.1', client=('127.0.0.1', 41234), headers={'x-user-id': '1'}) as client:
        yield client


def files(client, headers, name):
    return client.get(f'/api/avatar-factory/jobs/{PART}/native-parts/{V1}/{name}', headers=headers)


def test_a_member_loads_only_the_part_files_the_wardrobe_offers(client):
    assert files(client, MEMBER, 'hair.glb').content == b'hair'
    for name in ('model.glb', 'body.glb', 'record.json'):
        assert files(client, MEMBER, name).status_code == 404
    # Operators, by token or as the owner without one, read every assembly file.
    assert files(client, OPERATOR, 'model.glb').content == b'whole character'
    assert files(client, OWNER, 'model.glb').content == b'whole character'


def test_a_member_listing_has_no_unavailable_parts_or_fit_messages(client):
    member = client.get(f'/api/avatar-factory/wardrobe/bodies/{BODY}/parts', headers=MEMBER).json()
    operator = client.get(f'/api/avatar-factory/wardrobe/bodies/{BODY}/parts', headers=OWNER).json()
    assert [row['slot'] for row in operator['unavailable']] == ['top']
    assert member['unavailable'] == [] and [part['slot'] for part in member['parts']] == ['hair']


@pytest.mark.parametrize('authorization', [token('ADMIN', 'MEMBER', exp=1), token('ADMIN', 'MEMBER')[:-3] + 'abc',
                                           'Bearer garbage'], ids=['expired', 'bad-signature', 'not-a-jwt'])
def test_a_token_that_fails_is_refused_not_served_as_the_owner(client, authorization):
    response = files(client, {'authorization': authorization}, 'model.glb')
    assert response.status_code == 401 and response.content != b'whole character'


def test_without_jwt_secret_a_token_is_refused_not_served_as_the_owner(client, monkeypatch):
    monkeypatch.delenv('JWT_SECRET')
    response = files(client, MEMBER, 'model.glb')
    assert response.status_code == 503 and response.content != b'whole character'


def test_a_member_reads_previews_colours_and_coverage_only_at_the_offered_version(client, library):
    # A later assembly of the part job that the job does not offer (its current version stays V1).
    library.assembly(PART, LATER, contents={'hair': b'later hair'})
    for job, version in ((PART, LATER), (PART, V1)):
        drawing = sha(f'{job}:{version}:drawing')
        put(library.directory(job)/'pipeline.json',
            {'parts': [{'slot': 'hair', 'views': {'front': {'file': 'front.png', 'sha256': drawing}}}]})
        root = library.wardrobe.library.root/'wardrobe-previews'
        root.mkdir(parents=True, exist_ok=True)
        (root/f'{drawing[:32]}-plain-v2.png').write_bytes(b'png')
        colours = library.wardrobe.library.root/'wardrobe-colors'
        colours.mkdir(parents=True, exist_ok=True)
        part_sha = read_json(library.directory(job)/'native-parts'/version/'record.json')['files']['hair.glb']
        put(colours/f'{part_sha[:20]}-v3.json', {'slot': 'hair', 'material': 0, 'regions': []})
        (colours/f'{part_sha[:20]}-v3.png').write_bytes(b'mask')
        coverage = library.wardrobe.library.root/'wardrobe-coverage'
        body_sha = library.wardrobe._stored()['bodies'][0]['body_sha256']
        put(coverage/f'{body_sha[:20]}-{part_sha[:20]}-v12.json', {'slot': 'hair', 'covers_bottom': False})

    def reads(headers, version):
        return [client.get(f'/api/avatar-factory/wardrobe/previews/{PART}/hair', params={'version': version}, headers=headers),
                client.get(f'/api/avatar-factory/wardrobe/colors/{PART}/hair', params={'version': version}, headers=headers),
                client.get(f'/api/avatar-factory/wardrobe/colors/{PART}/hair/mask', params={'version': version}, headers=headers),
                client.get(f'/api/avatar-factory/wardrobe/bodies/{BODY}/coverage/{PART}/hair', params={'version': version},
                           headers=headers)]

    # The drawing is cached per version: the pipeline names the one written last (LATER's loop ran first, so V1's).
    assert [response.status_code for response in reads(MEMBER, V1)] == [200, 200, 200, 200]
    assert [response.status_code for response in reads(MEMBER, LATER)] == [404, 404, 404, 404]
    assert all(response.json()['error']['code'] == 'not_found' for response in reads(MEMBER, LATER))
    # The studio's operators still look at any version.
    assert [response.status_code for response in reads(OWNER, LATER)][1:] == [200, 200, 200]
