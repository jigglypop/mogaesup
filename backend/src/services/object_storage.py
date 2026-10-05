"""S3 is durable storage; filesystem paths are logical keys or Blender scratch files.

With CHARACTER_DATABASE_URL set, the `.json` records of the same namespaces live in PostgreSQL
(src.services.record_store) and only binary artifacts stay in S3. The database alone then decides
whether a record exists: JSON objects that the import left in S3 are never read or listed again.
`src.records import` leaves a marker object beside them, so that a server which lost the variable
refuses to start (assert_records_mode) instead of reading the stale JSON.
"""
from collections import OrderedDict
from contextlib import contextmanager
from contextvars import ContextVar
from functools import lru_cache
import base64
import hashlib
import io
import itertools
import json
import logging
import mimetypes
import os
from pathlib import Path as LocalPath, PurePosixPath
import stat
from threading import RLock, Thread
import time

from src.services import record_store

LOGGER = logging.getLogger(__name__)

# What the tables below remember only has to outlive a read or listing that began before the write: a few
# seconds of S3 timeouts. The tables are kept oldest first; once one holds more than _TABLE_LIMIT entries, those
# untouched for _MEMORY seconds are dropped.
_MEMORY = 120
_TABLE_LIMIT = 4096
# How long a listing answers for the keys below its prefix, absent ones included.
_INDEX_SECONDS = 15
# S3 answers 409 while another conditional write or a delete of the same key is in flight, and asks for the request
# again: seconds between the attempts.
_CONFLICT_DELAYS = (.2, .5, 1, 2)
_DIGEST_LIMIT = 4096

_working = ContextVar('asset_workspaces', default=())
_cache = {}
_content_cache = record_store.ByteBoundedCache(record_store.CONTENT_CACHE_BYTES)  # (bucket, key) -> (monotonic, bytes)
_digests = OrderedDict()    # (bucket, key, ETag) -> sha256 of an object stored without ChecksumSHA256, oldest first
_key_index = {}
_written_keys = {}          # bucket -> {key: monotonic time of the write}
_generations = OrderedDict()  # (bucket, key) -> (change number, monotonic time); a read stores only if it did not change
_change_numbers = itertools.count(1)
_changes = OrderedDict()    # job scope -> monotonic time of this process's last write below it
_cache_lock = RLock()
_workspace_lock = RLock()   # guards the bookkeeping below, never held while a worker runs
_directory_locks = {}       # one active workspace per local directory: [lock, workspaces holding or waiting for it]
_materialized = {}          # shared input path -> [workspaces using it, created by a workspace]


class StorageConflict(OSError):
    """S3 kept refusing a write while another conditional write or a delete of the same key was in flight (409). It
    says nothing about whether the object exists; the write may be tried again."""


class ArtifactChanged(ValueError):
    """The stored file changed between two reads that had to see the same bytes."""


def _forget_old(table, horizon, limit=0, at=lambda value: value):
    """Bound a table that is kept oldest first: while it holds more than `limit` entries, drop those untouched for
    `horizon` seconds (`at` reads an entry's time)."""
    now = time.monotonic()
    while len(table) > limit:
        oldest = next(iter(table))
        if now - at(table[oldest]) < horizon:
            return
        del table[oldest]


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
            _changes.pop(scope, None)
            _changes[scope] = time.monotonic()
            # changed_since is asked about moments within the last minute.
            _forget_old(_changes, 600, _TABLE_LIMIT)


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


def records_marker_key(prefix):
    """The object `src.records import` leaves to say that the records of a storage prefix live in the record database."""
    return '/'.join(filter(None, (prefix, '.records-in-database')))


def records_marker_present(s3, bucket, prefix):
    """Whether the marker exists; any failure to find out is raised."""
    key = records_marker_key(prefix)
    # A listing says "not there" with a 200. A HEAD of a missing key is a 403 for a role that may only list some
    # prefixes, which cannot be told from a real denial.
    found = s3.list_objects_v2(Bucket=bucket, Prefix=key, MaxKeys=1)
    return any(item['Key'] == key for item in found.get('Contents', []))


def assert_records_mode(timeout=5):
    """Refuse to run on S3 JSON that the record database has replaced.

    The records live in PostgreSQL only while CHARACTER_DATABASE_URL is set, and a replaced instance can lose that
    variable. The server would then read and write the old S3 JSON, stale since the import, and still look healthy.
    Raises RuntimeError when the marker of this storage prefix exists but the variable is not set. Whatever keeps the
    check from answering (no network, no permission, slower than `timeout` seconds) stops startup as well.
    """
    bucket = os.getenv('ASSET_S3_BUCKET', '').strip()
    if not bucket or record_store.configured() or os.getenv('ASSET_STORAGE_WORKER_LOCAL') == '1':
        return
    prefix = _prefix()
    outcome = []

    def probe():
        try:
            outcome.append(records_marker_present(_s3(), bucket, prefix))
        except Exception as exc:
            outcome.append(exc)

    worker = Thread(target=probe, name='records-marker', daemon=True)
    worker.start()
    worker.join(timeout)
    found = outcome[0] if outcome else TimeoutError(f'no answer within {timeout} s')
    if found is True:
        argument = prefix or "''"
        raise RuntimeError(
            f'The records of storage prefix {prefix!r} live in PostgreSQL, but CHARACTER_DATABASE_URL is not set. Set it, or '
            f'copy the records back to S3 with `uv run python -m src.records export --prefix {argument}` and run again.')
    if isinstance(found, Exception):
        raise RuntimeError('Could not verify the records storage mode; restore S3 access and retry startup.') from found


def _s3():
    return _client(os.getenv('ASSET_S3_REGION', os.getenv('AWS_REGION', 'ap-northeast-2')),
                   os.getenv('ASSET_AWS_PROFILE', os.getenv('AWS_PROFILE', '')))


def _s3_error(exc):
    """(error code, HTTP status) of a botocore ClientError."""
    response = getattr(exc, 'response', None) or {}
    return str((response.get('Error') or {}).get('Code', '')), (response.get('ResponseMetadata') or {}).get('HTTPStatusCode')


def _index(bucket, prefix):
    """Cached key set of one prefix. Callers only test membership; writers add under _cache_lock."""
    with _cache_lock:
        cached = _key_index.get((bucket, prefix))
        if cached and time.monotonic() - cached[0] < _INDEX_SECONDS:
            return cached[1]
    result = set()
    for page in _s3().get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=prefix):
        result.update(item['Key'] for item in page.get('Contents', []))
    with _cache_lock:
        # Writes that landed while the listing ran may be missing from it.
        written = _written_keys.get(bucket)
        if written:
            _forget_old(written, _MEMORY)
            result.update(key for key in written if key.startswith(prefix))
        if len(_key_index) > _TABLE_LIMIT:
            now = time.monotonic()
            for stale in [entry for entry, (at, _) in _key_index.items() if now - at >= _INDEX_SECONDS]:
                del _key_index[stale]
            if len(_key_index) > _TABLE_LIMIT:
                _key_index.clear()
        _key_index[bucket, prefix] = time.monotonic(), result
    return result


def _keys(bucket, prefix):
    keys = _index(bucket, prefix)
    with _cache_lock:
        return set(keys)


def _scope(key):
    """The job-sized prefix of a key (prefix/<namespace>/<owner>/<item>/), or None for shallow keys.

    An owner's library holds collections of items (library/<collection>/<item>/), so there the scope is one item, and
    a file directly in the library or in a collection is a scope of its own: no check of one file lists the library."""
    prefix = _prefix()
    depth = (len(prefix.split('/')) if prefix else 0) + 3
    parts = key.split('/')
    if len(parts) <= depth:
        return None
    if parts[depth - 1] == 'library':
        return '/'.join(parts[:depth + 2]) + '/' if len(parts) > depth + 2 else key
    return '/'.join(parts[:depth]) + '/'


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
    from botocore.exceptions import ClientError
    digest = hashlib.sha256(content).digest()
    for delay in (*_CONFLICT_DELAYS, None):
        try:
            _s3().put_object(Bucket=bucket, Key=key, Body=content, ContentType=mime,
                             Metadata={'sha256': digest.hex()}, ChecksumSHA256=base64.b64encode(digest).decode('ascii'),
                             ServerSideEncryption='AES256', **({'IfNoneMatch': '*'} if exclusive else {}))
            return
        except ClientError as exc:
            code, status = _s3_error(exc)
            if code in ('ConditionalRequestConflict', 'OperationAborted') or status == 409:
                # Another conditional write or a delete of the key is in flight and S3 asks for this one again. That
                # says nothing about the object existing, so it is not an exclusive create that lost the race.
                if delay is None:
                    raise StorageConflict(f'S3 kept refusing the write of {key} while another write of it was in '
                                          f'flight; try again') from exc
                time.sleep(delay)
                continue
            # An exclusive create that lost the race: the object exists. Callers handle the same FileExistsError as for
            # a local file or a record.
            if exclusive and (code == 'PreconditionFailed' or status == 412):
                raise FileExistsError(key) from None
            raise


def _put_record(record, content, *, exclusive=False, expected_version=None):
    prefix, path = record
    digest = hashlib.sha256(content).hexdigest()
    if len(content) <= record_store.INLINE_LIMIT:
        # Inline records are cached; a caller's bytearray must not change under the cache.
        record_store.put(prefix, path, content=bytes(content), size=len(content), sha256=digest, exclusive=exclusive,
                         expected_version=expected_version)
        return
    record_store.require(prefix)
    blob = record_blob_key(prefix, digest)
    # Bytes first, row second: a row never points at a blob that is not there yet.
    _upload(os.getenv('ASSET_S3_BUCKET', '').strip(), blob, content, 'application/json')
    record_store.put(prefix, path, blob_key=blob, size=len(content), sha256=digest, exclusive=exclusive,
                     expected_version=expected_version)


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
    _stored(bucket, key)


def _changed(bucket, key):
    """The object changed in S3: what a read or listing that began earlier saw must not be kept (hold _cache_lock)."""
    _cache.pop((bucket, key), None)
    _content_cache.pop((bucket, key), None)
    _generations.pop((bucket, key), None)
    _generations[bucket, key] = next(_change_numbers), time.monotonic()
    _forget_old(_generations, _MEMORY, _TABLE_LIMIT, at=lambda value: value[1])


def _stored(bucket, key):
    """The object now exists in S3: caches and the key indexes learn it at once."""
    with _cache_lock:
        _changed(bucket, key)
        written = _written_keys.setdefault(bucket, OrderedDict())
        written.pop(key, None)
        written[key] = time.monotonic()
        _forget_old(written, _MEMORY)
        for (indexed_bucket, prefix), (_, keys) in _key_index.items():
            if bucket == indexed_bucket and key.startswith(prefix):
                keys.add(key)


def _deleted(bucket, key):
    """The object is gone from S3."""
    with _cache_lock:
        _changed(bucket, key)
        _written_keys.get(bucket, {}).pop(key, None)
        for (indexed_bucket, _), (_, keys) in _key_index.items():
            if indexed_bucket == bucket:
                keys.discard(key)


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


def is_remote(path):
    """True when a write to `path` goes to S3 or the record database, where one PUT is atomic and a temporary file that is
    renamed afterwards only costs a copy and a delete; False for a local file, where temporary file and rename are atomic."""
    path = StoredPath(path)
    return bool(_location(path)) and not _is_working(path)


def read_json_versioned(path):
    """(document, version) of a JSON file. In the record database the version is the row's (0 while there is no row), the
    token write_json_if_version compares; elsewhere (S3 objects, local files) it is None, as there is nothing to compare."""
    from src.services.asset_editor import _retry_file_io
    path = StoredPath(path)
    record = None if _is_working(path) else _record(path)
    if record is None:
        try:
            # Windows can briefly deny a read while another thread replaces the file.
            return json.loads(_retry_file_io(lambda: path.read_text(encoding='utf-8'))), None
        except FileNotFoundError:
            return {}, None
    found = record_store.fetch(*record)
    if found is None:
        # A legacy local file stands in until the record exists.
        try:
            return json.loads(_retry_file_io(lambda: path.read_text(encoding='utf-8'))), 0
        except FileNotFoundError:
            return {}, 0
    meta, content = found
    if content is None:
        content = _read_record(record)
    return json.loads(content), meta.version


def write_json_if_version(path, value, version):
    """Replaces a JSON record only while it is still at `version` (0: it must not exist yet), the compare-and-set that the
    record database offers. False when another writer got there first. Only for a `version` read_json_versioned gave."""
    path = StoredPath(path)
    record = _record(path)
    if record is None or version is None:
        raise ValueError('Only records in the record database have versions')
    content = json.dumps(value, ensure_ascii=False, indent=2).encode('utf-8')
    mark_changed(path)
    try:
        _put_record(record, content, exclusive=version == 0, expected_version=None if version == 0 else version)
    except FileExistsError:
        return False
    finally:
        mark_changed(path)
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
            generation = _generations.get((bucket, key))
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
                if _generations.get((bucket, key)) == generation:
                    _content_cache[bucket, key] = time.monotonic(), content
        return content

    def write_bytes(self, data):
        # A downloaded model arrives as one bytearray of up to 256 MiB: it is uploaded as it is, never copied.
        content = data if isinstance(data, (bytes, bytearray)) else bytes(data)
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
                for path in record_store.listing(namespace, directory, pattern):
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
        # Two plain S3 objects: the copy happens inside S3, so a model of hundreds of MiB never passes through this host.
        if _server_copy(self, target):
            self.unlink()
            return target
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
        _deleted(*location)


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
    _stored(*destination)
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
            raise ArtifactChanged('Model changed during metadata read')
        content = StoredPath(path).read_bytes()[start:start + length]
        total, checksum = meta.size, meta.sha256
    elif location and not _is_working(path) and not record:
        from botocore.exceptions import ClientError
        try:
            response = _s3().get_object(Bucket=location[0], Key=location[1],
                Range=f'bytes={start}-{start + length - 1}', **({'IfMatch': etag} if etag else {}))
        except ClientError as exc:
            code, status = _s3_error(exc)
            if code in ('NoSuchKey', 'NotFound', '404') or status == 404:
                raise FileNotFoundError(str(path)) from None
            if code == 'PreconditionFailed' or status == 412:
                raise ArtifactChanged('Model changed during metadata read') from None
            if code == 'InvalidRange' or status == 416:
                raise ValueError('Incomplete model metadata') from None
            raise
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
            raise ArtifactChanged('Model changed during metadata read')
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
    if head and head.get('ETag'):
        digest = _object_sha256(*_location(path), head['ETag'])
        if digest:
            return digest
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _object_sha256(bucket, key, etag):
    """sha256 of the version `etag` names of an object stored without ChecksumSHA256 (one that other tools uploaded),
    downloaded once: a replaced object has another ETag and is hashed again. None when that version is gone."""
    with _cache_lock:
        digest = _digests.get((bucket, key, etag))
        if digest:
            _digests.move_to_end((bucket, key, etag))
            return digest
    from botocore.exceptions import ClientError
    try:
        # IfMatch: the bytes hashed are the version the ETag names, not one written since the HEAD.
        response = _s3().get_object(Bucket=bucket, Key=key, IfMatch=etag)
    except ClientError as exc:
        code, status = _s3_error(exc)
        if code in ('404', 'NoSuchKey', 'NotFound', 'PreconditionFailed') or status in (404, 412):
            return None
        raise
    hasher = hashlib.sha256()
    with response['Body'] as body:
        while chunk := body.read(1024 * 1024):
            hasher.update(chunk)
    digest = hasher.hexdigest()
    with _cache_lock:
        _digests[bucket, key, etag] = digest
        while len(_digests) > _DIGEST_LIMIT:
            _digests.popitem(last=False)
    return digest


def copy_tree(source, target):
    source, target = StoredPath(source), StoredPath(target)
    for path in source.rglob('*'):
        if path.is_file():
            copy_file(path, target/path.relative_to(source))
    return target


def artifact_response(path, **kwargs):
    from fastapi.responses import FileResponse, Response
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
    head = None
    if found:
        from botocore.exceptions import ClientError
        location = location[0], found[0].blob_key
        try:
            head = _s3().head_object(Bucket=location[0], Key=location[1])
        except ClientError as exc:
            code, status = _s3_error(exc)
            if code in ('404', 'NoSuchKey', 'NotFound') or status == 404:
                # The record names bytes that S3 does not hold: a missing file, not a server failure.
                raise FileNotFoundError(str(path)) from None
            raise
    elif location and not record:
        head = _head(path)
    if head:
        # Studio viewers fetch bytes through the app's authenticated gateway. A redirect sends the browser
        # to another origin and makes every GLB/texture depend on an external bucket CORS configuration.
        headers = {'Cache-Control': 'private, no-store', **kwargs.get('headers', {})}
        if kwargs.get('filename'):
            from urllib.parse import quote
            headers['Content-Disposition'] = f"attachment; filename*=UTF-8''{quote(kwargs['filename'])}"

        from src.services.remote_artifact import RemoteArtifactResponse
        return RemoteArtifactResponse(_s3(), *location, head,
                                      media_type=kwargs.get('media_type') or _content_type(path), headers=headers)
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


class WorkspaceUploadError(OSError):
    """Files of a local workspace that did not reach the store. They stay in its scratch directory."""


_FINAL_RECORDS = {'job.json', 'record.json', 'current.json', 'delivery.json', 'worker.json'}


def _upload_rank(path):
    return 2 if path.name in _FINAL_RECORDS else 1 if path.suffix == '.json' else 0


@contextmanager
def _directory_lock(local):
    """One active workspace per local directory; different jobs run their Blender workers in parallel. The lock is
    forgotten once no workspace holds or awaits it."""
    with _workspace_lock:
        entry = _directory_locks.setdefault(local, [RLock(), 0])
        entry[1] += 1
    try:
        with entry[0]:
            yield
    finally:
        with _workspace_lock:
            entry[1] -= 1
            if not entry[1]:
                del _directory_locks[local]


def _in_store(path):
    """True when the record database or S3 holds the file itself, whatever a copy on the local disk says."""
    record = _record(path)
    if record:
        return record_store.head(*record) is not None
    return _head(path) is not None


def _flush_workspace(local, downloaded):
    """Store what the worker wrote or changed, then clear the scratch. Returns {file: why it is not stored}.

    Artifacts go first, then JSON, then the records that declare the work complete, and those only when everything
    before them is stored: completion is never published ahead of its evidence. Every upload is attempted. A file the
    store did not take stays on disk, as it may be the only copy; the rest of the scratch, now in the store, goes."""
    files = [p for p in local.rglob('*') if p.is_file() and _location(p)]
    changed, failed = [], {}
    for path in files:
        try:
            with path.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').digest()
        except OSError as exc:
            failed[path] = exc
            continue
        # Skip bytes that came from the store unchanged.
        if downloaded.get(path.resolve()) != digest:
            changed.append(path)
    for path in sorted(changed, key=_upload_rank):
        if _upload_rank(path) == 2 and any(_upload_rank(other) < 2 for other in failed):
            failed[path] = 'withheld until the files before it are stored'
            continue
        try:
            _put(path, path.read_bytes())
        except Exception as exc:
            failed[path] = exc
    for path, reason in failed.items():
        name = path.relative_to(local).as_posix()
        if isinstance(reason, Exception):
            LOGGER.error('Workspace file %s was not stored', name, exc_info=reason)
        else:
            LOGGER.warning('Workspace file %s was %s', name, reason)
    for path in files:
        if path in failed:
            continue
        try:
            path.unlink()
        except OSError as exc:
            LOGGER.warning('Workspace scratch file %s could not be removed: %s', path.name, exc)
    return failed


def _upload_error(local, failed):
    names = ', '.join(f'{path.relative_to(local).as_posix()} ({reason if isinstance(reason, str) else type(reason).__name__})'
                      for path, reason in sorted(failed.items()))
    error = WorkspaceUploadError(f'Workspace files were not stored and stay on disk: {names}')
    error.__cause__ = next((reason for reason in failed.values() if isinstance(reason, Exception)), None)
    return error


def _materialize(target, content):
    """Write one workspace input. A copy already there must hold the same bytes; workspaces that share the input write
    the same stored bytes, each through its own temporary file and an atomic replace."""
    if target.is_file():
        if target.read_bytes() != content:
            raise ValueError('Existing local input differs from the saved assembly input')
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f'{target.name}.{os.getpid()}-{id(content):x}-{time.monotonic_ns()}.tmp')
    try:
        temporary.write_bytes(content)
        try:
            os.replace(temporary, target)
        except OSError:
            # Windows refuses to replace a file another workspace has open: the same input is already in place.
            if not target.is_file() or target.read_bytes() != content:
                raise
    finally:
        temporary.unlink(missing_ok=True)


def _release_inputs(held, original):
    """Explicit Blender inputs may live outside the output directory. Remove a shared input only when the last
    workspace that materialized it is done."""
    with _workspace_lock:
        for path in held:
            entry = _materialized.get(path)
            if entry is None:
                continue
            entry[0] -= 1
            if entry[0] <= 0:
                _materialized.pop(path, None)
                if entry[1] and path not in original and path.is_file():
                    try:
                        path.unlink()
                    except OSError as exc:
                        LOGGER.warning('Workspace input %s could not be removed: %s', path.name, exc)


@contextmanager
def local_workspace(directory, *, inputs=()):
    """Blender scratch only. Upload outputs, then remove newly materialized files.

    Every file the worker wrote is attempted (see _flush_workspace). What the store did not take stays in the scratch
    directory and the exit raises WorkspaceUploadError naming it, unless the body is already failing: that error
    stands and the upload failures are only logged. A scratch file the store lacks was left by such a failure, and goes
    up when the next workspace on the directory ends; a file the store has is replaced by the stored bytes.
    """
    directory = StoredPath(directory)
    if not _location(directory) or _is_working(directory):
        yield directory
        return
    local = LocalPath(directory).resolve()
    with _directory_lock(local):
        input_paths = [StoredPath(path) for path in inputs]
        input_locals = [LocalPath(path).resolve() for path in input_paths]
        shared = [p for p in input_locals if not p.is_relative_to(local)]
        local.mkdir(parents=True, exist_ok=True)
        original = {p.resolve() for p in local.rglob('*') if p.is_file()}
        downloaded, unstored, held = {}, set(), []
        try:
            for path in directory.rglob('*'):
                if 'provider-inputs' in path.parts or '-provider.' in path.name or path.name.startswith('guide-'):
                    continue
                if path.is_file():
                    target = LocalPath(path)
                    if target.resolve() in original and not _in_store(path):
                        # Left by a workspace whose upload failed: its bytes are not "downloaded", so they go up at the end.
                        unstored.add(target.resolve())
                        continue
                    content = path.read_bytes()
                    if target.resolve() in original and target.read_bytes() != content:
                        # The control plane rewrites records outside workspaces: the store is the newer one.
                        LOGGER.warning('Workspace scratch file %s differs from the stored one; the stored bytes are used',
                                       path.relative_to(directory).as_posix())
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(content)
                    downloaded[target.resolve()] = hashlib.sha256(content).digest()
            for path, target in zip(input_paths, input_locals):
                content = path.read_bytes()
                if target in shared:
                    # Another workspace may be using the same shared input right now: count this one in first, so the
                    # file is not removed under it, then compare or write it outside the lock that every workspace uses.
                    with _workspace_lock:
                        entry = _materialized.get(target)
                        if entry is None:
                            entry = _materialized[target] = [0, not target.is_file()]
                        entry[0] += 1
                    held.append(target)
                _materialize(target, content)
                if target.is_relative_to(local) and target not in unstored:
                    downloaded.setdefault(target, hashlib.sha256(content).digest())
            token = _working.set((*_working.get(), local, *input_locals))
            failure = None
            try:
                yield directory
            except BaseException as exc:
                failure = exc
                raise
            finally:
                _working.reset(token)
                failed = _flush_workspace(local, downloaded)
                if failed and failure is None:
                    raise _upload_error(local, failed)
        finally:
            _release_inputs(held, original)
