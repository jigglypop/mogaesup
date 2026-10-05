"""Local stdio MCP adapter for the existing authenticated Rust studio gateway.

Run `uv run --extra studio-mcp asset-studio-mcp` with MOGA_STUDIO_API_URL
and MOGA_STUDIO_SESSION set in the process environment. Mutations additionally
require MOGA_STUDIO_MCP_WRITE=1. No dotenv loader or provider keys are used.
Set MOGA_STUDIO_APP_ORIGIN when the gateway's configured APP_ORIGIN differs
from its API origin (for example, a development frontend and local API).
The paid garment tools (studio_garments.py) are listed only when
MOGA_STUDIO_MCP_PAID=1 is set as well; `asset-studio-mcp garments ...` runs
their queue from a terminal under the same two settings. One server process
sends paid requests under at most MOGA_STUDIO_MCP_PAID_LIMIT keys (1-100,
default 10).
"""
from __future__ import annotations

import os
import re
import sys
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field


CharacterId = Annotated[str, Field(pattern=r'^char-[a-f0-9]{12}$')]
FactoryId = Annotated[str, Field(pattern=r'^[a-f0-9]{24}$')]
OperationId = Annotated[str, Field(pattern=r'^[a-f0-9]{32}$')]
ArtifactSha = Annotated[str, Field(pattern=r'^[a-f0-9]{64}$')]
RequestKey = Annotated[str, Field(pattern=r'^[a-zA-Z0-9_-]{8,100}$')]
Revision = Annotated[str, Field(min_length=1, max_length=128, pattern=r'^[a-zA-Z0-9_.-]+$')]
_PRIVATE_KEYS = {'authorization', 'cookie', 'set-cookie', 'api_key', 'secret', 'token', 'credentials',
                 'executor', 'executor_process', 'command', 'payload', 'path', 'directory', 'raw_response'}
# Web addresses are matched first so a path inside one (or the `s:/` of `https://`) is not taken for a local path; a
# drive letter counts only where no ASCII letter, digit or underscore (as in a URL scheme) comes before it.
_PRIVATE_TEXT = re.compile(r'(?P<url>(?i:https?)://[^\s"<>]*)'
                           r'|(?P<path>(?:(?<![A-Za-z0-9_])[A-Za-z]:[\\/]'
                           r'|/(?:Users|home|srv|var|tmp|private|opt)/)[^\s"<>]*)')
_API_ERROR_CODES = frozenset({
    'action_unavailable', 'assembly_changed', 'artifact_changed', 'assembly_incomplete',
    'busy', 'coverage_required', 'draining', 'executor_interrupted', 'expression_pending',
    'factory_read_only', 'factory_paid_off', 'factory_budget', 'factory_unavailable', 'factory_timeout', 'factory_auth',
    'forbidden',
    'studio_waking', 'studio_stopping', 'studio_power_unconfigured', 'studio_power_unavailable', 'studio_start_failed',
    'studio_viewer_only', 'paid_operator_only', 'catalog_editor_only',
    'login_required', 'database', 'internal', 'conflict', 'invalid_value',
    'idempotency_conflict', 'input_changed', 'invalid_key', 'invalid_review', 'not_found',
    'operator_only', 'parts_required', 'revision_conflict', 'review_busy', 'review_required',
    'review_evidence_missing', 'technical_failure', 'unauthorized',
    # Single-part garment requests (studio_garments.py).
    'insufficient_credits', 'provider_unavailable', 'storage_required', 'listing_pending', 'worker_running',
    'base_changed', 'base_incomplete', 'body_changed', 'body_deleted', 'body_preparation_required',
    'fitted_part_changed', 'image_changed', 'model_changed', 'reference_changed', 'invalid_slots',
    'invalid_part_method', 'invalid_provider', 'invalid_fit_profile', 'invalid_description', 'invalid_bottom_kind',
    'texture_prompt_required',
})


def _signed(url: str) -> bool:
    """Whether a web address carries more than a location: a query (a presigned URL's signature), or a login."""
    try:
        parts = urlsplit(url)
        return bool(parts.query or parts.username or parts.password)
    except ValueError:
        return True


def _private_text(match: re.Match) -> str:
    url = match.group('url')
    if url is None:
        return '[private path]'
    return '[private artifact URL]' if _signed(url) else url


class ReviewInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    decision: Literal['approved', 'changes_requested']
    notes: str = Field(min_length=5, max_length=2000)
    appearance_checked: bool
    motion_checked: bool


class StudioClient:
    def __init__(self, base_url: str, session: str, *, app_origin: str | None = None, writable=False, paid=False,
                 transport=None):
        origin = self.validate_origin(base_url, 'MOGA_STUDIO_API_URL')
        browser_origin = self.validate_origin(app_origin or origin, 'MOGA_STUDIO_APP_ORIGIN')
        if not re.fullmatch(r'[a-fA-F0-9]{64}', session):
            raise ValueError('MOGA_STUDIO_SESSION must be a valid session credential')
        self.origin = origin
        self.writable = writable
        # Paid garment tools need both opt-ins (MOGA_STUDIO_MCP_WRITE=1 and MOGA_STUDIO_MCP_PAID=1).
        self.paid = bool(writable and paid)
        self._session = session
        # The app server sets the session as `__Host-mogaesup_session` over HTTPS and as `mogaesup_session` on a local
        # http origin (and still reads the old name for older sessions): the credential goes under both names.
        self._client = httpx.Client(base_url=self.origin, timeout=30, follow_redirects=False,
                                   transport=transport,
                                   headers={'Cookie': f'__Host-mogaesup_session={session}; mogaesup_session={session}',
                                            'Origin': browser_origin, 'Accept': 'application/json'})

    @staticmethod
    def validate_origin(base_url, setting):
        parsed = urlsplit(base_url)
        try:
            parsed.port
        except ValueError:
            raise ValueError(setting+' must be an HTTPS origin or a loopback HTTP origin') from None
        loopback = parsed.hostname in ('localhost', '127.0.0.1', '::1')
        if (parsed.scheme != 'https' and not (parsed.scheme == 'http' and loopback)
                or not parsed.hostname or parsed.username or parsed.password
                or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
            raise ValueError(setting+' must be an HTTPS origin or a loopback HTTP origin')
        return base_url.rstrip('/')

    def close(self):
        self._client.close()

    def sanitize(self, value):
        if isinstance(value, dict):
            return {key: self.sanitize(item) for key, item in value.items()
                    if key.lower() not in _PRIVATE_KEYS and not re.search(r'(secret|password|api.?key|credential|(?:^|_)token(?:$|_))', key, re.I)}
        if isinstance(value, list):
            return [self.sanitize(item) for item in value]
        if isinstance(value, str):
            if self._session in value:
                return '[redacted]'
            if value.startswith(('http://', 'https://')) and _signed(value):
                return '[private artifact URL]'
            return _PRIVATE_TEXT.sub(_private_text, value)
        return value

    def _request(self, method, path, *, body=None, headers=None):
        try:
            with self._client.stream(method, path, json=body, headers=headers) as response:
                content = bytearray()
                for chunk in response.iter_bytes(chunk_size=64*1024):
                    if len(content)+len(chunk) > 8*1024*1024:
                        return {'ok': False, 'error': {'code': 'response_too_large'}}
                    content.extend(chunk)
                status = response.status_code
        except httpx.HTTPError:
            return {'ok': False, 'error': {'code': 'api_unavailable', 'message': 'API response unavailable; inspect the existing operation before retrying'}}
        try:
            import json
            value = json.loads(content)
        except ValueError:
            if status < 300:
                return {'ok': False, 'error': {'code': 'invalid_response'}}
            value = {}
        if status >= 300:
            code = 'api_refused'
            try:
                # `{"error": {"code": ...}}` from the character server, `{"code": ...}` from the gateway and from the
                # character server's admission middleware while it drains. Only a code says what happened: any other
                # 503 (its authentication settings, say) stays `api_refused`.
                for error in (value.get('error'), value):
                    candidate = error.get('code') if isinstance(error, dict) else None
                    if candidate in _API_ERROR_CODES:
                        code = candidate
                        break
            except (ValueError, AttributeError, TypeError):
                pass
            return {'ok': False, 'status': status,
                    'error': {'code': code, 'message': 'The API refused this request'}}
        return {'ok': True, 'data': self.sanitize(value)}

    def read(self, tool: str, identifier='', operation=''):
        routes = {
            'get_my_permissions': '/api/auth/me',
            'list_catalog_items': '/api/catalog/items',
            'list_wardrobe_bodies': '/api/avatar-factory/wardrobe/bodies',
            'get_my_look': '/api/looks/me',
            'get_factory_usage': '/api/catalog/admin/factory-usage',
        }
        if tool == 'get_character':
            if not re.fullmatch(r'char-[a-f0-9]{12}', identifier):
                raise ValueError('Invalid character ID')
            path = '/api/characters/'+identifier
        elif tool == 'get_character_operation':
            if not re.fullmatch(r'char-[a-f0-9]{12}', identifier) or not re.fullmatch(r'[a-f0-9]{32}', operation):
                raise ValueError('Invalid operation ID')
            path = '/api/characters/'+identifier+'/operations/'+operation
        elif tool in ('get_factory_job', 'get_native_assembly'):
            if not re.fullmatch(r'[a-f0-9]{24}', identifier):
                raise ValueError('Invalid factory job ID')
            path = '/api/avatar-factory/jobs/'+identifier+('/native-parts' if tool == 'get_native_assembly' else '')
        elif tool in routes:
            path = routes[tool]
        else:
            raise ValueError('Unknown tool')
        return self._request('GET', path)

    def action(self, character_id, action, revision, key, body):
        if not self.writable:
            return {'ok': False, 'error': {'code': 'mcp_read_only'}}
        if not re.fullmatch(r'char-[a-f0-9]{12}', character_id):
            raise ValueError('Invalid character ID')
        if action not in ('inspect_model', 'record_review'):
            raise ValueError('Unsupported action')
        if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}', key) or not re.fullmatch(r'[a-zA-Z0-9_.-]{1,128}', revision):
            raise ValueError('Invalid request key or revision')
        payload = ReviewInput.model_validate(body).model_dump() if action == 'record_review' else {}
        if action == 'inspect_model' and body:
            raise ValueError('Inspect action takes no input')
        return self._request('POST', '/api/characters/'+character_id+'/actions/'+action, body=payload,
                             headers={'If-Match': revision, 'Idempotency-Key': key})

    def native_review(self, job_id, version, expected_assembly_sha256, key, body):
        if not self.writable:
            return {'ok': False, 'error': {'code': 'mcp_read_only'}}
        if not re.fullmatch(r'[a-f0-9]{24}', job_id) or not re.fullmatch(r'[a-f0-9]{24}', version):
            raise ValueError('Invalid native assembly ID')
        if not re.fullmatch(r'[a-f0-9]{64}', expected_assembly_sha256):
            raise ValueError('Invalid assembly SHA256')
        if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}', key):
            raise ValueError('Invalid request key')
        review = ReviewInput.model_validate(body).model_dump()
        if review['decision'] == 'approved':
            # The studio records an approval as a person's; that person approves in the studio screen.
            return {'ok': False, 'error': {'code': 'mcp_approval_refused',
                                           'message': 'Approval is made in the studio; record changes_requested only'}}
        payload = {'expected_assembly_sha256': expected_assembly_sha256, **review}
        return self._request('POST', f'/api/avatar-factory/jobs/{job_id}/native-parts/{version}/review',
                             body=payload, headers={'Idempotency-Key': key})


def build_server(client: StudioClient, garments=None):
    from mcp.server.fastmcp import FastMCP
    from mcp.types import ToolAnnotations
    instructions = 'Read saved studio state; mutations use existing operation receipts. Never retry a timed-out mutation automatically.'
    if client.writable and client.paid:
        from src.studio_garments import GarmentStudio
        garments = garments or GarmentStudio(client)
        instructions += (' Garment tools start paid generation: keep one idempotency_key per intended garment or call,'
                         ' and reuse it only to recover that call.'
                         f' This session sends paid requests under at most {garments.paid_limit} keys.')
    server = FastMCP('mogaesup-studio', instructions=instructions)
    read_only = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)
    mutation = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False)

    def register_read(name):
        def read() -> dict[str, Any]:
            return client.read(name)
        server.tool(name=name, annotations=read_only)(read)
    for name in ('get_my_permissions', 'list_catalog_items', 'list_wardrobe_bodies', 'get_my_look', 'get_factory_usage'):
        register_read(name)

    @server.tool(annotations=read_only)
    def get_character(character_id: CharacterId) -> dict[str, Any]:
        return client.read('get_character', character_id)

    @server.tool(annotations=read_only)
    def get_character_operation(character_id: CharacterId, operation_id: OperationId) -> dict[str, Any]:
        return client.read('get_character_operation', character_id, operation_id)

    @server.tool(annotations=read_only)
    def get_factory_job(job_id: FactoryId) -> dict[str, Any]:
        return client.read('get_factory_job', job_id)

    @server.tool(annotations=read_only)
    def get_native_assembly(job_id: FactoryId) -> dict[str, Any]:
        return client.read('get_native_assembly', job_id)

    @server.tool(annotations=mutation)
    def inspect_character(character_id: CharacterId, revision: Revision, idempotency_key: RequestKey) -> dict[str, Any]:
        return client.action(character_id, 'inspect_model', revision, idempotency_key, {})

    @server.tool(annotations=mutation)
    def record_character_review(character_id: CharacterId, revision: Revision, idempotency_key: RequestKey,
                                review: ReviewInput) -> dict[str, Any]:
        return client.action(character_id, 'record_review', revision, idempotency_key, review.model_dump())

    @server.tool(annotations=mutation)
    def record_native_review(job_id: FactoryId, version: FactoryId, expected_assembly_sha256: ArtifactSha,
                             idempotency_key: RequestKey, review: ReviewInput) -> dict[str, Any]:
        """Records changes_requested on a native assembly; approval is made by a person in the studio."""
        return client.native_review(job_id, version, expected_assembly_sha256, idempotency_key, review.model_dump())

    if client.writable and client.paid:
        from src.studio_garments import register_tools
        register_tools(server, garments)
    return server


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ['garments']:
        from src.studio_garments import cli
        raise SystemExit(cli(argv[1:]))
    writable = os.environ.get('MOGA_STUDIO_MCP_WRITE') == '1'
    try:
        client = StudioClient(os.environ.get('MOGA_STUDIO_API_URL', ''), os.environ.get('MOGA_STUDIO_SESSION', ''),
                              app_origin=os.environ.get('MOGA_STUDIO_APP_ORIGIN'), writable=writable,
                              paid=writable and os.environ.get('MOGA_STUDIO_MCP_PAID') == '1')
    except ValueError as exc:
        raise SystemExit(str(exc)) from None
    try:
        try:
            server = build_server(client)
        except ValueError as exc:  # MOGA_STUDIO_MCP_PAID_LIMIT out of range
            raise SystemExit(str(exc)) from None
        server.run(transport='stdio')
    finally:
        client.close()


if __name__ == '__main__':
    main()
