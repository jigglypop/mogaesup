"""PostgreSQL home of the character server's JSON records (CHARACTER_DATABASE_URL).

When the variable is set, object_storage keeps every `.json` file of the S3-mapped namespaces
(avatar-factory/, avatar-blueprints/, characters/) in `character_records.records`, keyed by the
storage prefix (ASSET_S3_PREFIX) and the path below the data root. Rows hold the exact bytes, so
digests stay identical to the S3 objects they replace. A record above INLINE_LIMIT keeps its bytes
in S3 under a content-addressed key and the row points at it. Binary artifacts never come here.

This module is the database half: queries, a small connection pool, and the caches that stand in
for the S3 key index (2 s per job-sized scope, written through on every local write).
"""

from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
import itertools
import os
from threading import Condition, RLock
import time


SCHEMA = 'character_records'
# Provider responses embed base64 images (several MB); rows above this keep their bytes in S3.
INLINE_LIMIT = 1024 * 1024
# Same horizons as the S3 caches: another process's write shows up within INDEX_SECONDS.
INDEX_SECONDS = 2
CONTENT_CACHE_LIMIT = 256_000
# All cached record bytes together; object_storage keeps a cache of the same size for S3 JSON.
CONTENT_CACHE_BYTES = 32 * 1024 * 1024
POOL_SIZE = 8
_IDLE_CHECK_SECONDS = 30
# A write mark outlives every query that began before the write: the statement timeout is 30 s, a pool wait 15 s.
_WRITE_MEMORY = 120
_WRITE_TABLE_LIMIT = 4096


class ByteBoundedCache(OrderedDict):
    """Least recently stored first. Values are (tag, bytes) pairs, and the bytes of all of them together stay within
    `budget`: the oldest go first."""

    def __init__(self, budget):
        super().__init__()
        self.budget, self.size = budget, 0

    def __setitem__(self, key, value):
        if key in self:
            self.pop(key)
        super().__setitem__(key, value)
        self.size += len(value[1])
        while self.size > self.budget and len(self) > 1:
            self.popitem(last=False)

    def __delitem__(self, key):
        self.size -= len(self[key][1])
        super().__delitem__(key)

    def pop(self, key, *default):
        if key not in self:
            if default:
                return default[0]
            raise KeyError(key)
        value = super().pop(key)
        self.size -= len(value[1])
        return value

    def popitem(self, last=True):
        key, value = super().popitem(last=last)
        self.size -= len(value[1])
        return key, value

    def clear(self):
        super().clear()
        self.size = 0


class RecordStoreUnavailable(RuntimeError):
    """The record database is missing, unreachable, or has not received this prefix's records."""


@dataclass(frozen=True)
class Meta:
    size: int
    sha256: str
    version: int
    updated_at: datetime
    blob_key: str | None = None


def configured() -> bool:
    return bool(os.getenv('CHARACTER_DATABASE_URL', '').strip())


def _url() -> str:
    url = os.getenv('CHARACTER_DATABASE_URL', '').strip()
    if not url:
        raise RecordStoreUnavailable('CHARACTER_DATABASE_URL is not set')
    return url


def connect(url: str | None = None, **overrides):
    import psycopg
    options = dict(autocommit=True, connect_timeout=5, application_name='character-records',
                   options='-c statement_timeout=30000', keepalives=1, keepalives_idle=30)
    options.update(overrides)
    return psycopg.connect(url or _url(), **options)


class _Pool:
    """A few autocommit connections shared by the API threads of the single worker."""

    def __init__(self, url, size):
        self.url, self.size = url, size
        self._idle = []            # (connection, last used monotonic)
        self._count = 0
        self._condition = Condition()

    @contextmanager
    def connection(self):
        conn = self._acquire()
        try:
            yield conn
        finally:
            self._release(conn)

    def _acquire(self):
        deadline = time.monotonic() + 15
        while True:
            with self._condition:
                while not self._idle and self._count >= self.size:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise RecordStoreUnavailable('record database connections are exhausted')
                    self._condition.wait(remaining)
                if self._idle:
                    conn, used = self._idle.pop()
                else:
                    self._count += 1
                    conn = used = None
            if conn is None:
                try:
                    return connect(self.url)
                except BaseException:
                    self._forget()
                    raise
            if not conn.closed and not conn.broken and (
                    time.monotonic() - used < _IDLE_CHECK_SECONDS or self._alive(conn)):
                return conn
            self._discard(conn)

    @staticmethod
    def _alive(conn):
        try:
            conn.execute('SELECT 1')
            return True
        except Exception:
            return False

    def _release(self, conn):
        from psycopg.pq import TransactionStatus
        if conn.closed or conn.broken or conn.info.transaction_status != TransactionStatus.IDLE:
            self._discard(conn)
            return
        with self._condition:
            self._idle.append((conn, time.monotonic()))
            self._condition.notify()

    def _discard(self, conn):
        try:
            conn.close()
        except Exception:
            pass
        self._forget()

    def _forget(self):
        with self._condition:
            self._count -= 1
            self._condition.notify()

    def close(self):
        with self._condition:
            idle, self._idle = self._idle, []
            self._count -= len(idle)
        for conn, _ in idle:
            try:
                conn.close()
            except Exception:
                pass


_pools = {}
_pool_lock = RLock()


def _pool():
    url = _url()
    with _pool_lock:
        pool = _pools.get(url)
        if pool is None:
            for stale in _pools.values():
                stale.close()
            _pools.clear()
            pool = _pools[url] = _Pool(url, POOL_SIZE)
        return pool


@contextmanager
def connection():
    import psycopg
    try:
        with _pool().connection() as conn:
            yield conn
    except psycopg.errors.UndefinedTable as exc:
        raise RecordStoreUnavailable('record schema is missing; run: uv run python -m src.records migrate') from exc


def reset():
    """Drop pooled connections and caches (tests, or after the URL changed)."""
    with _pool_lock:
        for pool in _pools.values():
            pool.close()
        _pools.clear()
    with _lock:
        _ready.clear()
        _indexes.clear()
        _heads.clear()
        _contents.clear()
        _writes.clear()


def ping() -> dict:
    if not configured():
        return {'configured': False, 'ok': False}
    try:
        with connection() as conn:
            prefix = os.getenv('ASSET_S3_PREFIX', 'assets').strip('/')
            found = conn.execute(f'SELECT 1 FROM {SCHEMA}.namespaces WHERE prefix = %s', (prefix,)).fetchone()
            if not found:
                raise _not_imported(prefix)
            # Check the exact schema and read permission used by records, not just the PostgreSQL connection.
            conn.execute(f'SELECT {_META}, content FROM {SCHEMA}.records WHERE prefix = %s LIMIT 0', (prefix,))
            pending = _unapplied_migrations(conn)
            if pending:
                raise RecordStoreUnavailable(f'record migrations not applied as shipped: {", ".join(pending)}; '
                                             f'run: uv run python -m src.records migrate')
        return {'configured': True, 'ok': True}
    except Exception as exc:
        # server.py logs the error and keeps only `configured` and `ok` in its public health answer.
        return {'configured': True, 'ok': False, 'error': str(exc)}


def _unapplied_migrations(conn):
    """The migration files shipped with this release that the database has not applied, or applied with other bytes,
    as `src.records migrate` records them (file name and sha256)."""
    import hashlib
    from src.records import MIGRATIONS
    applied = dict(conn.execute(f'SELECT name, sha256 FROM {SCHEMA}.migrations').fetchall())
    return [path.name for path in sorted(MIGRATIONS.glob('[0-9][0-9][0-9]_*.up.sql'))
            if applied.get(path.name) != hashlib.sha256(path.read_bytes()).hexdigest()]


# --- readiness -------------------------------------------------------------------------------
# A prefix whose records were never imported must not look empty: an empty view would lose job
# state and let idempotency receipts disappear, so paid requests could be sent twice.

_lock = RLock()
_ready = {}       # prefix -> monotonic time of the last negative check, or True


def require(prefix):
    with _lock:
        state = _ready.get(prefix)
        if state is True or (state is not None and time.monotonic() - state < 5):
            if state is True:
                return
            raise _not_imported(prefix)
    with connection() as conn:
        found = conn.execute(f'SELECT 1 FROM {SCHEMA}.namespaces WHERE prefix = %s', (prefix,)).fetchone()
    with _lock:
        _ready[prefix] = True if found else time.monotonic()
    if not found:
        raise _not_imported(prefix)


def _not_imported(prefix):
    argument = prefix or "''"
    return RecordStoreUnavailable(f'records of storage prefix {prefix!r} are not in the record database; '
                                  f'run: uv run python -m src.records import --prefix {argument}')


# --- caches ----------------------------------------------------------------------------------

_indexes = {}     # (prefix, scope) -> (monotonic, {path: Meta})
_heads = {}       # (prefix, path) -> (monotonic, Meta | None), for paths outside a scope
_contents = ByteBoundedCache(CONTENT_CACHE_BYTES)  # (prefix, path) -> (sha256, bytes); a digest match is a content match
_writes = OrderedDict()   # (prefix, scope or path) -> (number of the last local write, monotonic time), oldest first
_write_numbers = itertools.count(1)


def _write_number(key):
    """Compared before and after a query: a different number means a local write landed meanwhile (hold _lock)."""
    entry = _writes.get(key)
    return entry[0] if entry else 0


def _mark_write(key):
    """Hold _lock. The table forgets marks old enough that no query begun before them can still be running."""
    _writes.pop(key, None)
    _writes[key] = next(_write_numbers), time.monotonic()
    now = time.monotonic()
    while len(_writes) > _WRITE_TABLE_LIMIT:
        oldest = next(iter(_writes))
        if now - _writes[oldest][1] < _WRITE_MEMORY:
            break
        del _writes[oldest]


def scope_of(path):
    """The job-sized directory of a path (<namespace>/<owner>/<item>/), or None for shallow paths."""
    parts = path.split('/')
    return '/'.join(parts[:3]) + '/' if len(parts) > 3 else None


def _upper(prefix_path):
    """The smallest string above every string that starts with prefix_path (C collation)."""
    return prefix_path[:-1] + chr(ord(prefix_path[-1]) + 1)


_META = 'size, sha256, version, updated_at, blob_key'


def _meta(row):
    return Meta(size=row[0], sha256=row[1], version=row[2], updated_at=row[3], blob_key=row[4])


def _scope_index(prefix, scope):
    key = (prefix, scope)
    for _ in range(3):
        with _lock:
            cached = _indexes.get(key)
            if cached and time.monotonic() - cached[0] < INDEX_SECONDS:
                return cached[1]
            writes = _write_number(key)
        started = time.monotonic()
        with connection() as conn:
            rows = conn.execute(
                f'SELECT path, {_META} FROM {SCHEMA}.records WHERE prefix = %s AND path >= %s AND path < %s',
                (prefix, scope, _upper(scope))).fetchall()
        index = {row[0]: _meta(row[1:]) for row in rows}
        with _lock:
            # A local write that landed while this query ran may be missing from its result.
            if _write_number(key) == writes:
                if len(_indexes) > 4096:
                    _indexes.clear()
                _indexes[key] = started, index
                return index
    return index


def head(prefix, path):
    require(prefix)
    scope = scope_of(path)
    if scope:
        return _scope_index(prefix, scope).get(path)
    key = (prefix, path)
    with _lock:
        cached = _heads.get(key)
        if cached and time.monotonic() - cached[0] < INDEX_SECONDS:
            return cached[1]
        writes = _write_number(key)
    started = time.monotonic()
    with connection() as conn:
        row = conn.execute(f'SELECT {_META} FROM {SCHEMA}.records WHERE prefix = %s AND path = %s',
                           (prefix, path)).fetchone()
    meta = _meta(row) if row else None
    with _lock:
        if _write_number(key) == writes:
            if len(_heads) > 4096:
                _heads.clear()
            _heads[key] = started, meta
    return meta


def fetch(prefix, path):
    """(Meta, bytes) for an inline record, (Meta, None) for one whose bytes live in S3, or None."""
    meta = head(prefix, path)
    if meta is None:
        return None
    with _lock:
        cached = _contents.get((prefix, path))
        if cached and cached[0] == meta.sha256:
            return meta, cached[1]
    with connection() as conn:
        row = conn.execute(f'SELECT {_META}, content FROM {SCHEMA}.records WHERE prefix = %s AND path = %s',
                           (prefix, path)).fetchone()
    if row is None:
        _written(prefix, path, None)
        return None
    meta, content = _meta(row[:5]), (bytes(row[5]) if row[5] is not None else None)
    if content is not None and len(content) < CONTENT_CACHE_LIMIT:
        with _lock:
            _contents[prefix, path] = meta.sha256, content
    return meta, content


def _written(prefix, path, meta, content=None):
    """Write-through after a committed change, so this process reads its own writes at once."""
    scope = scope_of(path)
    with _lock:
        if scope:
            _mark_write((prefix, scope))
            cached = _indexes.get((prefix, scope))
            if cached:
                # Copy on write: readers iterate the previous dict without holding the lock.
                index = dict(cached[1])
                if meta is None:
                    index.pop(path, None)
                else:
                    index[path] = meta
                _indexes[prefix, scope] = cached[0], index
        else:
            _mark_write((prefix, path))
            if (prefix, path) in _heads:
                _heads[prefix, path] = time.monotonic(), meta
        _contents.pop((prefix, path), None)
        if meta is not None and content is not None and len(content) < CONTENT_CACHE_LIMIT:
            _contents[prefix, path] = meta.sha256, bytes(content)


def put(prefix, path, *, content=None, blob_key=None, size, sha256, exclusive=False, expected_version=None):
    """Store one record. `exclusive` raises FileExistsError when the path exists; `expected_version`
    raises FileExistsError unless the row is still at that version (a conditional replace)."""
    if (content is None) == (blob_key is None):
        raise ValueError('A record has either inline content or a blob key')
    require(prefix)
    values = (prefix, path, content, blob_key, size, sha256)
    insert = f'INSERT INTO {SCHEMA}.records AS r (prefix, path, content, blob_key, size, sha256) VALUES (%s, %s, %s, %s, %s, %s)'
    returning = f' RETURNING {_META}'
    with connection() as conn:
        if exclusive:
            row = conn.execute(insert + ' ON CONFLICT (prefix, path) DO NOTHING' + returning, values).fetchone()
        elif expected_version is not None:
            row = conn.execute(
                f'UPDATE {SCHEMA}.records AS r SET content = %s, blob_key = %s, size = %s, sha256 = %s, '
                f'version = r.version + 1, updated_at = now() '
                f'WHERE prefix = %s AND path = %s AND version = %s' + returning,
                (content, blob_key, size, sha256, prefix, path, expected_version)).fetchone()
        else:
            row = conn.execute(
                insert + ' ON CONFLICT (prefix, path) DO UPDATE SET content = excluded.content, '
                'blob_key = excluded.blob_key, size = excluded.size, sha256 = excluded.sha256, '
                'version = r.version + 1, updated_at = now()' + returning, values).fetchone()
    if row is None:
        raise FileExistsError(path)
    meta = _meta(row)
    _written(prefix, path, meta, content)
    return meta


def delete(prefix, path):
    require(prefix)
    with connection() as conn:
        row = conn.execute(f'DELETE FROM {SCHEMA}.records WHERE prefix = %s AND path = %s RETURNING {_META}',
                           (prefix, path)).fetchone()
    _written(prefix, path, None)
    return _meta(row) if row else None


def move(prefix, source, target):
    """Atomic rename inside the database: the target gets the source's bytes and the source is gone."""
    require(prefix)
    if source == target:
        meta = head(prefix, source)
        if meta is None:
            raise FileNotFoundError(source)
        return meta
    with connection() as conn:
        row = conn.execute(
            f'WITH moved AS (DELETE FROM {SCHEMA}.records WHERE prefix = %s AND path = %s '
            f'RETURNING content, blob_key, size, sha256) '
            f'INSERT INTO {SCHEMA}.records AS r (prefix, path, content, blob_key, size, sha256) '
            f'SELECT %s, %s, content, blob_key, size, sha256 FROM moved '
            f'ON CONFLICT (prefix, path) DO UPDATE SET content = excluded.content, blob_key = excluded.blob_key, '
            f'size = excluded.size, sha256 = excluded.sha256, version = r.version + 1, updated_at = now() '
            f'RETURNING {_META}', (prefix, source, prefix, target)).fetchone()
    if row is None:
        raise FileNotFoundError(source)
    _written(prefix, source, None)
    meta = _meta(row)
    _written(prefix, target, meta)
    return meta


def listing(prefix, directory, pattern=None):
    """{path: Meta} of every record below `directory` (a path ending in '/'). A glob `pattern` relative to `directory`
    lets the database leave out paths it cannot match; the result may still hold some that it does not match."""
    require(prefix)
    scope = scope_of(directory + '_')
    if scope and directory.startswith(scope):
        return {path: meta for path, meta in _scope_index(prefix, scope).items() if path.startswith(directory)}
    like = _like(directory, pattern)
    query = f'SELECT path, {_META} FROM {SCHEMA}.records WHERE prefix = %s AND path >= %s AND path < %s'
    values = (prefix, directory, _upper(directory))
    if like:
        # Backslash, the escape character of _like, is LIKE's default one.
        query, values = query + ' AND path LIKE %s', (*values, like)
    with connection() as conn:
        rows = conn.execute(query, values).fetchall()
    return {row[0]: _meta(row[1:]) for row in rows}


def _like(directory, pattern):
    """A LIKE pattern that every path below `directory` matching the glob `pattern` (object_storage._glob_match) also
    matches, or None when it would leave nothing out. Wildcards widen: `*` to `%`, `?` to `_`, `**/` to `%` (no
    directory at all is a match too), and a character class ends the pattern with `%`. With `**` the glob matches from
    the right, so the pattern may start anywhere below `directory`."""
    if not pattern:
        return None

    def literal(text):
        return text.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')

    # Tokens: a wildcard is exactly '%' or '_', a literal character is escaped ('\%' for a literal percent sign).
    converted, index = ['%'] if '**' in pattern else [], 0
    while index < len(pattern):
        if pattern.startswith('**/', index) or pattern[index] in '*[':
            if not converted or converted[-1] != '%':
                converted.append('%')
            if pattern[index] == '[':
                break
            index += 3 if pattern.startswith('**/', index) else 1
        elif pattern[index] == '?':
            converted.append('_')
            index += 1
        else:
            converted.append(literal(pattern[index]))
            index += 1
    return None if converted == ['%'] else literal(directory) + ''.join(converted)


def exists_under(prefix, directory):
    require(prefix)
    scope = scope_of(directory + '_')
    if scope and directory.startswith(scope):
        return any(path.startswith(directory) for path in _scope_index(prefix, scope))
    with connection() as conn:
        return conn.execute(
            f'SELECT 1 FROM {SCHEMA}.records WHERE prefix = %s AND path >= %s AND path < %s LIMIT 1',
            (prefix, directory, _upper(directory))).fetchone() is not None


def children(prefix, directory):
    """Names of the subdirectories of `directory` that hold records, one index probe per name."""
    require(prefix)
    start = len(directory) + 1
    # Loose index scan: after each hit, jump past the whole subdirectory (or the single file).
    query = f'''
        WITH RECURSIVE step(path) AS (
            (SELECT path FROM {SCHEMA}.records WHERE prefix = %(prefix)s AND path >= %(low)s AND path < %(high)s
             ORDER BY path LIMIT 1)
            UNION ALL
            SELECT (SELECT r.path FROM {SCHEMA}.records r
                    WHERE r.prefix = %(prefix)s AND r.path < %(high)s AND r.path >= CASE
                        WHEN strpos(substr(step.path, %(start)s), '/') > 0
                        THEN %(low)s || split_part(substr(step.path, %(start)s), '/', 1) || '0'
                        ELSE step.path || chr(1) END
                    ORDER BY r.path LIMIT 1)
            FROM step WHERE step.path IS NOT NULL
        )
        SELECT DISTINCT split_part(substr(path, %(start)s), '/', 1) FROM step
        WHERE path IS NOT NULL AND strpos(substr(path, %(start)s), '/') > 0'''
    with connection() as conn:
        rows = conn.execute(query, {'prefix': prefix, 'low': directory, 'high': _upper(directory),
                                    'start': start}).fetchall()
    return {row[0] for row in rows}
