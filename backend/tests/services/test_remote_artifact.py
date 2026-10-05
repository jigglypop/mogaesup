import asyncio
from datetime import datetime, timezone
import io

from fastapi import FastAPI
import httpx
import pytest
from starlette.requests import ClientDisconnect

from src.services.remote_artifact import CHUNK_BYTES, RemoteArtifactResponse

CONTENT = b'glTF' + b'x' * (CHUNK_BYTES * 3)
METADATA = {'ContentLength': len(CONTENT), 'ETag': '"fixed-model"',
            'LastModified': datetime(2026, 10, 1, tzinfo=timezone.utc)}


class Body(io.BytesIO):
    def __init__(self, content):
        super().__init__(content)
        self.read_sizes = []

    def read(self, size=-1):
        self.read_sizes.append(size)
        return super().read(size)


class S3:
    def __init__(self):
        self.calls, self.bodies = [], []

    def get_object(self, **parameters):
        self.calls.append(parameters)
        content = CONTENT
        if parameters.get('Range'):
            first, last = map(int, parameters['Range'].removeprefix('bytes=').split('-'))
            content = content[first:last + 1]
        body = Body(content)
        self.bodies.append(body)
        return {'Body': body}


def response(s3):
    return RemoteArtifactResponse(s3, 'offline-bucket', 'fixed/model.glb', METADATA,
                                  media_type='model/gltf-binary', headers={'Cache-Control': 'private, no-store'})


def test_s3_timezone_objects_are_normalized_for_last_modified():
    from dateutil.tz import tzutc
    metadata = {**METADATA, 'LastModified': datetime(2026, 10, 1, tzinfo=tzutc())}
    result = RemoteArtifactResponse(S3(), 'bucket', 'model', metadata, media_type='model/gltf-binary', headers={})
    assert result.headers['last-modified'] == 'Thu, 01 Oct 2026 00:00:00 GMT'


@pytest.mark.anyio
@pytest.mark.parametrize('anyio_backend', ['asyncio'])
async def test_streaming_is_bounded_and_preserves_metadata_head_and_conditional_get():
    s3, app = S3(), FastAPI()
    app.add_api_route('/model.glb', lambda: response(s3), methods=['GET', 'HEAD'])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        head = await client.head('/model.glb')
        assert head.content == b'' and head.headers['content-length'] == str(len(CONTENT))
        assert head.headers['etag'] == METADATA['ETag'] and not s3.calls
        unchanged = await client.get('/model.glb', headers={'If-None-Match': 'W/"fixed-model"'})
        assert unchanged.status_code == 304 and not s3.calls
        full = await client.get('/model.glb')
        assert full.status_code == 200 and full.content == CONTENT
        assert full.headers['content-type'] == 'model/gltf-binary'
        assert full.headers['last-modified'] == 'Thu, 01 Oct 2026 00:00:00 GMT'
        assert full.headers['accept-ranges'] == 'bytes'
        assert s3.calls[0]['IfMatch'] == METADATA['ETag']
        assert s3.bodies[0].closed and set(s3.bodies[0].read_sizes) == {CHUNK_BYTES}


@pytest.mark.anyio
@pytest.mark.parametrize('anyio_backend', ['asyncio'])
@pytest.mark.parametrize('value, start, end', [('bytes=0-3', 0, 3), ('bytes=-4', len(CONTENT)-4, len(CONTENT)-1),
                                             ('bytes=4-', 4, len(CONTENT)-1)])
async def test_valid_single_ranges_return_only_the_requested_bytes(value, start, end):
    s3, app = S3(), FastAPI()
    app.add_api_route('/model.glb', lambda: response(s3), methods=['GET'])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        part = await client.get('/model.glb', headers={'Range': value})
    assert part.status_code == 206 and part.content == CONTENT[start:end+1]
    assert part.headers['content-range'] == f'bytes {start}-{end}/{len(CONTENT)}'
    assert part.headers['content-length'] == str(end-start+1)
    assert s3.bodies[0].closed


@pytest.mark.anyio
@pytest.mark.parametrize('anyio_backend', ['asyncio'])
@pytest.mark.parametrize('value', ['bytes=-0', 'bytes=5-3', 'bytes=9999999-', 'bytes=0-1,3-4', 'garbage'])
async def test_invalid_ranges_do_not_open_a_stream(value):
    s3, app = S3(), FastAPI()
    app.add_api_route('/model.glb', lambda: response(s3), methods=['GET'])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        part = await client.get('/model.glb', headers={'Range': value})
    assert part.status_code == 416 and not s3.calls
    assert part.headers['content-range'] == f'bytes */{len(CONTENT)}'


@pytest.mark.anyio
@pytest.mark.parametrize('anyio_backend', ['asyncio'])
async def test_a_changed_if_range_validator_returns_the_full_file():
    s3, app = S3(), FastAPI()
    app.add_api_route('/model.glb', lambda: response(s3), methods=['GET'])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        full = await client.get('/model.glb', headers={'Range': 'bytes=0-3', 'If-Range': '"old-version"'})
    assert full.status_code == 200 and full.content == CONTENT and 'Range' not in s3.calls[0]


@pytest.mark.anyio
@pytest.mark.parametrize('anyio_backend', ['asyncio'])
async def test_disconnect_closes_the_owned_s3_body():
    s3, first_chunk = S3(), asyncio.Event()

    async def receive():
        await first_chunk.wait()
        return {'type': 'http.disconnect'}

    async def send(message):
        if message['type'] == 'http.response.body' and message.get('body'):
            first_chunk.set()

    await asyncio.wait_for(response(s3)({'type': 'http', 'method': 'GET', 'headers': [],
                                         'asgi': {'spec_version': '2.0'}}, receive, send), 5)
    assert first_chunk.is_set() and s3.bodies[0].closed


@pytest.mark.anyio
@pytest.mark.parametrize('anyio_backend', ['asyncio'])
async def test_send_error_closes_the_owned_s3_body():
    s3 = S3()

    async def receive():
        return {'type': 'http.disconnect'}

    async def send(message):
        if message['type'] == 'http.response.body':
            raise OSError('socket closed')

    with pytest.raises(ClientDisconnect):
        await response(s3)({'type': 'http', 'method': 'GET', 'headers': [],
                            'asgi': {'spec_version': '2.4'}}, receive, send)
    assert s3.bodies[0].closed


class ChangedS3(S3):
    """S3 whose GET after the HEAD finds the object replaced, deleted, or fails otherwise."""

    def __init__(self, code, status):
        super().__init__()
        self.code, self.status = code, status

    def get_object(self, **parameters):
        from botocore.exceptions import ClientError
        self.calls.append(parameters)
        raise ClientError({'Error': {'Code': self.code}, 'ResponseMetadata': {'HTTPStatusCode': self.status}},
                          'GetObject')


@pytest.mark.anyio
@pytest.mark.parametrize('anyio_backend', ['asyncio'])
@pytest.mark.parametrize('code, status, answer', [('PreconditionFailed', 412, (409, 'artifact_changed')),
                                                  ('NoSuchKey', 404, (404, 'not_found'))])
async def test_an_object_replaced_or_deleted_after_its_head_is_answered_as_such(code, status, answer):
    from src.api.characters import pipeline_error_handler
    from src.services.character_pipeline import PipelineError
    s3, app = ChangedS3(code, status), FastAPI()
    app.add_exception_handler(PipelineError, pipeline_error_handler)
    app.add_api_route('/model.glb', lambda: response(s3), methods=['GET'])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        received = await client.get('/model.glb', headers={'Range': 'bytes=0-3'})
    assert (received.status_code, received.json()['error']['code']) == answer
    assert s3.calls[0]['IfMatch'] == METADATA['ETag'] and not s3.bodies


@pytest.mark.anyio
@pytest.mark.parametrize('anyio_backend', ['asyncio'])
async def test_other_s3_failures_stay_errors():
    from botocore.exceptions import ClientError
    s3, app = ChangedS3('InternalError', 500), FastAPI()
    app.add_api_route('/model.glb', lambda: response(s3), methods=['GET'])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        with pytest.raises(ClientError):
            await client.get('/model.glb')
