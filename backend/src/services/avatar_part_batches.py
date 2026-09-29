"""Uploaded three-view hair batches with durable, independently resumable jobs."""
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
import hashlib
import io
import json
import os
import re
from threading import Lock, Semaphore

from PIL import Image

from src.services.asset_editor import _write_json
from src.services.avatar_blueprints import AvatarBlueprints
from src.services.avatar_factory import _LOCK, digest
from src.services.avatar_image_pipeline import AvatarImagePipeline, capabilities
from src.services.avatar_native_parts import AvatarNativeParts
from src.services.avatar_variants import AvatarVariants
from src.services.character_pipeline import PipelineError, now, read_json
from src.services.meshy_options import freeze_options
from src.services.process_identity import identity, lease_guard, state as process_state
from src.services.studio_library import StudioLibrary
from src.services.studio_prompts import StudioPrompts


_RUNS = {}
_PART_WORKERS = Semaphore(4)
_ASSET_ID = re.compile(r'[a-f0-9]{64}')
_EXPECTED_BUDGET = {'image_tasks': 0, 'reference_tasks': 0, 'expression_tasks': 0,
                    'meshy_tasks': 1, 'meshy_rig_tasks': 0, 'meshy_animation_tasks': 0}


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _require_s3():
    if not os.getenv('ASSET_S3_BUCKET', '').strip():
        raise PipelineError('storage_required', 'S3 저장소 설정이 필요합니다.', 503)


@contextmanager
def _batch_lease(directory):
    """Serialize the same batch across API and CLI processes on this host."""
    guard = lease_guard(directory)
    try:
        guard.__enter__()
    except ValueError:
        raise PipelineError('worker_active', '같은 일괄 작업을 다른 실행에서 처리 중입니다.', 409) from None
    try:
        yield
    finally:
        guard.__exit__(None, None, None)


def isolate_hair(tile):
    """Opt-in chroma filter for monochrome sheets; it cannot identify skin.

    Warm/colored hair matches the same RGB rule. Normal intake preserves every
    color and alpha value; only explicitly selected monochrome cleanup uses it.
    """
    tile = tile.convert('RGBA'); pixels = list(tile.getdata()); w, h = tile.size
    mask = bytearray(w*h)
    for i, (r, g, b, a) in enumerate(pixels):
        skin = r-b > 12 and r-g > 4 and g-b > -6
        matte = max(r, g, b)-min(r, g, b) > 100
        mask[i] = int(a > 24 and not skin and not matte and min(r, g, b) <= 245)
    kept = bytearray(w*h)
    for start in range(w*h):
        if not mask[start]:
            continue
        mask[start] = 0; queue = deque([start]); component = []
        while queue:
            index = queue.popleft(); component.append(index); x, y = index % w, index // w
            for other in (index-1 if x else -1, index+1 if x+1 < w else -1,
                          index-w if y else -1, index+w if y+1 < h else -1):
                if other >= 0 and mask[other]:
                    mask[other] = 0; queue.append(other)
        if len(component) >= 12:
            for index in component:
                kept[index] = 1
    tile.putdata([(r, g, b, a if kept[i] else 0) for i, (r, g, b, a) in enumerate(pixels)])
    return tile


def _valid_edges(edges, count):
    return (isinstance(edges, list) and len(edges) == count+1 and edges[0] == 0 and edges[-1] == 1
            and all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in edges)
            and all(a < b for a, b in zip(edges, edges[1:])))


def _validate_source_image(content):
    try:
        with Image.open(io.BytesIO(content)) as source:
            if source.format not in ('PNG', 'JPEG') or source.width*source.height > 32_000_000:
                raise ValueError('invalid image')
            source.load()
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        raise PipelineError('invalid_part_image', '3,200만 픽셀 이하의 PNG/JPEG 파츠 이미지를 선택하세요.', 422) from None


def _transparent_view_edges(image):
    """Find empty columns near thirds without clipping or rescaling hair strands."""
    occupied, _ = image.getchannel('A').getprojection()
    width = image.width
    edges = [0]
    for index in (1, 2):
        target = width*index/3
        low, high = round(target-width*.10), round(target+width*.10)
        candidates = [x for x in range(low, high) if not occupied[x]]
        if not candidates:
            raise PipelineError('view_seam_missing', '3뷰 사이의 투명 경계가 없습니다. 시트 분할에서 경계를 지정하세요.', 422)
        edges.append(min(candidates, key=lambda x: abs(x-target)))
    return [[edge/width for edge in [*edges, width]]]


def split_sheet(factory, owner, payload):
    _require_s3()
    assets = AvatarBlueprints(factory.data)
    raw = assets.asset(owner, payload['asset_id']).read_bytes()
    if hashlib.sha256(raw).hexdigest() != payload['asset_id']:
        raise PipelineError('source_changed', '시트 원본이 변경되었습니다.', 409)
    try:
        with Image.open(io.BytesIO(raw)) as source:
            if source.format not in ('PNG', 'JPEG') or source.width*source.height > 32_000_000:
                raise ValueError('invalid image')
            source.load(); image = source.convert('RGBA')
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        raise PipelineError('invalid_sheet', '3,200만 픽셀 이하의 PNG/JPEG 시트를 선택하세요.', 422) from None
    rows, columns = payload['rows'], payload['columns']
    row_edges = payload.get('row_edges') or [i/rows for i in range(rows+1)]
    if not _valid_edges(row_edges, rows):
        raise PipelineError('invalid_grid', '행 경계는 0에서 1까지 오름차순으로 입력하세요.', 422)
    view_edges = payload.get('view_edges')
    detect_seams = payload.get('detect_view_seams', False)
    if detect_seams:
        if rows != 1 or columns != 1 or view_edges is not None:
            raise PipelineError('invalid_grid', '투명 경계 분할은 3뷰 이미지 한 장에만 사용할 수 있습니다.', 422)
        view_edges = _transparent_view_edges(image)
    if view_edges is None:
        view_edges = [[i/(columns*3) for i in range(columns*3+1)] for _ in range(rows)]
    if len(view_edges) != rows or any(not _valid_edges(edges, columns*3) for edges in view_edges):
        raise PipelineError('invalid_grid', '각 행의 뷰 경계를 0에서 1까지 오름차순으로 입력하세요.', 422)
    contract = {**payload, 'row_edges': row_edges, 'view_edges': view_edges,
                'revision': 'hair-sheet-crop-v5-preserve-pixels'}
    sheet_id = _hash(contract)[:24]
    path = factory.root/str(int(owner))/'part-sheets'/sheet_id/'sheet.json'
    if path.is_file():
        return read_json(path)
    items = []
    from src.services.avatar_hair_sheet import crop_rows
    cropped_rows = crop_rows(image, [round(image.height*edge) for edge in row_edges],
                            [[round(image.width*edge) for edge in edges] for edges in view_edges],
                            remove_skin=payload['remove_skin'])
    canvas_side = max(max(tile.size) for row in cropped_rows for tile in row)+16
    for row in range(rows):
        row_tiles = cropped_rows[row]
        for col in range(columns):
            tiles = []
            for offset, view in enumerate(payload['view_order']):
                edge = col*3+offset
                tile = row_tiles[edge]
                if not tile.getchannel('A').getbbox():
                    raise PipelineError('empty_crop', f'{row+1}행 {col+1}번 {view} 이미지가 비어 있습니다.', 422)
                tiles.append((view, tile))
            # Every view uses the same fixed canvas. Never enlarge an individual bounding box.
            side = max(canvas_side, max(max(tile.size) for _, tile in tiles)+16)
            views = {}
            for view, tile in tiles:
                canvas = Image.new('RGBA', (side, side))
                canvas.alpha_composite(tile, ((side-tile.width)//2, (side-tile.height)//2))
                output = io.BytesIO(); canvas.save(output, format='PNG')
                views[view] = assets.upload(owner, output.getvalue())['id']
            items.append({'name': f'여성 헤어 {len(items)+1:02}', 'views': views,
                          'row': row+1, 'column': col+1})
    record = {'id': sheet_id, 'source_asset': payload['asset_id'], 'contract': contract,
              'items': items, 'created_at': now()}
    _write_json(path, record)
    return record


class PartBatches:
    def __init__(self, factory):
        self.factory = factory

    def root(self, owner, batch):
        if not re.fullmatch(r'[a-f0-9]{24}', batch):
            raise PipelineError('not_found', '일괄 작업을 찾을 수 없습니다.', 404)
        return self.factory.root/str(int(owner))/'part-batches'/batch

    def _path(self, owner, batch):
        return self.root(owner, batch)/'batch.json'

    def _save(self, owner, record):
        record['updated_at'] = now()
        _write_json(self._path(owner, record['id']), record)

    def _base_receipt(self, owner, payload):
        base = self.factory.get(owner, payload['base_job_id'])
        library = StudioLibrary(self.factory, owner)
        metadata = library.metadata()
        if (metadata['parts'].get(f"{payload['base_job_id']}:body", {}).get('deleted')
                or library.is_job_deleted(base, metadata)):
            raise PipelineError('body_deleted', '삭제한 기본 몸은 갤러리 휴지통에서 복원한 뒤 선택하세요.', 409)
        native = AvatarNativeParts(self.factory).get(owner, payload['base_job_id'], version=payload['base_version'])
        if native.get('status') != 'review_required' or native.get('version') != payload['base_version']:
            raise PipelineError('base_changed', '저장된 기본 몸 버전을 다시 선택하세요.', 409)
        artifact = next((item for item in native.get('artifacts', []) if item.get('name') == 'body.glb'), None)
        if not artifact or not _ASSET_ID.fullmatch(str(artifact.get('sha256', ''))):
            raise PipelineError('base_incomplete', '기준 여성 몸의 저장 영수증을 확인할 수 없습니다.', 409)
        if native.get('origin') == 'uploaded_glb':
            raise PipelineError('body_preparation_required', '피팅·조립이 끝난 기준 몸을 선택하세요.', 422)
        pipeline = read_json(self.factory.directory(owner, payload['base_job_id'])/'pipeline.json')
        if not pipeline.get('production_spec') or any(
                part.get('model', {}).get('status') != 'ready' for part in pipeline.get('parts', [])):
            raise PipelineError('base_incomplete', '파츠와 공통 규격이 저장된 기준 몸을 선택하세요.', 422)
        body = AvatarNativeParts(self.factory).artifact(
            owner, payload['base_job_id'], payload['base_version'], 'body.glb')
        if digest(body) != artifact['sha256']:
            raise PipelineError('base_changed', '기준 여성 몸 파일이 변경되었습니다.', 409)
        return {'job_id': payload['base_job_id'], 'version': payload['base_version'],
                'body_sha256': artifact['sha256']}

    def _child_snapshot(self, owner, item):
        job_id = item['job_id']; directory = self.factory.directory(owner, job_id)
        if not (directory/'job.json').is_file():
            if any(item.get(field) for field in ('task_id', 'model_receipt', 'native_receipt')):
                return {**item, 'state_error': '저장된 하위 작업을 일시적으로 조회할 수 없습니다.'}
            return {**item, 'status': 'queued', 'child_status': 'not_created',
                    'progress': {}, 'error': item.get('error')}
        child = self.factory.get(owner, job_id)
        task = read_json(directory/'parts'/'hair'/'character.json')
        generated = read_json(directory/'parts'/'hair'/'generation-artifacts.json').get('generated', {})
        task_id = task.get('task_id') if isinstance(task.get('task_id'), str) else None
        generated_sha = generated.get('sha256') if _ASSET_ID.fullmatch(str(generated.get('sha256', ''))) else None
        if generated_sha:
            model = directory/'parts'/'hair'/'generated.glb'
            if not model.is_file() or digest(model) != generated_sha:
                generated_sha = None
        native = AvatarNativeParts(self.factory).get(owner, job_id)
        artifact = next((value for value in native.get('artifacts', [])
                         if value.get('name') == 'hair.glb' and _ASSET_ID.fullmatch(str(value.get('sha256', '')))), None)
        complete = False
        if (native.get('status') == 'review_required' and artifact
                and not native.get('expression_pending') and not native.get('incomplete_parts')):
            try:
                AvatarNativeParts(self.factory).artifact(owner, job_id, native['version'], 'hair.glb')
                complete = True
            except PipelineError:
                artifact = None
        active = (child.get('status') in ('pipeline_running', 'accepted', 'running')
                  or bool(child.get('character_flow', {}).get('busy')))
        if native.get('status') in ('accepted', 'running'):
            active = True
        queued = child.get('status') == 'pipeline_queued'
        status = 'complete' if complete else 'running' if active else 'queued' if queued else 'paused'
        progress = child.get('progress') if isinstance(child.get('progress'), dict) else {}
        result = {**item, 'status': status, 'task_id': task_id,
                  'child_status': child.get('status'),
                  'progress': {key: progress[key] for key in ('stage', 'message') if key in progress},
                  'error': None if complete else child.get('error') or native.get('error')}
        hair_input = next((part for part in child.get('parts', []) if part['slot'] == 'hair'), {})
        if hair_input.get('hair_redraw'):
            result['prepared_views'] = [
                {'view': view, 'status': image.get('status'),
                 'background_removal': image.get('background_removal'),
                 'url': next((asset['url'] for asset in child.get('artifacts', [])
                              if image.get('status') == 'succeeded' and asset['name'] == image.get('file')), None)}
                for view, image in hair_input.get('views', {}).items()]
        if generated_sha:
            result['model_receipt'] = {'sha256': generated_sha}
        if artifact:
            result['native_receipt'] = {'version': native['version'], 'name': 'hair.glb',
                                        'sha256': artifact['sha256'], 'url': artifact.get('url')}
        return result

    def _public(self, owner, record):
        items = []
        for saved in record['items']:
            try:
                items.append(self._child_snapshot(owner, saved))
            except Exception as exc:
                items.append({**saved, 'state_error': exc.message if isinstance(exc, PipelineError)
                              else '저장된 하위 작업 상태를 확인할 수 없습니다.'})
        complete = all(item['status'] == 'complete' for item in items)
        running = any(item['status'] == 'running' for item in items)
        owner_running = record.get('status') == 'running' and process_state(record.get('process')) != 'exited'
        status = 'complete' if complete else 'running' if running or owner_running else record.get('status', 'paused')
        if status == 'running' and not running and not owner_running:
            status = 'paused'
        public = {key: value for key, value in record.items()
                  if key not in ('fingerprint', 'process', 'frozen_context')}
        public.update(status=status, items=items,
                      completed=sum(item['status'] == 'complete' for item in items),
                      can_resume=bool(not complete and not running and not owner_running))
        return public

    def create(self, owner, key, payload):
        _require_s3()
        if not re.fullmatch(r'[a-zA-Z0-9_-]{8,100}', key):
            raise PipelineError('invalid_key', '요청 식별자가 필요합니다.', 422)
        batch = hashlib.sha256(f'{owner}:part-batch:{key}'.encode()).hexdigest()[:24]
        path = self._path(owner, batch); fingerprint = _hash(payload)
        if not read_json(path):
            from src.services.meshy_status import require_credits
            require_credits(len(payload['items']))
        with _LOCK, _batch_lease(self.root(owner, batch)):
            old = read_json(path)
            if old:
                if old['fingerprint'] != fingerprint:
                    raise PipelineError('idempotency_conflict', '접수한 일괄 작업 입력이 다릅니다.', 409)
                return self._public(owner, old), False
            if len(payload['items']) > 48:
                raise PipelineError('batch_too_large', '일괄 작업은 최대 48개입니다.', 422)
            base_receipt = self._base_receipt(owner, payload)
            assets = AvatarBlueprints(self.factory.data)
            for item in payload['items']:
                if set(item['views']) != {'front', 'side', 'back'}:
                    raise PipelineError('invalid_views', '헤어마다 정면·측면·후면 3뷰가 필요합니다.', 422)
                for asset_id in item['views'].values():
                    content = assets.asset(owner, asset_id).read_bytes()
                    if hashlib.sha256(content).hexdigest() != asset_id:
                        raise PipelineError('source_changed', '헤어 원본이 변경되었습니다.', 409)
                    _validate_source_image(content)
            prompt_snapshot = StudioPrompts(self.factory, owner).snapshot()
            frozen_context = {'prompt_snapshot': prompt_snapshot,
                'meshy_options': {'hair': freeze_options(self.factory, owner, payload['meshy_options'],
                                                         'hair', prompt_snapshot['meshy_texture'])}}
            if payload.get('redraw') is not None:
                from src.services.avatar_hair_redraw import contract
                from src.services.avatar_openai_images import DEFAULT_BASE
                frozen_context['hair_redraw_contract'] = contract(**payload['redraw'])
                available = capabilities()
                if not available['image_configured']:
                    raise PipelineError('image_provider_unavailable', '고화질 다시 그리기에는 이미지 서비스 연결이 필요합니다.', 503)
                frozen_context['image_settings'] = {'image_provider': 'openai', 'image_model': available['image_model'],
                    'image_base': os.getenv('OPENAI_API_BASE', DEFAULT_BASE).rstrip('/')}
            # Persist the full frozen batch before accepting any child. The worker uses
            # deterministic child keys, so a crash can resume without a second request.
            children = []
            for index, source in enumerate(payload['items']):
                child_key = f'{batch}-{index:03}'
                job_id = hashlib.sha256(f'{owner}:variant:{child_key}'.encode()).hexdigest()[:24]
                children.append({'index': index, 'name': source['name'], 'status': 'queued',
                                 'key': child_key, 'job_id': job_id, 'task_id': None, 'error': None})
            record = {'id': batch, 'fingerprint': fingerprint, 'input': payload,
                      'base_job_id': payload['base_job_id'], 'base_version': payload['base_version'],
                      'base_receipt': base_receipt, 'concurrency': payload['concurrency'],
                      'budget': {'jobs': len(children), 'image_tasks_each': (3 if payload['redraw'].get('worn') else 4) if payload.get('redraw') is not None else 0, 'meshy_tasks_each': 1,
                                 'meshy_rig_tasks_each': 0, 'meshy_animation_tasks_each': 0},
                      'frozen_context': frozen_context, 'status': 'accepted', 'created_at': now(),
                      'updated_at': now(), 'error': None, 'items': children}
            _write_json(path, record)
        return self._public(owner, record), True

    def get(self, owner, batch):
        record = read_json(self._path(owner, batch))
        if not record:
            raise PipelineError('not_found', '일괄 작업을 찾을 수 없습니다.', 404)
        if record.get('status') == 'running' and process_state(record.get('process')) == 'exited':
            with _LOCK, _batch_lease(self.root(owner, batch)):
                current = read_json(self._path(owner, batch))
                if current.get('status') == 'running' and process_state(current.get('process')) == 'exited':
                    current.update(status='paused', error='서버가 중단되었습니다. 저장된 하위 작업으로 이어가세요.')
                    self._save(owner, current); record = current
        return self._public(owner, record)

    def list(self, owner):
        root = self.factory.root/str(int(owner))/'part-batches'
        items = [self.get(owner, path.parent.name) for path in root.glob('*/batch.json')]
        return {'items': sorted(items, key=lambda value: value['created_at'], reverse=True)}

    def resume(self, owner, batch):
        with _LOCK, _batch_lease(self.root(owner, batch)):
            record = read_json(self._path(owner, batch))
            if not record:
                raise PipelineError('not_found', '일괄 작업을 찾을 수 없습니다.', 404)
            if record.get('base_receipt') != self._base_receipt(owner, record['input']):
                raise PipelineError('base_changed', '접수한 기준 여성 몸이 변경되었습니다.', 409)
            public = self._public(owner, record)
            if public['status'] == 'complete' or not public['can_resume']:
                return public, False
            record.update(status='accepted', process=None, error=None, resume_requested_at=now())
            self._save(owner, record)
        return self.get(owner, batch), True

    def execute(self, owner, batch):
        with _LOCK:
            lock = _RUNS.setdefault((int(owner), batch), Lock())
        if not lock.acquire(False):
            return
        path = self._path(owner, batch)
        try:
            with _batch_lease(self.root(owner, batch)):
                record = read_json(path)
                if not record or record.get('status') != 'accepted':
                    return
                if record.get('base_receipt') != self._base_receipt(owner, record['input']):
                    raise PipelineError('base_changed', '접수한 기준 여성 몸이 변경되었습니다.', 409)
                record.update(status='running', process=identity(), error=None)
                self._save(owner, record)
            explicit_resume = bool(record.get('resume_requested_at'))

            def update(index, snapshot):
                with _LOCK, _batch_lease(self.root(owner, batch)):
                    current = read_json(path); saved = current['items'][index]
                    for field in ('status', 'task_id', 'model_receipt', 'native_receipt', 'error'):
                        if field in snapshot:
                            saved[field] = snapshot[field]
                    self._save(owner, current)

            def run(item):
                index = item['index']; job_id = item['job_id']
                with _PART_WORKERS:
                    try:
                        snapshot = self._child_snapshot(owner, item)
                        if snapshot['status'] == 'complete':
                            update(index, snapshot); return
                        source = record['input']['items'][index]
                        child, _ = AvatarVariants(self.factory).create_single_part(owner, item['key'], {
                            'base_job_id': record['input']['base_job_id'],
                            'base_version': record['input']['base_version'],
                            'slot': 'hair', 'hair_length': 'source', 'bottom_kind': 'source',
                            'view_mode': 'front_side_back', 'uploaded_views': source['views'],
                            'part_name': source['name'],
                            **({'redraw': record['input']['redraw']} if record['input'].get('redraw') is not None else {}),
                            'meshy_options': record['input']['meshy_options']},
                            frozen_context=record['frozen_context'])
                        child_pipeline = read_json(self.factory.directory(owner, job_id)/'pipeline.json')
                        expected_budget = {**_EXPECTED_BUDGET,
                            'image_tasks': record['budget']['image_tasks_each'] + sum(
                                len(image.get('previous_attempts', [])) for part in child_pipeline.get('parts', [])
                                for image in part.get('views', {}).values())}
                        if child['id'] != job_id or child.get('limits') != expected_budget:
                            raise PipelineError('budget_mismatch', '헤어 생성 예산 계약을 확인할 수 없습니다.', 409)
                        child = self.factory.get(owner, job_id)
                        service = AvatarImagePipeline(self.factory)
                        if child['status'] in ('pipeline_paused', 'failed', 'recovery_required', 'review_required'):
                            if not explicit_resume:
                                update(index, snapshot); return
                            images_pending = any(part.get('hair_redraw') and any(
                                image.get('status') != 'succeeded' for image in part.get('views', {}).values())
                                for part in child_pipeline.get('parts', []))
                            service.resume(owner, job_id, stage='images' if images_pending else 'models')
                        service.execute(owner, job_id)
                        update(index, self._child_snapshot(owner, item))
                    except Exception as exc:
                        update(index, {**item, 'status': 'paused',
                            'error': exc.message if isinstance(exc, PipelineError)
                            else '헤어 처리 중단. 저장된 하위 작업 ID로 이어갈 수 있습니다.'})

            with ThreadPoolExecutor(max_workers=record['concurrency'], thread_name_prefix='part-batch') as pool:
                for future in as_completed([pool.submit(run, item) for item in record['items']]):
                    future.result()
            with _LOCK, _batch_lease(self.root(owner, batch)):
                current = read_json(path); public = self._public(owner, current)
                current.update(status='complete' if public['completed'] == len(current['items']) else 'paused',
                               process=None, error=None if public['completed'] == len(current['items'])
                               else '완료되지 않은 헤어 작업을 저장했습니다. 이어가기로 계속하세요.')
                self._save(owner, current)
        except Exception as exc:
            try:
                with _LOCK, _batch_lease(self.root(owner, batch)):
                    record = read_json(path)
                    if record:
                        record.update(status='paused', process=None,
                                      error=exc.message if isinstance(exc, PipelineError)
                                      else '일괄 작업이 중단되었습니다. 하위 작업과 영수증은 보존했습니다.')
                        self._save(owner, record)
            except PipelineError:
                pass
        finally:
            lock.release()
