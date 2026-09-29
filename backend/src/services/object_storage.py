"""S3 is durable storage; filesystem paths are logical keys or Blender scratch files.

With CHARACTER_DATABASE_URL set, the `.json` records of the same namespaces live in PostgreSQL
(src.services.record_store) and only binary artifacts stay in S3. The database alone then decides
whether a record exists: JSON objects that the import left in S3 are never read or listed again.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from functools import lru_cache
import base64
import hashlib
import io
import json
import mimetypes
import os
from pathlib import Path as LocalPath, PurePosixPath
import stat
from threading import RLock
import time

from src.services import record_store

_working = ContextVar('asset_workspaces', default=())
_cache = {}
_content_cache = {}
_key_index = {}
_written_keys = {}
_generations = {}
_changes = {}
_cache_lock = RLock()
_workspace_lock = RLock()   # guards the bookkeeping below, never held while a worker runs
_directory_locks = {}       # one active workspace per local directory
_materialized = {}          # shared input path -> [workspaces using it, created by a workspace]


def _change_scope(path):
    from src.paths import data_root
    try:
        relative = LocalPath(path).resolve().relative_to(LocalPath(data_root()).resolve())
    except (ValueError, OSError):
        return None
    return '/'.join(relative.parts[:3]) if len(relative.parts) > 3 else None


def mark_changed(path):
    scope = _change_scope(path)
    if scope:
        with _cache_lock:
            _changes[scope] = time.monotonic()


def changed_since(path, since):
    """True when this process wrote under the path's job directory after `since` (monotonic)."""
    scope = _change_scope(path)
    with _cache_lock:
        return bool(scope) and _changes.get(scope, 0) > since


@lru_cache(maxsize=4)
def _client(region, profile):
    import boto3
    from botocore.config import Config
    # Sign the final regional host. The global host can redirect new buckets,
    # invalidating SigV4's signed Host header for unauthenticated URL consumers.
    suffix = 'amazonaws.com.cn' if region.startswith('cn-') else 'amazonaws.com'
    return boto3.Session(profile_name=profile or None).client('s3', region_name=region,
        endpoint_url=f'https://s3.{region}.{suffix}',
        config=Config(signature_version='s3v4', connect_timeout=5, read_timeout=30,
                      s3={'addressing_style': 'virtual'},
                      retries={'max_attempts': 2, 'mode': 'standard'}, max_pool_connections=24))


def _location(path):
    if os.getenv('ASSET_STORAGE_WORKER_LOCAL') == '1':
        return None
    bucket = os.getenv('ASSET_S3_BUCKET', '').strip()
    if not bucket:
        return None
    from src.paths import data_root
    root = LocalPath(data_root()).resolve()
    path = LocalPath(path).resolve()
    try:
        relative = path.relative_to(root)
    except ValueError:
        return None
    # Runtime launch logs and file locks remain process-local, never asset storage.
    if not relative.parts or relative.parts[0] not in ('avatar-factory', 'avatar-blueprints', 'characters'):
        return None
    if path.name.endswith(('.lock', '.lock.guard', '.tmp')) or '.locks' in relative.parts:
        return None
    key = '/'.join(filter(None, (_prefix(), relative.as_posix())))
    return bucket, key


def _prefix():
    return os.getenv('ASSET_S3_PREFIX', 'assets').strip('/')


def _logical(path):
    """(storage prefix, path below the data root) of a stored path, or None."""
    location = _location(path)
    if not location:
        return None
    prefix = _prefix()
    return prefix, location[1][len(prefix) + 1:] if prefix else location[1]


def _record(path):
    """The (prefix, path) key of a JSON record kept in the record database, or None."""
    if LocalPath(path).suffix != '.json' or not record_store.configured():
        return None
    return _logical(path)


def _record_key(key):
    """An S3 key whose file now lives in the record database; S3 listings skip it."""
    return key.endswith('.json') and record_store.configured()


def record_blob_key(prefix, digest):
    """Content-addressed S3 key for the bytes of a record above record_store.INLINE_LIMIT.
    It sits outside the mapped namespaces, so no listing of a job ever sees it."""
    return '/'.join(filter(None, (prefix, 'record-blobs', f'{digest}.json')))


def _s3():
    return _client(os.getenv('ASSET_S3_REGION', os.getenv('AWS_REGION', 'ap-northeast-2')),
                   os.getenv('ASSET_AWS_PROFILE', os.getenv('AWS_PROFILE', '')))


def _index(bucket, prefix):
    """Cached key set of one prefix. Callers only test membership; writers add under _cache_lock."""
    with _cache_lock:
        cached = _key_index.get((bucket, prefix))
        if cached and time.monotonic() - cached[0] < 15:
            return cached[1]
    result = set()
    for page in _s3().get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=prefix):
        result.update(item['Key'] for item in page.get('Contents', []))
    with _cache_lock:
        result.update(key for key in _written_keys.get(bucket, ()) if key.startswith(prefix))
        if len(_key_index) > 4096:
            _key_index.clear()
        _key_index[bucket, prefix] = time.monotonic(), result
    return result


def _keys(bucket, prefix):
    keys = _index(bucket, prefix)
    with _cache_lock:
        return set(keys)


def _scope(key):
    """The job-sized prefix of a key (prefix/<namespace>/<owner>/<item>/), or None for shallow keys."""
    prefix = os.getenv('ASSET_S3_PREFIX', 'assets').strip('/')
    depth = (len(prefix.split('/')) if prefix else 0) + 3
    parts = key.split('/')
    return '/'.join(parts[:depth]) + '/' if len(parts) > depth else None


def _head_object(location):
    with _cache_lock:
        cached = _cache.get(location)
        if cached and time.monotonic() - cached[0] < 2:
            return cached[1]
    from botocore.exceptions import ClientError
    try:
        result = _s3().head_object(Bucket=location[0], Key=location[1], ChecksumMode='ENABLED')
    except ClientError as exc:
        if exc.response['Error']['Code'] not in ('404', 'NoSuchKey', 'NotFound'):
            raise
        result = None
    with _cache_lock:
        if len(_cache) > 4096:
            _cache.clear()
        _cache[location] = time.monotonic(), result
    return result


def _listed(path):
    location = _location(path)
    if not location:
        return False
    # Index one job's keys, not the whole bucket; shallow files are checked directly.
    scope = _scope(location[1])
    if scope is None:
        return _head_object(location) is not None
    return location[1] in _index(location[0], scope)


def _is_working(path):
    return any(LocalPath(path).absolute().is_relative_to(root) for root in _working.get())


def _head(path):
    location = _location(path)
    if not location or not _listed(path):
        return None
    return _head_object(location)


def _content_type(path):
    # Windows MIME registrations do not consistently include WebP or glTF.
    known = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
             '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
             '.json': 'application/json', '.svg': 'image/svg+xml', '.gif': 'image/gif'}
    return known.get(LocalPath(path).suffix.lower()) or mimetypes.guess_type(str(path))[0] or 'application/octet-stream'


def _put(path, content, *, exclusive=False):
    mark_changed(path)
    try:
        _put_object(path, content, exclusive=exclusive)
    finally:
        mark_changed(path)  # A reader that started before completion must not cache the old value.


def _upload(bucket, key, content, mime, *, exclusive=False):
    digest = hashlib.sha256(content).digest()
    _s3().put_object(Bucket=bucket, Key=key, Body=content, ContentType=mime,
                     Metadata={'sha256': digest.hex()}, ChecksumSHA256=base64.b64encode(digest).decode('ascii'),
                     ServerSideEncryption='AES256', **({'IfNoneMatch': '*'} if exclusive else {}))


def _put_record(record, content, *, exclusive=False):
    prefix, path = record
    digest = hashlib.sha256(content).hexdigest()
    if len(content) <= record_store.INLINE_LIMIT:
        record_store.put(prefix, path, content=content, size=len(content), sha256=digest, exclusive=exclusive)
        return
    record_store.require(prefix)
    blob = record_blob_key(prefix, digest)
    # Bytes first, row second: a row never points at a blob that is not there yet.
    _upload(os.getenv('ASSET_S3_BUCKET', '').strip(), blob, content, 'application/json')
    record_store.put(prefix, path, blob_key=blob, size=len(content), sha256=digest, exclusive=exclusive)


def _read_record(record):
    """The record's bytes, or None when the database has no such record."""
    found = record_store.fetch(*record)
    if found is None:
        return None
    meta, content = found
    if content is not None:
        return content
    response = _s3().get_object(Bucket=os.getenv('ASSET_S3_BUCKET', '').strip(), Key=meta.blob_key)
    with response['Body'] as body:
        content = body.read()
    if hashlib.sha256(content).hexdigest() != meta.sha256:
        raise ValueError('Stored record bytes do not match their record')
    return content


def _put_object(path, content, *, exclusive=False):
    record = _record(path)
    if record:
        _put_record(record, content, exclusive=exclusive)
        return
    bucket, key = _location(path)
    _upload(bucket, key, content, _content_type(path), exclusive=exclusive)
    with _cache_lock:
        _cache.pop((bucket, key), None)
        _content_cache.pop((bucket, key), None)
        _generations[bucket, key] = _generations.get((bucket, key), 0) + 1
        _written_keys.setdefault(bucket, set()).add(key)
        for (indexed_bucket, prefix), (_, keys) in _key_index.items():
            if bucket == indexed_bucket and key.startswith(prefix):
                keys.add(key)


def write_json(path, value):
    """Return True only after the complete JSON was durably committed to S3."""
    mark_changed(path)
    if not _location(path):
        return False
    content = json.dumps(value, ensure_ascii=False, indent=2).encode('utf-8')
    if _is_working(path):
        LocalPath(path).write_bytes(content)
        mark_changed(path)
    else:
        _put(path, content)
    return True


class _Upload(io.BytesIO):
    def __init__(self, path, *, exclusive=False):
        super().__init__()
        self.path = path
        self.exclusive = exclusive

    def close(self):
        if self.closed:
            return
        try:
            if self.exclusive:
                _put(self.path, self.getvalue(), exclusive=True)
            else:
                self.path.write_bytes(self.getvalue())
        finally:
            # A failed write is reported once; garbage collection must not send it again.
            super().close()


class StoredPath(type(LocalPath())):
    """Path operations for the asset namespace, with read-only legacy fallback."""
    def read_bytes(self):
        if not _location(self) or _is_working(self):
            return LocalPath(self).read_bytes()
        record = _record(self)
        if record:
            content = _read_record(record)
            return LocalPath(self).read_bytes() if content is None else content
        if not _listed(self):
            return LocalPath(self).read_bytes()
        bucket, key = _location(self)
        with _cache_lock:
            generation = _generations.get((bucket, key), 0)
            cached = _content_cache.get((bucket, key))
            if cached and time.monotonic() - cached[0] < 2:
                return cached[1]
        from botocore.exceptions import ClientError
        try:
            response = _s3().get_object(Bucket=bucket, Key=key)
        except ClientError as exc:
            if exc.response['Error']['Code'] not in ('404', 'NoSuchKey', 'NotFound'):
                raise
            return LocalPath(self).read_bytes()
        with response['Body'] as body:
            content = body.read()
        if self.suffix == '.json' and len(content) < 256_000:
            with _cache_lock:
                if len(_content_cache) > 512:
                    _content_cache.clear()
                if _generations.get((bucket, key), 0) == generation:
                    _content_cache[bucket, key] = time.monotonic(), content
        return content

    def write_bytes(self, data):
        content = bytes(data)
        if not _location(self) or _is_working(self):
            mark_changed(self)
            try:
                return LocalPath(self).write_bytes(content)
            finally:
                mark_changed(self)
        _put(self, content)
        return len(content)

    def read_text(self, encoding=None, errors=None):
        return self.read_bytes().decode(encoding or 'utf-8', errors or 'strict')

    def write_text(self, data, encoding=None, errors=None, newline=None):
        if newline:
            data = data.replace('\n', newline)
        self.write_bytes(data.encode(encoding or 'utf-8', errors or 'strict'))
        return len(data)

    def is_file(self):
        if not _location(self) or _is_working(self):
            return LocalPath(self).is_file()
        record = _record(self)
        if record:
            return record_store.head(*record) is not None or LocalPath(self).is_file()
        if not _listed(self):
            return LocalPath(self).is_file()
        return bool(_head(self)) or LocalPath(self).is_file()

    def exists(self):
        return self.is_file() or self.is_dir()

    def is_dir(self):
        if LocalPath(self).is_dir():
            return True
        location = _location(self)
        if not location or _is_working(self):
            return False
        prefix = location[1].rstrip('/')+'/'
        if record_store.configured():
            namespace, directory = _logical(self)
            if record_store.exists_under(namespace, directory.rstrip('/')+'/'):
                return True
            # A record path is never a directory of artifacts: exists() on a missing record stays off S3.
            return not _record(self) and _holds_artifacts(location[0], prefix)
        return bool(_s3().list_objects_v2(Bucket=location[0], Prefix=prefix, MaxKeys=1).get('Contents'))

    def stat(self, *, follow_symlinks=True):
        if not _location(self) or _is_working(self):
            return LocalPath(self).stat(follow_symlinks=follow_symlinks)
        record = _record(self)
        if record:
            meta = record_store.head(*record)
            if not meta:
                return LocalPath(self).stat(follow_symlinks=follow_symlinks)
            timestamp = meta.updated_at.timestamp()
            return os.stat_result((stat.S_IFREG | 0o444, 0, 0, 1, 0, 0, meta.size, timestamp, timestamp, timestamp))
        if not _listed(self):
            return LocalPath(self).stat(follow_symlinks=follow_symlinks)
        head = _head(self)
        if not head:
            return LocalPath(self).stat(follow_symlinks=follow_symlinks)
        timestamp = head['LastModified'].timestamp()
        return os.stat_result((stat.S_IFREG | 0o444, 0, 0, 1, 0, 0, head['ContentLength'], timestamp, timestamp, timestamp))

    def open(self, mode='r', buffering=-1, encoding=None, errors=None, newline=None):
        if not _location(self) or _is_working(self):
            return LocalPath(self).open(mode, buffering, encoding, errors, newline)
        if mode in ('r', 'rb'):
            buffer = io.BytesIO(self.read_bytes())
        elif mode in ('w', 'wb', 'x', 'xb'):
            if 'x' in mode and self.is_file():
                raise FileExistsError(str(self))
            buffer = _Upload(self, exclusive='x' in mode)
        else:
            raise ValueError('Cloud assets support complete reads and writes only')
        return buffer if 'b' in mode else io.TextIOWrapper(buffer, encoding=encoding or 'utf-8', errors=errors, newline=newline)

    def glob(self, pattern):
        found = {StoredPath(p) for p in LocalPath(self).glob(pattern)}
        location = _location(self)
        if location and not _is_working(self):
            records = record_store.configured()
            # Only records can match a pattern ending in .json: no S3 listing for those.
            if not (records and pattern.endswith('.json')):
                prefix = location[1].rstrip('/')+'/'
                for key in _keys(location[0], prefix):
                    if not _record_key(key) and _glob_match(key[len(prefix):], pattern):
                        found.add(self/key[len(prefix):])
            if records:
                namespace, directory = _logical(self)
                directory = directory.rstrip('/')+'/'
                for path in record_store.listing(namespace, directory):
                    if _glob_match(path[len(directory):], pattern):
                        found.add(self/path[len(directory):])
        yield from sorted(found)

    def rglob(self, pattern):
        yield from self.glob('**/'+pattern)

    def replace(self, target):
        target = StoredPath(target)
        if not _location(self) or _is_working(self):
            LocalPath(self).replace(target)
            return target
        source, destination = _record(self), None if _is_working(target) else _record(target)
        if source and destination and source[0] == destination[0]:
            mark_changed(self); mark_changed(target)
            try:
                record_store.move(source[0], source[1], destination[1])
                return target
            except FileNotFoundError:
                pass  # Not in the database: a legacy local file, copied below like any other.
            finally:
                mark_changed(self); mark_changed(target)
        target.write_bytes(self.read_bytes())
        self.unlink()
        return target

    def unlink(self, missing_ok=False):
        mark_changed(self)
        try:
            return self._unlink(missing_ok)
        finally:
            mark_changed(self)

    def _unlink(self, missing_ok):
        location = _location(self)
        if not location or _is_working(self):
            return LocalPath(self).unlink(missing_ok=missing_ok)
        record = _record(self)
        if record:
            # Bytes above INLINE_LIMIT stay in their content-addressed blob; other rows may share it.
            if record_store.delete(*record) is None and not missing_ok:
                raise FileNotFoundError(str(self))
            return
        if not missing_ok and not _head(self):
            raise FileNotFoundError(str(self))
        _s3().delete_object(Bucket=location[0], Key=location[1])
        with _cache_lock:
            _cache.pop(location, None)
            _content_cache.pop(location, None)
            _generations[location] = _generations.get(location, 0) + 1
            _written_keys.get(location[0], set()).discard(location[1])
            for (bucket, _), (_, keys) in _key_index.items():
                if bucket == location[0]:
                    keys.discard(location[1])


def _glob_match(relative, pattern):
    if '..' in PurePosixPath(relative).parts:
        return False
    patterns = [pattern]
    while patterns[-1].startswith('**/'):
        patterns.append(patterns[-1][3:])
    return any(PurePosixPath(relative).match(p) for p in patterns) and (
        '**' in pattern or len(PurePosixPath(relative).parts) == len(PurePosixPath(pattern).parts))


def _holds_artifacts(bucket, prefix):
    """True when S3 holds a file under the prefix other than JSON left behind by the record import."""
    for page in _s3().get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=prefix):
        if any(not _record_key(item['Key']) for item in page.get('Contents', [])):
            return True
    return False


def child_names(path):
    """Immediate child directory names, local and stored, without listing their contents."""
    path = StoredPath(path)
    local = LocalPath(path)
    names = {child.name for child in local.iterdir() if child.is_dir()} if local.is_dir() else set()
    location = _location(path)
    if location and not _is_working(path):
        prefix = location[1].rstrip('/')+'/'
        listed = set()
        for page in _s3().get_paginator('list_objects_v2').paginate(Bucket=location[0], Prefix=prefix, Delimiter='/'):
            listed.update(item['Prefix'][len(prefix):].rstrip('/') for item in page.get('CommonPrefixes', []))
        if record_store.configured():
            namespace, directory = _logical(path)
            stored = record_store.children(namespace, directory.rstrip('/')+'/')
            # A directory that S3 lists only for its imported JSON no longer exists.
            listed = {name for name in listed
                      if name in stored or name in names or _holds_artifacts(location[0], f'{prefix}{name}/')}
            names |= stored
        names |= listed
    return sorted(names)


def copy_file(source, target):
    source, target = StoredPath(source), StoredPath(target)
    if not _location(target) or _is_working(target):
        target.parent.mkdir(parents=True, exist_ok=True)
    if _server_copy(source, target):
        return target
    target.write_bytes(source.read_bytes())
    return target


def _server_copy(source, target):
    """Copy inside S3 without moving the bytes through this host; False to fall back."""
    origin, destination = _location(source), _location(target)
    if not origin or not destination or _is_working(source) or _is_working(target):
        return False
    if _record(source) or _record(target) or not _listed(source):
        return False
    from botocore.exceptions import BotoCoreError, ClientError
    mark_changed(target)
    try:
        _s3().copy_object(Bucket=destination[0], Key=destination[1],
                          CopySource={'Bucket': origin[0], 'Key': origin[1]},
                          MetadataDirective='COPY', ServerSideEncryption='AES256', ChecksumAlgorithm='SHA256')
    except (BotoCoreError, ClientError):
        return False
    finally:
        mark_changed(target)
    bucket, key = destination
    with _cache_lock:
        _cache.pop((bucket, key), None)
        _content_cache.pop((bucket, key), None)
        _generations[bucket, key] = _generations.get((bucket, key), 0) + 1
        _written_keys.setdefault(bucket, set()).add(key)
        for (indexed_bucket, prefix), (_, keys) in _key_index.items():
            if bucket == indexed_bucket and key.startswith(prefix):
                keys.add(key)
    return True


def read_byte_range(path, start, length, *, etag=None):
    """Read bounded metadata bytes without downloading a mesh or falling back from S3."""
    if start < 0 or not 0 < length <= 4 * 1024 * 1024:
        raise ValueError('Invalid metadata range')
    location = _location(path)
    record = _record(path) if location and not _is_working(path) else None
    found = record_store.fetch(*record) if record else None
    if found:
        meta = found[0]
        identity = f'"{meta.sha256}:{meta.version}"'
        if etag and identity != etag:
            raise ValueError('Model changed during metadata read')
        content = StoredPath(path).read_bytes()[start:start + length]
        total, checksum = meta.size, meta.sha256
    elif location and not _is_working(path) and not record:
        response = _s3().get_object(Bucket=location[0], Key=location[1],
            Range=f'bytes={start}-{start + length - 1}', **({'IfMatch': etag} if etag else {}))
        with response['Body'] as body:
            content = body.read(length + 1)
        total = int(response['ContentRange'].rsplit('/', 1)[1])
        identity = response['ETag']
        checksum = response.get('Metadata', {}).get('sha256')
    else:
        local = LocalPath(path)
        stat = local.stat()
        total, identity, checksum = stat.st_size, f'{stat.st_mtime_ns}:{stat.st_size}', None
        if etag and identity != etag:
            raise ValueError('Model changed during metadata read')
        with local.open('rb') as stream:
            stream.seek(start)
            content = stream.read(length)
    if len(content) != length:
        raise ValueError('Incomplete model metadata')
    return content, total, identity, checksum


def publish_checkpoint(path):
    """Expose running process receipts while Blender's artifacts remain scratch."""
    path = StoredPath(path)
    if _location(path) and _is_working(path):
        _put(path, LocalPath(path).read_bytes())


def sha256(path):
    path = StoredPath(path)
    record = _record(path) if not _is_working(path) else None
    if record:
        meta = record_store.head(*record)
        if meta:
            return meta.sha256
    head = _head(path) if not _is_working(path) and not record else None
    if head and head.get('ChecksumSHA256') and head.get('ChecksumType', 'FULL_OBJECT') == 'FULL_OBJECT':
        return base64.b64decode(head['ChecksumSHA256'], validate=True).hex()
    return hashlib.sha256(path.read_bytes()).hexdigest()


def copy_tree(source, target):
    source, target = StoredPath(source), StoredPath(target)
    for path in source.rglob('*'):
        if path.is_file():
            copy_file(path, target/path.relative_to(source))
    return target


def artifact_response(path, **kwargs):
    from fastapi.responses import FileResponse, RedirectResponse, Response
    path = StoredPath(path)
    location = _location(path)
    record = _record(path)
    found = record_store.fetch(*record) if record else None
    if found and found[1] is not None:
        headers = {'Cache-Control': 'private, no-store'}
        if kwargs.get('filename'):
            from urllib.parse import quote
            headers['Content-Disposition'] = f"attachment; filename*=UTF-8''{quote(kwargs['filename'])}"
        return Response(found[1], media_type=kwargs.get('media_type') or _content_type(path), headers=headers)
    if found:
        location = location[0], found[0].blob_key
    if found or (location and not record and _head(path)):
        params = {'Bucket': location[0], 'Key': location[1],
                  'ResponseContentType': kwargs.get('media_type') or _content_type(path)}
        if kwargs.get('filename'):
            from urllib.parse import quote
            # Presigned downloads come from another origin, where the page's download attribute is ignored.
            params['ResponseContentDisposition'] = f"attachment; filename*=UTF-8''{quote(kwargs['filename'])}"
        url = _s3().generate_presigned_url('get_object', Params=params, ExpiresIn=900)
        return RedirectResponse(url, status_code=307, headers={'Cache-Control': 'private, no-store'})
    return FileResponse(LocalPath(path), **kwargs)


def provider_image(path, content, mime):
    """Short-lived access to immutable inputs, without uploading them in each POST."""
    if not _location(path):
        return None
    digest = hashlib.sha256(content).hexdigest()
    extension = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'}[mime]
    target = StoredPath(path).parent/'provider-inputs'/f'{digest}.{extension}'
    if not _head(target):
        target.write_bytes(content)
    bucket, key = _location(target)
    # Override the response MIME also for existing immutable inputs uploaded by
    # older Windows hosts as application/octet-stream; no object rewrite needed.
    return {'url': _s3().generate_presigned_url('get_object', Params={
                'Bucket': bucket, 'Key': key, 'ResponseContentType': mime}, ExpiresIn=3600),
            'identity': {'bucket': bucket, 'key': key, 'sha256': digest}}


@contextmanager
def local_workspace(directory, *, inputs=()):
    """Blender scratch only. Upload outputs, then remove newly materialized files."""
    directory = StoredPath(directory)
    if not _location(directory) or _is_working(directory):
        yield directory
        return
    local = LocalPath(directory).resolve()
    with _workspace_lock:
        directory_lock = _directory_locks.setdefault(local, RLock())
    # One workspace per directory; different jobs run their Blender workers in parallel.
    with directory_lock:
        input_paths = [StoredPath(path) for path in inputs]
        input_locals = [LocalPath(path).resolve() for path in input_paths]
        local.mkdir(parents=True, exist_ok=True)
        original = {p.resolve() for p in local.rglob('*') if p.is_file()}
        downloaded = {}
        for path in directory.rglob('*'):
            if 'provider-inputs' in path.parts or '-provider.' in path.name or path.name.startswith('guide-'):
                continue
            if path.is_file():
                content = path.read_bytes()
                target = LocalPath(path)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                downloaded[target.resolve()] = hashlib.sha256(content).digest()
        shared = [p for p in input_locals if not p.is_relative_to(local)]
        for path, target in zip(input_paths, input_locals):
            content = path.read_bytes()
            with _workspace_lock:
                # Another workspace may be using the same shared input right now.
                entry = _materialized.get(target) if target in shared else None
                if target.is_file() and target.read_bytes() != content:
                    raise ValueError('Existing local input differs from the saved assembly input')
                if target in shared:
                    if entry is None:
                        entry = _materialized[target] = [0, not target.is_file()]
                    entry[0] += 1
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.is_file():
                    target.write_bytes(content)
            if target.is_relative_to(local):
                downloaded.setdefault(target, hashlib.sha256(content).digest())
        token = _working.set((*_working.get(), local, *input_locals))
        try:
            yield directory
        finally:
            _working.reset(token)
            # Keep scratch files if any upload fails; never discard the only copy.
            files = [p for p in local.rglob('*') if p.is_file() and _location(p)]
            # Upload what the worker wrote or changed; skip bytes that came from S3 unchanged.
            changed = [p for p in files if downloaded.get(p.resolve()) != hashlib.sha256(p.read_bytes()).digest()]
            # Publish completion only after its artifacts and evidence are durable.
            final_records = {'job.json', 'record.json', 'current.json', 'delivery.json', 'worker.json'}
            for path in sorted(changed, key=lambda p: 2 if p.name in final_records else 1 if p.suffix == '.json' else 0):
                _put(path, path.read_bytes())
            for path in files:
                resolved = path.resolve()
                if resolved not in original and resolved.is_relative_to(local):
                    path.unlink()
            # Explicit Blender inputs may live outside the output directory. Remove a
            # shared input only when the last workspace that materialized it is done.
            with _workspace_lock:
                for path in shared:
                    entry = _materialized.get(path)
                    if entry is None:
                        continue
                    entry[0] -= 1
                    if entry[0] <= 0:
                        _materialized.pop(path, None)
                        if entry[1] and path not in original and path.is_file():
                            path.unlink()
