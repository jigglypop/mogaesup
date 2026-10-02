"""Authenticated same-origin delivery of S3 artifacts with bounded reads and owned cleanup."""
import re

import anyio
from starlette.datastructures import Headers
from starlette.responses import Response, StreamingResponse

CHUNK_BYTES = 256 * 1024


def _range(value, total):
    match = re.fullmatch(r'bytes=(\d*)-(\d*)', value.strip())
    if not match or not any(match.groups()) or total <= 0:
        raise ValueError('invalid range')
    first, last = match.groups()
    if not first:
        count = int(last)
        if count <= 0:
            raise ValueError('invalid suffix range')
        return max(0, total - count), total - 1
    start, end = int(first), min(int(last), total - 1) if last else total - 1
    if start > end or start >= total:
        raise ValueError('unsatisfiable range')
    return start, end


class RemoteArtifactResponse(StreamingResponse):
    def __init__(self, client, bucket, key, metadata, *, media_type, headers):
        self.client, self.bucket, self.key, self.metadata = client, bucket, key, metadata
        self._body = None
        headers = {**headers, 'Accept-Ranges': 'bytes'}
        if type(metadata.get('ContentLength')) is int:
            headers['Content-Length'] = str(metadata['ContentLength'])
        if metadata.get('ETag'):
            headers['ETag'] = metadata['ETag']
        if metadata.get('LastModified'):
            from datetime import timezone
            from email.utils import format_datetime
            headers['Last-Modified'] = format_datetime(metadata['LastModified'].astimezone(timezone.utc), usegmt=True)
        super().__init__(iter(()), media_type=media_type, headers=headers)

    async def __call__(self, scope, receive, send):
        request = Headers(scope=scope)
        headers = dict(self.headers)
        etag = headers.get('etag')
        candidates = [value.strip().removeprefix('W/') for value in request.get('if-none-match', '').split(',')]
        if etag and (etag in candidates or '*' in candidates):
            headers.pop('content-length', None)
            await Response(status_code=304, headers=headers)(scope, receive, send)
            return
        if scope['method'] == 'HEAD':
            await Response(headers=headers)(scope, receive, send)
            return
        parameters = {'Bucket': self.bucket, 'Key': self.key}
        if etag:
            parameters['IfMatch'] = etag
        status = 200
        byte_range = request.get('range')
        if_range = request.get('if-range')
        if byte_range and (not if_range or if_range in (etag, headers.get('last-modified'))):
            try:
                total = self.metadata['ContentLength']
                start, end = _range(byte_range, total)
            except (KeyError, TypeError, ValueError):
                headers['content-range'] = f'bytes */{self.metadata.get("ContentLength", "*")}'
                headers.pop('content-length', None)
                await Response(status_code=416, headers=headers)(scope, receive, send)
                return
            parameters['Range'] = f'bytes={start}-{end}'
            headers['content-range'] = f'bytes {start}-{end}/{total}'
            headers['content-length'] = str(end - start + 1)
            status = 206

        def open_body():
            value = self.client.get_object(**parameters)
            self._body = value['Body']

        def chunks():
            while chunk := self._body.read(CHUNK_BYTES):
                yield chunk

        try:
            # A cancelled caller still waits for the owned blocking operation; its body is then closed below.
            await anyio.to_thread.run_sync(open_body)
            response = StreamingResponse(chunks(), status_code=status, media_type=self.media_type, headers=headers)
            await response(scope, receive, send)
        finally:
            if self._body is not None:
                with anyio.CancelScope(shield=True):
                    await anyio.to_thread.run_sync(self._body.close)
